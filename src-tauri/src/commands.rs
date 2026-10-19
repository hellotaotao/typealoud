use crate::retry_error::{RetryError, RetryFailure};
use crate::hotkey;
use crate::history;
use crate::platform::{self, InsertResult};
use crate::settings::{self, AppConfig, SettingsPayload};
use crate::state::{ActiveTranscription, AppState, LocalModelDownload};
use anyhow::{Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

const MAX_AUDIO_SIZE_BYTES: usize = 25 * 1024 * 1024;
const MAX_RECOVERED_TEXT_BYTES: usize = 1024 * 1024;
const MAX_DIAGNOSTIC_LOG_BYTES: u64 = 1_000_000;
const SLOW_RECORDING_STARTUP_MS: u64 = 500;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartupTiming {
  pub recording_number: u64,
  pub uptime_ms: u64,
  pub native_ms: u64,
  pub event_delivery_ms: u64,
  pub preflight_ms: u64,
  pub microphone_ms: u64,
  pub setup_ms: u64,
  pub render_ms: u64,
  pub frontend_ms: u64,
  pub end_to_end_ms: u64,
}

/// Audio-capture diagnostics from the input-prompt window. `detail` is a
/// preformatted `key=value` tail rather than typed fields because the probe is
/// a moving target; it is sanitized below so a device name coming from the OS
/// can never inject newlines or unbounded text into the persistent log.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProbeReport {
  pub session_id: u64,
  pub stage: AudioProbeStage,
  pub detail: String,
  #[serde(default)]
  pub slow: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AudioProbeStage {
  Capture,
  Chunk,
  Onset,
  Envelope,
  Prime,
}

impl AudioProbeStage {
  fn as_str(&self) -> &'static str {
    match self {
      Self::Capture => "audio-capture",
      Self::Chunk => "audio-chunk",
      Self::Onset => "audio-onset",
      Self::Envelope => "audio-envelope",
      Self::Prime => "audio-prime",
    }
  }
}

const MAX_AUDIO_PROBE_DETAIL_CHARS: usize = 512;

fn sanitize_audio_probe_detail(detail: &str) -> String {
  detail
    .chars()
    .filter(|c| !c.is_control())
    .take(MAX_AUDIO_PROBE_DETAIL_CHARS)
    .collect()
}

// Fixed labels and numeric metadata only: the renderer cannot accidentally
// send transcript content or an arbitrary error string into persistent logs.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranscriptionPhase {
  Capture,
  RecorderStop,
  Finalize,
  Resample,
  ChunkIpc,
  History,
  Insert,
  Recovery,
  Session,
}

impl TranscriptionPhase {
  fn as_str(&self) -> &'static str {
    match self {
      Self::Capture => "capture",
      Self::RecorderStop => "recorder-stop",
      Self::Finalize => "finalize",
      Self::Resample => "resample",
      Self::ChunkIpc => "chunk-ipc",
      Self::History => "history",
      Self::Insert => "insert",
      Self::Recovery => "recovery",
      Self::Session => "session",
    }
  }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranscriptionEvent {
  Start,
  Complete,
  Timeout,
  Cancel,
  Error,
  Fallback,
  Late,
}

impl TranscriptionEvent {
  fn as_str(&self) -> &'static str {
    match self {
      Self::Start => "start",
      Self::Complete => "complete",
      Self::Timeout => "timeout",
      Self::Cancel => "cancel",
      Self::Error => "error",
      Self::Fallback => "fallback",
      Self::Late => "late",
    }
  }

  fn is_warning(&self) -> bool {
    matches!(self, Self::Timeout | Self::Error | Self::Fallback)
  }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionLifecycleReport {
  pub session_id: u64,
  pub phase: TranscriptionPhase,
  pub event: TranscriptionEvent,
  pub elapsed_ms: u64,
  pub chunk_index: Option<u32>,
  pub pending_count: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoveredTranscription {
  pub id: String,
  pub text: String,
  pub kind: history::RecoveryKind,
}

fn valid_stable_recovery_id(id: &str, prefix: &str) -> bool {
  id.len() <= 128 && id.strip_prefix(prefix).is_some_and(|suffix| {
    suffix.split('-').count() >= 2
      && suffix.split('-').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
  })
}

fn validate_recovered_transcription(
  window_label: &str,
  recovery: &RecoveredTranscription,
) -> Result<(), String> {
  if window_label != "input-prompt" {
    return Err("recovered transcriptions are only accepted from input-prompt".into());
  }
  if !valid_stable_recovery_id(&recovery.id, "recovery-") {
    return Err("invalid recovery id".into());
  }
  if recovery.text.trim().is_empty() {
    return Err("recovered text is empty".into());
  }
  if recovery.text.len() > MAX_RECOVERED_TEXT_BYTES {
    return Err("recovered text exceeds the size limit".into());
  }
  Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLog {
  pub content: String,
  pub size_bytes: u64,
  pub modified_at_unix_ms: u64,
  pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityStatus {
  pub granted: bool,
  pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneStatus {
  pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeTextResponse {
  pub success: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub method: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub message: Option<String>,
  #[serde(default)]
  pub skipped_no_text: bool,
}

#[tauri::command]
pub fn get_settings() -> Result<SettingsPayload, String> {
  log::info!("command:get_settings");
  settings::read_config()
    .map(|config| SettingsPayload::from_config(&config))
    .map_err(stringify_error)
}

fn read_diagnostic_log_file(path: &Path) -> Result<DiagnosticLog, String> {
  let mut file = match File::open(path) {
    Ok(file) => file,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
      return Ok(DiagnosticLog {
        content: String::new(),
        size_bytes: 0,
        modified_at_unix_ms: 0,
        truncated: false,
      });
    }
    Err(error) => return Err(stringify_error(error)),
  };
  let metadata = file.metadata().map_err(stringify_error)?;
  let size_bytes = metadata.len();
  let truncated = size_bytes > MAX_DIAGNOSTIC_LOG_BYTES;
  let start = size_bytes.saturating_sub(MAX_DIAGNOSTIC_LOG_BYTES);
  file.seek(SeekFrom::Start(start)).map_err(stringify_error)?;

  let mut bytes = Vec::with_capacity((size_bytes - start) as usize);
  (&mut file)
    .take(MAX_DIAGNOSTIC_LOG_BYTES)
    .read_to_end(&mut bytes)
    .map_err(stringify_error)?;
  if truncated {
    let first_complete_line = bytes
      .iter()
      .position(|byte| *byte == b'\n')
      .map(|index| index + 1)
      .unwrap_or(bytes.len());
    bytes.drain(..first_complete_line);
  }

  let modified_at_unix_ms = metadata
    .modified()
    .ok()
    .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
    .and_then(|duration| duration.as_millis().try_into().ok())
    .unwrap_or(0);

  Ok(DiagnosticLog {
    content: String::from_utf8_lossy(&bytes).into_owned(),
    size_bytes,
    modified_at_unix_ms,
    truncated,
  })
}

#[tauri::command]
pub fn get_diagnostic_log(
  window: tauri::WebviewWindow,
  app: AppHandle,
) -> Result<DiagnosticLog, String> {
  if window.label() != "main" {
    return Err("diagnostic logs are only available to the main Settings page".into());
  }
  let path = app
    .path()
    .app_log_dir()
    .map_err(stringify_error)?
    .join("TypeAloud.log");
  read_diagnostic_log_file(&path)
}

#[tauri::command]
pub fn report_recording_startup(
  window: tauri::WebviewWindow,
  timing: RecordingStartupTiming,
) -> Result<(), String> {
  if window.label() != "input-prompt" {
    return Err("recording startup timing is only accepted from input-prompt".into());
  }

  if timing.end_to_end_ms >= SLOW_RECORDING_STARTUP_MS {
    log::warn!(
      "recording-startup:slow number={} uptime_ms={} native_ms={} delivery_ms={} preflight_ms={} microphone_ms={} setup_ms={} render_ms={} frontend_ms={} end_to_end_ms={}",
      timing.recording_number,
      timing.uptime_ms,
      timing.native_ms,
      timing.event_delivery_ms,
      timing.preflight_ms,
      timing.microphone_ms,
      timing.setup_ms,
      timing.render_ms,
      timing.frontend_ms,
      timing.end_to_end_ms
    );
  } else {
    log::info!(
      "recording-startup:ready number={} uptime_ms={} native_ms={} delivery_ms={} preflight_ms={} microphone_ms={} setup_ms={} render_ms={} frontend_ms={} end_to_end_ms={}",
      timing.recording_number,
      timing.uptime_ms,
      timing.native_ms,
      timing.event_delivery_ms,
      timing.preflight_ms,
      timing.microphone_ms,
      timing.setup_ms,
      timing.render_ms,
      timing.frontend_ms,
      timing.end_to_end_ms
    );
  }
  Ok(())
}

#[tauri::command]
pub fn report_audio_probe(
  window: tauri::WebviewWindow,
  report: AudioProbeReport,
) -> Result<(), String> {
  if window.label() != "input-prompt" {
    return Err("audio probe reports are only accepted from input-prompt".into());
  }
  // typealoud_lifecycle is kept at INFO in release builds, unlike typealoud_lib::*,
  // so these lines survive in a packaged build the way the other frontend
  // lifecycle lines do. ":slow" additionally makes the bad case greppable.
  let level = if report.slow { log::Level::Warn } else { log::Level::Info };
  log::log!(
    target: "typealoud_lifecycle",
    level,
    "{}{} session_id={} {}",
    report.stage.as_str(),
    if report.slow { ":slow" } else { "" },
    report.session_id,
    sanitize_audio_probe_detail(&report.detail)
  );
  Ok(())
}

/// Verification only: capture briefly through CoreAudio and report the level
/// envelope, so the native path can be checked inside the real app process
/// (its microphone grant, its threads) before any of the pipeline moves over.
#[tauri::command]
pub async fn probe_native_capture(seconds: f64) -> Result<String, String> {
  let seconds = seconds.clamp(1.0, 15.0);
  log::info!(target: "typealoud_lifecycle", "native-capture entered seconds={seconds}");
  tokio::task::spawn_blocking(move || crate::native_capture::probe_capture(seconds))
    .await
    .map_err(stringify_error)?
    .map(|(device, rate, pcm)| {
      let resampled = crate::native_capture::resample_to_target(&pcm, rate);
      let env = crate::native_capture::envelope_db(
        &resampled,
        crate::native_capture::TARGET_RATE as f64,
        500.0,
      );
      let peak = pcm.iter().fold(0.0f32, |acc, v| acc.max(v.abs()));
      let summary = format!(
        "device={} in_rate={} in_samples={} out_samples={} peak={:.4} env_db={}",
        device.replace(char::is_whitespace, "_"),
        rate,
        pcm.len(),
        resampled.len(),
        peak,
        env.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(",")
      );
      log::info!(target: "typealoud_lifecycle", "native-capture {summary}");
      summary
    })
    .map_err(|error| {
      let message = stringify_error(error);
      log::warn!(target: "typealoud_lifecycle", "native-capture failed: {message}");
      message
    })
}

/// Start one per-dictation CoreAudio stream on macOS. PCM16LE blocks are sent
/// over a raw Tauri channel so the renderer receives ArrayBuffers rather than
/// JSON number arrays. The command resolves only after the device is live.
#[tauri::command]
pub async fn start_native_capture(
  window: tauri::WebviewWindow,
  state: State<'_, crate::native_capture::NativeCaptureState>,
  session_id: u64,
  microphone: String,
  on_audio: Channel<InvokeResponseBody>,
) -> Result<crate::native_capture::NativeCaptureInfo, crate::native_capture::NativeCaptureError> {
  if window.label() != "input-prompt" {
    return Err(crate::native_capture::NativeCaptureError::failed(
      "native capture is only available to input-prompt",
    ));
  }
  log::info!(
    target: "typealoud_lifecycle",
    "native-capture start session_id={session_id}"
  );
  let capture_state = state.inner().clone();
  tokio::task::spawn_blocking(move || {
    crate::native_capture::start_capture(&capture_state, session_id, microphone, on_audio)
  })
  .await
  .map_err(|error| crate::native_capture::NativeCaptureError::failed(stringify_error(error)))?
  .map_err(crate::native_capture::NativeCaptureError::from)
}

/// Stop exactly the requested recording and wait until its final PCM block has
/// been queued on the channel. Session matching prevents a stale frontend stop
/// from tearing down a newer recording.
#[tauri::command]
pub async fn stop_native_capture(
  window: tauri::WebviewWindow,
  state: State<'_, crate::native_capture::NativeCaptureState>,
  session_id: u64,
) -> Result<crate::native_capture::NativeCaptureStats, crate::native_capture::NativeCaptureError> {
  if window.label() != "input-prompt" {
    return Err(crate::native_capture::NativeCaptureError::failed(
      "native capture is only available to input-prompt",
    ));
  }
  let capture_state = state.inner().clone();
  let stats = tokio::task::spawn_blocking(move || {
    crate::native_capture::stop_capture(&capture_state, session_id)
  })
  .await
  .map_err(|error| crate::native_capture::NativeCaptureError::failed(stringify_error(error)))?
  .map_err(crate::native_capture::NativeCaptureError::from)?;
  log::info!(
    target: "typealoud_lifecycle",
    "native-capture stopped session_id={} input_samples={} output_samples={} peak={:.4} clipped={} channel_failures={}",
    stats.session_id,
    stats.input_samples,
    stats.output_samples,
    stats.peak,
    stats.clipped_samples,
    stats.channel_send_failures
  );
  Ok(stats)
}

fn qwen_prewarm_eligible(config: &AppConfig) -> bool {
  config.provider == crate::local_asr::LOCAL_PROVIDER
    && crate::local_asr::normalize_local_model_id(&config.model)
      != crate::local_asr::NEMOTRON_MODEL_ID
}

#[tauri::command]
pub fn report_transcription_lifecycle(
  window: tauri::WebviewWindow,
  report: TranscriptionLifecycleReport,
) -> Result<(), String> {
  if window.label() != "input-prompt" {
    return Err("transcription lifecycle reports are only accepted from input-prompt".into());
  }
  let level = if report.event.is_warning() { log::Level::Warn } else { log::Level::Info };
  log::log!(
    target: "typealoud_lifecycle",
    level,
    "frontend session_id={} phase={} event={} elapsed_ms={} chunk_index={:?} pending_count={:?}",
    report.session_id,
    report.phase.as_str(),
    report.event.as_str(),
    report.elapsed_ms,
    report.chunk_index,
    report.pending_count
  );
  // The session phase ends exactly once per hotkey recording.
  if matches!(report.phase, TranscriptionPhase::Session) {
    match report.event {
      TranscriptionEvent::Complete => crate::usage::record_dictation(true),
      TranscriptionEvent::Error => crate::usage::record_dictation(false),
      _ => {}
    }
  }
  Ok(())
}

#[tauri::command]
pub async fn prewarm_qwen_worker(
  window: tauri::WebviewWindow,
  session_id: u64,
) -> Result<bool, String> {
  if window.label() != "input-prompt" {
    return Err("Qwen prewarm is only accepted from input-prompt".into());
  }

  let model = settings::read_config().map_err(stringify_error)?.model;
  let outcome = crate::local_asr::prewarm_resident_worker_for(&model, session_id, || {
    settings::read_config().map(|config| {
      qwen_prewarm_eligible(&config)
        && crate::local_asr::normalize_local_model_id(&config.model)
          == crate::local_asr::normalize_local_model_id(&model)
    })
  })
  .await
  .map_err(|error| {
    log::warn!("command:prewarm_qwen_worker outcome=error error={error:#}");
    stringify_error(error)
  })?;
  log::info!("command:prewarm_qwen_worker outcome={outcome:?}");
  Ok(outcome.is_ready())
}

#[tauri::command]
pub fn finish_qwen_worker_session(
  window: tauri::WebviewWindow,
  session_id: u64,
) -> Result<bool, String> {
  if window.label() != "input-prompt" {
    return Err("Qwen worker sessions may only be finished from input-prompt".into());
  }
  Ok(crate::local_asr::finish_resident_session(session_id))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeys {
  pub api_key: String,
  pub api_key_groq: String,
  #[serde(rename = "apiKeyOpenAI")]
  pub api_key_openai: String,
}

// The raw API keys stay out of get_settings. The main window is the only
// editor now that Settings is one of its pages; input-prompt and auxiliary
// windows remain blocked by the label check below.
#[tauri::command]
pub fn get_api_keys(window: tauri::WebviewWindow) -> Result<ApiKeys, String> {
  if window.label() != "main" {
    return Err("get_api_keys is only available to the main Settings page".into());
  }
  let config = settings::read_config().map_err(stringify_error)?;
  Ok(ApiKeys {
    api_key: config.api_key,
    api_key_groq: config.api_key_groq,
    api_key_openai: config.api_key_openai,
  })
}

#[tauri::command]
pub fn save_settings(
  app: AppHandle,
  settings_input: AppConfig,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  log::info!(
    "command:save_settings provider={} shortcut={} ui_theme={}",
    settings_input.provider,
    settings_input.shortcut,
    settings_input.ui_theme
  );
  let mut usage_stats_turned_off = false;
  let config = settings::mutate_config(|existing| {
    let previous_auto_launch = existing.auto_launch;
    let mut config = settings_input;
    config.dictionary = existing.dictionary.clone();
    // Like dictionary: the settings form never carries this flag, and a missing
    // field deserializes to false — without this line every settings save would
    // re-trigger the onboarding wizard.
    config.onboarding_completed = existing.onboarding_completed;
    // Not a form field either; remember_qwen_model updates it after this save.
    config.qwen_model = existing.qwen_model.clone();
    // Hand-set development flag with no form field.
    config.debug_save_audio = existing.debug_save_audio;
    config.shortcut = settings::normalize_record_shortcut(&config.shortcut);
    config.nemotron_latency_ms =
      settings::normalize_nemotron_latency_ms(config.nemotron_latency_ms);
    config.local_compute = settings::normalize_local_compute(&config.local_compute).into();
    if config.provider == crate::local_asr::LOCAL_PROVIDER {
      config.model = crate::local_asr::normalize_local_model_id(&config.model).into();
    }
    if config.provider == crate::local_asr::LOCAL_PROVIDER {
      // The form's key fields are hidden for the local provider; keep the stored
      // legacy key instead of clobbering it with the (empty) local selection.
      config.api_key = existing.api_key.clone();
    } else {
      config.api_key = settings::selected_api_key(&config);
    }
    // Apply the login item before committing the matching config value. A
    // launchctl failure now leaves the previous config intact instead of
    // requiring a second compensating write.
    if settings::auto_launch_needs_update(previous_auto_launch, config.auto_launch) {
      settings::update_auto_launch(config.auto_launch)?;
    }
    usage_stats_turned_off = existing.usage_stats && !config.usage_stats;
    *existing = config;
    Ok(())
  })
  .map_err(stringify_error)?;
  if usage_stats_turned_off {
    crate::usage::delete_local_data();
  }

  if let Some(handle) = state.hotkey.lock().unwrap().as_ref() {
    handle.update_shortcut(config.shortcut.clone());
  }

  broadcast_settings_updates(&app, &config).map_err(stringify_error)?;
  sync_local_runtime(&app, &config);
  Ok(true)
}

// Marks the first-launch onboarding wizard as done (finished or skipped). A
// dedicated read-modify-write command keeps the wizard independent from the
// full Settings form and its secret fields.
#[tauri::command]
pub fn set_onboarding_completed() -> Result<bool, String> {
  log::info!("command:set_onboarding_completed");
  let mut first_time = false;
  settings::mutate_config(|config| {
    first_time = !config.onboarding_completed;
    config.onboarding_completed = true;
    Ok(())
  })
  .map_err(stringify_error)?;
  // Help replays the wizard on finished installs; only the first pass counts.
  if first_time {
    crate::usage::record_onboarding_completed();
  }
  Ok(true)
}

// The switch on the onboarding privacy page. Settings saves the same field
// through save_settings.
#[tauri::command]
pub fn set_usage_stats(enabled: bool) -> Result<bool, String> {
  log::info!("command:set_usage_stats enabled={enabled}");
  settings::mutate_config(|config| {
    config.usage_stats = enabled;
    Ok(())
  })
  .map_err(stringify_error)?;
  if !enabled {
    crate::usage::delete_local_data();
  }
  Ok(true)
}

#[tauri::command]
pub fn record_onboarding_step(step: String) -> Result<(), String> {
  crate::usage::record_onboarding_step(&step)
}

#[tauri::command]
pub fn get_usage_preview() -> serde_json::Value {
  crate::usage::preview()
}

// Onboarding page 5: set the provider + its API key without round-tripping the
// full config (keys flow INTO Rust only, never out to the main window). When
// the provider actually changes, the model is reset to that provider's default
// — otherwise a fresh config would send the OpenAI default model name to Groq.
#[tauri::command]
pub fn save_onboarding_api_key(
  app: AppHandle,
  provider: String,
  api_key: String,
) -> Result<bool, String> {
  log::info!("command:save_onboarding_api_key provider={provider}");
  let key = api_key.trim().to_string();
  if key.is_empty() {
    return Err("API key is empty".into());
  }

  let config = settings::mutate_config(|config| {
    match provider.as_str() {
      "groq" => config.api_key_groq = key,
      "openai" => config.api_key_openai = key,
      other => anyhow::bail!("Unknown provider: {other}"),
    }
    switch_provider(config, &provider);
    // Re-derive even when the provider didn't change: the key for the already
    // selected provider may have just been (re)entered.
    config.api_key = settings::selected_api_key(config);
    Ok(())
  })
  .map_err(stringify_error)?;
  broadcast_settings_updates(&app, &config).map_err(stringify_error)?;
  Ok(true)
}

/// The model a provider lands on when it's newly selected: its recommended
/// default (same table the settings UI marks "recommended").
fn default_model_for(provider: &str) -> &'static str {
  match provider {
    "groq" => "whisper-large-v3-turbo",
    crate::local_asr::LOCAL_PROVIDER => crate::local_asr::QWEN_MODEL_ID,
    _ => "gpt-transcribe",
  }
}

/// Point `config` at `provider`, resetting the model to that provider's
/// default. Everything else (keys, dictionary, shortcuts, onboarding flag)
/// is preserved; the legacy `api_key` mirror is left alone for "local" (no
/// key to mirror — clobbering it would lose the stored cloud key).
fn switch_provider(config: &mut AppConfig, provider: &str) {
  if config.provider == provider {
    return;
  }
  config.provider = provider.to_string();
  config.model = if provider == crate::local_asr::LOCAL_PROVIDER {
    settings::preferred_qwen_model(config).into()
  } else {
    default_model_for(provider).into()
  };
  if provider != crate::local_asr::LOCAL_PROVIDER {
    config.api_key = settings::selected_api_key(config);
  }
}

/// Engine quick-switch core, shared by the tray submenu (direct call) and the
/// `set_provider` command (home-page switcher / wizard). Persists the selection
/// independently of downloaded assets and broadcasts so every window's badges — and
/// the tray checkmarks — update live.
pub fn apply_provider_change(app: &AppHandle, provider: &str) -> Result<(), String> {
  if !matches!(
    provider,
    "groq" | "openai" | crate::local_asr::LOCAL_PROVIDER
  ) {
    return Err(format!("Unknown provider: {provider}"));
  }
  let config = settings::mutate_config(|config| {
    switch_provider(config, provider);
    Ok(())
  })
  .map_err(stringify_error)?;
  broadcast_settings_updates(app, &config).map_err(stringify_error)?;
  sync_local_runtime(app, &config);
  Ok(())
}

pub(crate) fn sync_local_runtime(app: &AppHandle, config: &AppConfig) {
  crate::local_asr::set_compute_preference(&config.local_compute);
  let selected = crate::local_asr::normalize_local_model_id(&config.model);
  crate::local_asr::sync_selected_model(selected);
  if config.provider == crate::local_asr::LOCAL_PROVIDER
    && selected == crate::local_asr::NEMOTRON_MODEL_ID
  {
    crate::local_asr::shutdown_resident_worker();
    let app = app.clone();
    let latency_ms = config.nemotron_latency_ms;
    tauri::async_runtime::spawn(async move {
      if let Err(error) = crate::nemotron_asr::prewarm(latency_ms).await {
        log::warn!("nemotron: prewarm failed: {error:#}");
        let _ = app.emit(
          "local-runtime-error",
          json!({
            "model": crate::local_asr::NEMOTRON_MODEL_ID,
            "message": error.to_string(),
          }),
        );
      }
    });
  } else {
    crate::nemotron_asr::shutdown();
    if config.provider != crate::local_asr::LOCAL_PROVIDER {
      crate::local_asr::shutdown_resident_worker();
    }
  }
}

#[tauri::command]
pub fn set_provider(app: AppHandle, provider: String) -> Result<bool, String> {
  log::info!("command:set_provider provider={provider}");
  apply_provider_change(&app, &provider)?;
  Ok(true)
}

#[tauri::command]
pub fn set_local_model(app: AppHandle, model: String) -> Result<bool, String> {
  apply_local_model_change(&app, &model)?;
  Ok(true)
}

pub fn apply_local_model_change(app: &AppHandle, model: &str) -> Result<(), String> {
  let model = crate::local_asr::normalize_local_model_id(model);
  let config = settings::mutate_config(|config| {
    config.provider = crate::local_asr::LOCAL_PROVIDER.into();
    config.model = model.into();
    Ok(())
  })
  .map_err(stringify_error)?;
  broadcast_settings_updates(app, &config).map_err(stringify_error)?;
  sync_local_runtime(app, &config);
  Ok(())
}

pub(crate) fn show_main_settings(app: &AppHandle, target: &str) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("main") {
    window.show().map_err(stringify_error)?;
    window.unminimize().map_err(stringify_error)?;
    window.set_focus().map_err(stringify_error)?;
  }
  app.emit_to("main", "open-settings-page", target)
    .map_err(stringify_error)
}

// Every "local isn't downloaded yet" guide (tray submenu, home switcher)
// funnels here: show the main Settings page and reveal the model panel.
#[tauri::command]
pub fn open_local_model_panel(app: AppHandle, model: Option<String>) -> Result<(), String> {
  let model = model
    .as_deref()
    .map(crate::local_asr::normalize_local_model_id)
    .unwrap_or(crate::local_asr::QWEN_MODEL_ID);
  log::info!("command:open_local_model_panel model={model}");
  show_local_model_panel(&app, model)
}

pub fn show_local_model_panel(app: &AppHandle, model: &str) -> Result<(), String> {
  let model = crate::local_asr::normalize_local_model_id(model);
  show_main_settings(app, &format!("local-model:{model}"))
}

#[tauri::command]
pub fn get_app_version() -> String {
  env!("CARGO_PKG_VERSION").into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
  pub version: String,
  /// "official" only when CI set TYPEALOUD_OFFICIAL_BUILD at compile time
  /// (see build.rs); any local build is "dev".
  pub channel: String,
  pub build_number: u64,
  pub git_hash: String,
  pub git_dirty: bool,
  /// Unix seconds; the frontend formats it.
  pub build_time: u64,
  pub debug: bool,
}

#[tauri::command]
pub fn get_build_info() -> BuildInfo {
  BuildInfo {
    version: env!("CARGO_PKG_VERSION").into(),
    channel: env!("TYPEALOUD_BUILD_CHANNEL").into(),
    build_number: env!("TYPEALOUD_BUILD_NUMBER").parse().unwrap_or(0),
    git_hash: env!("TYPEALOUD_GIT_HASH").into(),
    git_dirty: env!("TYPEALOUD_GIT_DIRTY") == "true",
    build_time: env!("TYPEALOUD_BUILD_TIME").parse().unwrap_or(0),
    debug: cfg!(debug_assertions),
  }
}

pub fn open_settings(app: AppHandle) -> Result<(), String> {
  log::info!("command:open_settings");
  show_main_settings(&app, "dictation")
}

/// The input prompt ended a locked (hands-free) recording without the hotkey:
/// its startup failed or its capture was interrupted. Releasing the lock lets
/// the next press start a recording instead of stopping one that is gone.
#[tauri::command]
pub fn release_recording_lock(lock_id: u64, state: State<'_, AppState>) {
  if let Some(handle) = state.hotkey.lock().unwrap().as_ref() {
    handle.release_lock(lock_id);
  }
}

/// Whether the calling window has a native glass backdrop (see `glass.rs`).
#[tauri::command]
pub fn get_native_glass(window: tauri::WebviewWindow) -> bool {
  crate::glass::has_native_backdrop(window.label())
}

/// The prompt page's glass surfaces, reported whenever one moves, resizes or fades.
#[tauri::command]
pub fn set_glass_regions(
  window: tauri::WebviewWindow,
  regions: Vec<crate::glass::GlassRegion>,
) -> Result<(), String> {
  crate::glass::set_regions(&window, regions)
}

/// Matches the calling window's glass to the app theme.
#[tauri::command]
pub fn set_glass_appearance(window: tauri::WebviewWindow, dark: bool) -> Result<(), String> {
  crate::glass::set_appearance(&window, dark)
}

#[tauri::command]
pub fn hide_input_prompt(app: AppHandle) -> Result<(), String> {
  let _ = app.emit_to("input-prompt", "cleanup-microphone", ());
  if let Some(window) = app.get_webview_window("input-prompt") {
    window.hide().map_err(stringify_error)?;
  }
  Ok(())
}

#[tauri::command]
pub fn cleanup_microphone(app: AppHandle) -> Result<bool, String> {
  let _ = app.emit_to("input-prompt", "cleanup-microphone", ());
  Ok(true)
}

fn cancel_active_transcriptions(
  active: &HashMap<u64, ActiveTranscription>,
  session_id: Option<u64>,
) -> bool {
  let mut cancelled = false;
  for transcription in active.values() {
    if session_id.is_some() && transcription.session_id != session_id {
      continue;
    }
    transcription.cancellation.cancel();
    cancelled = true;
  }
  cancelled
}

#[tauri::command]
pub fn cancel_transcription(
  state: State<'_, AppState>,
  session_id: Option<u64>,
) -> Result<bool, String> {
  let active = state.active_transcriptions.lock().unwrap();
  let cancelled = cancel_active_transcriptions(&active, session_id);
  Ok(cancelled)
}

/// Removes its entry from `active_transcriptions` when dropped, so the
/// bookkeeping survives every exit path — normal return, `?`, a panic inside
/// the transcription future, or the command future being dropped. Without it a
/// panicking request would leave its stale token in the map forever, making
/// cancel_transcription report "cancelled something" on an idle app.
struct ActiveTranscriptionGuard<'a> {
  map: &'a Mutex<HashMap<u64, ActiveTranscription>>,
  id: u64,
}

impl Drop for ActiveTranscriptionGuard<'_> {
  fn drop(&mut self) {
    // Skip cleanup on a poisoned lock rather than double-panic during unwind.
    if let Ok(mut map) = self.map.lock() {
      map.remove(&self.id);
    }
  }
}

// Called only when the whole result is ready, including assembled dictations
// and manual History retries. Formatting is shared by persistence and insertion.
fn prepare_final_transcription(raw: &str) -> String {
  let (options, dictionary) = match settings::read_config() {
    Ok(config) => (
      crate::scrub::FinalTextOptions {
        remove_fillers: config.remove_filler_words,
        merge_spelled_letters: config.merge_spelled_letters,
      },
      config.dictionary,
    ),
    Err(error) => {
      // Optional formatting must not discard a completed transcription or
      // guess that a user who disabled a setting wants it enabled again.
      log::warn!("could not read final text settings; skipping optional formatting: {error:#}");
      (crate::scrub::FinalTextOptions { remove_fillers: false, merge_spelled_letters: false }, String::new())
    }
  };
  // The user's rules run after the built-in cleanup, so they also see merged
  // letters and can override a built-in correction. Term matching comes last
  // and leaves a rule's wanted spelling alone, because that spelling is a term.
  let text = crate::scrub::finalize_transcription(raw, options);
  let text = crate::dictionary::apply_replacements(&text, &crate::dictionary::replacements(&dictionary));
  crate::terms::Terms::new(&crate::dictionary::terms(&dictionary)).correct(&text)
}

fn record_successful_transcription(
  app: &AppHandle,
  raw: &str,
  failure_id: Option<&str>,
  audio_for_debug: Option<(Vec<u8>, String)>,
) -> String {
  let text = prepare_final_transcription(raw);
  if text != raw {
    log::info!(
      "transcribe: postprocessed final text ({} -> {} chars)",
      raw.chars().count(),
      text.chars().count()
    );
  }
  if text.trim().is_empty() {
    if let Some(id) = failure_id {
      if let Err(error) = history::finish_pending_transcription(id, &text) {
        log::warn!("failed to record empty retry result: {error:#}");
      }
      let _ = app.emit("activity-updated", ());
    }
    return text;
  }
  // Resolve a prior failure or append the success in one locked History write.
  let mut debug_entry_id = None;
  let saved = history::record_transcription(&text, failure_id, || {
    let entry = activity_entry(&text, true, None);
    debug_entry_id = entry["id"].as_str().map(str::to_owned);
    entry
  });
  match saved {
    Ok(dropped) => {
      if let (Some(id), Some((audio, mime))) = (debug_entry_id, audio_for_debug) {
        if let Err(error) = history::attach_debug_audio(&id, &audio, &mime) {
          log::warn!("failed to attach debug audio: {error:#}");
        }
      }
      for id in dropped {
        let _ = history::delete_debug_audio(&id);
      }
    }
    Err(error) => log::warn!("failed to record transcription in history: {error:#}"),
  }
  let _ = app.emit("activity-updated", ());
  text
}

/// History for a chunked local dictation: the frontend concatenates the chunk
/// transcripts and records the result here, exactly once. Returns the formatted
/// text so the inserted string and the history row cannot drift apart, matching
/// what transcribe_audio returns on the unchunked path.
#[tauri::command]
pub fn record_assembled_transcription(app: AppHandle, text: String) -> String {
  record_successful_transcription(&app, &text, None, None)
}

// Recovery has a strict persistence acknowledgement, unlike the best-effort
// successful-transcription history path. No transcript text is logged here.
#[tauri::command]
pub fn save_recovered_transcription(
  window: tauri::WebviewWindow,
  app: AppHandle,
  recovery: RecoveredTranscription,
) -> Result<String, String> {
  validate_recovered_transcription(window.label(), &recovery)?;
  let saved = history::save_recovered_entry(&recovery.id, &recovery.text, recovery.kind)
    .map_err(stringify_error)?;
  for audio_id in saved.dropped_audio_ids {
    let _ = history::delete_debug_audio(&audio_id);
  }
  let _ = app.emit("activity-updated", ());
  Ok(saved.entry_id)
}

#[tauri::command]
pub async fn start_live_transcription(
  app: AppHandle,
  session_id: u64,
  sample_rate: u32,
) -> Result<bool, String> {
  let config = settings::read_config().map_err(stringify_error)?;
  if config.provider != crate::local_asr::LOCAL_PROVIDER
    || crate::local_asr::normalize_local_model_id(&config.model)
      != crate::local_asr::NEMOTRON_MODEL_ID
  {
    return Err("Nemotron is not the selected local model".into());
  }
  // Read the language from saved settings, like the batch path, so a change in
  // Settings reaches the next live session without restarting the app.
  crate::nemotron_asr::start_live_session(
    app,
    session_id,
    sample_rate,
    config.language.clone(),
    config.nemotron_latency_ms,
  )
  .await?;
  Ok(true)
}

#[tauri::command]
pub async fn push_live_audio(request: tauri::ipc::Request<'_>) -> Result<bool, String> {
  let bytes = match request.body() {
    tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
    tauri::ipc::InvokeBody::Json(_) => {
      return Err("push_live_audio expects a raw PCM16 body".into());
    }
  };
  let session_id = request
    .headers()
    .get("session-id")
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.parse::<u64>().ok())
    .ok_or_else(|| "push_live_audio requires a session id".to_string())?;
  crate::nemotron_asr::push_live_audio(session_id, bytes).await?;
  Ok(true)
}

#[tauri::command]
pub async fn finish_live_transcription(
  app: AppHandle,
  session_id: u64,
  capture_incomplete: Option<bool>,
) -> Result<String, String> {
  let raw = crate::nemotron_asr::finish_live_session(session_id).await?;
  if capture_incomplete.unwrap_or(false) {
    // The frontend persists partial text through the acknowledged recovery path.
    return Ok(crate::scrub::scrub_transcription(&raw));
  }
  // Nemotron's live session has no retried upload behind it, so no row to resolve.
  Ok(record_successful_transcription(&app, &raw, None, None))
}

#[tauri::command]
pub async fn cancel_live_transcription(session_id: u64) -> Result<bool, String> {
  Ok(crate::nemotron_asr::cancel_live_session(session_id).await)
}

fn scrub_transcription_with_chunk_diagnostics(raw: &str) -> (String, String) {
  let text = crate::scrub::scrub_transcription(raw);
  // Keep result content out of the persistent diagnostic log, including when
  // a legitimate empty result or the existing scrubber produces no text.
  let detail = format!(
    "raw_chars={} final_chars={} empty={}",
    raw.chars().count(),
    text.chars().count(),
    text.is_empty(),
  );
  (text, detail)
}

#[tauri::command]
pub async fn transcribe_audio(
  app: AppHandle,
  state: State<'_, AppState>,
  request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
  // The audio arrives as the raw IPC body (Tauri's octet-stream fast path), not
  // a JSON number array — see ipc-bridge.js (tauriRawBody). mime_type and the
  // session fields ride along as headers. NOTE: this requires input-prompt.html's CSP
  // to allow `ipc:` on macOS/Linux and `http://ipc.localhost` on Windows.
  // Without it Tauri falls back to the postMessage transport, which JSON-encodes
  // the bytes → body() is Json, not Raw → the error below.
  let audio_buffer: Vec<u8> = match request.body() {
    tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
    tauri::ipc::InvokeBody::Json(_) => {
      return Err("transcribe_audio expects a raw audio body".into());
    }
  };
  let headers = request.headers();
  let capture_incomplete = headers
    .get("capture-incomplete")
    .and_then(|value| value.to_str().ok())
    .map(|value| value == "true")
    .unwrap_or(false);
  let session_provider = headers.get("session-provider")
    .and_then(|value| value.to_str().ok()).unwrap_or("");
  let mime = headers
    .get("mime-type")
    .and_then(|value| value.to_str().ok())
    .filter(|value| !value.is_empty())
    .unwrap_or("audio/webm")
    .to_string();
  let session_id = headers
    .get("session-id")
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.parse::<u64>().ok());
  // Present only on the chunked local path: one dictation arrives as an ordered
  // series of chunks that decode while the user is still speaking.
  let chunk_index = headers
    .get("chunk-index")
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.parse::<u32>().ok());
  // Stable across the frontend's automatic retry of a timed-out upload, so both
  // attempts of one recording land on one History row (transcribeWithRetry).
  // Rejected unless well-formed: the id becomes a filename in the audio store
  // and a History row id. A rejected or absent id just means a fresh row.
  let failure_id = headers
    .get("failure-id")
    .and_then(|value| value.to_str().ok())
    .filter(|value| valid_stable_recovery_id(value, "failed-"))
    .map(str::to_owned);

  if audio_buffer.is_empty() {
    return Err("Audio buffer is empty".into());
  }
  if audio_buffer.len() > MAX_AUDIO_SIZE_BYTES {
    return Err(format!(
      "Audio too large: {} bytes (max {})",
      audio_buffer.len(),
      MAX_AUDIO_SIZE_BYTES
    ));
  }

  if let Some(chunk_index) = chunk_index {
    log::info!(
      target: "typealoud_lifecycle",
      "audio-chunk:received session_id={} chunk_index={chunk_index} bytes={}",
      session_id.map_or_else(|| "none".to_owned(), |id| id.to_string()),
      audio_buffer.len(),
    );
  }

  // A missing key is the archetypal recoverable failure — the user adds one and
  // re-transcribes. Route resolution runs before any request is built, so
  // returning straight out of it would drop the clip the retry needs. Guards
  // match the failure arm below: the frontend owns recovery for chunked and
  // local capture-incomplete sessions.
  let frontend_owns_recovery = frontend_owns_audio_recovery(
    session_provider, chunk_index, capture_incomplete,
  );
  let route_result: Result<_, String> = (|| {
    let provider = validate_session_provider(session_provider)?;
    let config = settings::read_config().map_err(|error| {
      log::warn!("transcription could not read settings: {error:#}");
      RetryError::SettingsRead.code().to_owned()
    })?;
    let route = resolve_transcription_route_for(provider, &config)?;
    Ok((transcription_config_for_provider(&config, provider), route, config.debug_save_audio))
  })();
  let (config, route) = match route_result {
    Ok((config, route, archive)) => {
      if crate::recording_archive::enabled(archive) {
        crate::recording_archive::save(session_id, chunk_index, audio_buffer.clone(), mime.clone());
      }
      (config, route)
    }
    Err(error) => {
      if !frontend_owns_recovery {
        record_failed_transcription(
          &app,
          failure_id.as_deref(),
          &error,
          &audio_buffer,
          &mime,
        );
      }
      return Err(error);
    }
  };

  let request_id = state.next_transcription_id.fetch_add(1, Ordering::Relaxed) + 1;
  let cancellation = CancellationToken::new();
  state
    .active_transcriptions
    .lock()
    .unwrap()
    .insert(
      request_id,
      ActiveTranscription {
        session_id,
        cancellation: cancellation.clone(),
      },
    );
  let active_transcription = ActiveTranscriptionGuard {
    map: &state.active_transcriptions,
    id: request_id,
  };

  // Keep bytes only when this command owns recovery. A
  // failed transcription is re-runnable from History, so this copy is kept in
  // release too — unlike the dev-only playback copy the success arm attaches.
  let audio_for_recovery = (!frontend_owns_recovery).then(|| audio_buffer.clone());

  let result = tokio::select! {
    _ = cancellation.cancelled() => Err(anyhow::anyhow!("TRANSCRIPTION_CANCELLED")),
    result = async {
      match &route {
        TranscriptionRoute::Local => {
          perform_local_transcription(&app, &config, audio_buffer, &mime, session_id, chunk_index)
            .await
        }
        TranscriptionRoute::Cloud { provider, api_key } => {
          perform_transcription_request(
            &state.http_client,
            &config,
            provider,
            api_key,
            audio_buffer,
            mime.clone(),
          ).await
        }
      }
    } => result,
  };

  drop(active_transcription);

  match result {
    // A chunked local dictation decodes as several transcribe_audio calls, so
    // history is written once by record_assembled_transcription after the
    // frontend joins the chunks -- otherwise a five-minute dictation would leave
    // a row (and, in dev, a debug-audio copy) per chunk. Scrubbing still runs
    // per chunk to filter hallucinations. Letter merging waits for the final
    // assembled result, so a spelling split across chunks remains mergeable.
    // Partial whole clips are also saved through the frontend recovery path.
    Ok(raw) if chunk_index.is_some() || capture_incomplete => {
      let (text, detail) = scrub_transcription_with_chunk_diagnostics(&raw);
      if let Some(chunk_index) = chunk_index {
        log::info!(
          target: "typealoud_lifecycle",
          "audio-chunk:complete session_id={} chunk_index={chunk_index} {detail}",
          session_id.map_or_else(|| "none".to_owned(), |id| id.to_string()),
        );
      }
      if capture_incomplete && !frontend_owns_recovery {
        if let Some(id) = failure_id.as_deref() {
          if let Err(error) = history::refresh_incomplete_retry(id, &text) {
            log::warn!("failed to refresh incomplete retry: {error:#}");
          }
          let _ = app.emit("activity-updated", ());
        }
      }
      Ok(text)
    }
    // Dev-only on the success path: history can play the recording back (for
    // diagnosing first-word drop / quality). Never in release.
    Ok(raw) => Ok(record_successful_transcription(
      &app,
      &raw,
      failure_id.as_deref(),
      audio_for_recovery.filter(|_| cfg!(debug_assertions)).map(|audio| (audio, mime.clone())),
    )),
    Err(error) => {
      if is_cancellation_error(&error) {
        return Err("TRANSCRIPTION_CANCELLED".into());
      }

      // Only local recovery is persisted by the frontend.
      if !frontend_owns_hang_recovery(&error, session_provider) && !frontend_owns_recovery {
        if let Some(audio) = audio_for_recovery.as_deref() {
          record_failed_transcription(
            &app, failure_id.as_deref(), &error.to_string(), audio, &mime,
          );
        } else {
          log::error!("recovery audio missing for a backend-owned failure");
          let message = transcription_failure_message(&error.to_string());
          if let Err(write_error) = append_activity(&message, false, Some(error.to_string())) {
            log::warn!("failed to record transcription error: {write_error:#}");
          }
          let _ = app.emit("activity-updated", ());
        }
      }
      Err(error.to_string())
    }
  }
}

// Shape-only text diagnostics (counts, never content — the "no transcribed
// text in logs" promise holds). `shape` is the same metric computed by the
// sender in JS; a mismatch between the two pins IPC-leg text corruption.
fn text_shape(text: &str) -> String {
  let (mut chars, mut cjk, mut latin1) = (0usize, 0usize, 0usize);
  for c in text.chars() {
    chars += 1;
    let u = c as u32;
    if (0x3000..=0x9FFF).contains(&u) {
      cjk += 1;
    } else if (0x80..=0xFF).contains(&u) {
      latin1 += 1;
    }
  }
  format!("chars={chars} cjk={cjk} latin1sup={latin1}")
}

#[tauri::command]
pub async fn type_text(
  _state: State<'_, AppState>,
  text: String,
  shape: Option<String>,
) -> Result<TypeTextResponse, String> {
  // The shape comparison exists to pin IPC-leg text corruption — only an
  // actual mismatch deserves warn (and thus the shipped log file, which
  // filters at Warn); the routine matching case stays dev-visible at info.
  let rust_shape = text_shape(&text);
  let js_shape = shape.as_deref().unwrap_or("-");
  if js_shape != "-" && js_shape != rust_shape {
    log::warn!("diag:type_text SHAPE MISMATCH rust[{rust_shape}] js[{js_shape}]");
  } else {
    log::info!("diag:type_text rust[{rust_shape}] js[{js_shape}]");
  }
  if text.trim().is_empty() {
    return Ok(TypeTextResponse {
      success: false,
      method: None,
      message: Some("No text to insert.".into()),
      skipped_no_text: true,
    });
  }

  // The whole insert path is blocking work — Accessibility queries plus a
  // paced synthetic-event loop (macOS sleeps ~5ms per 20 chars, so ≈250ms for
  // a 1000-char insert; enigo blocks similarly on Windows/Linux). Hand it to
  // the blocking pool so it never parks an async worker thread. This changes
  // no timing: the pacing is what makes text stream in rather than land at
  // once, and it stays exactly as it was.
  //
  // A panic inside the task degrades to `Failed` rather than propagating an
  // Err: that is the same graceful path as any failed insert, and the
  // transcription is already in History either way.
  let inserted_chars = text.chars().count();
  let outcome = match tokio::task::spawn_blocking(move || platform::insert_text(&text)).await {
    Ok(result) => result,
    Err(join_error) => {
      log::error!("text insertion task failed to run: {join_error}");
      InsertResult::Failed
    }
  };

  if matches!(outcome, InsertResult::Inserted { .. }) {
    crate::usage::record_inserted_chars(inserted_chars);
  }

  // No clipboard fallback by design: every transcription is already saved to
  // history (see transcribe_audio), so a failed insert just points the user
  // there instead of overwriting their clipboard. The per-OS mechanism lives
  // behind `platform::insert_text`; this maps its outcome to the response.
  Ok(match outcome {
    InsertResult::Inserted { method } => TypeTextResponse {
      success: true,
      method: Some(method.into()),
      message: Some("Text inserted directly.".into()),
      skipped_no_text: false,
    },
    InsertResult::NoEditableTarget => TypeTextResponse {
      success: false,
      method: None,
      message: Some("No editable text field is focused.".into()),
      skipped_no_text: false,
    },
    InsertResult::Failed => TypeTextResponse {
      success: false,
      method: None,
      message: Some("Text insertion failed; copy it from History.".into()),
      skipped_no_text: false,
    },
  })
}

#[tauri::command]
pub fn show_permission_dialog() -> Result<i32, String> {
  platform::open_accessibility_settings();
  Ok(0)
}

// Onboarding: deep link to the Microphone privacy pane, for when the user
// denied the system prompt and needs to flip the toggle manually.
#[tauri::command]
pub fn open_microphone_settings(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
  platform::open_microphone_settings().map_err(stringify_error)?;
  #[cfg(windows)]
  {
    let mut microphone = state.microphone.lock().unwrap();
    if microphone.reset() {
      let _ = app.emit("microphone-status-changed", MicrophoneStatus {
        status: microphone.status().into(),
      });
    }
  }
  #[cfg(not(windows))]
  let _ = (app, state);
  Ok(())
}

// Accessibility recovery: reveal the app bundle in Finder so the user can
// drag it into the Accessibility list — the drop equals clicking "+". Needed
// when the row is absent and the one-shot system prompt won't re-add it
// (typically after the user once removed TypeAloud from the list).
#[tauri::command]
pub fn reveal_app_in_finder() -> Result<(), String> {
  platform::reveal_app_in_finder();
  Ok(())
}

// Open the GitHub release page for a version the updater reported, so the Home
// update card can show what changed. The URL is built here from a validated
// version; the frontend never supplies one.
#[tauri::command]
pub fn open_release_page(version: String) -> Result<(), String> {
  log::info!("command:open_release_page version={version}");
  let url = crate::updater::release_page_url(&version)
    .ok_or_else(|| format!("not a release version: {version}"))?;
  platform::open_url(&url).map_err(stringify_error)
}

// Show the Accessibility drag cloud. Returns whether it was actually shown —
// false on a dev bare binary (no .app bundle), which the frontend uses to
// decide whether it needs to hide it later.
#[tauri::command]
pub fn show_ax_cloud(app: AppHandle) -> bool {
  crate::ax_cloud::show(&app)
}

#[tauri::command]
pub fn hide_ax_cloud(app: AppHandle) {
  crate::ax_cloud::hide(&app);
}

// The user dismissed the drag cloud before granting. Hides it and signals the
// main window to leave the "waiting" state so the guide button reappears.
#[tauri::command]
pub fn dismiss_ax_cloud(app: AppHandle) {
  crate::ax_cloud::dismiss(&app);
}

// Explicit, user-initiated clipboard write, used by the input-prompt's failed
// insertion affordance and Settings' diagnostic-log copy button. The per-OS
// mechanism (pbcopy on macOS) lives behind `platform::copy_to_clipboard`.
// There is still no automatic clipboard touch anywhere.
#[tauri::command]
pub fn copy_to_clipboard(text: String, shape: Option<String>) -> Result<bool, String> {
  log::warn!(
    "diag:copy_to_clipboard rust[{}] js[{}]",
    text_shape(&text),
    shape.as_deref().unwrap_or("-")
  );
  platform::copy_to_clipboard(&text)
    .map(|_| true)
    .map_err(stringify_error)
}

#[tauri::command]
pub fn check_microphone_permission(state: State<'_, AppState>) -> MicrophoneStatus {
  #[cfg(windows)]
  return MicrophoneStatus {
    status: state.microphone.lock().unwrap().status().into(),
  };
  #[cfg(not(windows))]
  let _ = state;
  #[cfg(not(windows))]
  MicrophoneStatus {
    status: platform::microphone_status(),
  }
}

#[tauri::command]
pub fn report_microphone_capture(
  app: AppHandle,
  state: State<'_, AppState>,
  outcome: String,
) -> Result<MicrophoneStatus, String> {
  #[cfg(windows)]
  {
    let mut microphone = state.microphone.lock().unwrap();
    let changed = microphone.report(&outcome)?;
    let status = MicrophoneStatus { status: microphone.status().into() };
    if changed {
      let _ = app.emit("microphone-status-changed", status.clone());
    }
    Ok(status)
  }
  #[cfg(not(windows))]
  {
    let _ = app;
    // Validate the IPC contract without replacing native macOS authorization.
    crate::microphone::CaptureMicrophoneState::default().report(&outcome)?;
    Ok(check_microphone_permission(state))
  }
}

#[tauri::command]
pub fn check_accessibility_permission() -> AccessibilityStatus {
  accessibility_status(false)
}

#[tauri::command]
pub fn request_accessibility_permission(
  app: AppHandle,
  state: State<'_, AppState>,
) -> AccessibilityStatus {
  sync_accessibility_status(app, state, accessibility_status(true))
}

#[tauri::command]
pub fn recheck_accessibility_permission(
  app: AppHandle,
  state: State<'_, AppState>,
) -> AccessibilityStatus {
  sync_accessibility_status(app, state, accessibility_status(false))
}

fn sync_accessibility_status(
  app: AppHandle,
  state: State<'_, AppState>,
  status: AccessibilityStatus,
) -> AccessibilityStatus {
  let mut previous = state.accessibility.lock().unwrap();
  let changed = previous
    .map(|value| value != status.granted)
    .unwrap_or(true);
  let became_granted = previous
    .map(|value| !value && status.granted)
    .unwrap_or(status.granted);
  *previous = Some(status.granted);
  drop(previous);

  if changed {
    let message = if status.granted {
      "Accessibility permission granted! Global hotkeys are now active."
    } else {
      "Accessibility permission revoked. Global hotkeys are disabled."
    };
    let _ = app.emit(
      "accessibility-permission-changed",
      json!({ "granted": status.granted, "message": message }),
    );
  }

  if became_granted {
    if let Some(handle) = state.hotkey.lock().unwrap().as_ref().cloned() {
      hotkey::restart_os_listener(handle);
    }
  }

  status
}

#[tauri::command]
pub fn get_recent_activities() -> Result<Vec<Value>, String> {
  history::read_history_entries().map_err(stringify_error)
}

#[derive(Serialize)]
pub struct DebugAudio {
  pub bytes: Vec<u8>,
  pub mime: String,
}

// Dev-only: return the original recorded audio for a history entry so the UI can
// play it back. Errors if the file is absent (e.g. an entry without audio).
#[tauri::command]
pub fn read_debug_audio(id: String) -> Result<DebugAudio, String> {
  let (bytes, mime) = history::read_debug_audio(&id).map_err(stringify_error)?;
  Ok(DebugAudio { bytes, mime })
}

#[tauri::command]
pub fn delete_history_item(app: AppHandle, id: String) -> Result<bool, String> {
  log::info!("command:delete_history_item id={id}");
  history::delete_history_entry(&id).map_err(stringify_error)?;
  let _ = history::delete_debug_audio(&id);
  let _ = app.emit("activity-updated", ());
  Ok(true)
}

#[tauri::command]
pub fn clear_history(app: AppHandle) -> Result<bool, String> {
  log::info!("command:clear_history");
  history::clear_history_entries().map_err(stringify_error)?;
  let _ = history::clear_debug_audio();
  let _ = app.emit("activity-updated", ());
  Ok(true)
}

#[tauri::command]
pub fn get_dictionary() -> Result<String, String> {
  settings::read_config()
    .map(|config| config.dictionary)
    .map_err(stringify_error)
}

#[tauri::command]
pub fn save_dictionary(text: String) -> Result<bool, String> {
  settings::mutate_config(|config| {
    config.dictionary = text;
    Ok(())
  })
  .map_err(stringify_error)?;
  Ok(true)
}

// --- Local ASR asset management (Settings page) ---

#[tauri::command]
pub async fn download_local_model(
  app: AppHandle,
  state: State<'_, AppState>,
  model: Option<String>,
  switch_when_ready: Option<bool>,
) -> Result<bool, String> {
  let model = crate::local_asr::normalize_local_model_id(model.as_deref().unwrap_or(""));
  let switch_when_ready = switch_when_ready.unwrap_or(false);
  log::info!("command:download_local_model model={model} switch_when_ready={switch_when_ready}");
  // "Download and use it" is a request made against the engine in use now. A
  // different engine chosen while it downloads is the later decision and wins.
  let engine_at_request = settings::read_config().ok().map(|config| (config.provider, config.model));
  let cancel = CancellationToken::new();
  {
    let mut slot = state.local_model_download.lock().unwrap();
    if slot.is_some() {
      return Err("Model download already in progress".into());
    }
    *slot = Some(LocalModelDownload {
      model: model.into(),
      cancellation: cancel.clone(),
    });
  }

  let result = crate::local_asr::download_model_for(model, app.clone(), cancel).await;
  *state.local_model_download.lock().unwrap() = None;

  let status = crate::local_asr::model_status_for(model, false);
  crate::usage::record_model_download(model, match &result {
    Ok(()) => crate::usage::DownloadResult::Ok,
    Err(err) if err == "DOWNLOAD_CANCELLED" => crate::usage::DownloadResult::Cancelled,
    Err(_) => crate::usage::DownloadResult::Error,
  });
  match result {
    Ok(()) => {
      // Switch before announcing "ready", so a window that re-reads settings on
      // that event already sees the new engine.
      if switch_when_ready {
        let engine_now = settings::read_config().ok().map(|config| (config.provider, config.model));
        if engine_unchanged_since_request(&engine_at_request, &engine_now) {
          if let Err(error) = apply_local_model_change(&app, model) {
            log::warn!("command:download_local_model could not switch to {model}: {error}");
          } else {
            log::info!("command:download_local_model switched to {model}");
          }
        } else {
          log::info!("command:download_local_model engine changed during download; not switching");
        }
      }
      let _ = app.emit(
        "local-model-download-progress",
        json!({ "model": model, "state": "ready", "downloadedBytes": status.downloaded_bytes, "totalBytes": status.total_bytes }),
      );
      Ok(true)
    }
    Err(err) if err == "DOWNLOAD_CANCELLED" => {
      let _ = app.emit(
        "local-model-download-progress",
        json!({ "model": model, "state": "cancelled", "downloadedBytes": status.downloaded_bytes, "totalBytes": status.total_bytes }),
      );
      Ok(false)
    }
    Err(err) => {
      let _ = app.emit(
        "local-model-download-progress",
        json!({ "model": model, "state": "error", "downloadedBytes": status.downloaded_bytes, "totalBytes": status.total_bytes, "message": err }),
      );
      Err(err)
    }
  }
}

fn engine_unchanged_since_request(
  at_request: &Option<(String, String)>,
  now: &Option<(String, String)>,
) -> bool {
  at_request.is_some() && at_request == now
}

/// Measured decode speed per local Qwen model (see local_speed.rs).
#[tauri::command]
pub fn get_local_speed() -> std::collections::BTreeMap<String, crate::local_speed::ModelSpeed> {
  crate::local_speed::summary()
}

#[tauri::command]
pub fn cancel_local_model_download(state: State<'_, AppState>) -> Result<bool, String> {
  log::info!("command:cancel_local_model_download");
  if let Some(download) = state.local_model_download.lock().unwrap().as_ref() {
    download.cancellation.cancel();
    return Ok(true);
  }
  Ok(false)
}

/// Status of the optional GPU acceleration pack, including which devices the
/// installed runtime can actually see — an installed pack that lists nothing
/// means this machine has no usable Vulkan device, and the panel says so.
#[tauri::command]
pub async fn get_gpu_runtime_status(
  state: State<'_, AppState>,
) -> Result<crate::local_asr::GpuRuntimeStatus, String> {
  let downloading = state.gpu_runtime_download.lock().unwrap().is_some();
  Ok(crate::local_asr::gpu_runtime_status(downloading).await)
}

#[tauri::command]
pub async fn download_gpu_runtime(
  app: AppHandle,
  state: State<'_, AppState>,
) -> Result<bool, String> {
  log::info!("command:download_gpu_runtime");
  let cancel = CancellationToken::new();
  {
    let mut slot = state.gpu_runtime_download.lock().unwrap();
    if slot.is_some() {
      return Err("GPU runtime download already in progress".into());
    }
    *slot = Some(cancel.clone());
  }

  let result = crate::local_asr::download_gpu_runtime(app.clone(), cancel).await;
  *state.gpu_runtime_download.lock().unwrap() = None;

  let status = crate::local_asr::gpu_runtime_status(false).await;
  let base = json!({
    "downloadedBytes": status.downloaded_bytes,
    "totalBytes": status.size_bytes,
    "devices": status.devices,
  });
  let emit = |state_name: &str, message: Option<String>| {
    let mut payload = base.clone();
    payload["state"] = json!(state_name);
    if let Some(message) = message {
      payload["message"] = json!(message);
    }
    let _ = app.emit("local-gpu-runtime-progress", payload);
  };
  match result {
    Ok(()) => {
      emit("ready", None);
      Ok(true)
    }
    Err(err) if err == "DOWNLOAD_CANCELLED" => {
      emit("cancelled", None);
      Ok(false)
    }
    Err(err) => {
      emit("error", Some(err.clone()));
      Err(err)
    }
  }
}

#[tauri::command]
pub fn cancel_gpu_runtime_download(state: State<'_, AppState>) -> Result<bool, String> {
  log::info!("command:cancel_gpu_runtime_download");
  if let Some(cancel) = state.gpu_runtime_download.lock().unwrap().as_ref() {
    cancel.cancel();
    return Ok(true);
  }
  Ok(false)
}

/// Remove the GPU pack and fall back to CPU. The models and the required CPU
/// runtime stay: this frees 33 MB, not the ~1 GB the engine needs.
#[tauri::command]
pub fn delete_gpu_runtime(app: AppHandle) -> Result<bool, String> {
  log::info!("command:delete_gpu_runtime");
  crate::local_asr::delete_gpu_runtime()?;
  settings::mutate_config(|config| {
    if settings::normalize_local_compute(&config.local_compute) == "gpu" {
      config.local_compute = "auto".into();
    }
    Ok(())
  })
  .map_err(stringify_error)?;
  crate::local_asr::set_compute_preference("auto");
  let _ = app.emit(
    "local-gpu-runtime-progress",
    json!({ "state": "absent", "downloadedBytes": 0, "totalBytes": 0, "devices": [] }),
  );
  Ok(true)
}

#[tauri::command]
pub fn get_local_model_status(
  state: State<'_, AppState>,
  model: Option<String>,
) -> crate::local_asr::ModelStatus {
  let model = crate::local_asr::normalize_local_model_id(model.as_deref().unwrap_or(""));
  let downloading = state
    .local_model_download
    .lock()
    .unwrap()
    .as_ref()
    .is_some_and(|download| download.model == model);
  crate::local_asr::model_status_for(model, downloading)
}

#[tauri::command]
pub fn delete_local_model(
  state: State<'_, AppState>,
  model: Option<String>,
) -> Result<bool, String> {
  let model = crate::local_asr::normalize_local_model_id(model.as_deref().unwrap_or(""));
  log::info!("command:delete_local_model model={model}");
  if state.local_model_download.lock().unwrap().is_some() {
    return Err("Cancel the running download first".into());
  }
  crate::local_asr::delete_model_for(model)?;
  Ok(true)
}

pub fn current_accessibility_granted() -> bool {
  platform::accessibility_granted(false)
}

fn stringify_error<E>(error: E) -> String
where
  E: std::fmt::Display,
{
  error.to_string()
}

fn broadcast_settings_updates(app: &AppHandle, config: &AppConfig) -> Result<()> {
  app.emit(
    "shortcut-updated",
    json!({
      "recordShortcut": config.shortcut,
      // Piggyback provider+model so the input-prompt's model badge updates live
      // on save without a dedicated event (non-secret, unlike the API keys).
      "provider": config.provider,
      "model": config.model,
    }),
  )?;
  app.emit(
    "ui-language-updated",
    json!({ "language": config.ui_language }),
  )?;
  app.emit("ui-theme-updated", json!({ "theme": config.ui_theme }))?;
  // The tray's Engine checkmarks mirror config.provider; every config write
  // funnels through here, so this keeps them in sync with all three switch
  // surfaces (settings form, tray, home switcher/wizard).
  crate::tray::refresh_menu(app);
  Ok(())
}

// Pure construction: debug-audio persistence must stay outside the History lock.
fn activity_entry(text: &str, success: bool, error: Option<String>) -> Value {
  json!({
    "id": history::next_entry_id(),
    "text": text,
    "timestamp": Utc::now().to_rfc3339(),
    "success": success,
    "error": error,
  })
}

fn append_activity(text: &str, success: bool, error: Option<String>) -> Result<()> {
  let entry = activity_entry(text, success, error);
  for aid in history::append_entry(entry)? {
    let _ = history::delete_debug_audio(&aid);
  }
  Ok(())
}

// Logs a failed transcription as ONE re-transcribable History row that holds
// both the reason and the clip, so the user can re-run it once the cause (a
// missing key, a dead network, a model that would not load) is fixed. Falls
// back to a text-only row when the clip cannot be stored: a failure the user
// cannot see at all is worse than one they cannot retry.
#[allow(clippy::too_many_arguments)]
fn record_failed_transcription(
  app: &AppHandle,
  failure_id: Option<&str>,
  error: &str,
  audio: &[u8],
  mime: &str,
) {
  let message = transcription_failure_message(error);
  match history::append_failed_audio(failure_id, &message, error, audio, mime) {
    Ok(saved) => {
      for audio_id in saved.dropped_audio_ids {
        let _ = history::delete_debug_audio(&audio_id);
      }
    }
    Err(audio_error) => {
      log::warn!("failed to keep the clip for re-transcription: {audio_error:#}");
      // Best-effort: surface the original API error to the user, not a
      // secondary history-write error.
      if let Err(err) = append_activity(&message, false, Some(error.to_owned())) {
        log::warn!("failed to record failed transcription in history: {err:#}");
      }
    }
  }
  let _ = app.emit("activity-updated", ());
}

fn transcription_failure_message(error: &str) -> String {
  format!("Transcription failed: {error}")
}

// Re-records why a stored clip still has no text, after EVERY failure that gets
// past loading its row — a missing key, an unreadable format and a dead network
// all reach the user through this one path. A row left blaming a cause the user
// has since fixed is worse than no reason at all, and the toast alone does not
// survive closing the window. `retryable` is false only when nothing is left to
// re-run (the clip itself is gone), in which case the row also stops offering a
// retry that could only fail the same way. Returns the reason, so callers read
// `return Err(refresh_failed_row(...))`.
fn refresh_failed_row(
  app: &AppHandle,
  id: &str,
  failure: RetryFailure<'_>,
  retryable: bool,
) -> String {
  let (message, error) = match failure {
    RetryFailure::BuiltIn(error) => (error.code().to_owned(), error.code()),
    RetryFailure::Engine(error) => (transcription_failure_message(error), error),
  };
  if let Err(write_error) = history::refresh_pending_failure(
    id, &message, error, retryable,
  ) {
    log::warn!("failed to refresh the reason on history entry {id}: {write_error:#}");
  }
  let _ = app.emit("activity-updated", ());
  error.to_owned()
}

// Persists a failed clip's audio and records a single "pending" history entry
// pointing at it, so the user can re-transcribe it later. Unlike append_activity's
// debug-only capture, this runs in release — it is the recovery store for a
// give-up after the frontend's auto-retry. The audio write MUST succeed (a
// pending entry with no audio is useless), so its error propagates. Returns the
// new entry id.
fn append_pending_audio(bytes: &[u8], mime: &str) -> Result<String> {
  let id = history::next_entry_id();
  history::write_debug_audio(&id, bytes, mime)?;
  let entry = json!({
    "id": id,
    "text": "",
    "timestamp": Utc::now().to_rfc3339(),
    "success": false,
    "error": null,
    "pending": true,
    "audioId": id,
    "audioMime": mime,
  });
  // Serialized read-modify-write; drop the audio files of entries falling off
  // the History cap so the store can't grow unbounded.
  for aid in history::append_entry(entry)? {
    let _ = history::delete_debug_audio(&aid);
  }
  Ok(id)
}

// Saves a clip whose transcription hung and could not be recovered by the
// frontend's auto-retry, as a re-transcribable "pending" history entry. The
// audio arrives as the raw IPC body (same octet-stream path as transcribe_audio);
// `mime-type` rides along as a header. Returns the new entry id.
#[tauri::command]
pub async fn save_pending_transcription(
  window: tauri::WebviewWindow,
  app: AppHandle,
  request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
  let audio: Vec<u8> = match request.body() {
    tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
    tauri::ipc::InvokeBody::Json(_) => {
      return Err("save_pending_transcription expects a raw audio body".into());
    }
  };
  if audio.is_empty() {
    return Err("Audio buffer is empty".into());
  }
  let mime = request
    .headers()
    .get("mime-type")
    .and_then(|value| value.to_str().ok())
    .filter(|value| !value.is_empty())
    .unwrap_or("audio/wav")
    .to_string();

  let recovery_id = request.headers().get("recovery-id")
    .map(|value| value.to_str().map(str::to_owned))
    .transpose().map_err(|_| "invalid pending recovery id".to_string())?;
  let id = if let Some(recovery_id) = recovery_id {
    if window.label() != "input-prompt" {
      return Err("pending recovery is only accepted from input-prompt".into());
    }
    if !valid_stable_recovery_id(&recovery_id, "pending-") {
      return Err("invalid pending recovery id".into());
    }
    if audio.len() > MAX_AUDIO_SIZE_BYTES {
      return Err("pending recovery audio exceeds the size limit".into());
    }
    let saved = history::save_pending_audio(&recovery_id, &audio, &mime)
      .map_err(stringify_error)?;
    for audio_id in saved.dropped_audio_ids {
      let _ = history::delete_debug_audio(&audio_id);
    }
    saved.entry_id
  } else {
    append_pending_audio(&audio, &mime).map_err(stringify_error)?
  };
  let _ = app.emit("activity-updated", ());
  Ok(id)
}

// Re-runs transcription on a stored pending clip, through whichever engine is
// configured NOW rather than the one that failed: the usual reason a clip is
// sitting here is a missing key, a dead network or an absent model, so the retry
// belongs on the settings the user has just fixed. Pinning the row to its
// original provider would instead lock the clip to the thing that broke. On
// success the entry becomes
// a normal text entry in place (position preserved) and its audio is deleted; on
// failure the entry stays pending, its recorded reason refreshed, so the user can
// try again (a re-hang is bounded by the same watchdog).
#[tauri::command]
pub async fn retranscribe_pending(
  app: AppHandle,
  state: State<'_, AppState>,
  id: String,
) -> Result<String, String> {
  let entry = history::read_history_entry(&id)
    .map_err(|error| {
      log::warn!("re-transcribe could not read History: {error:#}");
      RetryError::HistoryRead.code().to_owned()
    })?
    .ok_or_else(|| RetryError::EntryMissing.code().to_string())?;
  if entry["pending"] != true {
    return Err(RetryError::NotPending.code().into());
  }
  let (bytes, mime) = match history::read_debug_audio(&id) {
    Ok(audio) => audio,
    Err(error) => {
      log::warn!("re-transcribe could not read stored clip for {id}: {error:#}");
      let missing = error.downcast_ref::<std::io::Error>()
        .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound);
      let reason = if missing {
        RetryError::AudioMissing
      } else {
        RetryError::AudioRead
      };
      return Err(refresh_failed_row(
        &app,
        &id,
        RetryFailure::BuiltIn(reason),
        !missing,
      ));
    }
  };
  let config = match settings::read_config() {
    Ok(config) => config,
    Err(error) => {
      log::warn!("re-transcribe could not read settings: {error:#}");
      return Err(refresh_failed_row(&app, &id, RetryFailure::BuiltIn(RetryError::SettingsRead), true))
    }
  };
  let route = match resolve_transcription_route(&config) {
    Ok(route) => route,
    Err(error) => return Err(refresh_failed_row(&app, &id, RetryFailure::Engine(&error), true)),
  };
  // Name the setting to change instead of letting mtmd's decoder fail on a
  // container it cannot read. Only reachable on Windows/Linux — macOS captures
  // WAV natively, so its clips always suit the local engine.
  if matches!(route, TranscriptionRoute::Local) && !mime.contains("wav") {
    return Err(refresh_failed_row(
      &app,
      &id,
      RetryFailure::BuiltIn(RetryError::AudioFormat),
      true,
    ));
  }

  let result = match &route {
    TranscriptionRoute::Local => {
      perform_local_transcription(&app, &config, bytes, &mime, None, None).await
    }
    TranscriptionRoute::Cloud { provider, api_key } => {
      perform_transcription_request(
        &state.http_client,
        &config,
        provider,
        api_key,
        bytes,
        mime.clone(),
      )
      .await
    }
  };
  let raw = match result {
    Ok(raw) => raw,
    Err(error) => {
      return Err(refresh_failed_row(&app, &id, RetryFailure::Engine(&error.to_string()), true))
    }
  };
  let text = prepare_final_transcription(&raw);

  if !history::finish_pending_transcription(&id, &text).map_err(|error| {
    log::warn!("failed to save retry result: {error:#}");
    RetryError::ResultSave.code().to_owned()
  })? {
    return Err(RetryError::NotPending.code().into());
  }
  let _ = app.emit("activity-updated", ());
  Ok(text)
}

// A strong, richly-punctuated Chinese example appended to the transcription
// `prompt` — but ONLY for Whisper + Chinese (see `build_transcription_prompt`).
//
// Whisper-family models treat the `prompt` as a *style example*, NOT an
// instruction: they mirror its punctuation density rather than obeying "add
// punctuation". Verified on real audio (2026-07-02) — with no prompt, or an
// unpunctuated word-list dictionary, Groq `whisper-large-v3-turbo` returns a
// wall of text with ZERO punctuation for Chinese; prepend this seed and
// punctuation comes back reliably and deterministically (a hard clip went
// 0 → 12 marks, identical across repeated runs). It says "简体中文" to pin
// Simplified output, and must stay multi-sentence carrying all four marks
// (。，？！): a one-liner lost to the user's comma-list dictionary on the hard
// clip, while this held.
//
// Chinese-ONLY on purpose. Whisper's zero-punctuation collapse is a CJK/Chinese
// trait; high-resource languages punctuate acceptably on their own, and
// gpt-4o-transcribe punctuates everywhere by default. Injecting an unverified,
// possibly wrong-script seed into another language could only hurt — so every
// non-Chinese language (and every GPT-family model) gets no seed at all.
//
// "GPT-family" is matched as the `gpt-` prefix, not the literal `gpt-4o`: the
// seed exists to patch a Whisper decoding trait, so a newer OpenAI model must
// default to *no* seed rather than inherit an unverified prompt. That is how
// `gpt-transcribe` (added 2026-09) is covered without re-measuring it.
//
// NOTE: this literal is mirrored in `src/views/main.html` (`#punctuation-seed`,
// in the Dictionary page) for the read-only display — keep the two in sync.
pub const SEED_ZH: &str =
  "以下是一段简体中文语音的转写记录。你好，欢迎使用听写工具。今天的会议进展如何？太好了，我们继续！";

fn is_chinese(language: &str) -> bool {
  language.trim().to_lowercase().starts_with("zh")
}

/// Build the transcription `prompt` from the resolved model, the dictation
/// language, and the user's vocabulary dictionary.
///
/// A punctuation seed is added only for **Whisper + Chinese**: it's appended
/// LAST, closest to the audio, where Whisper weights style most heavily
/// (verified: seed-last beats seed-first), and is injected even with an empty
/// dictionary. Every other case — a GPT-family model (already punctuates) or
/// any non-Chinese language — passes the dictionary through unchanged, or sends
/// no prompt at all when the dictionary is empty.
fn build_transcription_prompt(model: &str, language: &str, dictionary: &str) -> Option<String> {
  let dict = dictionary.trim();
  let seed_chinese = !model.to_lowercase().starts_with("gpt-") && is_chinese(language);
  if seed_chinese {
    if dict.is_empty() {
      Some(SEED_ZH.to_string())
    } else {
      Some(format!("{dict}\n{SEED_ZH}"))
    }
  } else if dict.is_empty() {
    None
  } else {
    Some(dict.to_string())
  }
}

fn frontend_owns_audio_recovery(
  provider: &str, chunk_index: Option<u32>, capture_incomplete: bool,
) -> bool {
  chunk_index.is_some()
    || (capture_incomplete && provider == crate::local_asr::LOCAL_PROVIDER)
}

#[derive(Debug)]
pub enum TranscriptionRoute {
  Local,
  Cloud {
    provider: &'static str,
    api_key: String,
  },
}

pub const SESSION_PROVIDER_INVALID: &str = "SESSION_PROVIDER_INVALID";

fn validate_session_provider(provider: &str) -> Result<&'static str, String> {
  match provider {
    "local" => Ok("local"),
    "groq" => Ok("groq"),
    "openai" => Ok("openai"),
    _ => Err(SESSION_PROVIDER_INVALID.into()),
  }
}

/// A recording pins the provider, not the model. If Settings has switched to
/// another provider, its model and legacy key mirror no longer belong to this
/// recording. Use the pinned provider's default model and provider-specific key.
fn transcription_config_for_provider(config: &AppConfig, provider: &str) -> AppConfig {
  let mut session_config = config.clone();
  if config.provider != provider {
    session_config.provider = provider.into();
    session_config.model = default_model_for(provider).into();
    session_config.api_key.clear();
  }
  session_config
}

/// Decide where this transcription goes: the local engine stays on the device,
/// a cloud provider uses its own key.
pub fn resolve_transcription_route(config: &AppConfig) -> Result<TranscriptionRoute, String> {
  resolve_transcription_route_for(&config.provider, config)
}

pub fn resolve_transcription_route_for(
  provider: &str,
  config: &AppConfig,
) -> Result<TranscriptionRoute, String> {
  let provider = validate_session_provider(provider)?;
  if provider == crate::local_asr::LOCAL_PROVIDER {
    return Ok(TranscriptionRoute::Local);
  }
  let api_key = settings::selected_api_key(&transcription_config_for_provider(config, provider));
  if api_key.trim().is_empty() {
    return Err("API key not configured".into());
  }
  Ok(TranscriptionRoute::Cloud { provider, api_key })
}

/// Local decode: hand the (frontend-guaranteed) WAV to the subprocess runner.
/// Lives inside the caller's tokio::select! — dropping this future kills the
/// child process (kill_on_drop), so cancel truly aborts the decode. `app` is
/// only used to stream partial transcript text to the input-prompt window.
/// llama.cpp's mtmd decoder reads WAV via miniaudio and cannot handle AAC/m4a,
/// so the frontend re-encodes to 16 kHz mono WAV for the local route. A
/// non-WAV mime arriving here means that contract broke upstream — fail loudly
/// rather than handing the decoder bytes it will choke on.
fn ensure_wav_mime(mime_type: &str) -> Result<()> {
  if !mime_type.contains("wav") {
    return Err(anyhow::anyhow!(
      "local transcription expects WAV audio, got {mime_type} (frontend must re-encode)"
    ));
  }
  Ok(())
}

async fn perform_local_transcription(
  app: &AppHandle,
  config: &AppConfig,
  audio_buffer: Vec<u8>,
  mime_type: &str,
  session_id: Option<u64>,
  chunk_index: Option<u32>,
) -> Result<String> {
  ensure_wav_mime(mime_type)?;
  let result = if crate::local_asr::normalize_local_model_id(&config.model)
    == crate::local_asr::NEMOTRON_MODEL_ID
  {
    crate::nemotron_asr::transcribe_wav(
      audio_buffer,
      &config.language,
      config.nemotron_latency_ms,
    )
    .await
  } else {
    crate::local_asr::transcribe_wav_for(&config.model, Some(app), session_id, chunk_index, &audio_buffer).await
  };
  result.map_err(normalize_local_transcription_error)
}

fn normalize_local_transcription_error(err: anyhow::Error) -> anyhow::Error {
  if err.to_string().starts_with("LOCAL_MODEL_MISSING") {
    anyhow::anyhow!("LOCAL_MODEL_MISSING: Local model files are missing — download the model again in Settings.")
  } else {
    err
  }
}

async fn perform_transcription_request(
  client: &reqwest::Client,
  config: &AppConfig,
  provider: &str,
  api_key: &str,
  audio_buffer: Vec<u8>,
  mime_type: String,
) -> Result<String> {
  let endpoint_root = if provider == "groq" {
    "https://api.groq.com/openai/v1"
  } else {
    "https://api.openai.com/v1"
  };
  let endpoint = format!("{endpoint_root}/audio/transcriptions");
  let model = if config.model.trim().is_empty() {
    if provider == "groq" {
      "whisper-large-v3-turbo".to_string()
    } else {
      "gpt-transcribe".to_string()
    }
  } else {
    config.model.clone()
  };

  let extension = if mime_type.contains("mp4") {
    "m4a"
  } else if mime_type.contains("wav") {
    "wav"
  } else {
    "webm"
  };
  let file_part =
    reqwest::multipart::Part::bytes(audio_buffer).file_name(format!("audio.{extension}"));

  let mut form = reqwest::multipart::Form::new()
    .part("file", file_part)
    .text("model", model.clone())
    .text("response_format", "text");

  if config.language != "auto" && !config.language.trim().is_empty() {
    form = form.text("language", config.language.clone());
  }
  if let Some(prompt) =
    build_transcription_prompt(&model, &config.language, &crate::dictionary::prompt_terms(&config.dictionary))
  {
    form = form.text("prompt", prompt);
  }

  // Diagnostic: record which model ACTUALLY hits the API. No API key or
  // transcribed text is logged (see the log setup note in lib.rs).
  log::info!(
    "transcribe: model={model} provider={provider} language={}",
    config.language
  );

  let response = client
    .post(endpoint)
    .bearer_auth(api_key)
    .multipart(form)
    .send()
    .await
    .context("failed to send transcription request")?;

  if !response.status().is_success() {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    return Err(anyhow::anyhow!("API error {status}: {body}"));
  }

  let text = response
    .text()
    .await
    .context("failed to read transcription response")?;
  Ok(text.trim().to_string())
}

fn is_cancellation_error(error: &anyhow::Error) -> bool {
  error.to_string().contains("TRANSCRIPTION_CANCELLED")
}

// Whether a transcription failure is a hang/timeout — the local watchdog aborts
// a wedged decode with a "treating as hung" message, and the hard cap reports
// "timed out". The frontend auto-retries these. Keep in sync with
// isRetryableTranscriptionError in input-prompt.js. Whether that retry ends in
// the frontend recording the failure is a further question — see
// frontend_owns_hang_recovery, and do NOT gate history logging on this alone.
fn is_hang_error(error: &anyhow::Error) -> bool {
  let message = error.to_string();
  message.contains("treating as hung") || message.contains("timed out")
}

/// Whether the frontend, not `transcribe_audio`, records this failure.
///
/// A session captured with the local provider is auto-retried; on final give-up
/// saves a single "pending audio" entry (`save_pending_transcription`); a row per
/// attempt here would double-log one recording. That hand-off is local-only —
/// the frontend's recovery gate requires `provider === "local"` — use its
/// recording-start snapshot even if Settings changed during capture.
/// A cloud-origin session that times out is nobody else's to record and must be
/// kept here like any other failure, or it would vanish from History entirely.
fn frontend_owns_hang_recovery(error: &anyhow::Error, recovery_provider: &str) -> bool {
  is_hang_error(error) && recovery_provider == crate::local_asr::LOCAL_PROVIDER
}

fn accessibility_status(prompt: bool) -> AccessibilityStatus {
  if platform::accessibility_required() {
    let granted = platform::accessibility_granted(prompt);
    AccessibilityStatus {
      granted,
      status: if granted {
        "granted".into()
      } else {
        "denied".into()
      },
    }
  } else {
    AccessibilityStatus {
      granted: true,
      status: "not_required".into(),
    }
  }
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<crate::updater::UpdateStatus, String> {
  log::info!("command:check_for_updates");
  Ok(crate::updater::check_and_download(&app).await)
}

#[tauri::command]
pub fn get_update_status(app: AppHandle) -> crate::updater::UpdateStatus {
  crate::updater::current_status(&app)
}

#[tauri::command]
pub fn install_update_and_restart(app: AppHandle) -> Result<(), String> {
  log::info!("command:install_update_and_restart");
  crate::updater::install_pending_and_restart(&app)
}

#[cfg(test)]
mod tests {
  #[test]
  fn incomplete_audio_recovery_matches_the_frontend_persistence_gate() {
    for provider in ["local", "groq", "openai"] {
      assert_eq!(frontend_owns_audio_recovery(provider, None, true), provider == "local");
      assert!(!frontend_owns_audio_recovery(provider, None, false));
      assert!(frontend_owns_audio_recovery(provider, Some(0), true));
    }
  }

  #[test]
  fn audio_probe_detail_drops_control_characters_and_caps_length() {
    // A device label comes from the OS, so a newline in it must not be able to
    // forge a second log line.
    assert_eq!(
      sanitize_audio_probe_detail("device=Mic\nlevel=WARN forged"),
      "device=Miclevel=WARN forged"
    );
    let long = "x".repeat(MAX_AUDIO_PROBE_DETAIL_CHARS + 50);
    assert_eq!(
      sanitize_audio_probe_detail(&long).chars().count(),
      MAX_AUDIO_PROBE_DETAIL_CHARS
    );
  }

  #[test]
  fn audio_probe_stage_labels_match_the_log_grep() {
    assert_eq!(AudioProbeStage::Capture.as_str(), "audio-capture");
    assert_eq!(AudioProbeStage::Chunk.as_str(), "audio-chunk");
    assert_eq!(AudioProbeStage::Onset.as_str(), "audio-onset");
    assert_eq!(AudioProbeStage::Envelope.as_str(), "audio-envelope");
    assert_eq!(AudioProbeStage::Prime.as_str(), "audio-prime");
  }

  #[test]
  fn audio_probe_accepts_chunk_accounting_reports() {
    let report: AudioProbeReport = serde_json::from_value(json!({
      "sessionId": 17,
      "stage": "chunk",
      "detail": "event=finalize received_samples=1200000 enqueued_samples=1200000",
    })).unwrap();
    assert_eq!(report.stage.as_str(), "audio-chunk");
    assert_eq!(report.session_id, 17);
    assert!(!report.slow);
  }

  #[test]
  fn chunk_result_diagnostics_keep_text_private_and_count_characters() {
    let raw = "secret caf\u{00e9} \u{1f680}";
    let (text, detail) = scrub_transcription_with_chunk_diagnostics(raw);
    assert_eq!(text, raw);
    assert_eq!(detail, "raw_chars=13 final_chars=13 empty=false");
    assert!(!detail.contains("secret"));
    assert!(!detail.contains("caf"));
    assert!(!detail.contains('\u{1f680}'));
  }

  #[test]
  fn chunk_result_diagnostics_preserve_legitimate_empty_results() {
    for raw in ["", " \n\t "] {
      let (text, detail) = scrub_transcription_with_chunk_diagnostics(raw);
      assert_eq!(text, "");
      assert_eq!(detail, format!(
        "raw_chars={} final_chars=0 empty=true", raw.chars().count(),
      ));
    }
  }

  #[test]
  fn chunk_result_diagnostics_distinguish_scrubbed_empty_from_raw_empty() {
    let (text, detail) = scrub_transcription_with_chunk_diagnostics(SEED_ZH);
    assert_eq!(text, "");
    assert_eq!(detail, format!(
      "raw_chars={} final_chars=0 empty=true", SEED_ZH.chars().count(),
    ));
    assert!(!detail.contains(SEED_ZH));
  }

  use super::*;

  #[test]
  fn recovered_transcription_requires_known_schema_and_valid_payload() {
    let mut recovery: RecoveredTranscription = serde_json::from_value(json!({
      "id": "recovery-1788040000000-23", "text": "kept words", "kind": "incomplete",
    })).unwrap();
    assert!(validate_recovered_transcription("input-prompt", &recovery).is_ok());
    assert!(validate_recovered_transcription("main", &recovery).is_err());
    for id in ["", "ordinary-id", "recovery-", "recovery-100--1", "recovery-100-../1"] {
      recovery.id = id.into();
      assert!(validate_recovered_transcription("input-prompt", &recovery).is_err());
    }
    recovery.id = "recovery-100-1".into();
    recovery.text = " \n\t ".into();
    assert!(validate_recovered_transcription("input-prompt", &recovery).is_err());
    recovery.text = "x".repeat(MAX_RECOVERED_TEXT_BYTES + 1);
    assert!(validate_recovered_transcription("input-prompt", &recovery).is_err());
    recovery.text = "x".repeat(MAX_RECOVERED_TEXT_BYTES);
    assert!(validate_recovered_transcription("input-prompt", &recovery).is_ok());
    for invalid in [
      json!({"id": "recovery-100-1", "text": "words", "kind": "unknown"}),
      json!({"id": "recovery-100-1", "text": "words", "kind": "incomplete", "extra": true}),
      json!({"id": "recovery-100-1", "text": "words"}),
      json!({"id": 1, "text": "words", "kind": "insert-failed"}),
    ] {
      assert!(serde_json::from_value::<RecoveredTranscription>(invalid).is_err());
    }
  }

  #[test]
  fn pending_audio_recovery_id_validation_rejects_paths_and_other_id_kinds() {
    assert!(valid_stable_recovery_id("pending-1788040000000-23", "pending-"));
    for id in ["pending-", "pending-100", "pending-100--1", "pending-100-../1", "recovery-100-1"] {
      assert!(!valid_stable_recovery_id(id, "pending-"));
    }
    assert!(!valid_stable_recovery_id(&format!("pending-{}-1", "1".repeat(130)), "pending-"));
  }

  #[test]
  fn lifecycle_diagnostics_accept_only_shape_and_known_labels() {
    let report: TranscriptionLifecycleReport = serde_json::from_value(json!({
      "sessionId": 7,
      "phase": "chunk-ipc",
      "event": "timeout",
      "elapsedMs": 450000,
      "chunkIndex": 2,
      "pendingCount": 1
    })).unwrap();
    assert_eq!(report.session_id, 7);
    assert_eq!(report.phase.as_str(), "chunk-ipc");
    assert_eq!(report.event.as_str(), "timeout");
    assert!(report.event.is_warning());
    assert_eq!(report.chunk_index, Some(2));

    for invalid in [
      json!({"sessionId": 7, "phase": "private transcript", "event": "start", "elapsedMs": 0}),
      json!({"sessionId": 7, "phase": "history", "event": "private transcript", "elapsedMs": 0}),
      json!({"sessionId": 7, "phase": "history", "event": "start", "elapsedMs": -1}),
      json!({"sessionId": 7, "phase": "history", "event": "start", "elapsedMs": 0, "text": "private transcript"}),
    ] {
      assert!(serde_json::from_value::<TranscriptionLifecycleReport>(invalid).is_err());
    }
  }

  #[test]
  fn lifecycle_diagnostics_allow_omitted_chunk_metadata() {
    let report: TranscriptionLifecycleReport = serde_json::from_value(json!({
      "sessionId": 9, "phase": "recorder-stop", "event": "complete", "elapsedMs": 20
    })).unwrap();
    assert_eq!(report.chunk_index, None);
    assert_eq!(report.pending_count, None);
    assert!(!report.event.is_warning());
  }

  #[test]
  fn recording_startup_timing_uses_camel_case_wire_fields() {
    let timing = RecordingStartupTiming {
      recording_number: 7,
      uptime_ms: 3_600_000,
      native_ms: 80,
      event_delivery_ms: 300,
      preflight_ms: 10,
      microphone_ms: 150,
      setup_ms: 10,
      render_ms: 10,
      frontend_ms: 180,
      end_to_end_ms: 560,
    };
    let wire = serde_json::to_value(&timing).unwrap();

    assert_eq!(wire["recordingNumber"], 7);
    assert_eq!(wire["eventDeliveryMs"], 300);
    assert_eq!(wire["endToEndMs"], 560);
  }

  #[test]
  fn diagnostic_log_reader_returns_content_and_metadata() {
    let path = std::env::temp_dir().join(format!(
      "typealoud-diagnostic-log-{}-{}.log",
      std::process::id(),
      Utc::now().timestamp_micros()
    ));
    std::fs::write(&path, "first line\nsecond line\n").unwrap();

    let result = read_diagnostic_log_file(&path).unwrap();

    assert_eq!(result.content, "first line\nsecond line\n");
    assert_eq!(result.size_bytes, 23);
    assert!(result.modified_at_unix_ms > 0);
    assert!(!result.truncated);
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn missing_diagnostic_log_is_an_empty_success() {
    let path = std::env::temp_dir().join(format!(
      "typealoud-missing-diagnostic-log-{}-{}.log",
      std::process::id(),
      Utc::now().timestamp_micros()
    ));

    let result = read_diagnostic_log_file(&path).unwrap();

    assert!(result.content.is_empty());
    assert_eq!(result.size_bytes, 0);
    assert_eq!(result.modified_at_unix_ms, 0);
    assert!(!result.truncated);
  }

  // --- Build info: channel fail-safe + wire shape ---

  #[test]
  fn build_info_defaults_to_dev_channel_with_camel_case_fields() {
    // Test builds never set TYPEALOUD_OFFICIAL_BUILD, so build.rs must have
    // embedded the fail-safe "dev" channel.
    let info = get_build_info();
    assert_eq!(info.channel, "dev");
    assert!(!info.version.is_empty());

    let wire = serde_json::to_value(&info).unwrap();
    for field in ["version", "channel", "buildNumber", "gitHash", "gitDirty", "buildTime", "debug"] {
      assert!(wire.get(field).is_some(), "missing wire field {field}");
    }
  }

  // The retry id arrives from the webview and becomes both a History row id and
  // a filename in the audio store, so it is validated, not trusted.
  #[test]
  fn failure_id_validation_rejects_paths_and_other_id_kinds() {
    assert!(valid_stable_recovery_id("failed-1788040000000-23", "failed-"));
    for id in [
      "failed-", "failed-100", "failed-100--1", "failed-100-../1", "failed-/etc/passwd",
      "pending-1788040000000-23", "recovery-100-1", "1788040000000-4",
    ] {
      assert!(!valid_stable_recovery_id(id, "failed-"), "must reject {id}");
    }
    assert!(!valid_stable_recovery_id(&format!("failed-{}-1", "1".repeat(130)), "failed-"));
  }

  // --- Hang classification: gates per-attempt failed-history logging ---

  #[test]
  fn hang_and_timeout_errors_are_classified_as_retryable_hangs() {
    assert!(is_hang_error(&anyhow::anyhow!(
      "local ASR stalled mid-decode (no progress for 20s) — treating as hung"
    )));
    assert!(is_hang_error(&anyhow::anyhow!(
      "local ASR produced no output within 23s for a 82s clip — treating as hung"
    )));
    assert!(is_hang_error(&anyhow::anyhow!("local ASR timed out after 180s")));
    // Deterministic / user errors are not hangs — they still log once.
    assert!(!is_hang_error(&anyhow::anyhow!("api key not configured")));
    assert!(!is_hang_error(&anyhow::anyhow!("TRANSCRIPTION_CANCELLED")));
    assert!(!is_hang_error(&anyhow::anyhow!(
      "Recording is too long for the on-device model (900s)."
    )));
  }

  // The hand-off is local-only: the frontend's recovery gate requires
  // provider === "local", so a cloud timeout has no other recorder and must be
  // kept by transcribe_audio or it disappears from History entirely.
  #[test]
  fn only_a_local_hang_is_handed_to_the_frontend_to_record() {
    let hang = anyhow::anyhow!("local ASR stalled mid-decode — treating as hung");
    let timeout = anyhow::anyhow!("error sending request: operation timed out");
    let refused = anyhow::anyhow!("API key not configured");

    assert!(frontend_owns_hang_recovery(&hang, "local"));
    assert!(frontend_owns_hang_recovery(&timeout, "local"));
    assert!(!frontend_owns_hang_recovery(&timeout, "groq"));
    assert!(!frontend_owns_hang_recovery(&hang, "groq"));
    assert!(!frontend_owns_hang_recovery(&refused, "local"));
    assert!(!frontend_owns_hang_recovery(&refused, "groq"));
    assert!(!frontend_owns_hang_recovery(&timeout, ""));
  }

  // --- Engine switch: model reset + config preservation ---

  #[test]
  fn switch_provider_resets_model_to_the_new_providers_default() {
    let mut config = AppConfig::default(); // openai / gpt-transcribe
    switch_provider(&mut config, "groq");
    assert_eq!(config.provider, "groq");
    assert_eq!(config.model, "whisper-large-v3-turbo");
    switch_provider(&mut config, "local");
    assert_eq!(config.model, "qwen3-asr-0.6b-q8_0");
    switch_provider(&mut config, "openai");
    assert_eq!(config.model, "gpt-transcribe");
  }

  #[test]
  fn switching_back_to_local_returns_to_the_last_qwen_size() {
    let mut config = AppConfig::default();
    config.provider = "local".into();
    config.model = crate::local_asr::QWEN_LARGE_MODEL_ID.into();
    settings::remember_qwen_model(&mut config);
    switch_provider(&mut config, "openai");
    assert_eq!(settings::preferred_qwen_model(&config), crate::local_asr::QWEN_LARGE_MODEL_ID);
    switch_provider(&mut config, "local");
    assert_eq!(config.model, crate::local_asr::QWEN_LARGE_MODEL_ID);
  }

  #[test]
  fn a_requested_switch_applies_only_if_the_engine_is_unchanged() {
    let small = Some(("local".to_string(), crate::local_asr::QWEN_MODEL_ID.to_string()));
    let groq = Some(("groq".to_string(), "whisper-large-v3-turbo".to_string()));
    assert!(engine_unchanged_since_request(&small, &small.clone()));
    assert!(!engine_unchanged_since_request(&small, &groq));
    assert!(!engine_unchanged_since_request(&None, &None));
    assert!(!engine_unchanged_since_request(&small, &None));
  }

  #[test]
  fn switch_provider_same_provider_keeps_custom_model() {
    let mut config = AppConfig::default();
    config.model = "whisper-1".into();
    switch_provider(&mut config, "openai");
    assert_eq!(config.model, "whisper-1");
  }

  #[test]
  fn qwen_prewarm_requires_the_local_qwen_engine() {
    let mut config = AppConfig::default();
    assert!(!qwen_prewarm_eligible(&config));

    config.provider = crate::local_asr::LOCAL_PROVIDER.into();
    config.model = crate::local_asr::QWEN_MODEL_ID.into();
    assert!(qwen_prewarm_eligible(&config));
    config.model = crate::local_asr::QWEN_LARGE_MODEL_ID.into();
    assert!(qwen_prewarm_eligible(&config));

    config.model = crate::local_asr::NEMOTRON_MODEL_ID.into();
    assert!(!qwen_prewarm_eligible(&config));
  }

  #[test]
  fn switch_provider_preserves_keys_and_dictionary() {
    let mut config = AppConfig::default();
    config.api_key_groq = "gsk_x".into();
    config.api_key_openai = "sk_x".into();
    config.api_key = "sk_x".into();
    config.dictionary = "Claude".into();
    config.onboarding_completed = true;

    // → local: the legacy api_key mirror must survive (no key to mirror).
    switch_provider(&mut config, "local");
    assert_eq!(config.api_key, "sk_x");
    assert_eq!(config.api_key_groq, "gsk_x");
    assert_eq!(config.dictionary, "Claude");
    assert!(config.onboarding_completed);

    // → groq: the mirror follows the newly selected provider's key.
    switch_provider(&mut config, "groq");
    assert_eq!(config.api_key, "gsk_x");
    assert_eq!(config.api_key_openai, "sk_x");
  }

  // --- ActiveTranscriptionGuard: cleanup must survive every exit path ---

  #[test]
  fn transcription_guard_removes_its_entry_on_drop() {
    let map = Mutex::new(HashMap::new());
    map.lock().unwrap().insert(7, ActiveTranscription {
      session_id: Some(7),
      cancellation: CancellationToken::new(),
    });
    {
      let _guard = ActiveTranscriptionGuard { map: &map, id: 7 };
    }
    assert!(map.lock().unwrap().is_empty());
  }

  #[test]
  fn transcription_guard_removes_its_entry_during_panic_unwind() {
    // The whole point of the guard: a panic inside the transcription future
    // must not leave a stale token behind.
    let map = Mutex::new(HashMap::new());
    map.lock().unwrap().insert(7, ActiveTranscription {
      session_id: Some(7),
      cancellation: CancellationToken::new(),
    });
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
      let _guard = ActiveTranscriptionGuard { map: &map, id: 7 };
      panic!("simulated transcription panic");
    }));
    assert!(panicked.is_err());
    assert!(map.lock().unwrap().is_empty());
  }

  #[test]
  fn transcription_guard_only_removes_its_own_entry() {
    let map = Mutex::new(HashMap::new());
    map.lock().unwrap().insert(7, ActiveTranscription {
      session_id: Some(7),
      cancellation: CancellationToken::new(),
    });
    map.lock().unwrap().insert(8, ActiveTranscription {
      session_id: Some(8),
      cancellation: CancellationToken::new(),
    });
    drop(ActiveTranscriptionGuard { map: &map, id: 7 });
    let remaining = map.lock().unwrap();
    assert!(!remaining.contains_key(&7));
    assert!(remaining.contains_key(&8));
  }

  #[test]
  fn targeted_cancellation_leaves_other_sessions_running() {
    let first = CancellationToken::new();
    let second = CancellationToken::new();
    let mut active = HashMap::new();
    active.insert(
      1,
      crate::state::ActiveTranscription {
        session_id: Some(10),
        cancellation: first.clone(),
      },
    );
    active.insert(
      2,
      crate::state::ActiveTranscription {
        session_id: Some(11),
        cancellation: second.clone(),
      },
    );

    assert!(cancel_active_transcriptions(&active, Some(11)));
    assert!(!first.is_cancelled());
    assert!(second.is_cancelled());
  }

  // --- Whisper + Chinese: the seed is injected, placed LAST ---

  #[test]
  fn whisper_chinese_empty_dictionary_gets_the_seed() {
    // Bug repro: no prompt at all -> Whisper emits zero punctuation for Chinese,
    // so the seed must be injected even with an empty dictionary.
    let p = build_transcription_prompt("whisper-large-v3-turbo", "zh", "").unwrap();
    assert_eq!(p, SEED_ZH);
    assert!(p.contains('。') && p.contains('？') && p.contains('！'));
  }

  #[test]
  fn whisper_chinese_appends_seed_after_dictionary() {
    // Seed sits LAST (closest to the audio); the vocabulary comes first.
    let dict = "Claude\nAzure";
    let p = build_transcription_prompt("whisper-large-v3-turbo", "zh", dict).unwrap();
    assert_eq!(p, format!("{dict}\n{SEED_ZH}"));
    assert!(p.starts_with(dict) && p.ends_with(SEED_ZH));
    assert!(p.find(SEED_ZH).unwrap() > p.find("Claude").unwrap());
  }

  #[test]
  fn whisper_chinese_trims_dictionary_whitespace() {
    let p = build_transcription_prompt("whisper-large-v3-turbo", "zh", "  \n Claude \n ").unwrap();
    assert_eq!(p, format!("Claude\n{SEED_ZH}"));
  }

  #[test]
  fn chinese_detection_is_case_and_region_insensitive() {
    // Any zh* code counts as Chinese and is seeded. (There is no Traditional
    // option in the app today; a zh-TW user would still get the Simplified seed —
    // an accepted limitation, revisit if Traditional is ever offered.)
    for lang in ["zh", "ZH", "zh-Hans", "zh-CN", "zh-TW"] {
      let p = build_transcription_prompt("whisper-large-v3-turbo", lang, "").unwrap();
      assert_eq!(p, SEED_ZH, "language {lang:?} should be seeded as Chinese");
    }
  }

  // --- Non-Chinese languages: NO seed (dictionary passes through, or nothing) ---

  #[test]
  fn whisper_non_chinese_is_never_seeded() {
    for lang in ["en", "en-AU", "ja", "es", "auto", ""] {
      // empty dictionary -> no prompt at all
      assert_eq!(
        build_transcription_prompt("whisper-large-v3-turbo", lang, ""),
        None,
        "language {lang:?} should send no prompt when the dictionary is empty"
      );
      // non-empty dictionary -> passed through verbatim, never seeded
      let p = build_transcription_prompt("whisper-large-v3-turbo", lang, "Claude").unwrap();
      assert_eq!(p, "Claude", "language {lang:?} must not be seeded");
      assert!(!p.contains(SEED_ZH));
    }
  }

  // --- GPT family: never seeded, even for Chinese (it already punctuates) ---

  #[test]
  fn gpt_family_is_never_seeded_even_for_chinese() {
    for model in ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-transcribe"] {
      assert_eq!(build_transcription_prompt(model, "zh", ""), None);
      assert_eq!(build_transcription_prompt(model, "zh", "   "), None);
      let p = build_transcription_prompt(model, "zh", "Claude\nAzure").unwrap();
      assert_eq!(p, "Claude\nAzure");
      assert!(!p.contains(SEED_ZH) && !p.contains('。'));
    }
  }

  // The rule is the `gpt-` prefix, so the Whisper models — the ones the seed was
  // actually measured on — must keep getting it.
  #[test]
  fn whisper_models_are_still_seeded_for_chinese() {
    for model in ["whisper-1", "whisper-large-v3", "whisper-large-v3-turbo"] {
      assert_eq!(
        build_transcription_prompt(model, "zh", "").unwrap(),
        SEED_ZH,
        "{model} lost the Chinese punctuation seed"
      );
    }
  }

  // --- Transcription routing: local vs cloud ---

  #[test]
  fn unknown_provider_cannot_resolve_a_cloud_route() {
    let mut config = config_with("unexpected", "gsk", "osk");
    config.api_key = "legacy".into();
    assert_eq!(resolve_transcription_route(&config).unwrap_err(), "SESSION_PROVIDER_INVALID");
  }

  #[test]
  fn session_provider_header_requires_an_exact_known_value() {
    for provider in ["local", "groq", "openai"] {
      assert_eq!(validate_session_provider(provider).unwrap(), provider);
    }
    // Missing and non-UTF8 headers are decoded as an empty string at the IPC edge.
    for provider in ["", "unknown", "LOCAL", " openai", "openai "] {
      assert_eq!(validate_session_provider(provider).unwrap_err(), SESSION_PROVIDER_INVALID);
    }
  }

  #[test]
  fn invalid_session_provider_errors_keep_backend_audio_unless_chunked() {
    for provider in ["", "invalid"] {
      for incomplete in [false, true] {
        assert!(!frontend_owns_audio_recovery(provider, None, incomplete));
        assert!(frontend_owns_audio_recovery(provider, Some(0), incomplete));
      }
    }
  }

  #[test]
  fn local_session_stays_local_after_settings_switches_to_cloud() {
    for provider in ["groq", "openai"] {
      let config = config_with(provider, "gsk", "osk");
      assert!(matches!(resolve_transcription_route_for("local", &config).unwrap(), TranscriptionRoute::Local));
      let local = transcription_config_for_provider(&config, "local");
      assert_eq!(local.provider, "local");
      assert_eq!(local.model, crate::local_asr::QWEN_MODEL_ID);
    }
  }

  #[test]
  fn cloud_session_keeps_its_destination_and_key_after_settings_change() {
    for selected in ["local", "groq", "openai"] {
      let mut config = config_with(selected, "gsk", "osk");
      config.model = default_model_for(selected).into();
      for (session, expected_key) in [("groq", "gsk"), ("openai", "osk")] {
        match resolve_transcription_route_for(session, &config).unwrap() {
          TranscriptionRoute::Cloud { provider, api_key } => {
            assert_eq!(provider, session);
            assert_eq!(api_key, expected_key);
          }
          other => panic!("expected cloud, got {other:?}"),
        }
        assert_eq!(transcription_config_for_provider(&config, session).model, default_model_for(session));
      }
    }
  }

  #[test]
  fn switched_session_cannot_reuse_another_providers_legacy_key() {
    let mut config = config_with("groq", "gsk", "");
    config.api_key = "gsk".into();
    assert!(resolve_transcription_route_for("openai", &config).is_err());
  }

  #[test]
  fn session_provider_does_not_pin_the_local_model() {
    let mut config = config_with("local", "", "");
    config.model = crate::local_asr::QWEN_LARGE_MODEL_ID.into();
    assert_eq!(transcription_config_for_provider(&config, "local").model, crate::local_asr::QWEN_LARGE_MODEL_ID);
  }

  #[test]
  fn missing_local_model_error_keeps_its_machine_readable_prefix() {
    let error = normalize_local_transcription_error(anyhow::anyhow!("LOCAL_MODEL_MISSING: /private/model/path"));
    assert!(error.to_string().starts_with("LOCAL_MODEL_MISSING"));
    assert!(!error.to_string().contains("/private/model/path"));
  }

  fn config_with(provider: &str, groq: &str, openai: &str) -> AppConfig {
    let mut c = AppConfig::default();
    c.provider = provider.into();
    c.api_key_groq = groq.into();
    c.api_key_openai = openai.into();
    c
  }

  #[test]
  fn local_provider_routes_to_local_for_normal_dictation() {
    let route = resolve_transcription_route(&config_with("local", "", "")).unwrap();
    assert!(matches!(route, TranscriptionRoute::Local));
  }

  #[test]
  fn cloud_providers_route_unchanged_and_require_a_key() {
    match resolve_transcription_route(&config_with("groq", "gsk", "")).unwrap() {
      TranscriptionRoute::Cloud { provider, api_key } => {
        assert_eq!(provider, "groq");
        assert_eq!(api_key, "gsk");
      }
      other => panic!("{other:?}"),
    }
    assert!(resolve_transcription_route(&config_with("openai", "", "")).is_err());
  }

  #[test]
  fn local_route_accepts_the_wav_mimes_the_frontend_sends() {
    for mime in ["audio/wav", "audio/wave", "audio/x-wav", "audio/wav; codecs=1"] {
      assert!(ensure_wav_mime(mime).is_ok(), "{mime} should be accepted");
    }
  }

  #[test]
  fn local_route_rejects_mimes_the_local_decoder_cannot_read() {
    // Chiefly the WebKit MediaRecorder default (AAC in mp4) — reaching the
    // local decoder with it means the frontend skipped its WAV re-encode.
    for mime in ["audio/mp4", "audio/aac", "audio/webm;codecs=opus", ""] {
      let err = ensure_wav_mime(mime).unwrap_err().to_string();
      assert!(err.contains("expects WAV audio"), "unexpected error for {mime:?}: {err}");
    }
  }
}

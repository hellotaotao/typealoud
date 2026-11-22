use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

pub const APP_IDENTIFIER: &str = "com.tao.typealoud";
/// The identifier before the TypeAloud rename. Its data directory and login
/// item are carried over once, on the first launch after the rename.
pub const LEGACY_APP_IDENTIFIER: &str = "com.tao.saytype";
pub const CONFIG_FILE_NAME: &str = "config.json";
pub const HISTORY_FILE_NAME: &str = "transcription-history.json";
pub const DEFAULT_RECORD_SHORTCUT: &str = "Ctrl+Shift";
pub const DEFAULT_NEMOTRON_LATENCY_MS: u32 = 560;
pub const NEMOTRON_ACCURACY_LATENCY_MS: u32 = 1_120;

static CONFIG_LOCK: Mutex<()> = Mutex::new(());

fn config_lock() -> MutexGuard<'static, ()> {
  CONFIG_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn default_language() -> String {
  "auto".into()
}

fn default_merge_spelled_letters() -> bool {
  true
}

fn default_remove_filler_words() -> bool {
  true
}

fn default_usage_stats() -> bool {
  true
}

fn default_ui_language() -> String {
  "auto".into()
}

fn default_ui_theme() -> String {
  "elegant".into()
}

fn default_model() -> String {
  "gpt-transcribe".into()
}

fn default_microphone() -> String {
  "default".into()
}

pub const OPENROUTER_PROVIDER: &str = "openrouter";
/// OpenRouter speech-to-text models offered in Settings, default first. Chosen
/// from the 2026-11 comparison in docs/cloud-transcription.md.
pub const OPENROUTER_MODELS: &[&str] = &["qwen/qwen3-asr-1.7b", "microsoft/mai-transcribe-2"];
pub const OPENROUTER_DEFAULT_MODEL: &str = "qwen/qwen3-asr-1.7b";

fn default_provider() -> String {
  "openai".into()
}

fn default_nemotron_latency_ms() -> u32 {
  DEFAULT_NEMOTRON_LATENCY_MS
}

pub fn normalize_nemotron_latency_ms(value: u32) -> u32 {
  match value {
    NEMOTRON_ACCURACY_LATENCY_MS => NEMOTRON_ACCURACY_LATENCY_MS,
    _ => DEFAULT_NEMOTRON_LATENCY_MS,
  }
}

fn default_local_compute() -> String {
  crate::local_asr::ComputePreference::Auto.as_str().into()
}

/// Anything unrecognised means "auto" — the config file is user-editable,
/// and an unknown value must never select a backend.
pub fn normalize_local_compute(value: &str) -> &'static str {
  crate::local_asr::ComputePreference::parse(value).as_str()
}

fn default_shortcut() -> String {
  DEFAULT_RECORD_SHORTCUT.into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
  #[serde(default)]
  pub api_key: String,
  #[serde(default, rename = "apiKeyOpenRouter")]
  pub api_key_openrouter: String,
  #[serde(default, rename = "apiKeyOpenAI")]
  pub api_key_openai: String,
  #[serde(default = "default_shortcut")]
  pub shortcut: String,
  #[serde(default = "default_language")]
  pub language: String,
  #[serde(default = "default_merge_spelled_letters")]
  pub merge_spelled_letters: bool,
  #[serde(default = "default_remove_filler_words")]
  pub remove_filler_words: bool,
  #[serde(default = "default_ui_language")]
  pub ui_language: String,
  #[serde(default = "default_ui_theme")]
  pub ui_theme: String,
  #[serde(default = "default_model")]
  pub model: String,
  #[serde(default = "default_microphone")]
  pub microphone: String,
  #[serde(default)]
  pub auto_launch: bool,
  #[serde(default)]
  pub start_minimized: bool,
  #[serde(default = "default_provider")]
  pub provider: String,
  #[serde(default)]
  pub dictionary: String,
  #[serde(default = "default_nemotron_latency_ms")]
  pub nemotron_latency_ms: u32,
  /// "auto" | "cpu" | "gpu" — which backend the local engine runs on.
  /// See local_asr::ComputePreference; "auto" resolves to CPU today.
  #[serde(default = "default_local_compute")]
  pub local_compute: String,
  /// The GPU the local engine uses when the GPU runtime sees more than one,
  /// as llama.cpp names it ("Vulkan1"). Empty, or a name no longer listed,
  /// means the first one. Set by `set_gpu_device`, never by the settings form.
  #[serde(default)]
  pub local_gpu_device: String,
  #[serde(default)]
  pub onboarding_completed: bool,
  /// Set once the user has picked a record shortcut in the picker or closed the
  /// one-time "new shortcuts" prompt; see `shortcut_prompt_due`.
  #[serde(default)]
  pub shortcut_prompt_seen: bool,
  /// The Qwen size last used ("qwen3-asr-0.6b-q8_0" | "qwen3-asr-1.7b-q8_0"),
  /// so switching back to Qwen from a cloud engine returns to it. Empty means
  /// the default size. Kept up to date by `remember_qwen_model`.
  #[serde(default)]
  pub qwen_model: String,
  /// Anonymous daily usage counts (usage.rs, PRIVACY.md). On by default; the
  /// onboarding privacy page and Settings both carry the switch.
  #[serde(default = "default_usage_stats")]
  pub usage_stats: bool,
  /// Development builds only: keep a copy of every clip sent for transcription
  /// (recording_archive.rs). No UI; set by hand for offline tests.
  #[serde(default)]
  pub debug_save_audio: bool,
}

impl Default for AppConfig {
  fn default() -> Self {
    Self {
      api_key: String::new(),
      api_key_openrouter: String::new(),
      api_key_openai: String::new(),
      shortcut: default_shortcut(),
      language: default_language(),
      merge_spelled_letters: default_merge_spelled_letters(),
      remove_filler_words: default_remove_filler_words(),
      ui_language: default_ui_language(),
      ui_theme: default_ui_theme(),
      model: default_model(),
      microphone: default_microphone(),
      auto_launch: false,
      start_minimized: false,
      provider: default_provider(),
      dictionary: String::new(),
      nemotron_latency_ms: default_nemotron_latency_ms(),
      local_compute: default_local_compute(),
      local_gpu_device: String::new(),
      onboarding_completed: false,
      shortcut_prompt_seen: false,
      qwen_model: String::new(),
      usage_stats: default_usage_stats(),
      debug_save_audio: false,
    }
  }
}

/// The Qwen size in use, or the one used last when another engine is active.
pub fn preferred_qwen_model(config: &AppConfig) -> &'static str {
  if config.provider == crate::local_asr::LOCAL_PROVIDER {
    match config.model.as_str() {
      crate::local_asr::QWEN_MODEL_ID => return crate::local_asr::QWEN_MODEL_ID,
      crate::local_asr::QWEN_LARGE_MODEL_ID => return crate::local_asr::QWEN_LARGE_MODEL_ID,
      _ => {}
    }
  }
  remembered_qwen_model(config)
}

fn remembered_qwen_model(config: &AppConfig) -> &'static str {
  if config.qwen_model == crate::local_asr::QWEN_LARGE_MODEL_ID {
    crate::local_asr::QWEN_LARGE_MODEL_ID
  } else {
    crate::local_asr::QWEN_MODEL_ID
  }
}

/// Record the Qwen size whenever a Qwen model is the active engine.
pub fn remember_qwen_model(config: &mut AppConfig) {
  if config.provider == crate::local_asr::LOCAL_PROVIDER
    && matches!(config.model.as_str(), crate::local_asr::QWEN_MODEL_ID | crate::local_asr::QWEN_LARGE_MODEL_ID)
  {
    config.qwen_model = config.model.clone();
  }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
  /// Whether the selected engine can transcribe now. The raw keys are NOT in
  /// this payload — get_settings is read by every window (main, input-prompt),
  /// and only the Settings editor in the main window needs the actual keys.
  pub engine_ready: bool,
  pub engine_blocker: &'static str,
  pub shortcut: String,
  pub language: String,
  pub merge_spelled_letters: bool,
  pub remove_filler_words: bool,
  pub ui_language: String,
  pub ui_theme: String,
  pub model: String,
  pub microphone: String,
  pub auto_launch: bool,
  pub start_minimized: bool,
  pub provider: String,
  pub nemotron_latency_ms: u32,
  /// Which backend the local engine runs on: "auto" | "cpu" | "gpu".
  pub local_compute: String,
  /// The chosen GPU's llama.cpp name, or "" for the first one.
  pub local_gpu_device: String,
  /// The OS the backend runs on ("macos" | "windows" | "linux"), so the frontend
  /// can choose OS-correct copy and modifier glyphs instead of relying on the
  /// deprecated navigator.platform.
  pub os: String,
  #[serde(rename = "isDev")]
  pub is_dev: bool,
  /// Whether the first-launch onboarding wizard has been completed (or skipped).
  /// The main window shows the wizard while this is false.
  pub onboarding_completed: bool,
  /// Whether the sidebar shows the Files page (`file_transcription::PAGE_ENABLED`).
  pub files_page_enabled: bool,
  /// Whether the main window should offer the shortcut picker once, for an
  /// existing install still on one of the two original shortcuts.
  pub shortcut_prompt_due: bool,
  /// Whether local engines are offered on this build. This remains independent
  /// of model download state and the hardware recommendation in local_tier.
  pub local_capable: bool,
  pub local_tier: crate::hardware::LocalTier,
  /// The Qwen size Home and Settings show for the Qwen engine: the one in use,
  /// else the one used last.
  pub qwen_model: String,
  /// Whether the Nemotron engine can run here at all (its streaming runtime is
  /// available for Apple Silicon and Windows x64). False means the engine is
  /// not offered — the Settings provider list, the Home engine switcher and the
  /// tray all drop it rather than exposing a backend that can only fail.
  pub nemotron_supported: bool,
  /// Whether an optional GPU runtime exists for this platform. False on
  /// macOS, whose runtime already carries Metal, and the Settings row is
  /// hidden rather than offering a switch that could not do anything.
  pub gpu_runtime_supported: bool,
  pub usage_stats: bool,
}

impl SettingsPayload {
  pub fn from_config(config: &AppConfig) -> Self {
    Self::from_config_with(config, crate::local_asr::assets_ready_for(&config.model))
  }

  /// `local_model_ready` injected for tests (assets_ready_for() reads the real
  /// app data dir). Readiness never changes the selected provider.
  pub fn from_config_with(config: &AppConfig, local_model_ready: bool) -> Self {
    let engine_blocker = match config.provider.as_str() {
      "local" if !local_model_ready => "local-model-missing",
      "local" => "",
      "openrouter" | "openai" if selected_api_key(config).trim().is_empty() => "api-key-missing",
      "openrouter" | "openai" => "",
      _ => "provider-invalid",
    };
    Self {
      engine_ready: engine_blocker.is_empty(),
      engine_blocker,
      shortcut: config.shortcut.clone(),
      language: config.language.clone(),
      merge_spelled_letters: config.merge_spelled_letters,
      remove_filler_words: config.remove_filler_words,
      ui_language: config.ui_language.clone(),
      ui_theme: config.ui_theme.clone(),
      model: config.model.clone(),
      microphone: config.microphone.clone(),
      auto_launch: config.auto_launch,
      start_minimized: config.start_minimized,
      provider: config.provider.clone(),
      nemotron_latency_ms: normalize_nemotron_latency_ms(config.nemotron_latency_ms),
      local_compute: normalize_local_compute(&config.local_compute).into(),
      local_gpu_device: config.local_gpu_device.clone(),
      gpu_runtime_supported: crate::local_asr::gpu_runtime_supported(),
      os: std::env::consts::OS.to_string(),
      is_dev: cfg!(debug_assertions),
      onboarding_completed: config.onboarding_completed,
      files_page_enabled: crate::file_transcription::PAGE_ENABLED,
      shortcut_prompt_due: shortcut_prompt_due(config),
      local_capable: crate::platform::supports_local_first(),
      local_tier: crate::hardware::local_tier(),
      qwen_model: preferred_qwen_model(config).into(),
      nemotron_supported: crate::nemotron_asr::supported(),
      usage_stats: config.usage_stats,
    }
  }
}

fn data_base_dir() -> Option<PathBuf> {
  dirs::data_local_dir().or_else(dirs::data_dir)
}

pub fn app_data_dir() -> Result<PathBuf> {
  let base = data_base_dir().context("failed to resolve application data directory")?;
  let dir = base.join(APP_IDENTIFIER);
  fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;
  Ok(dir)
}

/// Move the pre-rename data directory (settings, history, downloaded models
/// and runtimes) to the current identifier. Must run before anything calls
/// `app_data_dir`, which creates the directory and starts filling it.
/// Logging is not set up yet at that point, so failures go to stderr.
pub fn migrate_legacy_app_data() {
  let Some(base) = data_base_dir() else { return };
  match move_legacy_dir(&base.join(LEGACY_APP_IDENTIFIER), &base.join(APP_IDENTIFIER)) {
    Ok(true) => crate::platform::migrate_legacy_login_item(LEGACY_APP_IDENTIFIER),
    Ok(false) => {}
    Err(error) => eprintln!("legacy data migration failed: {error:#}"),
  }
}

/// Rename `legacy` to `current` when only the legacy directory exists, or when
/// `current` is an empty shell. Returns whether anything moved.
fn move_legacy_dir(legacy: &Path, current: &Path) -> Result<bool> {
  if !legacy.is_dir() {
    return Ok(false);
  }
  if current.exists() {
    // Anything that resolves `app_data_dir` before the first launch leaves an
    // empty directory behind (a `cargo test` run does), and that must not keep
    // the old data where the app no longer looks. One that holds anything else
    // already belongs to this identifier.
    if !is_empty_data_dir(current) {
      return Ok(false);
    }
    fs::remove_dir_all(current)
      .with_context(|| format!("failed to remove empty {}", current.display()))?;
  }
  fs::rename(legacy, current)
    .with_context(|| format!("failed to move {} to {}", legacy.display(), current.display()))?;
  Ok(true)
}

/// A directory with no entries apart from Finder's `.DS_Store`.
fn is_empty_data_dir(dir: &Path) -> bool {
  fs::read_dir(dir)
    .map(|entries| entries.flatten().all(|entry| entry.file_name() == ".DS_Store"))
    .unwrap_or(false)
}

pub fn config_path() -> Result<PathBuf> {
  Ok(app_data_dir()?.join(CONFIG_FILE_NAME))
}

pub fn history_path() -> Result<PathBuf> {
  Ok(app_data_dir()?.join(HISTORY_FILE_NAME))
}

pub fn debug_audio_dir() -> Result<PathBuf> {
  Ok(app_data_dir()?.join("debug-audio"))
}

pub fn read_config() -> Result<AppConfig> {
  read_config_from_path(&config_path()?)
}

pub fn read_config_from_path(path: &Path) -> Result<AppConfig> {
  read_config_from_path_with_tier(path, crate::hardware::local_tier())
}

/// The only two record shortcuts Settings offered before right-hand single keys
/// arrived (2026-11-17). An install still on one of them never really chose it,
/// so it is shown the shortcut picker once after updating. Nobody's shortcut
/// changes by itself: saved configs keep theirs.
const ORIGINAL_SHORTCUTS: &[&str] = &["Ctrl+Shift", "Ctrl+Alt"];

/// macOS and Windows got new recommended keys; Linux kept Ctrl+Shift.
pub fn shortcut_prompt_due(config: &AppConfig) -> bool {
  shortcut_prompt_due_on(cfg!(any(target_os = "macos", target_os = "windows")), config)
}

fn shortcut_prompt_due_on(platform_has_new_keys: bool, config: &AppConfig) -> bool {
  if !platform_has_new_keys || !config.onboarding_completed || config.shortcut_prompt_seen {
    return false;
  }
  // An unreadable saved shortcut falls back to the default, as the listener does.
  let canonical = |value: &str| crate::hotkey::Shortcut::parse(value).map(|shortcut| shortcut.canonical());
  let current = canonical(&config.shortcut).or_else(|| canonical(DEFAULT_RECORD_SHORTCUT));
  ORIGINAL_SHORTCUTS.iter().any(|original| canonical(original) == current)
}

/// The record shortcut a new install starts with. macOS: the right Command key,
/// which does nothing on its own and leaves the left hand free. Not the right
/// Option key: the Claude desktop app opens its quick entry on a double tap of
/// Option by default, which takes over the double tap that starts hands-free
/// recording, and Option also types special characters. Windows: Ctrl+Win,
/// since Ctrl+Shift cycles input methods there, a lone Alt moves focus to the
/// menu bar and the right Ctrl is missing on laptops with a Copilot key. Linux
/// keeps the original Ctrl+Shift. Existing installs keep what they saved.
pub fn new_install_shortcut() -> &'static str {
  if cfg!(target_os = "macos") {
    "RightMeta"
  } else if cfg!(target_os = "windows") {
    "Ctrl+Meta"
  } else {
    DEFAULT_RECORD_SHORTCUT
  }
}

pub fn fresh_config_for(tier: crate::hardware::LocalTier) -> AppConfig {
  let mut config = AppConfig::default();
  config.shortcut = new_install_shortcut().into();
  if tier == crate::hardware::LocalTier::CloudDefault {
    config.provider = OPENROUTER_PROVIDER.into();
    config.model = OPENROUTER_DEFAULT_MODEL.into();
  } else {
    config.provider = crate::local_asr::LOCAL_PROVIDER.into();
    config.model = crate::local_asr::QWEN_MODEL_ID.into();
  }
  config
}

fn read_config_from_path_with_tier(path: &Path, tier: crate::hardware::LocalTier) -> Result<AppConfig> {
  let text = match fs::read_to_string(path) {
    Ok(text) => text,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(fresh_config_for(tier)),
    Err(error) => return Err(error).with_context(|| format!("failed to read {}", path.display())),
  };
  let mut config = serde_json::from_str::<AppConfig>(&text)
    .with_context(|| format!("failed to parse {}", path.display()))?;
  migrate_removed_providers(&mut config);
  Ok(config)
}

/// Groq was removed in favour of OpenRouter (2026-11-23). An install still on
/// Groq moves to OpenRouter's default model; its Groq key cannot be used there,
/// so the engine shows "needs a key" until one is entered. The legacy `api_key`
/// mirror held the Groq key and is cleared so it can never reach another
/// provider. The `apiKeyGroq` field itself is no longer read.
fn migrate_removed_providers(config: &mut AppConfig) {
  if config.provider == "groq" {
    config.provider = OPENROUTER_PROVIDER.into();
    config.model = OPENROUTER_DEFAULT_MODEL.into();
    config.api_key.clear();
  } else if config.provider == OPENROUTER_PROVIDER
    && !OPENROUTER_MODELS.contains(&config.model.as_str())
  {
    config.model = OPENROUTER_DEFAULT_MODEL.into();
  }
}

fn mutate_config_at(
  path: &Path,
  mutation: impl FnOnce(&mut AppConfig) -> Result<()>,
) -> Result<AppConfig> {
  let _guard = config_lock();
  let mut config = read_config_from_path(path)?;
  mutation(&mut config)?;
  remember_qwen_model(&mut config);
  write_config_to_path(path, &config)?;
  Ok(config)
}

pub fn mutate_config(
  mutation: impl FnOnce(&mut AppConfig) -> Result<()>,
) -> Result<AppConfig> {
  mutate_config_at(&config_path()?, mutation)
}

pub fn write_config_to_path(path: &Path, config: &AppConfig) -> Result<()> {
  let text = serde_json::to_string_pretty(config)?;
  atomic_write(path, &text)
}

/// Write `contents` to `path` atomically: write to a sibling temp file, then
/// rename it over the target. rename is atomic on the same filesystem, so a
/// crash/power loss mid-write leaves either the old complete file or the new one
/// — never a truncated, unparseable file (which for config would silently reset
/// settings, including API keys; for history would fail every later read).
///
/// The temp name carries the pid + a counter so concurrent writers — e.g. two
/// overlapping transcriptions both appending history — never collide on it.
pub fn atomic_write(path: &Path, contents: &str) -> Result<()> {
  use std::sync::atomic::{AtomicU64, Ordering};
  static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent)
      .with_context(|| format!("failed to create {}", parent.display()))?;
  }
  let file_name = path
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or("config");
  let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
  let tmp_path = path.with_file_name(format!("{file_name}.{}.{seq}.tmp", std::process::id()));
  fs::write(&tmp_path, contents)
    .with_context(|| format!("failed to write {}", tmp_path.display()))?;
  fs::rename(&tmp_path, path)
    .with_context(|| format!("failed to replace {}", path.display()))?;
  Ok(())
}

pub fn selected_api_key(config: &AppConfig) -> String {
  match config.provider.as_str() {
    // The legacy single `api_key` predates per-provider keys and only ever
    // held an OpenAI or Groq key, so it is never sent to OpenRouter.
    "openai" if config.api_key_openai.trim().is_empty() => config.api_key.clone(),
    "openai" => config.api_key_openai.clone(),
    OPENROUTER_PROVIDER => config.api_key_openrouter.clone(),
    _ => String::new(),
  }
}

pub fn normalize_record_shortcut(value: &str) -> String {
  crate::hotkey::Shortcut::parse(value)
    .map(|shortcut| shortcut.canonical())
    .unwrap_or_else(|| DEFAULT_RECORD_SHORTCUT.into())
}

/// Whether the macOS login-item registration must be re-applied.
///
/// Re-registering runs `launchctl load` on a `RunAtLoad` LaunchAgent, which
/// immediately spawns a fresh process. Doing that on every settings save would
/// launch a duplicate app instance, so callers must only re-apply when the
/// value actually changed.
pub fn auto_launch_needs_update(previous: bool, next: bool) -> bool {
  previous != next
}

/// Apply (or remove) the OS login item. The per-OS mechanism — a LaunchAgent
/// plist on macOS, a no-op on platforms not yet wired up — lives behind
/// `platform::set_auto_launch`. Callers gate this with `auto_launch_needs_update`
/// so it only runs when the value actually changed.
pub fn update_auto_launch(enabled: bool) -> Result<()> {
  crate::platform::set_auto_launch(enabled)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn legacy_data_dir_moves_only_when_current_is_missing() {
    let temp = tempfile::TempDir::new().unwrap();
    let legacy = temp.path().join(LEGACY_APP_IDENTIFIER);
    let current = temp.path().join(APP_IDENTIFIER);
    fs::create_dir_all(legacy.join("local-asr")).unwrap();
    fs::write(legacy.join(CONFIG_FILE_NAME), "{}").unwrap();

    assert!(move_legacy_dir(&legacy, &current).unwrap());
    assert!(!legacy.exists());
    assert!(current.join(CONFIG_FILE_NAME).is_file());
    assert!(current.join("local-asr").is_dir());

    fs::create_dir_all(&legacy).unwrap();
    assert!(!move_legacy_dir(&legacy, &current).unwrap());
    assert!(legacy.is_dir());
  }

  #[test]
  fn legacy_data_dir_replaces_an_empty_current_dir() {
    let temp = tempfile::TempDir::new().unwrap();
    let legacy = temp.path().join(LEGACY_APP_IDENTIFIER);
    let current = temp.path().join(APP_IDENTIFIER);
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join(HISTORY_FILE_NAME), "{}").unwrap();
    fs::create_dir_all(&current).unwrap();
    fs::write(current.join(".DS_Store"), "").unwrap();

    assert!(move_legacy_dir(&legacy, &current).unwrap());
    assert!(!legacy.exists());
    assert!(current.join(HISTORY_FILE_NAME).is_file());
    assert!(!current.join(".DS_Store").exists());
  }

  #[test]
  fn legacy_data_dir_stays_when_current_holds_anything() {
    let temp = tempfile::TempDir::new().unwrap();
    let legacy = temp.path().join(LEGACY_APP_IDENTIFIER);
    let current = temp.path().join(APP_IDENTIFIER);
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join(HISTORY_FILE_NAME), "{}").unwrap();
    fs::create_dir_all(current.join("local-asr")).unwrap();

    assert!(!move_legacy_dir(&legacy, &current).unwrap());
    assert!(legacy.join(HISTORY_FILE_NAME).is_file());
    assert!(current.join("local-asr").is_dir());
  }

  #[test]
  fn legacy_data_dir_absent_is_a_no_op() {
    let temp = tempfile::TempDir::new().unwrap();
    let current = temp.path().join(APP_IDENTIFIER);
    assert!(!move_legacy_dir(&temp.path().join(LEGACY_APP_IDENTIFIER), &current).unwrap());
    assert!(!current.exists());
  }

  #[test]
  fn merge_spelled_letters_defaults_on_for_new_and_existing_configs() {
    use crate::hardware::LocalTier;
    for config in [
      AppConfig::default(),
      fresh_config_for(LocalTier::Qwen),
      fresh_config_for(LocalTier::CloudDefault),
      serde_json::from_str::<AppConfig>(r#"{"provider":"openrouter"}"#).unwrap(),
    ] {
      assert_eq!(serde_json::to_value(config).unwrap()["mergeSpelledLetters"], true);
    }
  }

  #[test]
  fn merge_spelled_letters_disabled_survives_config_round_trip() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("config.json");
    let config: AppConfig = serde_json::from_str(r#"{"mergeSpelledLetters":false}"#).unwrap();
    write_config_to_path(&path, &config).unwrap();
    let restored = read_config_from_path(&path).unwrap();
    assert_eq!(serde_json::to_value(restored).unwrap()["mergeSpelledLetters"], false);
  }

  #[test]
  fn merge_spelled_letters_setting_is_in_the_frontend_payload() {
    for enabled in [true, false] {
      let config: AppConfig = serde_json::from_value(serde_json::json!({
        "mergeSpelledLetters": enabled,
      })).unwrap();
      let payload = serde_json::to_value(SettingsPayload::from_config_with(&config, false)).unwrap();
      assert_eq!(payload["mergeSpelledLetters"], enabled);
    }
  }

  #[test]
  fn remove_filler_words_defaults_on_and_reaches_the_frontend_payload() {
    use crate::hardware::LocalTier;
    for config in [
      AppConfig::default(),
      fresh_config_for(LocalTier::Qwen),
      fresh_config_for(LocalTier::CloudDefault),
      serde_json::from_str::<AppConfig>(r#"{"provider":"openrouter"}"#).unwrap(),
    ] {
      assert_eq!(serde_json::to_value(config).unwrap()["removeFillerWords"], true);
    }
    for enabled in [true, false] {
      let config: AppConfig = serde_json::from_value(serde_json::json!({
        "removeFillerWords": enabled,
      })).unwrap();
      let payload = serde_json::to_value(SettingsPayload::from_config_with(&config, false)).unwrap();
      assert_eq!(payload["removeFillerWords"], enabled);
    }
  }

  #[test]
  fn defaults_match_current_app_behavior() {
    let config = AppConfig::default();
    assert_eq!(config.provider, "openai");
    assert_eq!(config.model, "gpt-transcribe");
    assert_eq!(config.shortcut, DEFAULT_RECORD_SHORTCUT);
    assert_eq!(config.nemotron_latency_ms, DEFAULT_NEMOTRON_LATENCY_MS);
  }

  #[test]
  fn local_compute_defaults_to_auto_and_rejects_unknown_values() {
    assert_eq!(AppConfig::default().local_compute, "auto");
    assert_eq!(normalize_local_compute("gpu"), "gpu");
    assert_eq!(normalize_local_compute("cpu"), "cpu");
    // A hand-edited config must never end up selecting a backend by accident.
    assert_eq!(normalize_local_compute("vulkan"), "auto");
    assert_eq!(normalize_local_compute(""), "auto");
  }

  #[test]
  fn settings_payload_normalizes_local_compute_for_the_frontend() {
    let mut config = AppConfig::default();
    config.local_compute = "CUDA".into();
    let payload = SettingsPayload::from_config_with(&config, false);
    assert_eq!(payload.local_compute, "auto");
    // The GPU row is hidden where no pack exists, so this flag has to track the
    // backend rather than being assumed true on every desktop.
    assert_eq!(payload.gpu_runtime_supported, crate::local_asr::gpu_runtime_supported());
  }

  #[test]
  fn qwen_size_is_remembered_across_engines() {
    let mut config = AppConfig::default();
    assert_eq!(preferred_qwen_model(&config), crate::local_asr::QWEN_MODEL_ID);
    config.provider = crate::local_asr::LOCAL_PROVIDER.into();
    config.model = crate::local_asr::QWEN_LARGE_MODEL_ID.into();
    remember_qwen_model(&mut config);
    assert_eq!(config.qwen_model, crate::local_asr::QWEN_LARGE_MODEL_ID);
    // Nemotron is not a Qwen size, so it leaves the remembered one alone.
    config.model = crate::local_asr::NEMOTRON_MODEL_ID.into();
    remember_qwen_model(&mut config);
    assert_eq!(preferred_qwen_model(&config), crate::local_asr::QWEN_LARGE_MODEL_ID);
    config.provider = "openai".into();
    config.model = "gpt-transcribe".into();
    assert_eq!(preferred_qwen_model(&config), crate::local_asr::QWEN_LARGE_MODEL_ID);
    assert_eq!(SettingsPayload::from_config_with(&config, true).qwen_model, crate::local_asr::QWEN_LARGE_MODEL_ID);
  }

  #[test]
  fn nemotron_latency_accepts_only_supported_profiles() {
    assert_eq!(normalize_nemotron_latency_ms(560), 560);
    assert_eq!(normalize_nemotron_latency_ms(1_120), 1_120);
    assert_eq!(normalize_nemotron_latency_ms(0), 560);
    assert_eq!(normalize_nemotron_latency_ms(999), 560);
  }

  #[test]
  fn normalize_invalid_shortcuts_falls_back() {
    assert_eq!(normalize_record_shortcut("Ctrl"), DEFAULT_RECORD_SHORTCUT);
    assert_eq!(normalize_record_shortcut("Shift+Alt"), "Shift+Alt");
    assert_eq!(normalize_record_shortcut("Ctrl+Shift+Alt"), "Ctrl+Shift+Alt");
    assert_eq!(normalize_record_shortcut("control + option"), "Ctrl+Alt");
    assert_eq!(normalize_record_shortcut("Win+Ctrl"), "Ctrl+Meta");
    assert_eq!(normalize_record_shortcut("rightoption"), "RightAlt");
    assert_eq!(normalize_record_shortcut("RightMeta"), "RightMeta");
    assert_eq!(normalize_record_shortcut("RightCtrl"), "RightCtrl");
    assert_eq!(normalize_record_shortcut("Alt"), DEFAULT_RECORD_SHORTCUT);
    assert_eq!(normalize_record_shortcut("RightShift"), DEFAULT_RECORD_SHORTCUT);
    assert_eq!(normalize_record_shortcut("Ctrl+Bogus"), DEFAULT_RECORD_SHORTCUT);
  }

  #[test]
  fn only_new_installs_get_the_platform_shortcut() {
    use crate::hardware::LocalTier;
    assert_eq!(fresh_config_for(LocalTier::Qwen).shortcut, new_install_shortcut());
    assert_eq!(fresh_config_for(LocalTier::CloudDefault).shortcut, new_install_shortcut());
    // A saved config without the field, and the struct default, keep the old one.
    assert_eq!(AppConfig::default().shortcut, DEFAULT_RECORD_SHORTCUT);
    let saved: AppConfig = serde_json::from_str(r#"{"provider":"openrouter"}"#).unwrap();
    assert_eq!(saved.shortcut, DEFAULT_RECORD_SHORTCUT);
    assert_eq!(normalize_record_shortcut(new_install_shortcut()), new_install_shortcut());
  }

  #[test]
  fn parses_config_from_path() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("config.json");
    fs::write(
      &path,
      r#"{
        "apiKey":"legacy",
        "apiKeyOpenRouter":"gsk",
        "apiKeyOpenAI":"osk",
        "provider":"openrouter",
        "language":"en",
        "uiTheme":"midnight"
      }"#,
    )
    .unwrap();

    let config = read_config_from_path(&path).unwrap();
    assert_eq!(config.api_key, "legacy");
    assert_eq!(config.api_key_openrouter, "gsk");
    assert_eq!(config.api_key_openai, "osk");
    assert_eq!(config.provider, "openrouter");
    assert_eq!(config.language, "en");
    assert_eq!(config.nemotron_latency_ms, DEFAULT_NEMOTRON_LATENCY_MS);
  }

  #[test]
  fn missing_config_uses_hardware_defaults_without_changing_legacy_defaults() {
    use crate::hardware::LocalTier;
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("missing.json");
    for tier in [LocalTier::Qwen] {
      let config = read_config_from_path_with_tier(&path, tier).unwrap();
      assert_eq!(config.provider, "local");
      assert_eq!(config.model, crate::local_asr::QWEN_MODEL_ID);
    }
    let cloud = read_config_from_path_with_tier(&path, LocalTier::CloudDefault).unwrap();
    assert_eq!(cloud.provider, "openrouter");
    assert_eq!(cloud.model, OPENROUTER_DEFAULT_MODEL);
    assert_eq!(AppConfig::default().provider, "openai");
    assert_eq!(AppConfig::default().model, "gpt-transcribe");
    assert!(!path.exists());
  }

  #[test]
  fn existing_and_legacy_config_ignore_hardware_defaults() {
    use crate::hardware::LocalTier;
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("config.json");
    for tier in [LocalTier::CloudDefault, LocalTier::Qwen] {
      fs::write(&path, r#"{"provider":"openrouter","model":"microsoft/mai-transcribe-2","apiKeyOpenRouter":"sk-or"}"#).unwrap();
      let config = read_config_from_path_with_tier(&path, tier).unwrap();
      assert_eq!(config.provider, "openrouter");
      assert_eq!(config.model, "microsoft/mai-transcribe-2");
      assert_eq!(config.api_key_openrouter, "sk-or");
      fs::write(&path, "{}").unwrap();
      let legacy = read_config_from_path_with_tier(&path, tier).unwrap();
      assert_eq!(legacy.provider, "openai");
      assert_eq!(legacy.model, "gpt-transcribe");
    }
  }

  #[test]
  fn unreadable_or_invalid_config_does_not_become_a_fresh_install() {
    let temp = tempfile::TempDir::new().unwrap();
    assert!(read_config_from_path_with_tier(temp.path(), crate::hardware::LocalTier::Qwen).is_err());
    let path = temp.path().join("config.json");
    fs::write(&path, "not json").unwrap();
    assert!(read_config_from_path_with_tier(&path, crate::hardware::LocalTier::Qwen).is_err());
  }

  #[test]
  fn auto_launch_reapplies_only_when_value_changes() {
    // Unchanged → must NOT re-register: re-registering runs `launchctl load`
    // on a RunAtLoad agent, spawning a duplicate instance on every save.
    assert!(!auto_launch_needs_update(true, true));
    assert!(!auto_launch_needs_update(false, false));
    // Changed → must re-register (enable installs+loads, disable removes).
    assert!(auto_launch_needs_update(false, true));
    assert!(auto_launch_needs_update(true, false));
  }

  #[test]
  fn config_write_is_atomic_and_roundtrips() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("config.json");
    let mut config = AppConfig::default();
    config.provider = "openai".into();
    config.api_key_openai = "sk-test".into();
    write_config_to_path(&path, &config).unwrap();

    // No leftover temp file beside the target.
    let stray = fs::read_dir(temp.path())
      .unwrap()
      .filter_map(|e| e.ok())
      .any(|e| e.file_name().to_string_lossy().contains(".tmp"));
    assert!(!stray, "atomic_write must not leave a temp file behind");

    let read = read_config_from_path(&path).unwrap();
    assert_eq!(read.provider, "openai");
    assert_eq!(read.api_key_openai, "sk-test");
  }

  #[test]
  fn concurrent_config_mutations_preserve_unrelated_fields() {
    use std::sync::{Arc, Barrier};

    let path = std::env::temp_dir().join(format!(
      "typealoud-config-mutation-{}-{}.json",
      std::process::id(),
      chrono::Utc::now().timestamp_micros()
    ));
    write_config_to_path(&path, &AppConfig::default()).unwrap();
    let start = Arc::new(Barrier::new(3));

    let first_path = path.clone();
    let first_start = start.clone();
    let first = std::thread::spawn(move || {
      first_start.wait();
      mutate_config_at(&first_path, |config| {
        config.dictionary = "alpha".into();
        std::thread::sleep(std::time::Duration::from_millis(20));
        Ok(())
      })
      .unwrap();
    });

    let second_path = path.clone();
    let second_start = start.clone();
    let second = std::thread::spawn(move || {
      second_start.wait();
      mutate_config_at(&second_path, |config| {
        config.ui_theme = "midnight".into();
        Ok(())
      })
      .unwrap();
    });

    start.wait();
    first.join().unwrap();
    second.join().unwrap();
    let config = read_config_from_path(&path).unwrap();
    assert_eq!(config.dictionary, "alpha");
    assert_eq!(config.ui_theme, "midnight");
    std::fs::remove_file(path).unwrap();
  }

  #[test]
  fn shortcut_prompt_is_due_once_for_installs_on_an_original_shortcut() {
    let mut config = AppConfig::default();
    config.onboarding_completed = true;
    for shortcut in ["Ctrl+Shift", "shift+ctrl", "Ctrl+Alt", ""] {
      config.shortcut = shortcut.into();
      assert!(shortcut_prompt_due_on(true, &config), "{shortcut:?}");
    }
    config.shortcut = "Ctrl+Shift".into();
    assert!(!shortcut_prompt_due_on(false, &config), "Linux kept Ctrl+Shift");
    for shortcut in ["RightAlt", "Ctrl+Meta", "RightCtrl"] {
      config.shortcut = shortcut.into();
      assert!(!shortcut_prompt_due_on(true, &config), "{shortcut:?} was already chosen");
    }
    config.shortcut = "Ctrl+Shift".into();
    config.shortcut_prompt_seen = true;
    assert!(!shortcut_prompt_due_on(true, &config), "shown once");
    config.shortcut_prompt_seen = false;
    config.onboarding_completed = false;
    assert!(!shortcut_prompt_due_on(true, &config), "onboarding has its own shortcut step");
  }

  #[test]
  fn onboarding_completed_roundtrips_and_defaults_false() {
    // Pre-wizard config files don't have the field → must default to false so
    // the wizard shows exactly once for them.
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("config.json");
    fs::write(&path, r#"{ "provider": "openrouter" }"#).unwrap();
    let config = read_config_from_path(&path).unwrap();
    assert!(!config.onboarding_completed);

    let mut config = config;
    config.onboarding_completed = true;
    write_config_to_path(&path, &config).unwrap();
    assert!(read_config_from_path(&path).unwrap().onboarding_completed);
    assert!(SettingsPayload::from_config(&config).onboarding_completed);
  }

  #[test]
  fn settings_payload_reports_key_presence_without_raw_keys() {
    let mut config = AppConfig::default();
    config.provider = "openai".into();
    // No key for the selected provider yet.
    assert!(!SettingsPayload::from_config(&config).engine_ready);
    // OpenAI key present → selected provider has a usable key.
    config.api_key_openai = "sk-x".into();
    assert!(SettingsPayload::from_config(&config).engine_ready);
    // Switch to openrouter with no openrouter key → none usable, and the
    // legacy shared key (an OpenAI or Groq key) is never used for it.
    config.provider = "openrouter".into();
    assert!(!SettingsPayload::from_config(&config).engine_ready);
    config.api_key = "legacy".into();
    assert!(!SettingsPayload::from_config(&config).engine_ready);
    config.api_key_openrouter = "sk-or".into();
    assert!(SettingsPayload::from_config(&config).engine_ready);
    // For OpenAI the legacy key is still the fallback.
    config.provider = "openai".into();
    config.api_key_openai.clear();
    assert!(SettingsPayload::from_config(&config).engine_ready);
  }

  #[test]
  fn groq_installs_move_to_openrouter_without_their_groq_key() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("config.json");
    fs::write(
      &path,
      r#"{"provider":"groq","model":"whisper-large-v3-turbo","apiKeyGroq":"gsk","apiKey":"gsk","apiKeyOpenAI":"osk"}"#,
    )
    .unwrap();
    let config = read_config_from_path(&path).unwrap();
    assert_eq!(config.provider, "openrouter");
    assert_eq!(config.model, OPENROUTER_DEFAULT_MODEL);
    assert_eq!(config.api_key, "");
    assert_eq!(config.api_key_openai, "osk");
    assert_eq!(selected_api_key(&config), "");
    assert_eq!(SettingsPayload::from_config(&config).engine_blocker, "api-key-missing");
    // Writing it back drops the Groq key for good.
    write_config_to_path(&path, &config).unwrap();
    assert!(!fs::read_to_string(&path).unwrap().contains("gsk"));
  }

  #[test]
  fn openrouter_with_an_unknown_model_falls_back_to_the_default() {
    let mut config: AppConfig =
      serde_json::from_str(r#"{"provider":"openrouter","model":"gpt-transcribe"}"#).unwrap();
    migrate_removed_providers(&mut config);
    assert_eq!(config.model, OPENROUTER_DEFAULT_MODEL);
    let mut other: AppConfig =
      serde_json::from_str(r#"{"provider":"openai","model":"gpt-transcribe"}"#).unwrap();
    migrate_removed_providers(&mut other);
    assert_eq!(other.model, "gpt-transcribe");
  }

  #[test]
  fn selected_api_key_is_empty_for_local_provider() {
    let mut config = AppConfig::default();
    config.provider = "local".into();
    config.api_key_openrouter = "gsk".into();
    config.api_key = "legacy".into();
    assert_eq!(selected_api_key(&config), "");
  }

  #[test]
  fn unknown_provider_never_exposes_a_stored_key() {
    let mut config = AppConfig::default();
    config.api_key = "legacy".into();
    config.api_key_openrouter = "gsk".into();
    config.api_key_openai = "osk".into();
    for provider in ["", "unexpected", "OPENAI", " openai"] {
      config.provider = provider.into();
      assert_eq!(selected_api_key(&config), "", "{provider}");
    }
  }

  #[test]
  fn settings_payload_separates_engine_readiness_from_selection() {
    let mut config = AppConfig::default();
    config.provider = "local".into();
    let payload = serde_json::to_value(SettingsPayload::from_config_with(&config, false)).unwrap();
    assert_eq!(payload["provider"], "local");
    assert_eq!(payload["engineReady"], false);
    assert_eq!(payload["engineBlocker"], "local-model-missing");
    assert!(payload.get("hasApiKey").is_none());
  }

  #[test]
  fn settings_payload_identifies_each_engine_blocker_without_exposing_keys() {
    for (provider, ready, key, blocker) in [
      ("local", false, "", "local-model-missing"),
      ("local", true, "", ""),
      ("openai", true, "", "api-key-missing"),
      ("openrouter", true, " ", "api-key-missing"),
      ("openai", false, "sk-test", ""),
      ("openrouter", false, "gsk-test", ""),
      ("invalid", true, "secret", "provider-invalid"),
    ] {
      let mut config = AppConfig::default();
      config.provider = provider.into();
      config.api_key_openai = key.into();
      config.api_key_openrouter = key.into();
      config.api_key = key.into();
      let payload = SettingsPayload::from_config_with(&config, ready);
      assert_eq!(payload.engine_blocker, blocker, "{provider}");
      assert_eq!(payload.engine_ready, blocker.is_empty(), "{provider}");
      let payload = serde_json::to_value(payload).unwrap();
      for secret_field in ["apiKey", "apiKeyOpenRouter", "apiKeyOpenAI", "hasApiKey"] {
        assert!(payload.get(secret_field).is_none());
      }
      assert!(payload["localTier"].is_string());
      assert_eq!(payload["localCapable"], crate::platform::supports_local_first());
    }
  }

  #[test]
  fn settings_payload_local_provider_reports_model_readiness() {
    let mut config = AppConfig::default();
    config.provider = "local".into();
    assert!(SettingsPayload::from_config_with(&config, true).engine_ready);
    assert!(!SettingsPayload::from_config_with(&config, false).engine_ready);
    config.provider = "openrouter".into();
    config.api_key_openrouter = "gsk".into();
    assert!(SettingsPayload::from_config_with(&config, false).engine_ready);
  }

  #[test]
  fn settings_payload_is_local_first_on_every_supported_build() {
    let payload = SettingsPayload::from_config_with(&AppConfig::default(), false);
    assert!(payload.local_capable);
  }

  #[test]
  fn settings_payload_nemotron_supported_follows_platform() {
    // Nemotron runs wherever upstream publishes a runtime TypeAloud wires up:
    // Apple Silicon (Metal) and Windows x86_64 (CPU). Elsewhere the frontend
    // hides the engine instead of offering a backend that cannot start.
    let payload = SettingsPayload::from_config_with(&AppConfig::default(), false);
    assert_eq!(
      payload.nemotron_supported,
      cfg!(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64")
      ))
    );
  }

  #[test]
  fn local_provider_selection_does_not_require_downloaded_assets() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("config.json");
    let config = mutate_config_at(&path, |config| {
      config.provider = "local".into();
      config.model = crate::local_asr::QWEN_MODEL_ID.into();
      Ok(())
    }).unwrap();
    assert_eq!(read_config_from_path(&path).unwrap().provider, "local");
    assert!(!SettingsPayload::from_config_with(&config, false).engine_ready);
  }
}

//! Anonymous usage statistics (PRIVACY.md is the public description).
//!
//! Counts are kept per local calendar day in `usage-stats.json` and sent to
//! PostHog as one `daily_usage` event per finished day, plus a handful of
//! one-off onboarding events. Only counts and fixed labels ever enter this
//! file: never transcript text, audio, dictionary entries, paths or API keys.
//!
//! Only official builds with a compiled-in PostHog key send anything, and only
//! after the user has passed the onboarding privacy page (or finished
//! onboarding). Turning the setting off deletes the file, install ID included.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{Local, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::settings::{self, AppConfig};

pub const USAGE_FILE_NAME: &str = "usage-stats.json";
const POSTHOG_HOST: &str = "https://eu.i.posthog.com";
const POSTHOG_KEY: Option<&str> = option_env!("TYPEALOUD_POSTHOG_KEY");
/// Days that could not be sent (offline, endpoint down) are kept this long.
const MAX_UNSENT_DAYS: usize = 30;
const MAX_QUEUED_EVENTS: usize = 50;
const STARTUP_SEND_DELAY: Duration = Duration::from_secs(60);
const SEND_INTERVAL: Duration = Duration::from_secs(60 * 60);
const SEND_TIMEOUT: Duration = Duration::from_secs(20);

const ONBOARDING_STEPS: &[&str] =
  &["welcome", "privacy", "engine", "microphone", "accessibility", "practice"];
/// Reaching any of these means the privacy page, which describes these
/// statistics and carries their switch, has been shown.
const STEPS_BEFORE_DISCLOSURE: &[&str] = &["welcome", "privacy"];

static USAGE_LOCK: Mutex<()> = Mutex::new(());

fn usage_lock() -> MutexGuard<'static, ()> {
  USAGE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageStore {
  #[serde(default)]
  install_id: String,
  #[serde(default)]
  disclosure_seen: bool,
  #[serde(default)]
  first_dictation_recorded: bool,
  #[serde(default)]
  onboarding_steps: Vec<String>,
  /// Keyed by local date, `YYYY-MM-DD`.
  #[serde(default)]
  days: BTreeMap<String, DayUsage>,
  #[serde(default)]
  events: Vec<QueuedEvent>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DayUsage {
  #[serde(default)]
  dictations: u32,
  #[serde(default)]
  failures: u32,
  #[serde(default)]
  inserted_chars: u64,
  #[serde(default)]
  engine: String,
  #[serde(default)]
  app_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct QueuedEvent {
  event: String,
  timestamp: String,
  properties: Map<String, Value>,
}

/// Outcome of a local model download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DownloadResult {
  Ok,
  Error,
  Cancelled,
}

impl DownloadResult {
  fn as_str(self) -> &'static str {
    match self {
      Self::Ok => "ok",
      Self::Error => "error",
      Self::Cancelled => "cancelled",
    }
  }
}

fn usage_path() -> Result<PathBuf> {
  Ok(settings::app_data_dir()?.join(USAGE_FILE_NAME))
}

fn read_store(path: &Path) -> UsageStore {
  let Ok(text) = std::fs::read_to_string(path) else {
    return UsageStore::default();
  };
  serde_json::from_str(&text).unwrap_or_default()
}

fn write_store(path: &Path, store: &UsageStore) -> Result<()> {
  settings::atomic_write(path, &serde_json::to_string_pretty(store)?)
}

fn new_install_id() -> String {
  uuid::Uuid::new_v4().to_string()
}

fn engine_label(config: &AppConfig) -> String {
  format!("{}/{}", config.provider, config.model)
}

fn app_version() -> &'static str {
  env!("CARGO_PKG_VERSION")
}

fn today() -> NaiveDate {
  Local::now().date_naive()
}

/// Apply `change` to the store when statistics are enabled. Stats are
/// best-effort: a failure is logged and never reaches the dictation path.
fn update(change: impl FnOnce(&mut UsageStore, &AppConfig)) {
  let Ok(config) = settings::read_config() else {
    return;
  };
  if !config.usage_stats {
    return;
  }
  let result = usage_path().and_then(|path| {
    let _guard = usage_lock();
    update_at(&path, &config, change)
  });
  if let Err(error) = result {
    log::warn!("usage: could not update stats: {error:#}");
  }
}

fn update_at(
  path: &Path,
  config: &AppConfig,
  change: impl FnOnce(&mut UsageStore, &AppConfig),
) -> Result<()> {
  let mut store = read_store(path);
  if store.install_id.is_empty() {
    store.install_id = new_install_id();
  }
  change(&mut store, config);
  prune(&mut store);
  write_store(path, &store)
}

fn prune(store: &mut UsageStore) {
  while store.days.len() > MAX_UNSENT_DAYS {
    let oldest = store.days.keys().next().cloned().unwrap();
    store.days.remove(&oldest);
  }
  let excess = store.events.len().saturating_sub(MAX_QUEUED_EVENTS);
  store.events.drain(..excess);
}

fn day_entry<'a>(store: &'a mut UsageStore, date: NaiveDate, config: &AppConfig) -> &'a mut DayUsage {
  let day = store.days.entry(date.to_string()).or_default();
  day.engine = engine_label(config);
  day.app_version = app_version().into();
  day
}

fn queue_event(store: &mut UsageStore, event: &str, properties: Value) {
  let properties = match properties {
    Value::Object(map) => map,
    _ => Map::new(),
  };
  store.events.push(QueuedEvent {
    event: event.into(),
    timestamp: Utc::now().to_rfc3339(),
    properties,
  });
}

/// The app ran today, whether or not anything was dictated.
pub fn record_active_day() {
  update(|store, config| {
    day_entry(store, today(), config);
  });
}

/// One finished hotkey session: the recording reached a final result or failed.
pub fn record_dictation(succeeded: bool) {
  update(|store, config| apply_dictation(store, config, today(), succeeded));
}

fn apply_dictation(store: &mut UsageStore, config: &AppConfig, date: NaiveDate, succeeded: bool) {
  let day = day_entry(store, date, config);
  if succeeded {
    day.dictations += 1;
  } else {
    day.failures += 1;
  }
  if !store.first_dictation_recorded {
    store.first_dictation_recorded = true;
    let result = if succeeded { "ok" } else { "error" };
    queue_event(store, "first_dictation", json!({ "result": result, "engine": engine_label(config) }));
  }
}

/// Characters typed into another app by a successful insertion.
pub fn record_inserted_chars(count: usize) {
  update(|store, config| {
    day_entry(store, today(), config).inserted_chars += count as u64;
  });
}

/// The onboarding wizard showed `step`. Each step is recorded once per install.
pub fn record_onboarding_step(step: &str) -> Result<(), String> {
  if !ONBOARDING_STEPS.contains(&step) {
    return Err(format!("unknown onboarding step: {step}"));
  }
  // Help replays the wizard on finished installs; those views are not onboarding.
  update(|store, config| {
    if !config.onboarding_completed {
      apply_onboarding_step(store, step);
    }
  });
  Ok(())
}

fn apply_onboarding_step(store: &mut UsageStore, step: &str) {
  if !STEPS_BEFORE_DISCLOSURE.contains(&step) {
    store.disclosure_seen = true;
  }
  if store.onboarding_steps.iter().any(|seen| seen == step) {
    return;
  }
  store.onboarding_steps.push(step.into());
  queue_event(store, "onboarding_step", json!({ "step": step }));
}

pub fn record_onboarding_completed() {
  update(|store, _| queue_event(store, "onboarding_completed", json!({})));
}

pub fn record_model_download(model: &str, result: DownloadResult) {
  update(|store, _| {
    queue_event(store, "model_download", json!({ "model": model, "result": result.as_str() }));
  });
}

/// Called when the user turns statistics off: nothing unsent survives, and a
/// later opt-in starts with a new install ID.
pub fn delete_local_data() {
  let _guard = usage_lock();
  match usage_path() {
    Ok(path) => match std::fs::remove_file(&path) {
      Ok(()) => log::info!("usage: statistics turned off, local data deleted"),
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => log::warn!("usage: could not delete local data: {error}"),
    },
    Err(error) => log::warn!("usage: could not resolve data path: {error:#}"),
  }
}

fn common_properties() -> Map<String, Value> {
  let mut properties = Map::new();
  properties.insert("app_version".into(), json!(app_version()));
  properties.insert("os".into(), json!(std::env::consts::OS));
  properties.insert(
    "os_version".into(),
    json!(sysinfo::System::os_version().unwrap_or_default()),
  );
  properties.insert("arch".into(), json!(std::env::consts::ARCH));
  // No person profiles and no IP geolocation: events stay anonymous rows.
  properties.insert("$process_person_profile".into(), json!(false));
  properties.insert("$geoip_disable".into(), json!(true));
  properties
}

fn day_timestamp(date: NaiveDate) -> String {
  let noon = date.and_hms_opt(12, 0, 0).unwrap();
  Local
    .from_local_datetime(&noon)
    .earliest()
    .map(|time| time.to_rfc3339())
    .unwrap_or_else(|| Utc.from_utc_datetime(&noon).to_rfc3339())
}

/// What is sent next: every finished day and every queued event. With
/// `include_today`, today's running count is added so Settings can show it.
fn build_batch(store: &UsageStore, today: NaiveDate, include_today: bool) -> (Vec<Value>, Vec<String>, usize) {
  let common = common_properties();
  let mut batch = Vec::new();
  let mut sent_days = Vec::new();
  for (date_text, day) in &store.days {
    let Ok(date) = NaiveDate::parse_from_str(date_text, "%Y-%m-%d") else {
      continue;
    };
    let finished = date < today;
    if !finished && !(include_today && date == today) {
      continue;
    }
    let mut properties = common.clone();
    properties.insert("date".into(), json!(date_text));
    properties.insert("dictations".into(), json!(day.dictations));
    properties.insert("failures".into(), json!(day.failures));
    properties.insert("inserted_chars".into(), json!(day.inserted_chars));
    properties.insert("engine".into(), json!(day.engine));
    // The version that ran that day, not the one sending it.
    properties.insert("app_version".into(), json!(day.app_version));
    batch.push(json!({
      "event": "daily_usage",
      "distinct_id": store.install_id,
      "timestamp": day_timestamp(date),
      "properties": properties,
    }));
    if finished {
      sent_days.push(date_text.clone());
    }
  }
  for event in &store.events {
    let mut properties = common.clone();
    properties.extend(event.properties.clone());
    batch.push(json!({
      "event": event.event,
      "distinct_id": store.install_id,
      "timestamp": event.timestamp,
      "properties": properties,
    }));
  }
  (batch, sent_days, store.events.len())
}

/// Settings' "view what is sent": the exact rows of the next upload, with
/// today's running count included. The PostHog key is left out.
pub fn preview() -> Value {
  let enabled = settings::read_config().map(|config| config.usage_stats).unwrap_or(false);
  let store = usage_path()
    .map(|path| {
      let _guard = usage_lock();
      read_store(&path)
    })
    .unwrap_or_default();
  let (batch, _, _) = build_batch(&store, today(), true);
  json!({
    "enabled": enabled,
    "endpoint": format!("{POSTHOG_HOST}/batch/"),
    "batch": batch,
  })
}

fn sending_configured() -> Option<&'static str> {
  if env!("TYPEALOUD_BUILD_CHANNEL") != "official" {
    return None;
  }
  POSTHOG_KEY.filter(|key| !key.trim().is_empty())
}

async fn send_pending() -> Result<()> {
  let Some(key) = sending_configured() else {
    return Ok(());
  };
  let config = settings::read_config()?;
  if !config.usage_stats {
    return Ok(());
  }
  let path = usage_path()?;
  let (batch, sent_days, sent_events) = {
    let _guard = usage_lock();
    let store = read_store(&path);
    if store.install_id.is_empty() || !(config.onboarding_completed || store.disclosure_seen) {
      return Ok(());
    }
    build_batch(&store, today(), false)
  };
  if batch.is_empty() {
    return Ok(());
  }

  let response = reqwest::Client::new()
    .post(format!("{POSTHOG_HOST}/batch/"))
    .timeout(SEND_TIMEOUT)
    .json(&json!({ "api_key": key, "batch": batch }))
    .send()
    .await
    .context("usage upload failed")?;
  if !response.status().is_success() {
    anyhow::bail!("usage upload returned {}", response.status());
  }

  // Remove exactly what was sent. Events queued meanwhile sit after them, and
  // a finished day is never written again. The setting may have been turned
  // off during the upload; then the file is already gone and stays gone.
  let _guard = usage_lock();
  if !settings::read_config().map(|config| config.usage_stats).unwrap_or(false) {
    return Ok(());
  }
  let mut store = read_store(&path);
  for date in &sent_days {
    store.days.remove(date);
  }
  let sent_events = sent_events.min(store.events.len());
  store.events.drain(..sent_events);
  write_store(&path, &store)?;
  log::info!("usage: sent {} rows", batch.len());
  Ok(())
}

/// Mark today active at startup and hourly, and upload whatever is due.
pub fn spawn_periodic_sends() {
  tauri::async_runtime::spawn(async {
    tokio::time::sleep(STARTUP_SEND_DELAY).await;
    loop {
      record_active_day();
      if let Err(error) = send_pending().await {
        log::warn!("usage: {error:#}");
      }
      tokio::time::sleep(SEND_INTERVAL).await;
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn config() -> AppConfig {
    let mut config = AppConfig::default();
    config.provider = "local".into();
    config.model = "qwen3-asr-0.6b-q8_0".into();
    config
  }

  fn date(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
  }

  #[test]
  fn counts_land_on_their_day_and_only_finished_days_are_sent() {
    let config = config();
    let mut store = UsageStore { install_id: "id".into(), ..Default::default() };
    apply_dictation(&mut store, &config, date("2026-09-28"), true);
    apply_dictation(&mut store, &config, date("2026-09-28"), false);
    apply_dictation(&mut store, &config, date("2026-09-29"), true);

    let (batch, sent_days, _) = build_batch(&store, date("2026-09-29"), false);
    let daily: Vec<_> = batch.iter().filter(|row| row["event"] == "daily_usage").collect();
    assert_eq!(daily.len(), 1);
    assert_eq!(daily[0]["properties"]["date"], "2026-09-28");
    assert_eq!(daily[0]["properties"]["dictations"], 1);
    assert_eq!(daily[0]["properties"]["failures"], 1);
    assert_eq!(daily[0]["properties"]["engine"], "local/qwen3-asr-0.6b-q8_0");
    assert_eq!(sent_days, vec!["2026-09-28".to_string()]);

    let (preview, sent_with_today, _) = build_batch(&store, date("2026-09-29"), true);
    assert_eq!(preview.iter().filter(|row| row["event"] == "daily_usage").count(), 2);
    // Today shows in the preview but is never marked as sent.
    assert_eq!(sent_with_today, vec!["2026-09-28".to_string()]);
  }

  #[test]
  fn first_dictation_is_queued_once() {
    let config = config();
    let mut store = UsageStore::default();
    apply_dictation(&mut store, &config, date("2026-09-29"), false);
    apply_dictation(&mut store, &config, date("2026-09-29"), true);
    let firsts: Vec<_> = store.events.iter().filter(|event| event.event == "first_dictation").collect();
    assert_eq!(firsts.len(), 1);
    assert_eq!(firsts[0].properties["result"], "error");
  }

  #[test]
  fn onboarding_steps_dedupe_and_mark_disclosure_after_the_privacy_page() {
    let mut store = UsageStore::default();
    apply_onboarding_step(&mut store, "welcome");
    apply_onboarding_step(&mut store, "privacy");
    assert!(!store.disclosure_seen);
    apply_onboarding_step(&mut store, "engine");
    apply_onboarding_step(&mut store, "engine");
    assert!(store.disclosure_seen);
    assert_eq!(store.events.len(), 3);
    assert!(record_onboarding_step("private text").is_err());
  }

  #[test]
  fn rows_carry_only_counts_and_fixed_labels() {
    let config = config();
    let mut store = UsageStore { install_id: "id".into(), ..Default::default() };
    apply_dictation(&mut store, &config, date("2026-09-28"), true);
    let (batch, _, _) = build_batch(&store, date("2026-09-29"), false);
    let mut keys: Vec<_> = batch[0]["properties"].as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(
      keys,
      [
        "$geoip_disable", "$process_person_profile", "app_version", "arch", "date", "dictations",
        "engine", "failures", "inserted_chars", "os", "os_version",
      ]
    );
  }

  #[test]
  fn unsent_backlog_is_capped() {
    let config = config();
    let mut store = UsageStore::default();
    let start = date("2026-01-01");
    for offset in 0..40 {
      apply_dictation(&mut store, &config, start + chrono::Days::new(offset), true);
    }
    for _ in 0..60 {
      queue_event(&mut store, "onboarding_completed", json!({}));
    }
    prune(&mut store);
    assert_eq!(store.days.len(), MAX_UNSENT_DAYS);
    assert_eq!(store.days.keys().next().unwrap(), "2026-01-11");
    assert_eq!(store.events.len(), MAX_QUEUED_EVENTS);
  }

  #[test]
  fn update_at_creates_an_install_id_and_persists() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(USAGE_FILE_NAME);
    let config = config();
    update_at(&path, &config, |store, config| apply_dictation(store, config, date("2026-09-29"), true)).unwrap();
    let store = read_store(&path);
    assert_eq!(store.install_id.len(), 36);
    assert_eq!(store.days["2026-09-29"].dictations, 1);
  }
}

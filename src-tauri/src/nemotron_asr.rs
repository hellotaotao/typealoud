//! Nemotron 3.5 streaming ASR runtime, assets, and realtime sessions.

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::Digest;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Emitter;
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_util::sync::CancellationToken;

use crate::local_asr::{Asset, ModelStatus, NEMOTRON_MODEL_ID};

const MODEL_FILE: &str = "models/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf";
/// Extraction directory id. Bumping it (a new upstream version) makes every
/// installed client re-extract instead of trusting whatever is already there.
const RUNTIME_BUILD: &str = "nemo-speech-0.1.0";
const MODEL_SIZE: u64 = 741_548_352;
const MODEL_SHA256: &str = "a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae";
const PROGRESS_EMIT_STEP: u64 = 8 * 1024 * 1024;
const SIDECAR_READY_TIMEOUT: Duration = Duration::from_secs(60);
const FINAL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PCM_CHUNK_BYTES: usize = 512 * 1024;
const BALANCED_RIGHT_CONTEXT: &str = "6";
const ACCURACY_RIGHT_CONTEXT: &str = "13";

static MODEL_ASSET: Asset = Asset {
  rel_path: MODEL_FILE,
  urls: &[
    "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/1c8deaecc64b91f034d73e08dd8b64625eb3395d/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf",
  ],
  bundled: None,
  size: MODEL_SIZE,
  sha256: MODEL_SHA256,
};

/// Everything about the runtime that differs per platform.
///
/// TypeAloud used to compile its own macOS runtime from NeMo-Speech.cpp. That is
/// gone: the pinned source commit turned out to *be* upstream's v0.1.0 tag, and
/// upstream's archives are self-contained — SentencePiece linked statically (no
/// Homebrew dylib, which is what the private build's patches existed to avoid),
/// an `@loader_path/../lib` rpath, ad-hoc signed, and on Windows the MSVC and
/// OpenMP runtimes shipped alongside. Building it privately only re-derived
/// packaging upstream had already done, which is the same conclusion
/// `vendor/llama.cpp/README.md` records for the other local engine.
struct RuntimeSpec {
  /// Upstream's release archive: tarball on unix, real zip on Windows.
  asset: Asset,
  /// The executable's path inside the extracted tree. Kept as shipped — the
  /// binary finds its dylibs through `@loader_path/../lib`, so flattening the
  /// layout (as the llama.cpp extractor does) would break it.
  exe: &'static str,
  /// ggml backend. Metal on Apple Silicon; Windows has no measured GPU path,
  /// so it runs on CPU.
  device: &'static str,
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
static RUNTIME: Option<RuntimeSpec> = Some(RuntimeSpec {
  asset: Asset {
    rel_path: "runtime/nemo-speech-0.1.0-macos-aarch64-metal.tar.gz",
    urls: &[
      "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-macos-aarch64-metal.tar.gz",
      "https://typealoud.app/download/runtime/nemo-speech/v0.1.0/nemo-speech-0.1.0-macos-aarch64-metal.tar.gz",
    ],
    bundled: None,
    size: 3_465_028,
    sha256: "f1dff4f9dd9c96214f8cb78b982812459132df8a4ad1a42409fd94de4a366244",
  },
  exe: "bin/nemo-speech",
  device: "metal",
});

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
static RUNTIME: Option<RuntimeSpec> = Some(RuntimeSpec {
  asset: Asset {
    rel_path: "runtime/nemo-speech-0.1.0-windows-x86_64-cpu.zip",
    urls: &[
      "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-windows-x86_64-cpu.zip",
      "https://typealoud.app/download/runtime/nemo-speech/v0.1.0/nemo-speech-0.1.0-windows-x86_64-cpu.zip",
    ],
    bundled: None,
    size: 4_730_421,
    sha256: "5e4ea81046012edcd77fd8848de8eefb5a4ba38cc26f52eb544ab184695a75d6",
  },
  // The zip has no top-level directory: bin\ holds nemo-speech.exe next to
  // every DLL it loads, MSVC and OpenMP runtimes included, so there is no
  // redistributable to install.
  exe: "bin/nemo-speech.exe",
  device: "cpu",
});

#[cfg(not(any(
  all(target_os = "macos", target_arch = "aarch64"),
  all(target_os = "windows", target_arch = "x86_64")
)))]
static RUNTIME: Option<RuntimeSpec> = None;

/// Whether this build can run Nemotron at all — i.e. whether upstream publishes
/// a runtime for it that TypeAloud wires up. Where it doesn't, the engine is not
/// merely undownloaded but unavailable, and no UI offers it.
pub fn supported() -> bool {
  RUNTIME.is_some()
}

fn runtime() -> Result<&'static RuntimeSpec, String> {
  RUNTIME.as_ref().ok_or_else(|| UNSUPPORTED.to_string())
}

const UNSUPPORTED: &str = "Nemotron is not available on this platform";

fn base_dir() -> Result<PathBuf> {
  crate::local_asr::local_asr_dir()
}

fn runtime_dir(base: &Path) -> PathBuf {
  base.join("bin").join(RUNTIME_BUILD)
}

fn runtime_path(base: &Path) -> PathBuf {
  let exe = RUNTIME.as_ref().map(|spec| spec.exe).unwrap_or("bin/nemo-speech");
  runtime_dir(base).join(exe)
}

fn runtime_archive_path(base: &Path) -> PathBuf {
  base.join(RUNTIME.as_ref().map(|spec| spec.asset.rel_path).unwrap_or("runtime/none"))
}

fn runtime_stamp_path(base: &Path) -> PathBuf {
  runtime_dir(base).join(crate::local_asr::RUNTIME_STAMP_FILE)
}

fn model_path(base: &Path) -> PathBuf {
  base.join(MODEL_FILE)
}

fn exact_file(path: &Path, size: u64) -> bool {
  fs::metadata(path)
    .map(|metadata| metadata.is_file() && metadata.len() == size)
    .unwrap_or(false)
}

fn asset_part_path(path: &Path) -> PathBuf {
  path.with_file_name(format!(
    "{}.part",
    path.file_name().and_then(|name| name.to_str()).unwrap_or("")
  ))
}

fn sha256_file(path: &Path) -> Result<String, String> {
  let mut hasher = sha2::Sha256::new();
  let mut reader = fs::File::open(path).map_err(|error| error.to_string())?;
  std::io::copy(&mut reader, &mut hasher).map_err(|error| error.to_string())?;
  Ok(format!("{:x}", hasher.finalize()))
}

/// A completed runtime archive is reusable only after both its size and digest
/// match the manifest. Invalid regular files are removed so the next download
/// can replace them on Windows, where rename does not overwrite an existing
/// destination.
fn runtime_archive_verified_at(base: &Path) -> Result<bool, String> {
  let spec = runtime()?;
  let path = runtime_archive_path(base);
  let metadata = match fs::symlink_metadata(&path) {
    Ok(metadata) => metadata,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
    Err(error) => return Err(error.to_string()),
  };
  if !metadata.file_type().is_file() {
    return Err(format!(
      "runtime archive path is not a regular file: {}",
      path.display()
    ));
  }
  if metadata.len() != spec.asset.size || sha256_file(&path)? != spec.asset.sha256 {
    log::warn!("nemotron: discarding an invalid completed runtime archive");
    fs::remove_file(&path).map_err(|error| error.to_string())?;
    return Ok(false);
  }
  Ok(true)
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  fs::metadata(path)
    .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
    .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
  true
}

fn runtime_ready_at(base: &Path) -> bool {
  let executable = runtime_path(base);
  fs::metadata(&executable)
    .map(|metadata| metadata.is_file())
    .unwrap_or(false)
    && is_executable(&executable)
    && crate::local_asr::read_runtime_stamp(&runtime_stamp_path(base))
      .map(|stamp| Some(stamp.trim()) == RUNTIME.as_ref().map(|spec| spec.asset.sha256))
      .unwrap_or(false)
}

pub fn assets_ready_at(base: &Path) -> bool {
  supported() && exact_file(&model_path(base), MODEL_SIZE) && runtime_ready_at(base)
}

pub fn assets_ready() -> bool {
  if !supported() {
    return false;
  }
  base_dir()
    .map(|base| {
      // Cheap no-op unless the archive is downloaded and not yet unpacked.
      if let Err(error) = ensure_runtime_at(&base) {
        log::warn!("nemotron: failed to install the downloaded runtime: {error}");
      }
      assets_ready_at(&base)
    })
    .unwrap_or(false)
}

fn runtime_size() -> u64 {
  RUNTIME.as_ref().map(|spec| spec.asset.size).unwrap_or(0)
}

fn total_bytes() -> u64 {
  MODEL_SIZE + runtime_size()
}

fn asset_downloaded_bytes(path: &Path, size: u64) -> u64 {
  if exact_file(path, size) {
    size
  } else {
    let completed = fs::metadata(path)
      .map(|metadata| metadata.len())
      .unwrap_or(0)
      .min(size);
    let partial = fs::metadata(asset_part_path(path))
      .map(|metadata| metadata.len())
      .unwrap_or(0)
      .min(size);
    completed.saturating_add(partial).min(size)
  }
}

fn model_downloaded_bytes_at(base: &Path) -> u64 {
  asset_downloaded_bytes(&model_path(base), MODEL_SIZE)
}

fn runtime_downloaded_bytes_at(base: &Path) -> u64 {
  asset_downloaded_bytes(&runtime_archive_path(base), runtime_size())
}

fn downloaded_bytes_at(base: &Path) -> u64 {
  model_downloaded_bytes_at(base) + runtime_downloaded_bytes_at(base)
}

pub fn model_status(downloading: bool) -> ModelStatus {
  if !supported() {
    return ModelStatus {
      state: "unsupported".into(),
      downloaded_bytes: 0,
      total_bytes: total_bytes(),
    };
  }
  let Ok(base) = base_dir() else {
    return ModelStatus {
      state: "absent".into(),
      downloaded_bytes: 0,
      total_bytes: total_bytes(),
    };
  };
  let _ = ensure_runtime_at(&base);
  let downloaded = downloaded_bytes_at(&base);
  let state = if downloading {
    "downloading"
  } else if assets_ready_at(&base) {
    "ready"
  } else if downloaded > 0 {
    "partial"
  } else {
    "absent"
  };
  ModelStatus {
    state: state.into(),
    downloaded_bytes: downloaded,
    total_bytes: total_bytes(),
  }
}

fn emit_progress(app: &tauri::AppHandle, state: &str, downloaded: u64, message: Option<&str>) {
  let _ = app.emit(
    "local-model-download-progress",
    json!({
      "model": NEMOTRON_MODEL_ID,
      "state": state,
      "downloadedBytes": downloaded,
      "totalBytes": total_bytes(),
      "message": message,
    }),
  );
}

pub async fn download_model(
  app: tauri::AppHandle,
  cancel: CancellationToken,
) -> Result<(), String> {
  let spec = runtime()?;
  let base = base_dir().map_err(|error| error.to_string())?;
  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    .build()
    .map_err(|error| error.to_string())?;
  // Runtime first: it is a thousandth of the model's size, so a broken release
  // URL or a hostile network fails in seconds instead of after a 741 MB wait.
  if !runtime_archive_verified_at(&base)? {
    // Progress is aggregate, not download-order based. In particular, an old
    // Mac install can already have the full model while only the new runtime is
    // missing, so its first runtime event must stay near 100% rather than fall
    // back to zero.
    let already = model_downloaded_bytes_at(&base);
    download_asset(&app, &client, &base, &spec.asset, already, &cancel).await?;
  }
  if !exact_file(&model_path(&base), MODEL_SIZE) {
    let already = runtime_downloaded_bytes_at(&base);
    download_asset(&app, &client, &base, &MODEL_ASSET, already, &cancel).await?;
  }
  ensure_runtime_at(&base)?;
  Ok(())
}

/// `already` is the number of bytes the other asset contributes, so progress
/// stays aggregate even when an upgrade downloads the runtime after the model
/// is already present.
async fn download_asset(
  app: &tauri::AppHandle,
  client: &reqwest::Client,
  base: &Path,
  asset: &Asset,
  already: u64,
  cancel: &CancellationToken,
) -> Result<(), String> {
  use std::io::Write;

  let final_path = base.join(asset.rel_path);
  let part_path = asset_part_path(&final_path);
  if let Some(parent) = part_path.parent() {
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
  }
  let mut last_error = String::new();
  for url in asset.urls {
    if cancel.is_cancelled() {
      return Err("DOWNLOAD_CANCELLED".into());
    }
    let existing = fs::metadata(&part_path)
      .map(|metadata| metadata.len())
      .unwrap_or(0);
    let offset = if existing > asset.size { 0 } else { existing };
    let stream_result = async {
      if offset == asset.size {
        return Ok(());
      }
      let mut request = client.get(*url);
      if offset > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
      }
      let mut response = request.send().await.map_err(|error| error.to_string())?;
      if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
      }
      let append = offset > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
      let mut output = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&part_path)
        .map_err(|error| error.to_string())?;
      let mut written = if append { offset } else { 0 };
      let mut last_emit = written;
      loop {
        let chunk = tokio::select! {
          _ = cancel.cancelled() => return Err("DOWNLOAD_CANCELLED".into()),
          chunk = response.chunk() => chunk.map_err(|error| error.to_string())?,
        };
        let Some(chunk) = chunk else { break };
        output
          .write_all(&chunk)
          .map_err(|error| error.to_string())?;
        written += chunk.len() as u64;
        if written.saturating_sub(last_emit) >= PROGRESS_EMIT_STEP {
          last_emit = written;
          emit_progress(app, "downloading", already + written.min(asset.size), None);
        }
      }
      output.flush().map_err(|error| error.to_string())?;
      Ok(())
    }
    .await;

    match stream_result {
      Ok(()) => {
        let got = fs::metadata(&part_path)
          .map(|metadata| metadata.len())
          .unwrap_or(0);
        if got != asset.size {
          last_error = format!("size mismatch {got} != {}", asset.size);
          let _ = fs::remove_file(&part_path);
          continue;
        }
        let hash_path = part_path.clone();
        let hash = tokio::task::spawn_blocking(move || sha256_file(&hash_path))
          .await
          .map_err(|error| error.to_string())??;
        if hash != asset.sha256 {
          last_error = "sha256 mismatch".into();
          let _ = fs::remove_file(&part_path);
          continue;
        }
        fs::rename(&part_path, &final_path).map_err(|error| error.to_string())?;
        emit_progress(app, "downloading", already + asset.size, None);
        return Ok(());
      }
      Err(error) if error == "DOWNLOAD_CANCELLED" => return Err(error),
      Err(error) => {
        last_error = format!("{url}: {error}");
        log::warn!("nemotron: download source failed: {last_error}");
      }
    }
  }
  Err(format!(
    "failed to download {}: {last_error}",
    asset.rel_path
  ))
}

/// Unpack the downloaded archive when it is present and not already
/// installed. A no-op (not an error) before the download runs, so readiness
/// checks can call it freely.
fn ensure_runtime_at(base: &Path) -> Result<(), String> {
  let spec = runtime()?;
  if runtime_ready_at(base) {
    return Ok(());
  }
  let archive = runtime_archive_path(base);
  if !runtime_archive_verified_at(base)? {
    return Ok(());
  }
  extract_runtime(base, &archive)?;
  if !runtime_path(base).is_file() {
    return Err(format!("runtime archive did not contain {}", spec.exe));
  }
  fs::write(runtime_stamp_path(base), spec.asset.sha256).map_err(|error| error.to_string())?;
  Ok(())
}

/// Where an archive entry lands, or None if it should be skipped. The macOS
/// tarball nests everything under a nemo-speech/ directory and the Windows zip
/// does not, so that leading component is dropped when present. Absolute paths
/// and .. are refused: a hostile archive must not escape the runtime directory.
fn entry_destination(out_dir: &Path, name: &str) -> Option<PathBuf> {
  let normalized = name.replace('\\', "/");
  // Reject Unix roots, UNC/device roots after normalization, Windows drive
  // prefixes and alternate-data-stream syntax on every host. Checking this as
  // text keeps a Windows archive equally safe when tests run on macOS.
  if normalized.starts_with('/')
    || normalized.split('/').any(|part| part.contains(':'))
  {
    return None;
  }
  let mut parts = normalized
    .split('/')
    .filter(|part| !part.is_empty() && *part != ".")
    .peekable();
  let mut path = out_dir.to_path_buf();
  let mut pushed = 0;
  if parts.peek() == Some(&"nemo-speech") {
    parts.next();
  }
  for part in parts {
    if part == ".." {
      return None;
    }
    path.push(part);
    pushed += 1;
  }
  (pushed > 0).then_some(path)
}

#[cfg(unix)]
fn symlink_target_stays_within(out_dir: &Path, link_path: &Path, target: &Path) -> bool {
  use std::path::Component;

  if target.is_absolute() {
    return false;
  }
  let Some(parent) = link_path.parent() else {
    return false;
  };
  let Ok(relative_parent) = parent.strip_prefix(out_dir) else {
    return false;
  };
  let mut depth = relative_parent.components().count();
  for component in target.components() {
    match component {
      Component::CurDir => {}
      Component::Normal(_) => depth += 1,
      Component::ParentDir if depth > 0 => depth -= 1,
      Component::ParentDir | Component::RootDir | Component::Prefix(_) => return false,
    }
  }
  true
}

#[cfg(unix)]
fn extract_runtime(base: &Path, archive_path: &Path) -> Result<(), String> {
  use std::os::unix::fs::PermissionsExt;

  let output_dir = runtime_dir(base);
  let _ = fs::remove_dir_all(&output_dir);
  fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
  let file = fs::File::open(archive_path).map_err(|error| error.to_string())?;
  let decoder = flate2::read::GzDecoder::new(file);
  let mut archive = tar::Archive::new(decoder);
  for entry in archive.entries().map_err(|error| error.to_string())? {
    let mut entry = entry.map_err(|error| error.to_string())?;
    let entry_type = entry.header().entry_type();
    let raw = entry
      .path()
      .map_err(|error| error.to_string())?
      .to_string_lossy()
      .into_owned();
    let Some(out_path) = entry_destination(&output_dir, &raw) else {
      continue;
    };
    if let Some(parent) = out_path.parent() {
      fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // The compat symlinks (libggml.0.dylib -> libggml.0.12.0.dylib) are what
    // the binary actually loads, so they have to survive extraction.
    if entry_type.is_symlink() {
      if let Some(target) = entry.link_name().map_err(|error| error.to_string())? {
        if !symlink_target_stays_within(&output_dir, &out_path, target.as_ref()) {
          return Err(format!("runtime archive contained an unsafe symlink: {raw}"));
        }
        let _ = fs::remove_file(&out_path);
        std::os::unix::fs::symlink(target.as_ref(), &out_path)
          .map_err(|error| error.to_string())?;
      }
      continue;
    }
    if !entry_type.is_file() {
      continue;
    }
    let mut out = fs::File::create(&out_path).map_err(|error| error.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|error| error.to_string())?;
    fs::set_permissions(&out_path, fs::Permissions::from_mode(0o755))
      .map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[cfg(windows)]
fn extract_runtime(base: &Path, archive_path: &Path) -> Result<(), String> {
  let output_dir = runtime_dir(base);
  let _ = fs::remove_dir_all(&output_dir);
  fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;
  let file = fs::File::open(archive_path).map_err(|error| error.to_string())?;
  let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
  for index in 0..archive.len() {
    let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
    if entry.is_dir() || entry.is_symlink() {
      continue;
    }
    // This archive stores its paths with backslashes, which the zip crate
    // returns verbatim; entry_destination normalizes them.
    let Some(out_path) = entry_destination(&output_dir, entry.name()) else {
      continue;
    };
    if let Some(parent) = out_path.parent() {
      fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut out = fs::File::create(&out_path).map_err(|error| error.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|error| error.to_string())?;
  }
  Ok(())
}

#[derive(Clone)]
struct SidecarEndpoint {
  port: u16,
  token: String,
}

struct Sidecar {
  child: Child,
  endpoint: SidecarEndpoint,
  right_context: &'static str,
}

static SIDECAR: Mutex<Option<Sidecar>> = Mutex::const_new(None);
static LIVE_SESSIONS: OnceLock<Mutex<HashMap<u64, mpsc::Sender<LiveCommand>>>> = OnceLock::new();
static TOKEN_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn live_sessions() -> &'static Mutex<HashMap<u64, mpsc::Sender<LiveCommand>>> {
  LIVE_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

enum LiveCommand {
  Audio(Vec<u8>),
  Commit(oneshot::Sender<Result<String, String>>),
  Cancel,
}

#[derive(Debug, PartialEq, Eq)]
enum ServerEvent {
  Ignore,
  Partial(String),
  Final(String),
  Committed,
  Error(String),
}

fn parse_server_event(text: &str, partial: &mut String) -> ServerEvent {
  let Ok(event) = serde_json::from_str::<Value>(text) else {
    return ServerEvent::Ignore;
  };
  match event
    .get("type")
    .and_then(Value::as_str)
    .unwrap_or_default()
  {
    "conversation.item.input_audio_transcription.delta" => {
      if let Some(delta) = event.get("delta").and_then(Value::as_str) {
        partial.push_str(delta);
      }
      ServerEvent::Partial(partial.clone())
    }
    "conversation.item.input_audio_transcription.completed" => ServerEvent::Final(
      event
        .get("transcript")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string(),
    ),
    "input_audio_buffer.committed" => ServerEvent::Committed,
    "error" => ServerEvent::Error(
      event
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("Nemotron realtime session failed")
        .to_string(),
    ),
    _ => ServerEvent::Ignore,
  }
}

fn next_token() -> String {
  let seed = format!(
    "{}:{}:{}",
    std::process::id(),
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap_or_default()
      .as_nanos(),
    TOKEN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
  );
  format!("{:x}", sha2::Sha256::digest(seed.as_bytes()))
}

fn reserve_loopback_port() -> Result<u16> {
  let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
  Ok(listener.local_addr()?.port())
}

fn right_context_for_latency_ms(latency_ms: u32) -> &'static str {
  match crate::settings::normalize_nemotron_latency_ms(latency_ms) {
    crate::settings::NEMOTRON_ACCURACY_LATENCY_MS => ACCURACY_RIGHT_CONTEXT,
    _ => BALANCED_RIGHT_CONTEXT,
  }
}

fn session_update(sample_rate: u32, language: &str) -> Value {
  let language = if language.trim().is_empty() {
    "auto"
  } else {
    language.trim()
  };
  json!({
    "type": "session.update",
    "session": {
      "sample_rate": sample_rate,
      "language": language,
      "automatic_punctuation": true,
    },
  })
}

// `serve --threads` sizes the HTTP worker pool, not ggml inference threads.
// Keep the existing two-worker behavior on both platforms; backend compute
// parallelism is managed independently by NeMo-Speech.cpp.
const HTTP_WORKER_THREADS: &str = "2";

fn sidecar_command(program: PathBuf) -> tokio::process::Command {
  let command = tokio::process::Command::new(program);
  #[cfg(target_os = "windows")]
  {
    let mut command = command;
    // nemo-speech is a console executable; without CREATE_NO_WINDOW Windows
    // flashes a terminal on every prewarm and can steal focus from the app
    // that is about to receive the text.
    command.creation_flags(0x0800_0000);
    command
  }
  #[cfg(not(target_os = "windows"))]
  {
    command
  }
}

async fn ensure_sidecar(latency_ms: u32) -> Result<SidecarEndpoint> {
  if !assets_ready() {
    anyhow::bail!("LOCAL_MODEL_MISSING: Nemotron assets are missing or incomplete");
  }
  let right_context = right_context_for_latency_ms(latency_ms);
  let mut slot = SIDECAR.lock().await;
  if let Some(sidecar) = slot.as_mut() {
    if matches!(sidecar.child.try_wait(), Ok(None)) && sidecar.right_context == right_context {
      return Ok(sidecar.endpoint.clone());
    }
    let _ = sidecar.child.start_kill();
    slot.take();
  }

  let spec = runtime().map_err(|error| anyhow::anyhow!(error))?;
  let base = base_dir()?;
  let port = reserve_loopback_port()?;
  let token = next_token();
  let mut child = sidecar_command(runtime_path(&base))
    .arg("serve")
    .arg("--host")
    .arg("127.0.0.1")
    .arg("--port")
    .arg(port.to_string())
    .arg("--threads")
    .arg(HTTP_WORKER_THREADS)
    .arg("--max-upload-mb")
    .arg("64")
    .arg("--read-timeout")
    .arg("120")
    .arg("--write-timeout")
    .arg("120")
    .arg("--no-ui")
    .arg("--asr-model")
    .arg(model_path(&base))
    .arg("--device")
    .arg(spec.device)
    .arg("--asr.streaming.rnnt_right_context")
    .arg(right_context)
    .env("NEMO_SPEECH_HTTP_API_KEY", &token)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .kill_on_drop(true)
    .spawn()
    .context("failed to start the Nemotron runtime")?;

  let endpoint = SidecarEndpoint { port, token };
  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_millis(300))
    .timeout(Duration::from_secs(2))
    .build()?;
  let started = std::time::Instant::now();
  loop {
    if let Some(status) = child.try_wait()? {
      anyhow::bail!("Nemotron runtime exited during startup ({status})");
    }
    let ready = client
      .get(format!("http://127.0.0.1:{port}/ready"))
      .send()
      .await
      .map(|response| response.status().is_success())
      .unwrap_or(false);
    if ready {
      break;
    }
    if started.elapsed() >= SIDECAR_READY_TIMEOUT {
      let _ = child.start_kill();
      anyhow::bail!("Nemotron runtime did not become ready within 60 seconds");
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
  }

  log::info!(
    "nemotron: sidecar ready on loopback port {port} with right context {right_context}"
  );
  *slot = Some(Sidecar {
    child,
    endpoint: endpoint.clone(),
    right_context,
  });
  Ok(endpoint)
}

pub async fn prewarm(latency_ms: u32) -> Result<()> {
  ensure_sidecar(latency_ms).await.map(|_| ())
}

pub async fn start_live_session(
  app: tauri::AppHandle,
  session_id: u64,
  sample_rate: u32,
  language: String,
  latency_ms: u32,
) -> Result<(), String> {
  if !(8_000..=96_000).contains(&sample_rate) {
    return Err(format!("unsupported realtime sample rate: {sample_rate}"));
  }
  let endpoint = ensure_sidecar(latency_ms)
    .await
    .map_err(|error| error.to_string())?;
  let url = format!(
    "ws://127.0.0.1:{}/v1/realtime?api_key={}",
    endpoint.port, endpoint.token
  );
  let (mut socket, _) = tokio_tungstenite::connect_async(url)
    .await
    .map_err(|error| format!("failed to connect to Nemotron realtime API: {error}"))?;

  let created = tokio::time::timeout(Duration::from_secs(5), socket.next())
    .await
    .map_err(|_| "Nemotron realtime session did not initialize".to_string())?
    .ok_or_else(|| "Nemotron realtime socket closed during initialization".to_string())?
    .map_err(|error| error.to_string())?;
  let created_ok = match created {
    Message::Text(text) => {
      serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|value| {
          value
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_string)
        })
        .as_deref()
        == Some("session.created")
    }
    _ => false,
  };
  if !created_ok {
    return Err("Nemotron realtime API returned an invalid session handshake".into());
  }

  socket
    .send(Message::Text(
      session_update(sample_rate, &language).to_string(),
    ))
    .await
    .map_err(|error| error.to_string())?;

  let (tx, mut rx) = mpsc::channel::<LiveCommand>(32);
  if let Some(previous) = live_sessions().lock().await.insert(session_id, tx) {
    let _ = previous.send(LiveCommand::Cancel).await;
  }

  tauri::async_runtime::spawn(async move {
    let mut partial = String::new();
    let mut final_reply: Option<oneshot::Sender<Result<String, String>>> = None;
    loop {
      tokio::select! {
        command = rx.recv() => match command {
          Some(LiveCommand::Audio(bytes)) => {
            if let Err(error) = socket.send(Message::Binary(bytes)).await {
              if let Some(reply) = final_reply.take() {
                let _ = reply.send(Err(error.to_string()));
              }
              break;
            }
          }
          Some(LiveCommand::Commit(reply)) => {
            final_reply = Some(reply);
            if let Err(error) = socket.send(Message::Text(
              json!({ "type": "input_audio_buffer.commit" }).to_string()
            )).await {
              if let Some(reply) = final_reply.take() {
                let _ = reply.send(Err(error.to_string()));
              }
              break;
            }
          }
          Some(LiveCommand::Cancel) | None => {
            let _ = socket.send(Message::Text(
              json!({ "type": "response.cancel" }).to_string()
            )).await;
            if let Some(reply) = final_reply.take() {
              let _ = reply.send(Err("TRANSCRIPTION_CANCELLED".into()));
            }
            break;
          }
        },
        incoming = socket.next() => {
          let Some(incoming) = incoming else {
            if let Some(reply) = final_reply.take() {
              let _ = reply.send(Err("Nemotron realtime socket closed before final transcription".into()));
            }
            break;
          };
          match incoming {
            Ok(Message::Text(text)) => match parse_server_event(&text, &mut partial) {
              ServerEvent::Partial(text) if !text.is_empty() => {
                let _ = app.emit(
                  "local-transcription-partial",
                  json!({ "sessionId": session_id, "text": text, "engine": "nemotron" }),
                );
              }
              ServerEvent::Final(text) => {
                if let Some(reply) = final_reply.take() {
                  let _ = reply.send(Ok(text));
                }
              }
              ServerEvent::Error(error) => {
                if let Some(reply) = final_reply.take() {
                  let _ = reply.send(Err(error));
                }
                break;
              }
              _ => {}
            },
            Ok(Message::Close(_)) | Err(_) => {
              if let Some(reply) = final_reply.take() {
                let _ = reply.send(Err("Nemotron realtime socket closed before final transcription".into()));
              }
              break;
            }
            _ => {}
          }
        }
      }
    }
    let _ = socket.close(None).await;
  });
  Ok(())
}

pub async fn push_live_audio(session_id: u64, bytes: Vec<u8>) -> Result<(), String> {
  if bytes.is_empty() {
    return Ok(());
  }
  if bytes.len() > MAX_PCM_CHUNK_BYTES || bytes.len() % 2 != 0 {
    return Err("invalid PCM16 realtime audio chunk".into());
  }
  let sender = live_sessions()
    .lock()
    .await
    .get(&session_id)
    .cloned()
    .ok_or_else(|| "Nemotron realtime session is not active".to_string())?;
  sender
    .send(LiveCommand::Audio(bytes))
    .await
    .map_err(|_| "Nemotron realtime session closed".to_string())
}

pub async fn finish_live_session(session_id: u64) -> Result<String, String> {
  let sender = live_sessions()
    .lock()
    .await
    .get(&session_id)
    .cloned()
    .ok_or_else(|| "Nemotron realtime session is not active".to_string())?;
  let (reply_tx, reply_rx) = oneshot::channel();
  let result = if sender.send(LiveCommand::Commit(reply_tx)).await.is_err() {
    Err("Nemotron realtime session closed".to_string())
  } else {
    match tokio::time::timeout(FINAL_TIMEOUT, reply_rx).await {
      Ok(Ok(result)) => result,
      Ok(Err(_)) => Err("Nemotron realtime session closed".to_string()),
      Err(_) => Err("Nemotron final transcription timed out".to_string()),
    }
  };
  live_sessions().lock().await.remove(&session_id);
  let _ = sender.send(LiveCommand::Cancel).await;
  result
}

pub async fn cancel_live_session(session_id: u64) -> bool {
  let sender = live_sessions().lock().await.remove(&session_id);
  if let Some(sender) = sender {
    let _ = sender.send(LiveCommand::Cancel).await;
    true
  } else {
    false
  }
}

pub async fn transcribe_wav(
  wav: Vec<u8>,
  language: &str,
  latency_ms: u32,
) -> Result<String> {
  let endpoint = ensure_sidecar(latency_ms).await?;
  let part = reqwest::multipart::Part::bytes(wav)
    .file_name("audio.wav")
    .mime_str("audio/wav")?;
  let form = reqwest::multipart::Form::new()
    .part("file", part)
    .text(
      "language",
      if language.trim().is_empty() {
        "auto"
      } else {
        language
      }
      .to_string(),
    )
    .text("response_format", "json");
  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(5))
    .timeout(FINAL_TIMEOUT)
    .build()?;
  let response = client
    .post(format!(
      "http://127.0.0.1:{}/v1/audio/transcriptions",
      endpoint.port
    ))
    .bearer_auth(endpoint.token)
    .multipart(form)
    .send()
    .await?;
  let status = response.status();
  let body = response.text().await?;
  if !status.is_success() {
    anyhow::bail!("Nemotron transcription failed ({status}): {body}");
  }
  let value: Value = serde_json::from_str(&body)?;
  Ok(
    value
      .get("text")
      .and_then(Value::as_str)
      .unwrap_or_default()
      .to_string(),
  )
}

pub fn shutdown() {
  let mut sessions_pending = false;
  if let Some(sessions) = LIVE_SESSIONS.get() {
    if let Ok(mut sessions) = sessions.try_lock() {
      sessions.clear();
    } else {
      sessions_pending = true;
    }
  }
  let mut sidecar_pending = false;
  if let Ok(mut sidecar) = SIDECAR.try_lock() {
    if let Some(mut sidecar) = sidecar.take() {
      let _ = sidecar.child.start_kill();
    }
  } else {
    sidecar_pending = true;
  }

  if sessions_pending || sidecar_pending {
    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
      runtime.spawn(async move {
        if sessions_pending {
          live_sessions().lock().await.clear();
        }
        if sidecar_pending {
          if let Some(mut sidecar) = SIDECAR.lock().await.take() {
            let _ = sidecar.child.start_kill();
          }
        }
      });
    }
  }
}

pub fn delete_model() -> Result<(), String> {
  shutdown();
  let _sidecar_guard = SIDECAR
    .try_lock()
    .map_err(|_| "Nemotron runtime is busy; try deleting the model again shortly".to_string())?;
  let base = base_dir().map_err(|error| error.to_string())?;
  let _ = fs::remove_file(model_path(&base));
  let _ = fs::remove_file(base.join(format!("{MODEL_FILE}.part")));
  let archive = runtime_archive_path(&base);
  let _ = fs::remove_file(&archive);
  let _ = fs::remove_file(asset_part_path(&archive));
  match fs::remove_dir_all(runtime_dir(&base)) {
    Ok(()) => Ok(()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error.to_string()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn manifest_is_self_consistent() {
    assert_eq!(MODEL_ASSET.size, MODEL_SIZE);
    assert_eq!(MODEL_ASSET.sha256, MODEL_SHA256);
    assert_eq!(MODEL_SHA256.len(), 64);
    let Some(spec) = RUNTIME.as_ref() else {
      assert!(!supported());
      return;
    };
    assert_eq!(spec.asset.sha256.len(), 64);
    assert!(spec.asset.size > 0);
    assert!(!spec.asset.urls.is_empty());
    assert!(spec.asset.bundled.is_none(), "the runtime is downloaded, not shipped");
    assert!(spec.exe.starts_with("bin/"));
    assert!(matches!(spec.device, "metal" | "cpu"));
  }

  #[test]
  fn archive_entries_land_under_the_runtime_directory() {
    let out = Path::new("/runtime");
    // macOS tarball: the wrapping directory is dropped, the layout is kept.
    assert_eq!(
      entry_destination(out, "nemo-speech/bin/nemo-speech"),
      Some(out.join("bin").join("nemo-speech"))
    );
    assert_eq!(
      entry_destination(out, "nemo-speech/lib/libggml.0.dylib"),
      Some(out.join("lib").join("libggml.0.dylib"))
    );
    // Windows zip: no wrapping directory, backslash separators.
    assert_eq!(
      entry_destination(out, "bin\\nemo-speech.exe"),
      Some(out.join("bin").join("nemo-speech.exe"))
    );
    // Traversal and empty names are refused.
    assert_eq!(entry_destination(out, "../escape"), None);
    assert_eq!(entry_destination(out, "nemo-speech/../../escape"), None);
    assert_eq!(entry_destination(out, "nemo-speech/"), None);
    assert_eq!(entry_destination(out, "/absolute/escape"), None);
    assert_eq!(entry_destination(out, "C:\\absolute\\escape"), None);
    assert_eq!(entry_destination(out, "\\\\server\\share\\escape"), None);
    assert_eq!(entry_destination(out, "bin\\nemo-speech.exe:stream"), None);
  }

  #[test]
  fn completed_assets_require_the_expected_digest() {
    let temp = tempfile::TempDir::new().unwrap();
    let path = temp.path().join("asset");
    fs::write(&path, b"good").unwrap();
    let expected = format!("{:x}", sha2::Sha256::digest(b"good"));
    assert!(exact_file(&path, 4));
    assert_eq!(sha256_file(&path).unwrap(), expected);

    // Same length is not sufficient evidence that a completed file is valid.
    fs::write(&path, b"evil").unwrap();
    assert!(exact_file(&path, 4));
    assert_ne!(sha256_file(&path).unwrap(), expected);
  }

  #[cfg(unix)]
  #[test]
  fn symlink_targets_cannot_leave_the_runtime_directory() {
    let out = Path::new("/runtime");
    let link = out.join("lib").join("libggml.0.dylib");
    assert!(symlink_target_stays_within(out, &link, Path::new("libggml.0.12.0.dylib")));
    assert!(symlink_target_stays_within(out, &link, Path::new("../bin/nemo-speech")));
    assert!(!symlink_target_stays_within(out, &link, Path::new("../../escape")));
    assert!(!symlink_target_stays_within(out, &link, Path::new("/absolute/escape")));
  }

  #[test]
  fn invalid_completed_runtime_archive_is_removed_for_retry() {
    let Some(spec) = RUNTIME.as_ref() else {
      return;
    };
    let temp = tempfile::TempDir::new().unwrap();
    let path = runtime_archive_path(temp.path());
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::File::create(&path).unwrap().set_len(spec.asset.size).unwrap();

    assert!(!runtime_archive_verified_at(temp.path()).unwrap());
    assert!(
      !path.exists(),
      "an invalid final file would block rename on Windows"
    );
  }

  #[test]
  fn aggregate_progress_counts_an_existing_other_asset() {
    let temp = tempfile::TempDir::new().unwrap();
    let model = temp.path().join("model");
    fs::File::create(&model).unwrap().set_len(10).unwrap();
    assert_eq!(asset_downloaded_bytes(&model, 10), 10);

    let runtime = temp.path().join("runtime.zip");
    fs::File::create(asset_part_path(&runtime)).unwrap().set_len(3).unwrap();
    assert_eq!(asset_downloaded_bytes(&runtime, 5), 3);
    assert_eq!(
      asset_downloaded_bytes(&model, 10) + asset_downloaded_bytes(&runtime, 5),
      13
    );
  }

  #[test]
  fn streaming_profiles_map_to_the_supported_right_contexts() {
    assert_eq!(right_context_for_latency_ms(560), "6");
    assert_eq!(right_context_for_latency_ms(1_120), "13");
    assert_eq!(right_context_for_latency_ms(999), "6");
  }

  #[test]
  fn realtime_session_uses_the_selected_language() {
    let update = session_update(16_000, "zh");
    assert_eq!(update["session"]["language"], "zh");
    assert_eq!(session_update(16_000, "")["session"]["language"], "auto");
  }

  #[test]
  fn realtime_events_accumulate_partials_and_replace_them_with_the_final() {
    let mut partial = String::new();
    assert_eq!(
      parse_server_event(
        r#"{"type":"conversation.item.input_audio_transcription.delta","delta":"hello"}"#,
        &mut partial,
      ),
      ServerEvent::Partial("hello".into())
    );
    assert_eq!(
      parse_server_event(
        r#"{"type":"conversation.item.input_audio_transcription.delta","delta":" world"}"#,
        &mut partial,
      ),
      ServerEvent::Partial("hello world".into())
    );
    assert_eq!(
      parse_server_event(
        r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":"Hello world."}"#,
        &mut partial,
      ),
      ServerEvent::Final("Hello world.".into())
    );
  }

  #[test]
  fn qwen_files_do_not_make_nemotron_ready() {
    let temp = tempfile::TempDir::new().unwrap();
    let base = temp.path();
    let qwen = base.join(crate::local_asr::MODEL_ASSETS[0].rel_path);
    fs::create_dir_all(qwen.parent().unwrap()).unwrap();
    fs::File::create(qwen)
      .unwrap()
      .set_len(crate::local_asr::MODEL_ASSETS[0].size)
      .unwrap();
    assert!(!assets_ready_at(base));
  }
}

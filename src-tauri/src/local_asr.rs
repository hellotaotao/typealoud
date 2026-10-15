//! Local Qwen3-ASR backend (provider "local"): on-demand assets (2 GGUF files
//! + a pinned llama.cpp release binary), resumable downloads, and
//! inference via llama-mtmd-cli. A chat-mode worker is prewarmed and leased to
//! one recording session; a one-shot subprocess remains the compatibility
//! fallback. See docs/local-asr.md.
use anyhow::{Context, Result};
use serde::Serialize;
use sha2::Digest;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub const LOCAL_PROVIDER: &str = "local";
pub const QWEN_MODEL_ID: &str = "qwen3-asr-0.6b-q8_0";
pub const QWEN_LARGE_MODEL_ID: &str = "qwen3-asr-1.7b-q8_0";
pub const NEMOTRON_MODEL_ID: &str = "nemotron-3.5-asr-streaming-0.6b-q8_0";

pub fn normalize_local_model_id(model: &str) -> &'static str {
  match model.trim() {
    QWEN_LARGE_MODEL_ID => QWEN_LARGE_MODEL_ID,
    NEMOTRON_MODEL_ID => NEMOTRON_MODEL_ID,
    _ => QWEN_MODEL_ID,
  }
}
/// Pinned llama.cpp release. Must stay ≥ b9173 (Qwen3-ASR repetition fix,
/// ggml-org/llama.cpp#22357). Upgrading requires re-verifying CLI flags,
/// stdout format, all sha256s, and a real-dictation regression.
// Use upstream's official runtime on every platform. Worker reuse is bounded
// by one recording session and guarded by contamination detection below.
pub const LLAMA_BUILD: &str = "b9960";

pub struct Asset {
  /// Final location under local_asr_dir(); doubles as the download's .part
  /// sibling name. Forward slashes are fine in PathBuf::join on Windows.
  pub rel_path: &'static str,
  /// Try in order (mirror fallback); byte-identical across sources. Listed
  /// global-first; `ordered_urls` moves mainland-China mirrors to the front
  /// only on machines set to a mainland China time zone.
  pub urls: &'static [&'static str],
  /// A runtime carried inside the app instead of fetched from the network.
  pub bundled: Option<&'static [u8]>,
  pub size: u64,
  pub sha256: &'static str,
}

pub const MODEL_ASSETS: &[Asset] = &[
  Asset {
    rel_path: "models/Qwen3-ASR-0.6B-Q8_0.gguf",
    // ModelScope mirrors this repo (probed 2026-07-13, HTTP 200, identical
    // X-Linked-Etag). Hugging Face is unreachable from mainland China, where
    // `ordered_urls` tries ModelScope first; everywhere else HF leads.
    urls: &[
      "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/Qwen3-ASR-0.6B-Q8_0.gguf",
      "https://modelscope.cn/models/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/master/Qwen3-ASR-0.6B-Q8_0.gguf",
    ],
    bundled: None,
    size: 804_749_248,
    sha256: "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971",
  },
  Asset {
    rel_path: "models/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
    urls: &[
      "https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
      "https://modelscope.cn/models/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/master/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf",
    ],
    bundled: None,
    size: 214_392_480,
    sha256: "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d",
  },
];

pub const LARGE_MODEL_ASSETS: &[Asset] = &[
  Asset {
    rel_path: "models/Qwen3-ASR-1.7B-Q8_0.gguf",
    // Same ModelScope mirror and ordering as the 0.6B assets (probed
    // 2026-09-29: LFS object path and X-Linked-Etag equal the sha256 below).
    urls: &[
      "https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main/Qwen3-ASR-1.7B-Q8_0.gguf",
      "https://modelscope.cn/models/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/master/Qwen3-ASR-1.7B-Q8_0.gguf",
    ],
    bundled: None,
    size: 2_165_034_944,
    sha256: "58e22d0532d4eacaf034cfac17a6fed159f37c41390c710186783be439d1fc57",
  },
  Asset {
    rel_path: "models/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf",
    urls: &[
      "https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf",
      "https://modelscope.cn/models/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/master/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf",
    ],
    bundled: None,
    size: 355_709_344,
    sha256: "46c1d533af3f354ceb37ce855dbceff7da7fa7cf1e6a523df3b13440bd164c0d",
  },
];

fn qwen_assets(model: &str) -> &'static [Asset] {
  if normalize_local_model_id(model) == QWEN_LARGE_MODEL_ID {
    LARGE_MODEL_ASSETS
  } else {
    MODEL_ASSETS
  }
}

fn qwen_total_bytes(model: &str) -> u64 {
  qwen_assets(model).iter().map(|asset| asset.size).sum::<u64>() + llama_zip_asset().size
}

// One llama.cpp archive per platform; only the current platform's entry is
// used. macOS/Linux releases are gzip-compressed tarballs, Windows is a real
// zip -- rel_path/urls reflect each asset's actual file extension.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
static MAC_ZIP: Asset = Asset {
  rel_path: "llama-macos-arm64.tar.gz",
  urls: &[
    "https://github.com/ggml-org/llama.cpp/releases/download/b9960/llama-b9960-bin-macos-arm64.tar.gz",
    "https://typealoud.app/download/runtime/llama.cpp/b9960/llama-b9960-bin-macos-arm64.tar.gz",
  ],
  bundled: None,
  size: 10_734_569,
  sha256: "7a8c6b6ae3395e15b5cc330ed2938cc0aa4510905db1189658fd022035734b48",
};
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub fn llama_zip_asset() -> &'static Asset {
  &MAC_ZIP
}

// Intel-Mac slice of the universal binary. Never built by ci.yml (which is
// aarch64-only for macOS) — only the release's universal-apple-darwin build
// compiles this arch, so this gap first surfaced at the v1.4.0 release.
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
static MAC_ZIP: Asset = Asset {
  rel_path: "llama-macos-x64.tar.gz",
  urls: &[
    "https://github.com/ggml-org/llama.cpp/releases/download/b9960/llama-b9960-bin-macos-x64.tar.gz",
    "https://typealoud.app/download/runtime/llama.cpp/b9960/llama-b9960-bin-macos-x64.tar.gz",
  ],
  bundled: None,
  size: 11_007_527,
  sha256: "d42000ae003fd61d7db50997af0e80f421524e30b534856c66573d064a478c1d",
};
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
pub fn llama_zip_asset() -> &'static Asset {
  &MAC_ZIP
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
static WIN_ZIP: Asset = Asset {
  rel_path: "llama-win-x64.zip",
  urls: &[
    "https://github.com/ggml-org/llama.cpp/releases/download/b9960/llama-b9960-bin-win-cpu-x64.zip",
    "https://typealoud.app/download/runtime/llama.cpp/b9960/llama-b9960-bin-win-cpu-x64.zip",
  ],
  bundled: None,
  size: 18_209_357,
  sha256: "795333e29cedf9f9ef9ae91324bfa423e338d39d75cc63a8dd76d1686c32ced6",
};
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub fn llama_zip_asset() -> &'static Asset {
  &WIN_ZIP
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
static LINUX_ZIP: Asset = Asset {
  rel_path: "llama-linux-x64.tar.gz",
  urls: &[
    "https://github.com/ggml-org/llama.cpp/releases/download/b9960/llama-b9960-bin-ubuntu-x64.tar.gz",
    "https://typealoud.app/download/runtime/llama.cpp/b9960/llama-b9960-bin-ubuntu-x64.tar.gz",
  ],
  bundled: None,
  size: 15_819_482,
  sha256: "542732e344420ff904c1d72acfeef6341f509232c5d131809421943235a818a2",
};
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub fn llama_zip_asset() -> &'static Asset {
  &LINUX_ZIP
}

/// Optional GPU acceleration pack, downloaded only when the user asks for it.
/// It is the *same* llama.cpp build as the required CPU pack — upstream ships
/// one executable per platform and varies only the backend library beside it —
/// so this is that runtime plus `ggml-vulkan.dll`, extracted into its own
/// `bin/<build>-vulkan/`. Nothing about the invocation changes: b9960 defaults
/// `-ngl` to `auto`, so the presence of that one DLL is the whole switch, and
/// llama.cpp assigns every layer to the GPU on its own.
///
/// Vulkan rather than CUDA/HIP on purpose: 32.9 MB covering NVIDIA, AMD and
/// Intel, against 553 MB (CUDA 13.3 + its cudart pack) for NVIDIA alone. For a
/// 0.6B model the vendor SDK's edge does not buy back that download.
///
/// macOS is absent by design, not by omission: upstream's macOS packs already
/// carry Metal, so Apple hardware has always run this model on the GPU.
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
static GPU_ZIP: Option<Asset> = Some(Asset {
  rel_path: "llama-win-vulkan-x64.zip",
  urls: &[
    "https://github.com/ggml-org/llama.cpp/releases/download/b9960/llama-b9960-bin-win-vulkan-x64.zip",
    "https://typealoud.app/download/runtime/llama.cpp/b9960/llama-b9960-bin-win-vulkan-x64.zip",
  ],
  bundled: None,
  size: 32_896_693,
  sha256: "712ccd52eb6d2a77cf79e44d1645f6860990ea9295ca06e2d9609ee741b62616",
});
#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
static GPU_ZIP: Option<Asset> = None;

pub fn gpu_zip_asset() -> Option<&'static Asset> {
  GPU_ZIP.as_ref()
}

/// Which extracted llama.cpp runtime a process should be started from. Both
/// hold the same `llama-mtmd-cli`; they differ only in the backend libraries
/// sitting next to it, which is what decides CPU vs GPU execution.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Runtime {
  Cpu,
  Gpu,
}

impl Runtime {
  pub fn label(self) -> &'static str {
    match self {
      Self::Cpu => "cpu",
      Self::Gpu => "gpu",
    }
  }
}

fn runtime_asset(runtime: Runtime) -> Option<&'static Asset> {
  match runtime {
    Runtime::Cpu => Some(llama_zip_asset()),
    Runtime::Gpu => gpu_zip_asset(),
  }
}

#[cfg(test)]
pub fn total_download_bytes() -> u64 {
  MODEL_ASSETS.iter().map(|a| a.size).sum::<u64>() + llama_zip_asset().size
}

pub fn local_asr_dir() -> Result<PathBuf> {
  Ok(crate::settings::app_data_dir()?.join("local-asr"))
}

fn remove_legacy_dir(path: &Path) -> Result<()> {
  match fs::remove_dir_all(path) {
    Ok(()) => {
      log::info!("local-asr: removed legacy assets at {}", path.display());
      Ok(())
    }
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(error) => Err(error)
      .with_context(|| format!("failed to remove legacy assets at {}", path.display())),
  }
}

fn cleanup_legacy_assets_at(app_data: &Path) -> Result<()> {
  // The pre-GGUF spike stored three ONNX graphs here. No current code reads
  // this exact directory; leaving it behind costs roughly another model copy.
  remove_legacy_dir(&app_data.join("models/qwen3-asr-0.6b-int8"))?;

  // Both directions of the patched-runtime experiment leave a stale extraction
  // behind, so clear whichever one is not current. macOS arm64 and, for v1.10.x,
  // Windows ran the patched build; everything now runs upstream b9960 again, and
  // an upgrade that switches back would otherwise strand ~14 MB per machine.
  let stale = if LLAMA_BUILD == "b9960" { "b9960-saytype-reset-v1" } else { "b9960" };
  remove_legacy_dir(&app_data.join("local-asr/bin").join(stale))?;

  // Nemotron ran on a privately built macOS runtime through v1.10.x. It now
  // uses upstream's own release under a new id, so the old extraction is dead
  // weight (~10 MB) on every Mac that enabled the engine.
  remove_legacy_dir(&app_data.join("local-asr/bin/nemo-speech-4f967622"))?;
  Ok(())
}

pub fn cleanup_legacy_assets() -> Result<()> {
  cleanup_legacy_assets_at(&crate::settings::app_data_dir()?)
}

#[cfg(test)]
pub fn bin_dir(base: &Path) -> PathBuf {
  runtime_bin_dir(base, Runtime::Cpu)
}

/// The GPU pack lives beside the CPU one under its own id, so both can be
/// installed at once and switching back to CPU never re-downloads anything.
fn runtime_bin_dir(base: &Path, runtime: Runtime) -> PathBuf {
  let id = match runtime {
    Runtime::Cpu => LLAMA_BUILD.to_string(),
    Runtime::Gpu => format!("{LLAMA_BUILD}-vulkan"),
  };
  base.join("bin").join(id)
}

pub fn cli_path(base: &Path) -> PathBuf {
  runtime_cli_path(base, Runtime::Cpu)
}

fn runtime_cli_path(base: &Path, runtime: Runtime) -> PathBuf {
  let name = if cfg!(target_os = "windows") { "llama-mtmd-cli.exe" } else { "llama-mtmd-cli" };
  runtime_bin_dir(base, runtime).join(name)
}

/// Records which bundled/downloaded archive produced the extracted runtime.
/// The CLI merely being present is not proof it is the *current* one: a runtime
/// id can be rebuilt in place (b9960-saytype-reset-v1 shipped once with a
/// machine-specific rpath that died with the build directory), and without this
/// stamp a stale extraction would survive the very update that fixes it.
fn runtime_stamp_path(base: &Path, runtime: Runtime) -> PathBuf {
  runtime_bin_dir(base, runtime).join(".saytype-runtime-sha256")
}

fn write_runtime_stamp(base: &Path, runtime: Runtime) {
  if let Some(asset) = runtime_asset(runtime) {
    let _ = fs::write(runtime_stamp_path(base, runtime), asset.sha256);
  }
}

fn runtime_is_installed(base: &Path, runtime: Runtime) -> bool {
  let Some(asset) = runtime_asset(runtime) else { return false };
  let cli = runtime_cli_path(base, runtime);
  fs::metadata(&cli).map(|m| m.is_file()).unwrap_or(false)
    && is_executable(&cli)
    && fs::read_to_string(runtime_stamp_path(base, runtime))
      .map(|stamp| stamp.trim() == asset.sha256)
      .unwrap_or(false)
}

fn installed_runtime_is_current(base: &Path) -> bool {
  runtime_is_installed(base, Runtime::Cpu)
}

fn models_ready_at(dir: &Path) -> bool {
  MODEL_ASSETS.iter().all(|a| {
    fs::metadata(dir.join(a.rel_path)).map(|m| m.len() == a.size).unwrap_or(false)
  })
}

fn local_asr_command(program: PathBuf) -> tokio::process::Command {
  let command = tokio::process::Command::new(program);
  #[cfg(target_os = "windows")]
  {
    let mut command = command;
    // llama-mtmd-cli is a console executable. Without CREATE_NO_WINDOW,
    // Windows opens a terminal for every transcription and may steal focus
    // from the app that should receive the resulting text.
    command.creation_flags(0x0800_0000);
    command
  }
  #[cfg(not(target_os = "windows"))]
  {
    command
  }
}

/// Cheap readiness: every GGUF at its exact size, plus the extracted CLI
/// present (executable on unix). sha256 is verified once at download time.
#[cfg(test)]
pub fn assets_ready_at(dir: &Path) -> bool {
  qwen_ready_at(dir, QWEN_MODEL_ID)
}

fn qwen_ready_at(dir: &Path, model: &str) -> bool {
  let models_ok = qwen_assets(model).iter().all(|asset| {
    fs::metadata(dir.join(asset.rel_path))
      .map(|metadata| metadata.is_file() && metadata.len() == asset.size)
      .unwrap_or(false)
  });
  let cli = cli_path(dir);
  let cli_ok = fs::metadata(&cli).map(|m| m.is_file()).unwrap_or(false)
    && is_executable(&cli);
  models_ok && cli_ok
}

#[cfg(test)]
pub fn assets_ready_for_at(dir: &Path, model: &str) -> bool {
  match normalize_local_model_id(model) {
    NEMOTRON_MODEL_ID => crate::nemotron_asr::assets_ready_at(dir),
    _ => qwen_ready_at(dir, model),
  }
}

pub fn assets_ready_for(model: &str) -> bool {
  match normalize_local_model_id(model) {
    NEMOTRON_MODEL_ID => crate::nemotron_asr::assets_ready(),
    _ => local_asr_dir().map(|dir| {
      let _ = ensure_bundled_runtime_at(&dir);
      qwen_ready_at(&dir, model)
    }).unwrap_or(false),
  }
}

// ---------------------------------------------------------------------------
// GPU acceleration (opt-in)
// ---------------------------------------------------------------------------

/// What the user picked in Settings. Held as a process-global so the decode
/// path never reads the config file: `commands::sync_local_runtime` pushes it
/// here at startup and on every settings save.
static COMPUTE_PREFERENCE: AtomicU8 = AtomicU8::new(0);

/// Set once a GPU start has failed on this machine. Selection then falls back
/// to CPU for the rest of the session, so one bad driver cannot turn every
/// dictation into a failure.
static GPU_DISABLED: AtomicBool = AtomicBool::new(false);

/// Devices the installed GPU runtime reports, cached per process. Cleared when
/// the pack is installed or removed.
static GPU_DEVICES: Mutex<Option<Vec<String>>> = Mutex::new(None);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ComputePreference {
  Auto,
  Cpu,
  Gpu,
}

impl ComputePreference {
  pub fn parse(value: &str) -> Self {
    match value.trim() {
      "gpu" => Self::Gpu,
      "cpu" => Self::Cpu,
      _ => Self::Auto,
    }
  }

  pub fn as_str(self) -> &'static str {
    match self {
      Self::Auto => "auto",
      Self::Cpu => "cpu",
      Self::Gpu => "gpu",
    }
  }

  fn code(self) -> u8 {
    match self {
      Self::Auto => 0,
      Self::Cpu => 1,
      Self::Gpu => 2,
    }
  }

  fn from_code(code: u8) -> Self {
    match code {
      1 => Self::Cpu,
      2 => Self::Gpu,
      _ => Self::Auto,
    }
  }
}

pub fn compute_preference() -> ComputePreference {
  ComputePreference::from_code(COMPUTE_PREFERENCE.load(Ordering::Relaxed))
}

/// Apply a settings change. A parked worker was started from whichever runtime
/// was selected at the time, so a real change retires it rather than letting
/// the next dictation run on the backend the user just switched away from.
pub fn set_compute_preference(value: &str) {
  let next = ComputePreference::parse(value);
  let previous =
    ComputePreference::from_code(COMPUTE_PREFERENCE.swap(next.code(), Ordering::Relaxed));
  if previous != next {
    log::info!("local-asr: compute preference {} -> {}", previous.as_str(), next.as_str());
    shutdown_resident_worker();
  }
}

/// Whether a GPU pack exists for this platform at all. False on macOS by
/// design, not omission: upstream's macOS runtime already carries Metal, so
/// Apple hardware has never been on the CPU path and has nothing to opt into.
pub fn gpu_runtime_supported() -> bool {
  gpu_zip_asset().is_some()
}

pub fn gpu_runtime_ready_at(base: &Path) -> bool {
  runtime_is_installed(base, Runtime::Gpu)
}

fn disable_gpu_for_process(reason: &str) {
  if !GPU_DISABLED.swap(true, Ordering::Relaxed) {
    log::warn!("local-asr: GPU runtime disabled for this session ({reason}); using CPU");
  }
}

/// Which runtime a new process starts from. GPU only when the user asked for
/// it, the pack is installed, and it has not already failed this session.
///
/// `Auto` resolves to CPU today, deliberately. The only signal available
/// without a new platform dependency is `--list-devices`, which reports an
/// integrated GPU's shared system memory as if it were VRAM (a 2017 Intel
/// HD 630 lists 12 GiB) — so any "enough memory, use the GPU" rule would fire
/// exactly on the hardware measured to be twice as slow as its own CPU.
/// Flipping this default needs real numbers from discrete GPUs first.
fn selected_runtime(base: &Path) -> Runtime {
  if compute_preference() != ComputePreference::Gpu {
    return Runtime::Cpu;
  }
  if GPU_DISABLED.load(Ordering::Relaxed) || !gpu_runtime_ready_at(base) {
    return Runtime::Cpu;
  }
  Runtime::Gpu
}

/// Parses `--list-devices` output, whose device lines look like
/// `  Vulkan0: Intel(R) HD Graphics 630 (12243 MiB, 11475 MiB free)` — take the
/// name between the device id and the trailing memory figures. The
/// `Available devices:` header has no `": "` separator and drops out.
fn parse_device_list(stdout: &str) -> Vec<String> {
  stdout
    .lines()
    .filter_map(|line| {
      let (id, rest) = line.trim().split_once(": ")?;
      if id.is_empty() || id.contains(char::is_whitespace) {
        return None;
      }
      let name = rest.rsplit_once(" (").map_or(rest, |(name, _)| name);
      let name = name.trim();
      (!name.is_empty()).then(|| name.to_string())
    })
    .collect()
}

/// Ask the installed GPU runtime what it can see. An installed pack with an
/// empty list means the machine has no usable Vulkan device (no driver, or a
/// GPU too old) — the Settings panel says so instead of silently running CPU.
pub async fn gpu_devices() -> Vec<String> {
  if let Some(cached) = GPU_DEVICES.lock().unwrap().clone() {
    return cached;
  }
  let Ok(base) = local_asr_dir() else { return Vec::new() };
  if !gpu_runtime_ready_at(&base) {
    return Vec::new();
  }
  let output = local_asr_command(runtime_cli_path(&base, Runtime::Gpu))
    .arg("--list-devices")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .kill_on_drop(true)
    .output()
    .await;
  let devices = match output {
    Ok(output) => parse_device_list(&String::from_utf8_lossy(&output.stdout)),
    Err(error) => {
      log::warn!("local-asr: could not list GPU devices: {error}");
      Vec::new()
    }
  };
  log::info!(
    "local-asr: GPU devices: {}",
    if devices.is_empty() { "none".to_string() } else { devices.join(", ") }
  );
  *GPU_DEVICES.lock().unwrap() = Some(devices.clone());
  devices
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuRuntimeStatus {
  /// Whether this platform has a GPU pack to offer at all.
  pub supported: bool,
  /// "absent" | "downloading" | "ready"
  pub state: String,
  pub size_bytes: u64,
  pub downloaded_bytes: u64,
  /// What the installed runtime can see. Empty while `state == "ready"` means
  /// the pack works but the machine has no usable device.
  pub devices: Vec<String>,
  /// Whether a decode started right now would run on the GPU.
  pub active: bool,
  /// Whether a GPU start already failed this session and CPU took over.
  pub fell_back: bool,
}

pub async fn gpu_runtime_status(downloading: bool) -> GpuRuntimeStatus {
  let Some(asset) = gpu_zip_asset() else {
    return GpuRuntimeStatus {
      supported: false,
      state: "absent".into(),
      size_bytes: 0,
      downloaded_bytes: 0,
      devices: Vec::new(),
      active: false,
      fell_back: false,
    };
  };
  let dir = local_asr_dir().ok();
  let ready = dir.as_deref().map(gpu_runtime_ready_at).unwrap_or(false);
  let downloaded = if ready {
    asset.size
  } else {
    dir
      .as_deref()
      .and_then(|dir| fs::metadata(dir.join(format!("{}.part", asset.rel_path))).ok())
      .map(|meta| meta.len().min(asset.size))
      .unwrap_or(0)
  };
  let state = if downloading {
    "downloading"
  } else if ready {
    "ready"
  } else {
    "absent"
  };
  GpuRuntimeStatus {
    supported: true,
    state: state.into(),
    size_bytes: asset.size,
    downloaded_bytes: downloaded,
    devices: if ready { gpu_devices().await } else { Vec::new() },
    active: dir.as_deref().map(|dir| selected_runtime(dir) == Runtime::Gpu).unwrap_or(false),
    fell_back: GPU_DISABLED.load(Ordering::Relaxed),
  }
}

fn emit_gpu_progress(app: &tauri::AppHandle, state: &str, downloaded: u64, message: Option<&str>) {
  let _ = app.emit(
    "local-gpu-runtime-progress",
    serde_json::json!({
      "state": state,
      "downloadedBytes": downloaded,
      "totalBytes": gpu_zip_asset().map_or(0, |asset| asset.size),
      "message": message,
    }),
  );
}

/// Fetch and extract the GPU pack. Resumable and sha256-gated like every other
/// asset; the archive is removed once extracted. Terminal events are emitted by
/// the command, matching `download_model`.
pub async fn download_gpu_runtime(
  app: tauri::AppHandle,
  cancel: CancellationToken,
) -> Result<(), String> {
  let asset = gpu_zip_asset().ok_or("GPU acceleration is not available on this platform")?;
  let dir = local_asr_dir().map_err(|e| e.to_string())?;
  if gpu_runtime_ready_at(&dir) {
    return Ok(());
  }
  let client = reqwest::Client::builder()
    .connect_timeout(std::time::Duration::from_secs(15))
    .build()
    .map_err(|e| e.to_string())?;
  let report = |downloaded: u64| emit_gpu_progress(&app, "downloading", downloaded, None);

  let archive = dir.join(asset.rel_path);
  if !fs::metadata(&archive).map(|m| m.len() == asset.size).unwrap_or(false) {
    download_asset(&report, &client, &dir, asset, &cancel, 0).await?;
  }
  let extract_dir = dir.clone();
  tokio::task::spawn_blocking(move || extract_runtime_archive(&extract_dir, Runtime::Gpu))
    .await
    .map_err(|e| e.to_string())??;
  let _ = fs::remove_file(&archive);

  // Only a process started after this can use the pack, and the device list was
  // cached as "none" while it was missing.
  *GPU_DEVICES.lock().unwrap() = None;
  GPU_DISABLED.store(false, Ordering::Relaxed);
  shutdown_resident_worker();
  Ok(())
}

/// Remove the GPU pack, leaving the required CPU runtime and the models alone.
pub fn delete_gpu_runtime() -> Result<(), String> {
  shutdown_resident_worker();
  let dir = local_asr_dir().map_err(|e| e.to_string())?;
  if let Some(asset) = gpu_zip_asset() {
    let _ = fs::remove_file(dir.join(asset.rel_path));
    let _ = fs::remove_file(dir.join(format!("{}.part", asset.rel_path)));
  }
  *GPU_DEVICES.lock().unwrap() = None;
  match fs::remove_dir_all(runtime_bin_dir(&dir, Runtime::Gpu)) {
    Ok(()) => Ok(()),
    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(err) => Err(err.to_string()),
  }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
  use std::os::unix::fs::PermissionsExt;
  fs::metadata(path).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_path: &Path) -> bool {
  true
}

/// Hard ceiling on one decode. Metal does ~60s audio in ~3s; on CPU-only
/// platforms (Windows/Linux, RTF ~0.3) a maximal 25MB-WAV clip (~13 min)
/// could exceed this — acceptable for now, those platforms are not yet
/// real-machine verified. Revisit if long-form CPU dictation becomes real.
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(180);
// The per-decode watchdog is not an end-to-end deadline: a request can wait
// for a permit, start a worker, retry one-shot and then wait for child exit.
// Leave room for both existing decode budgets, but bound the whole request.
const PIPELINE_TIMEOUT: Duration = Duration::from_secs(420);
const PREWARM_TIMEOUT: Duration = Duration::from_secs(30);

struct PipelineProgress {
  operation: &'static str,
  session_id: Option<u64>,
  chunk_index: Option<u32>,
  started: std::time::Instant,
  phase: Mutex<(&'static str, std::time::Instant)>,
  finished: AtomicBool,
}

impl PipelineProgress {
  fn new(operation: &'static str, session_id: Option<u64>, chunk_index: Option<u32>) -> Self {
    let now = std::time::Instant::now();
    let progress = Self {
      operation,
      session_id,
      chunk_index,
      started: now,
      phase: Mutex::new(("inference-queue", now)),
      finished: AtomicBool::new(false),
    };
    progress.report("start", log::Level::Info);
    progress
  }

  fn enter(&self, phase: &'static str) {
    let now = std::time::Instant::now();
    let (previous_phase, entered) = {
      let mut current = self.phase.lock().unwrap_or_else(|error| error.into_inner());
      let previous = *current;
      *current = (phase, now);
      previous
    };
    // One transition retains both the new wait and the previous stage's
    // duration, without doubling the release log volume at each boundary.
    log::info!(
      target: "typealoud_lifecycle",
      "native operation={} session_id={:?} chunk_index={:?} phase={} event=start previous_phase={} previous_elapsed_ms={} total_ms={}",
      self.operation, self.session_id, self.chunk_index, phase, previous_phase,
      now.duration_since(entered).as_millis(), self.started.elapsed().as_millis()
    );
  }

  fn report(&self, event: &'static str, level: log::Level) {
    let (phase, entered) = *self.phase.lock().unwrap_or_else(|error| error.into_inner());
    log::log!(
      target: "typealoud_lifecycle",
      level,
      "native operation={} session_id={:?} chunk_index={:?} phase={} event={} elapsed_ms={} total_ms={}",
      self.operation, self.session_id, self.chunk_index, phase, event,
      entered.elapsed().as_millis(), self.started.elapsed().as_millis()
    );
  }
}

impl Drop for PipelineProgress {
  fn drop(&mut self) {
    if !self.finished.load(Ordering::Relaxed) {
      // The command's CancellationToken drops this future directly. Persist
      // that path too, without logging audio or exception/transcript strings.
      if std::thread::panicking() {
        self.report("panic", log::Level::Warn);
      } else {
        self.report("cancel", log::Level::Info);
      }
    }
  }
}

async fn with_pipeline_deadline<T>(
  future: impl std::future::Future<Output = Result<T>>,
  deadline: Duration,
  progress: &PipelineProgress,
) -> Result<T> {
  let result = match tokio::time::timeout(deadline, future).await {
    Ok(result) => {
      progress.report(if result.is_ok() { "complete" } else { "error" },
        if result.is_ok() { log::Level::Info } else { log::Level::Warn });
      result
    }
    Err(_) => {
      progress.report("timeout", log::Level::Warn);
      let phase = progress.phase.lock().unwrap_or_else(|error| error.into_inner()).0;
      Err(anyhow::anyhow!("local ASR {} timed out during {} after {}ms", progress.operation, phase, deadline.as_millis()))
    }
  };
  progress.finished.store(true, Ordering::Relaxed);
  result
}
/// Context size for one decode, sized to the clip. It MUST be passed
/// explicitly: the model metadata declares ctx 65536 and the CLI default
/// ("0" = from model) preallocates a ~7 GiB KV cache (measured). But a fixed
/// small ctx overflows on long audio — llama.cpp preallocates the KV cache to
/// the *full* ctx, and Qwen3-ASR streams the clip into it at ~15 tokens/s on
/// top of the generated transcript. At the old fixed 2048 this failed past
/// ~2 min: `failed to decode audio` once the audio alone overflowed (~2.7 min),
/// or `failed to decode token` when the audio fit but audio+transcript didn't
/// (~2.2 min, the common user-visible one). So we size ctx to the clip.
///
/// The frontend always uploads 16 kHz mono 16-bit WAV in local mode
/// (vad-gate.js forceWav/encodeFullWav) = 32000 bytes/s, so seconds ≈
/// (len-44)/32000. Budget ~20 tokens/s (audio ~15/s + transcript headroom) plus
/// a 512 base, clamped to [FLOOR, CAP]. The 2048 FLOOR keeps short clips at the
/// old memory; the 16384 CAP bounds a pathological clip (~2.9 GiB peak RSS,
/// ~13 min of speech). Measured peak RSS ≈ 110 KiB/token: ctx 2048→1288 MiB,
/// 8192→2020, 16384→2891, 32768→4659. Verified 135 s–300 s clips that failed at
/// 2048 all decode cleanly under this formula.
const CTX_FLOOR: u32 = 2048;
const CTX_CAP: u32 = 16384;
fn ctx_size_for_wav(wav_len: usize) -> u32 {
  let seconds = wav_len.saturating_sub(44) as f64 / 32000.0;
  let tokens = (seconds * 20.0) as u32 + 512;
  tokens.clamp(CTX_FLOOR, CTX_CAP)
}

/// How long to wait for the FIRST stdout byte before declaring the decode hung,
/// sized to the clip. Qwen3-ASR encodes the whole clip before emitting token 1,
/// and that encode grows with clip length (measured ~0.03 s per audio-second:
/// first byte 2.4 s into an 82 s clip, 7.7 s into a 5.5 min one). Budget
/// generously — a 15 s base + 0.1 s per audio-second gives ~5-10x margin over
/// those measurements, so a slow machine is never mistaken for a wedged process.
/// `TRANSCRIBE_TIMEOUT` remains the per-attempt cap; `PIPELINE_TIMEOUT` also
/// covers queue acquisition, initialization, fallback and process teardown.
const FIRST_BYTE_BASE: Duration = Duration::from_secs(15);
fn first_byte_deadline(wav_len: usize) -> Duration {
  let seconds = wav_len.saturating_sub(44) as f64 / 32000.0;
  FIRST_BYTE_BASE + Duration::from_millis((seconds * 100.0) as u64)
}

/// Once tokens are flowing, a healthy decode never pauses this long between
/// stdout growth. A gap beyond this means the CLI wedged mid-decode.
const NO_PROGRESS_TIMEOUT: Duration = Duration::from_secs(20);

/// How often the hang watchdog re-evaluates progress. Coarse on purpose — the
/// thresholds it guards are tens of seconds, so a 1 s cadence is plenty.
const WATCHDOG_POLL: Duration = Duration::from_secs(1);

/// Skip llama.cpp's per-process device-memory fitting pass. TypeAloud already
/// supplies a bounded context size, and real-device benchmarks show that
/// re-running the automatic fit calculation on every short transcription adds
/// measurable latency without changing output or peak memory.
const FIT_ARGS: &[&str] = &["--fit", "off"];

/// Verdict of the hang watchdog at one poll tick.
#[derive(Debug, PartialEq, Eq)]
enum StallCheck {
  /// Still making (or plausibly about to make) progress — keep waiting.
  Ok,
  /// No stdout at all past the clip-sized first-byte grace: the CLI never
  /// started producing, treat as wedged.
  HungBeforeFirstByte,
  /// Tokens were flowing but stdout has been silent past NO_PROGRESS_TIMEOUT.
  HungMidDecode,
}

/// Decide whether a decode has hung, given whether any stdout byte has landed,
/// how long since the process started, how long since stdout last grew, and the
/// clip length (which sets the first-byte grace). Pure so it can be unit-tested
/// without a subprocess; the async pump calls it on a poll tick.
fn stall_check(
  seen_first_byte: bool,
  since_start: Duration,
  since_progress: Duration,
  wav_len: usize,
) -> StallCheck {
  if !seen_first_byte {
    if since_start > first_byte_deadline(wav_len) {
      return StallCheck::HungBeforeFirstByte;
    }
  } else if since_progress > NO_PROGRESS_TIMEOUT {
    return StallCheck::HungMidDecode;
  }
  StallCheck::Ok
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
/// llama-mtmd-cli maps roughly 1.3-1.9 GiB per decode. Keep all local entry
/// points single-flight so overlapping hotkeys and History retries cannot
/// multiply that memory or contend for the same Metal device. Cloud requests
/// do not pass through this module and remain concurrent.
static LOCAL_INFERENCE: Semaphore = Semaphore::const_new(1);
static RESIDENT_WORKER: Mutex<Option<ResidentWorker>> = Mutex::new(None);
static RESIDENT_GENERATION: AtomicU64 = AtomicU64::new(0);
static RESIDENT_EPOCH: AtomicU64 = AtomicU64::new(0);
static FINISHED_RESIDENT_SESSIONS: OnceLock<Mutex<HashSet<u64>>> = OnceLock::new();
const FINISHED_SESSION_TOMBSTONES: usize = 1024;
static BUNDLED_RUNTIME_INSTALL: Mutex<()> = Mutex::new(());
#[cfg(test)]
static RESIDENT_STARTS: AtomicU64 = AtomicU64::new(0);

/// A preloaded worker must survive until the frontend's 75 s hard chunk cut.
/// Session completion normally retires it sooner; this is the leak guard.
const PREWARM_IDLE_TIMEOUT: Duration = Duration::from_secs(80);
const CHAT_PROMPT: &[u8] = b"\n> ";

fn worker_identity_matches(
  loaded_model: &str,
  loaded_runtime: Runtime,
  requested_model: &str,
  requested_runtime: Runtime,
) -> bool {
  loaded_model == requested_model && loaded_runtime == requested_runtime
}

struct ResidentWorker {
  child: Child,
  stdin: ChildStdin,
  stdout: ChildStdout,
  ctx_size: u32,
  /// Which extracted runtime this process was started from. A parked worker
  /// cannot change backend, so a preference change retires it.
  runtime: Runtime,
  model: &'static str,
  generation: u64,
  epoch: u64,
  /// A worker belongs to one uninterrupted hotkey hold. It may serve each
  /// chunk from that recording, but it is never handed to another dictation.
  session_id: Option<u64>,
  /// Previous transcript from this worker, for the contamination check in
  /// `transcribe`. Populated on the normal path now that a worker serves every
  /// chunk of its session: it is the only evidence that upstream handed this
  /// decode the previous audio, so it is load-bearing, not a debug aid.
  last_transcript: Option<String>,
  decodes_served: u32,
}

impl ResidentWorker {
  async fn spawn(
    base: &Path,
    ctx_size: u32,
    session_id: Option<u64>,
    runtime: Runtime,
    model: &'static str,
  ) -> Result<Self> {
    let mut child = local_asr_command(runtime_cli_path(base, runtime))
      .arg("-m").arg(base.join(qwen_assets(model)[0].rel_path))
      .arg("--mmproj").arg(base.join(qwen_assets(model)[1].rel_path))
      .arg("--no-warmup")
      .args(FIT_ARGS)
      .arg("-c").arg(ctx_size.to_string())
      // With no --audio and no prompt, mtmd enters chat mode and accepts a
      // sequence of `/audio <path>` commands while keeping both models loaded.
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      // Chat-mode stderr is verbose enough to fill a pipe over a long session;
      // one-shot fallback below retains detailed stderr for error reporting.
      .stderr(Stdio::null())
      .kill_on_drop(true)
      .spawn()
      .context("failed to start resident llama-mtmd-cli")?;
    let stdin = child.stdin.take().expect("stdin is piped");
    let mut stdout = child.stdout.take().expect("stdout is piped");
    read_chat_response(&mut stdout, 0, false, |_| {}).await
      .context("resident llama-mtmd-cli did not reach its initial prompt")?;
    #[cfg(test)]
    RESIDENT_STARTS.fetch_add(1, Ordering::Relaxed);
    Ok(Self {
      child,
      stdin,
      stdout,
      ctx_size,
      runtime,
      model,
      generation: 0,
      session_id,
      last_transcript: None,
      decodes_served: 0,
      epoch: RESIDENT_EPOCH.load(Ordering::Relaxed),
    })
  }

  /// Start a worker on the runtime the settings ask for, falling back to CPU
  /// if the GPU one cannot start. A GPU pack that fails here is broken for the
  /// session (missing driver, no usable device, unsupported adapter), so it is
  /// switched off for the process rather than retried on every dictation.
  async fn spawn_selected(
    base: &Path,
    ctx_size: u32,
    session_id: Option<u64>,
    model: &'static str,
  ) -> Result<Self> {
    let runtime = selected_runtime(base);
    match Self::spawn(base, ctx_size, session_id, runtime, model).await {
      Ok(worker) => Ok(worker),
      Err(error) if runtime == Runtime::Gpu => {
        disable_gpu_for_process(&format!("worker start failed: {error:#}"));
        Self::spawn(base, ctx_size, session_id, Runtime::Cpu, model).await
      }
      Err(error) => Err(error),
    }
  }

  fn is_running(&mut self) -> bool {
    matches!(self.child.try_wait(), Ok(None))
  }

  async fn transcribe(
    &mut self,
    audio_path: &Path,
    wav_len: usize,
    on_partial: &mut impl FnMut(&str),
  ) -> Result<String> {
    let audio_path_text = audio_path.to_string_lossy();
    if audio_path_text.contains('\n') || audio_path_text.contains('\r') {
      anyhow::bail!("temporary audio path contains a newline");
    }

    self.stdin.write_all(b"/clear\n").await?;
    self.stdin.flush().await?;
    read_chat_response(&mut self.stdout, 0, false, |_| {}).await
      .context("resident worker did not clear its previous conversation")?;

    self.stdin
      .write_all(format!("/audio {}\n", audio_path.display()).as_bytes())
      .await?;
    self.stdin.flush().await?;
    let loaded = read_chat_response(&mut self.stdout, 0, false, |_| {}).await
      .context("resident worker did not load the audio")?;
    if !String::from_utf8_lossy(&loaded).contains("audio loaded") {
      anyhow::bail!("resident worker rejected the audio file");
    }

    self.stdin.write_all(b"a\n").await?;
    self.stdin.flush().await?;
    let response = read_chat_response(&mut self.stdout, wav_len, true, on_partial).await?;
    let output = String::from_utf8_lossy(&response);
    if !output.contains("<asr_text>") {
      anyhow::bail!("resident worker returned no ASR marker");
    }
    let text = parse_mtmd_output(&output);
    self.decodes_served += 1;

    // Contamination check. Upstream b9960 can hand a reused worker the media
    // batch from the previous call, so the decode returns the previous audio's
    // transcript. That is indistinguishable from a correct result unless the
    // two clips differ, which is why it is caught here by comparison rather
    // than by anything the output itself reveals.
    //
    // A user really can dictate the same words twice, so this over-reports.
    // That costs one extra decode and still returns the right text; the
    // alternative — inserting the previous utterance — is not recoverable.
    if repeats_previous(self.last_transcript.as_deref(), &text) {
      // A digest, never the words: this is dictation, it lands in a log file on
      // disk, and the whole point of the local engine is that what the user
      // says stays with them. The hash still lets repeats be correlated across
      // lines, which is all the diagnosis needs.
      let digest = format!("{:x}", sha2::Sha256::digest(text.as_bytes()));
      log::warn!(
        "local-asr: POLLUTION DETECTED — decode {} on this worker returned the previous \
         transcript verbatim; retiring it and re-decoding one-shot. The packaged reset \
         contract did not isolate this session's audio. chars={} sha256={}",
        self.decodes_served,
        text.chars().count(),
        &digest[..12],
      );
      anyhow::bail!("resident worker returned the previous transcript (contaminated)");
    }
    self.last_transcript = Some(text.clone());
    Ok(text)
  }
}

/// Read one chat-mode response, ending at the next prompt. For an inference
/// response, stream text after `<asr_text>` while retaining the existing
/// first-token and no-progress watchdog semantics.
async fn read_chat_response(
  stdout: &mut ChildStdout,
  wav_len: usize,
  stream_partials: bool,
  mut on_partial: impl FnMut(&str),
) -> Result<Vec<u8>> {
  let started = std::time::Instant::now();
  let mut last_progress = started;
  let mut acc = Vec::new();
  let mut buf = [0u8; 2048];
  let mut seen_asr_marker = false;
  let mut last_emit: Option<std::time::Instant> = None;
  let mut last_sent = 0usize;

  loop {
    let allowed_gap = if seen_asr_marker {
      NO_PROGRESS_TIMEOUT
    } else {
      first_byte_deadline(wav_len)
    };
    let elapsed = if seen_asr_marker {
      last_progress.elapsed()
    } else {
      started.elapsed()
    };
    let remaining = allowed_gap.saturating_sub(elapsed);
    if remaining.is_zero() {
      if seen_asr_marker {
        anyhow::bail!(
          "local ASR stalled mid-decode (no progress for {}s) — treating as hung",
          NO_PROGRESS_TIMEOUT.as_secs()
        );
      }
      anyhow::bail!(
        "local ASR produced no output within {}s for a {}s clip — treating as hung",
        first_byte_deadline(wav_len).as_secs(),
        wav_len.saturating_sub(44) / 32000
      );
    }

    let n = tokio::time::timeout(remaining, stdout.read(&mut buf))
      .await
      .map_err(|_| anyhow::anyhow!("resident local ASR response timed out"))?
      .context("failed to read resident llama-mtmd-cli output")?;
    if n == 0 {
      anyhow::bail!("resident llama-mtmd-cli exited unexpectedly");
    }
    last_progress = std::time::Instant::now();
    acc.extend_from_slice(&buf[..n]);
    seen_asr_marker |= acc.windows("<asr_text>".len()).any(|w| w == b"<asr_text>");

    if acc.ends_with(CHAT_PROMPT) {
      acc.truncate(acc.len() - CHAT_PROMPT.len());
      if stream_partials {
        if let Some(text) = partial_text(&acc) {
          if text.len() != last_sent {
            on_partial(&text);
          }
        }
      }
      return Ok(acc);
    }

    if stream_partials && seen_asr_marker
      && !last_emit.is_some_and(|t| t.elapsed() < PARTIAL_EMIT_INTERVAL)
    {
      if let Some(text) = partial_text(&acc) {
        if text.len() != last_sent {
          last_sent = text.len();
          last_emit = Some(std::time::Instant::now());
          on_partial(&text);
        }
      }
    }
  }
}

fn retire_resident_worker(generation: Option<u64>) {
  let mut slot = RESIDENT_WORKER.lock().unwrap();
  let retire = slot
    .as_ref()
    .is_some_and(|worker| generation.is_none() || generation == Some(worker.generation));
  if retire {
    if let Some(mut worker) = slot.take() {
      let _ = worker.child.start_kill();
    }
  }
}

fn finished_resident_sessions() -> &'static Mutex<HashSet<u64>> {
  FINISHED_RESIDENT_SESSIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn resident_session_finished(session_id: Option<u64>) -> bool {
  session_id.is_some_and(|id| finished_resident_sessions().lock().unwrap().contains(&id))
}

fn session_reuse_miss(
  worker_session_id: Option<u64>,
  requested_session_id: Option<u64>,
) -> Option<&'static str> {
  // A decode with no session owns nothing, so it never inherits a worker — and
  // an unowned worker is never handed on. Comparing the two `Option`s directly
  // would call `None == None` a match and permit exactly the multi-audio reuse
  // this predicate exists to forbid. `park_resident_worker` also refuses to
  // cache an unowned worker, but the rule belongs here, where reuse is decided.
  let Some(requested) = requested_session_id else {
    return Some("unowned");
  };
  if worker_session_id != Some(requested) {
    Some("session_mismatch")
  } else if resident_session_finished(Some(requested)) {
    Some("session_finished")
  } else {
    None
  }
}

/// End exactly one continuous recording's worker lease. If its worker is
/// currently decoding, the finished marker makes `park_resident_worker` kill it
/// instead of caching it when the decode returns. A newer recording's worker is
/// left alone.
///
/// The worker slot is locked *around* the marking, not after it: that is what
/// makes the hand-off with `park_resident_worker_for` atomic. See the note
/// there.
pub fn finish_resident_session(session_id: u64) -> bool {
  let mut slot = RESIDENT_WORKER.lock().unwrap();
  {
    let mut finished = finished_resident_sessions().lock().unwrap();
    finished.insert(session_id);
    if finished.len() > FINISHED_SESSION_TOMBSTONES * 2 {
      let floor = session_id.saturating_sub(FINISHED_SESSION_TOMBSTONES as u64);
      finished.retain(|id| *id >= floor);
    }
  }
  if slot
    .as_ref()
    .is_some_and(|worker| worker.session_id == Some(session_id))
  {
    if let Some(mut worker) = slot.take() {
      let _ = worker.child.start_kill();
    }
    true
  } else {
    false
  }
}

/// Stop the warm local worker when TypeAloud exits, switches away from local, or
/// removes the model files.
pub fn sync_selected_model(model: &str) {
  static SELECTED_MODEL: AtomicBool = AtomicBool::new(false);
  let large = normalize_local_model_id(model) == QWEN_LARGE_MODEL_ID;
  if SELECTED_MODEL.swap(large, Ordering::Relaxed) != large {
    shutdown_resident_worker();
  }
}

pub fn shutdown_resident_worker() {
  // Invalidate a worker currently checked out for inference as well as one in
  // the idle cache. A checked-out worker observes the new epoch in park() and
  // kills itself instead of becoming resident again.
  RESIDENT_EPOCH.fetch_add(1, Ordering::Relaxed);
  retire_resident_worker(None);
}

fn schedule_resident_retirement(generation: u64, idle_timeout: Duration) {
  tauri::async_runtime::spawn(async move {
    tokio::time::sleep(idle_timeout).await;
    retire_resident_worker(Some(generation));
  });
}

/// Park unconditionally. Prewarm uses this: the worker it just started has to
/// be waiting in the slot for the decode that follows, whether or not the
/// worker is allowed to survive past that decode.
fn park_resident_worker_for(mut worker: ResidentWorker, idle_timeout: Duration) {
  // The finished-session test and the store are one critical section, and
  // `finish_resident_session` takes this same lock before it marks a session.
  // Split apart, a cancel arriving between them would mark the session, find
  // the slot still empty, report "nothing retired" — and then this store would
  // park the worker it was supposed to kill, leaving ~1.3 GiB resident for the
  // full idle timeout. Both paths lock the slot before the finished set, so the
  // order is consistent and cannot deadlock.
  let generation = {
    let mut slot = RESIDENT_WORKER.lock().unwrap();
    if worker.epoch != RESIDENT_EPOCH.load(Ordering::Relaxed)
      || resident_session_finished(worker.session_id)
    {
      let _ = worker.child.start_kill();
      return;
    }
    let generation = RESIDENT_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    worker.generation = generation;
    *slot = Some(worker);
    generation
  };
  schedule_resident_retirement(generation, idle_timeout);
}

/// Keep a worker only for the recording session that owns it. The 80-second
/// guard spans the next hard chunk cut; normal completion retires it sooner.
/// The finished-session case is left to `park_resident_worker_for`, which
/// settles it under the slot lock.
fn park_resident_worker(mut worker: ResidentWorker) {
  if worker.session_id.is_none() {
    let _ = worker.child.start_kill();
    return;
  }
  park_resident_worker_for(worker, PREWARM_IDLE_TIMEOUT);
}

/// Whether a decode handed back exactly what the previous one did, which on a
/// reused worker means upstream's media batch was served again instead of the
/// new audio.
///
/// Empty repeats count. An empty result is harmless to insert, but it is the
/// same evidence that the worker is serving stale state, and a worker left
/// alive on that evidence is one whose *next* decode returns the previous
/// words. There is nothing to compare on the first decode.
fn repeats_previous(previous: Option<&str>, text: &str) -> bool {
  previous == Some(text)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResidentPrewarmOutcome {
  // No Unsupported: prewarm is available on every platform now that it no
  // longer rides on the reuse flag.
  Ineligible,
  AssetsMissing,
  Reused,
  Spawned,
}

impl ResidentPrewarmOutcome {
  pub fn is_ready(self) -> bool {
    matches!(self, Self::Reused | Self::Spawned)
  }
}

/// Load the fixed short-dictation worker while recording is already underway.
/// The shared inference permit makes this single-flight with both decode and
/// other prewarm requests. Eligibility is rechecked after waiting for the
/// permit, so a provider/model switch cannot start a stale worker.
#[cfg(test)]
pub async fn prewarm_resident_worker(
  session_id: u64,
  eligible: impl FnOnce() -> Result<bool>,
) -> Result<ResidentPrewarmOutcome> {
  prewarm_resident_worker_for(QWEN_MODEL_ID, session_id, eligible).await
}

pub async fn prewarm_resident_worker_for(
  model: &str,
  session_id: u64,
  eligible: impl FnOnce() -> Result<bool>,
) -> Result<ResidentPrewarmOutcome> {
  let model = normalize_local_model_id(model);
  let progress = PipelineProgress::new("prewarm", Some(session_id), None);
  with_pipeline_deadline(
    prewarm_resident_worker_inner(model, session_id, eligible, &progress),
    PREWARM_TIMEOUT,
    &progress,
  ).await
}

async fn prewarm_resident_worker_inner(
  model: &'static str,
  session_id: u64,
  eligible: impl FnOnce() -> Result<bool>,
  progress: &PipelineProgress,
) -> Result<ResidentPrewarmOutcome> {
  // Prewarm runs on every platform. It used to be gated on the same flag as
  // reuse, so anywhere the resident worker was unsafe also lost the load
  // overlap — which was the larger of the two wins, and the one that costs
  // nothing in correctness.
  let queued_at = std::time::Instant::now();
  let _inference_permit = LOCAL_INFERENCE
    .acquire()
    .await
    .expect("local inference semaphore is never closed");
  let queue_ms = queued_at.elapsed().as_millis();
  let lease_epoch = RESIDENT_EPOCH.load(Ordering::Relaxed);
  progress.enter("prepare");

  if resident_session_finished(Some(session_id)) || !eligible()? {
    log::info!("local-asr: prewarm outcome=ineligible queue_ms={queue_ms}");
    return Ok(ResidentPrewarmOutcome::Ineligible);
  }

  let base = local_asr_dir()?;
  ensure_bundled_runtime_at(&base).map_err(anyhow::Error::msg)?;
  if !qwen_ready_at(&base, model) {
    log::info!("local-asr: prewarm outcome=assets_missing queue_ms={queue_ms}");
    return Ok(ResidentPrewarmOutcome::AssetsMissing);
  }

  let cached = RESIDENT_WORKER.lock().unwrap().take();
  if let Some(mut worker) = cached {
    if worker_identity_matches(worker.model, worker.runtime, model, selected_runtime(&base))
      && worker.session_id == Some(session_id)
      && worker.ctx_size == CTX_FLOOR
      && worker.is_running()
    {
      worker.epoch = lease_epoch;
      park_resident_worker_for(worker, PREWARM_IDLE_TIMEOUT);
      log::info!(
        "local-asr: prewarm outcome=reused ctx={} queue_ms={} resident_spawn_ms=0 idle_ms={}",
        CTX_FLOOR,
        queue_ms,
        PREWARM_IDLE_TIMEOUT.as_millis()
      );
      return Ok(ResidentPrewarmOutcome::Reused);
    }
  }

  let spawn_started = std::time::Instant::now();
  progress.enter("worker-start");
  let mut worker = ResidentWorker::spawn_selected(&base, CTX_FLOOR, Some(session_id), model).await?;
  let resident_spawn_ms = spawn_started.elapsed().as_millis();
  let worker_runtime = worker.runtime.label();
  worker.epoch = lease_epoch;
  park_resident_worker_for(worker, PREWARM_IDLE_TIMEOUT);
  log::info!(
    "local-asr: prewarm outcome=spawned model={model} runtime={} ctx={} queue_ms={} resident_spawn_ms={} idle_ms={}",
    worker_runtime,
    CTX_FLOOR,
    queue_ms,
    resident_spawn_ms,
    PREWARM_IDLE_TIMEOUT.as_millis()
  );
  Ok(ResidentPrewarmOutcome::Spawned)
}

/// Removes the temp WAV on drop -- including when the whole transcribe future
/// is dropped by the caller's tokio::select! on cancellation.
struct TempFile(PathBuf);
impl Drop for TempFile {
  fn drop(&mut self) {
    let _ = fs::remove_file(&self.0);
  }
}

/// Extract the transcription from llama-mtmd-cli stdout. The ASR chat
/// template emits `language <lang><asr_text>TEXT`; silence comes back as
/// `language None<asr_text>` with empty text. If the marker is ever absent
/// (format drift on a llama upgrade), fall back to the trimmed whole output
/// so dictations degrade instead of vanishing.
pub fn parse_mtmd_output(stdout: &str) -> String {
  match stdout.rfind("<asr_text>") {
    Some(idx) => stdout[idx + "<asr_text>".len()..].trim().to_string(),
    None => stdout.trim().to_string(),
  }
}

/// The transcript so far, from a partially-read stdout. None until the
/// `<asr_text>` marker lands — everything before it is the chat template's
/// `language <lang>` prefix, which is not transcript. Unlike
/// parse_mtmd_output this must tolerate a truncated tail: a read can split a
/// multi-byte char, which from_utf8_lossy renders as U+FFFD, so trailing
/// replacement chars are dropped rather than shown as garbage.
fn partial_text(stdout: &[u8]) -> Option<String> {
  let s = String::from_utf8_lossy(stdout);
  let idx = s.rfind("<asr_text>")?;
  Some(s[idx + "<asr_text>".len()..].trim_start().trim_end_matches('\u{FFFD}').to_string())
}

/// Floor on how often partial text is pushed to the webview. The model emits
/// tokens far faster than the UI needs repainting.
const PARTIAL_EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// Run one transcription in a llama-mtmd-cli subprocess. Cancellation-safe
/// by construction: dropping this future kills the child (kill_on_drop) and
/// removes the temp file (TempFile guard).
///
/// stdout is drained incrementally rather than via wait_with_output(): the CLI
/// emits the transcript token-by-token (measured: first byte 2.4s into a 6.5s
/// decode of an 82s clip; 7.7s into 31.7s for a 5.5min one), so partial text is
/// forwarded to the input-prompt window as it lands. This buys *visible
/// progress only* — the whole clip is still encoded before the first token, so
/// total latency and peak memory are unchanged; it is not streaming ASR (the
/// model is encoder-decoder and cannot be).
fn partial_event_payload(
  session_id: Option<u64>,
  chunk_index: Option<u32>,
  text: &str,
) -> serde_json::Value {
  serde_json::json!({
    "sessionId": session_id,
    "chunkIndex": chunk_index,
    "text": text,
  })
}

/// `chunk_index` is `Some` only on the chunked long-audio path, where one
/// dictation decodes as an ordered series of ≤75 s chunks; the frontend routes
/// each partial to that chunk's slot so finalized chunks are not overwritten by
/// a later chunk's in-progress text. `None` means the whole clip is one decode.
#[cfg(test)]
pub async fn transcribe_wav(
  app: Option<&tauri::AppHandle>,
  session_id: Option<u64>,
  chunk_index: Option<u32>,
  wav_bytes: &[u8],
) -> Result<String> {
  transcribe_wav_for(QWEN_MODEL_ID, app, session_id, chunk_index, wav_bytes).await
}

pub async fn transcribe_wav_for(
  model: &str,
  app: Option<&tauri::AppHandle>,
  session_id: Option<u64>,
  chunk_index: Option<u32>,
  wav_bytes: &[u8],
) -> Result<String> {
  let model = normalize_local_model_id(model);
  let progress = PipelineProgress::new("decode", session_id, chunk_index);
  let inference = transcribe_wav_inner_for(model, session_id, chunk_index, wav_bytes, &progress, |text| {
    let Some(app) = app else { return };
    // Broadcast rather than emit_to, by choice — not by necessity. (An earlier
    // version of this comment claimed an Any listener cannot receive a targeted
    // event; that is false — tauri's match_any_or_filter short-circuits on
    // EventTarget::Any before comparing labels, so emit_to would reach
    // ipc-bridge.js too.) input-prompt is the only window listening today, and a
    // broadcast keeps it that way if another window ever wants the partials.
    let _ = app.emit(
      "local-transcription-partial",
      partial_event_payload(session_id, chunk_index, text),
    );
  });
  with_pipeline_deadline(inference, PIPELINE_TIMEOUT, &progress).await
}

/// The runner behind transcribe_wav. `on_partial` receives the transcript so
/// far as tokens land (throttled to PARTIAL_EMIT_INTERVAL, and only when the
/// text actually grew). Split out so tests can observe the streaming without
/// standing up an AppHandle.
async fn transcribe_wav_inner_for(
  model: &'static str,
  session_id: Option<u64>,
  chunk_index: Option<u32>,
  wav_bytes: &[u8],
  progress: &PipelineProgress,
  mut on_partial: impl FnMut(&str),
) -> Result<String> {
  let lease_epoch = RESIDENT_EPOCH.load(Ordering::Relaxed);
  let queued_at = std::time::Instant::now();
  let _inference_permit = LOCAL_INFERENCE
    .acquire()
    .await
    .expect("local inference semaphore is never closed");
  let queue_time = queued_at.elapsed();
  progress.enter("prepare");
  if queue_time >= Duration::from_millis(10) {
    log::info!("local-asr: waited {} ms for inference slot", queue_time.as_millis());
  }
  let first_visible_partial_ms = AtomicU64::new(u64::MAX);
  let mut tracked_partial = |text: &str| {
    let elapsed_ms = queued_at.elapsed().as_millis() as u64;
    let _ = first_visible_partial_ms.compare_exchange(
      u64::MAX,
      elapsed_ms,
      Ordering::Relaxed,
      Ordering::Relaxed,
    );
    on_partial(text);
  };

  let base = local_asr_dir()?;
  ensure_bundled_runtime_at(&base).map_err(anyhow::Error::msg)?;
  if !qwen_ready_at(&base, model) {
    anyhow::bail!("LOCAL_MODEL_MISSING: local model assets are missing or incomplete");
  }

  let tmp_path = std::env::temp_dir().join(format!(
    "typealoud-asr-{}-{}.wav",
    std::process::id(),
    TMP_SEQ.fetch_add(1, Ordering::Relaxed)
  ));
  let _tmp = TempFile(tmp_path.clone());
  fs::write(&tmp_path, wav_bytes)
    .with_context(|| format!("failed to write temp audio {}", tmp_path.display()))?;

  let ctx_size = ctx_size_for_wav(wav_bytes.len());
  let cached = RESIDENT_WORKER.lock().unwrap().take();
  let (reusable, reuse_miss_reason) = match cached {
    None => (None, "cold"),
    Some(mut cached) => {
      if !worker_identity_matches(cached.model, cached.runtime, model, cached.runtime) {
        (None, "model_mismatch")
      } else if cached.runtime != selected_runtime(&base) {
        // The backend changed under a parked worker (a preference switch, or
        // the GPU runtime being taken out of the session). Start a fresh one.
        (None, "runtime_mismatch")
      } else if cached.ctx_size != ctx_size {
        (None, "ctx_mismatch")
      } else if !cached.is_running() {
        (None, "worker_exited")
      } else if let Some(reason) =
        session_reuse_miss(cached.session_id, session_id)
      {
        (None, reason)
      } else {
        (Some(cached), "none")
      }
    }
  };
  let worker_reused = reusable.is_some();
  let mut resident_spawn_ms = None;
  // A worker that never reaches its chat prompt must not fail the dictation:
  // fall through to the one-shot path, which captures the child's stderr and
  // so reports the real cause (a broken runtime install, an unreadable model)
  // instead of the opaque "did not reach its initial prompt".
  let started_worker = match reusable {
    Some(worker) => Some(worker),
    None => {
      progress.enter("worker-start");
      let spawn_started = std::time::Instant::now();
      let result = ResidentWorker::spawn_selected(&base, ctx_size, session_id, model).await;
      resident_spawn_ms = Some(spawn_started.elapsed().as_millis());
      match result {
        Ok(worker) => Some(worker),
        Err(error) => {
          log::warn!("local-asr: resident worker could not start, falling back to one-shot: {error:#}");
          None
        }
      }
    }
  };

  if let Some(mut worker) = started_worker {
    progress.enter("resident-decode");
    worker.epoch = lease_epoch;
    let resident_started = std::time::Instant::now();
    match tokio::time::timeout(
      TRANSCRIBE_TIMEOUT,
      worker.transcribe(&tmp_path, wav_bytes.len(), &mut tracked_partial),
    ).await {
      Ok(Ok(text)) => {
        let resident_decode_ms = resident_started.elapsed().as_millis();
        crate::local_speed::record(model, wav_bytes.len(), resident_decode_ms);
        let worker_runtime = worker.runtime.label();
        progress.enter("park-worker");
        park_resident_worker(worker);
        let total_ms = queued_at.elapsed().as_millis();
        log::info!(
          "local-asr: decode mode=resident model={model} runtime={} session_id={} chunk_index={} ctx={} worker_reused={} reuse_miss={} resident_spawn_ms={} queue_ms={} total_ms={} resident_decode_ms={} first_visible_partial_ms={} wav_kb={} chars={}",
          worker_runtime,
          session_id.map_or_else(|| "none".into(), |value| value.to_string()),
          chunk_index.map_or_else(|| "none".into(), |value| value.to_string()),
          ctx_size,
          worker_reused,
          reuse_miss_reason,
          resident_spawn_ms.map_or_else(|| "0".into(), |value| value.to_string()),
          queue_time.as_millis(),
          total_ms,
          resident_decode_ms,
          match first_visible_partial_ms.load(Ordering::Relaxed) {
            u64::MAX => "none".into(),
            value => value.to_string(),
          },
          wav_bytes.len() / 1024,
          text.chars().count()
        );
        return Ok(text);
      }
      Ok(Err(error)) => {
        log::warn!("local-asr: resident worker failed, retrying one-shot: {error:#}");
      }
      Err(_) => {
        log::warn!(
          "local-asr: resident worker timed out after {}s, retrying one-shot",
          TRANSCRIBE_TIMEOUT.as_secs()
        );
      }
    }
    // A GPU-backed worker that died mid-decode takes the GPU runtime out of
    // this session with it: the retry below must not walk into the same
    // failure, and a lost decode costs the user far more than a lost backend.
    if worker.runtime == Runtime::Gpu {
      disable_gpu_for_process("resident decode failed");
    }
    // `worker` is deliberately not returned to the cache after any protocol
    // failure. kill_on_drop terminates it so the one-shot retry starts clean.
    drop(worker);
  }

  // Compatibility fallback: preserve the original one-process-per-clip path
  // and its detailed stderr diagnostics if chat mode ever drifts in a future
  // pinned llama.cpp build.
  // This path has no ready prompt, so its phase timing intentionally includes
  // process start, model initialization, and decode as one `one_shot_ms` value.
  let started = std::time::Instant::now();
  progress.enter("one-shot-decode");
  let one_shot_runtime = selected_runtime(&base);
  let mut child = local_asr_command(runtime_cli_path(&base, one_shot_runtime))
    .arg("-m").arg(base.join(qwen_assets(model)[0].rel_path))
    .arg("--mmproj").arg(base.join(qwen_assets(model)[1].rel_path))
    .arg("--audio").arg(&tmp_path)
    // Each invocation performs real inference immediately and then exits.
    // llama.cpp's default dummy warmup is redundant here; on the Windows
    // i5-7400 test machine disabling it cut a 3.2 s clip from 5.40 s to 4.62 s.
    .arg("--no-warmup")
    .args(FIT_ARGS)
    .arg("-p").arg("a")
    .arg("-c").arg(ctx_size.to_string())
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true)
    .spawn()
    .context("failed to start llama-mtmd-cli")?;

  let mut child_stdout = child.stdout.take().expect("stdout is piped");
  let mut child_stderr = child.stderr.take().expect("stderr is piped");

  // Shared progress state read by the hang watchdog below. The stdout loop
  // stamps `last_progress_ms` (millis since `started`) every time bytes land and
  // flips `seen_first_byte` on the first one; the watchdog turns a lack of
  // movement into an abort. Relaxed ordering is fine — these are advisory
  // liveness signals, not a synchronization protocol.
  let last_progress_ms = AtomicU64::new(0);
  let seen_first_byte = AtomicBool::new(false);
  let wav_len = wav_bytes.len();

  // Both pipes must be drained concurrently -- letting either fill blocks the
  // child. stdout additionally streams partial text out as it arrives.
  let pump = async {
    let stream_stdout = async {
      let mut acc: Vec<u8> = Vec::new();
      let mut buf = [0u8; 2048];
      let mut last_emit: Option<std::time::Instant> = None;
      let mut last_sent = 0usize;
      loop {
        let n = child_stdout.read(&mut buf).await?;
        if n == 0 {
          break;
        }
        seen_first_byte.store(true, Ordering::Relaxed);
        last_progress_ms.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
        acc.extend_from_slice(&buf[..n]);
        if last_emit.is_some_and(|t| t.elapsed() < PARTIAL_EMIT_INTERVAL) {
          continue;
        }
        if let Some(text) = partial_text(&acc) {
          if text.len() != last_sent {
            last_sent = text.len();
            last_emit = Some(std::time::Instant::now());
            tracked_partial(&text);
          }
        }
      }
      Ok::<Vec<u8>, std::io::Error>(acc)
    };
    let drain_stderr = async {
      let mut acc = Vec::new();
      child_stderr.read_to_end(&mut acc).await?;
      Ok::<Vec<u8>, std::io::Error>(acc)
    };
    tokio::try_join!(stream_stdout, drain_stderr)
  };

  // Hang watchdog: a healthy decode either produces its first byte within the
  // clip-sized grace, or — once flowing — never pauses past NO_PROGRESS_TIMEOUT.
  // Detect a wedged CLI early instead of making the user wait out the flat
  // TRANSCRIBE_TIMEOUT (which stays as the outer hard cap). On a hung verdict we
  // return Err; the function returning drops `child` (kill_on_drop) and `_tmp`.
  let watchdog = async {
    loop {
      tokio::time::sleep(WATCHDOG_POLL).await;
      let since_start = started.elapsed();
      let since_progress =
        since_start.saturating_sub(Duration::from_millis(last_progress_ms.load(Ordering::Relaxed)));
      match stall_check(
        seen_first_byte.load(Ordering::Relaxed),
        since_start,
        since_progress,
        wav_len,
      ) {
        StallCheck::Ok => continue,
        StallCheck::HungBeforeFirstByte => {
          break anyhow::anyhow!(
            "local ASR produced no output within {}s for a {}s clip — treating as hung",
            first_byte_deadline(wav_len).as_secs(),
            wav_len.saturating_sub(44) / 32000
          );
        }
        StallCheck::HungMidDecode => {
          break anyhow::anyhow!(
            "local ASR stalled mid-decode (no progress for {}s) — treating as hung",
            NO_PROGRESS_TIMEOUT.as_secs()
          );
        }
      }
    }
  };

  let (stdout_bytes, stderr_bytes) = tokio::select! {
    pumped = tokio::time::timeout(TRANSCRIBE_TIMEOUT, pump) => pumped
      .map_err(|_| anyhow::anyhow!("local ASR timed out after {}s", TRANSCRIBE_TIMEOUT.as_secs()))?
      .context("failed to read llama-mtmd-cli output")?,
    hung = watchdog => return Err(hung),
  };
  progress.enter("child-exit");
  let status = child.wait().await.context("failed to run llama-mtmd-cli")?;

  if !status.success() {
    let stderr = String::from_utf8_lossy(&stderr_bytes);
    let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    // After dynamic ctx sizing (see CTX_CAP), a decode failure almost always
    // means the clip still exceeded the KV-cache cap. Translate the raw llama
    // error ("failed to decode audio"/"failed to decode token") into something
    // the user can act on instead of surfacing the CLI's internals.
    if stderr.contains("failed to decode") {
      let secs = wav_bytes.len().saturating_sub(44) / 32000;
      anyhow::bail!(
        "Recording is too long for the on-device model ({secs}s). Keep local dictation under ~13 minutes, or switch to a cloud provider in Settings for long recordings."
      );
    }
    anyhow::bail!("llama-mtmd-cli failed ({status}): {last}");
  }

  let text = parse_mtmd_output(&String::from_utf8_lossy(&stdout_bytes));
  let one_shot_ms = started.elapsed().as_millis();
  let total_ms = queued_at.elapsed().as_millis();
  // Counts only -- no transcribed text in logs.
  log::info!(
    "local-asr: decode mode=one_shot model={model} runtime={} session_id={} chunk_index={} ctx={} worker_reused={} reuse_miss={} resident_spawn_ms={} queue_ms={} total_ms={} one_shot_ms={} first_visible_partial_ms={} wav_kb={} chars={}",
    one_shot_runtime.label(),
    session_id.map_or_else(|| "none".into(), |value| value.to_string()),
    chunk_index.map_or_else(|| "none".into(), |value| value.to_string()),
    ctx_size,
    worker_reused,
    reuse_miss_reason,
    resident_spawn_ms.map_or_else(|| "0".into(), |value| value.to_string()),
    queue_time.as_millis(),
    total_ms,
    one_shot_ms,
    match first_visible_partial_ms.load(Ordering::Relaxed) {
      u64::MAX => "none".into(),
      value => value.to_string(),
    },
    wav_bytes.len() / 1024,
    text.chars().count()
  );
  Ok(text)
}

/// Emit a progress event at most every this many bytes.
const PROGRESS_EMIT_STEP: u64 = 8 * 1024 * 1024;
/// A source that sends nothing for this long is treated as failed, so the next
/// source resumes the .part. A blocked host often accepts the connection and
/// then goes silent, which the connect timeout alone never catches.
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(20);
/// After this long, a source averaging below `DOWNLOAD_MIN_BYTES_PER_SEC` gives
/// way to the next one. The last source is never dropped for being slow.
const DOWNLOAD_SLOW_WINDOW: Duration = Duration::from_secs(15);
const DOWNLOAD_MIN_BYTES_PER_SEC: u64 = 200 * 1024;

/// Hosts that serve mainland China reliably, where the global hosts often don't.
/// `typealoud.app/download` carries the runtime archives, which GitHub
/// alone hosts otherwise.
const CN_MIRROR_HOSTS: &[&str] = &["modelscope.cn", "typealoud.app"];

/// Mainland China time zones, including the legacy aliases some systems still
/// report. Hong Kong and Macau reach Hugging Face directly, so they stay out.
fn is_mainland_china_time_zone(tz: &str) -> bool {
  matches!(
    tz,
    "Asia/Shanghai" | "Asia/Chongqing" | "Asia/Chungking" | "Asia/Harbin" | "Asia/Urumqi" | "Asia/Kashgar" | "PRC"
  )
}

pub(crate) fn is_cn_mirror(url: &str) -> bool {
  let host = url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or("");
  CN_MIRROR_HOSTS.iter().any(|mirror| host == *mirror || host.ends_with(&format!(".{mirror}")))
}

/// The time zone is a local, offline hint for where the machine is; it sends
/// nothing anywhere. Browser language would misplace Chinese speakers abroad.
/// A wrong guess only costs one stall/slow check before the next source.
fn ordered_urls(asset: &Asset) -> Vec<&'static str> {
  ordered_urls_for(asset.urls, prefers_cn_mirrors())
}

pub(crate) fn prefers_cn_mirrors() -> bool {
  iana_time_zone::get_timezone().map(|tz| is_mainland_china_time_zone(&tz)).unwrap_or(false)
}

fn ordered_urls_for(urls: &[&'static str], prefer_cn: bool) -> Vec<&'static str> {
  let mut ordered = urls.to_vec();
  if prefer_cn {
    // Stable sort keeps the listed order within each group.
    ordered.sort_by_key(|url| !is_cn_mirror(url));
  }
  ordered
}

/// Whether a source that has streamed `bytes` in `elapsed` should give way.
fn source_too_slow(bytes: u64, elapsed: Duration) -> bool {
  elapsed >= DOWNLOAD_SLOW_WINDOW && bytes < DOWNLOAD_MIN_BYTES_PER_SEC * elapsed.as_secs()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
  pub state: String,
  pub downloaded_bytes: u64,
  pub total_bytes: u64,
}

fn qwen_status(model: &str, downloading: bool) -> ModelStatus {
  match local_asr_dir() {
    Ok(dir) => {
      if let Err(error) = ensure_bundled_runtime_at(&dir) {
        log::warn!("failed to install bundled local ASR runtime: {error}");
      }
      qwen_status_at(&dir, model, downloading)
    }
    Err(_) => ModelStatus {
      state: "absent".into(),
      downloaded_bytes: 0,
      total_bytes: qwen_total_bytes(model),
    },
  }
}

fn ensure_bundled_runtime_at(dir: &Path) -> Result<(), String> {
  let asset = llama_zip_asset();
  let Some(bytes) = asset.bundled else { return Ok(()) };
  if !models_ready_at(dir) || installed_runtime_is_current(dir) {
    return Ok(());
  }

  let _install = BUNDLED_RUNTIME_INSTALL.lock().map_err(|e| e.to_string())?;
  if installed_runtime_is_current(dir) {
    return Ok(());
  }
  if bytes.len() as u64 != asset.size {
    return Err(format!("bundled runtime size mismatch: {} != {}", bytes.len(), asset.size));
  }
  let hash = format!("{:x}", sha2::Sha256::digest(bytes));
  if hash != asset.sha256 {
    return Err("bundled runtime sha256 mismatch".into());
  }

  let archive_path = dir.join(asset.rel_path);
  let part_path = dir.join(format!("{}.part", asset.rel_path));
  if let Some(parent) = archive_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  fs::write(&part_path, bytes).map_err(|e| e.to_string())?;
  fs::rename(&part_path, &archive_path).map_err(|e| e.to_string())?;
  extract_runtime_archive(dir, Runtime::Cpu)?;
  let _ = fs::remove_file(archive_path);
  Ok(())
}

#[cfg(test)]
fn model_status_at(dir: &Path, downloading: bool) -> ModelStatus {
  qwen_status_at(dir, QWEN_MODEL_ID, downloading)
}

fn qwen_status_at(dir: &Path, model: &str, downloading: bool) -> ModelStatus {
  let mut downloaded = 0u64;
  let mut complete = true;
  let zip = llama_zip_asset();
  // Model files count by exact size; the zip counts as fully downloaded once
  // the extracted CLI exists (the archive is removed after extraction).
  for a in qwen_assets(model) {
    let got = fs::metadata(dir.join(a.rel_path)).map(|m| m.len()).unwrap_or(0);
    if got == a.size {
      downloaded += a.size;
    } else {
      complete = false;
      downloaded += got.min(a.size);
      if let Ok(m) = fs::metadata(dir.join(format!("{}.part", a.rel_path))) {
        downloaded += m.len().min(a.size);
      }
    }
  }
  let cli = cli_path(dir);
  if fs::metadata(&cli).map(|m| m.is_file()).unwrap_or(false) && is_executable(&cli) {
    downloaded += zip.size;
  } else {
    complete = false;
    if let Ok(m) = fs::metadata(dir.join(format!("{}.part", zip.rel_path))) {
      downloaded += m.len().min(zip.size);
    } else if let Ok(m) = fs::metadata(dir.join(zip.rel_path)) {
      downloaded += m.len().min(zip.size);
    }
  }
  let state = if downloading {
    "downloading"
  } else if complete {
    "ready"
  } else if downloaded > 0 {
    "partial"
  } else {
    "absent"
  };
  ModelStatus { state: state.into(), downloaded_bytes: downloaded, total_bytes: qwen_total_bytes(model) }
}

fn emit_progress(model: &str, app: &tauri::AppHandle, state: &str, downloaded: u64, message: Option<&str>) {
  let _ = app.emit(
    "local-model-download-progress",
    serde_json::json!({
      "model": model,
      "state": state,
      "downloadedBytes": downloaded,
      "totalBytes": qwen_total_bytes(model),
      "message": message,
    }),
  );
}

/// Download all missing assets (resumable), verify sha256, extract the llama
/// archive, mark the CLI executable. Terminal events are emitted by the COMMAND.
async fn download_qwen_model(model: &str, app: tauri::AppHandle, cancel: CancellationToken) -> Result<(), String> {
  let dir = local_asr_dir().map_err(|e| e.to_string())?;
  let client = reqwest::Client::builder()
    .connect_timeout(std::time::Duration::from_secs(15))
    .build()
    .map_err(|e| e.to_string())?;

  let report = |downloaded: u64| emit_progress(model, &app, "downloading", downloaded, None);

  let mut done: u64 = 0;
  for a in qwen_assets(model) {
    if fs::metadata(dir.join(a.rel_path)).map(|m| m.len() == a.size).unwrap_or(false) {
      done += a.size;
      continue;
    }
    download_asset(&report, &client, &dir, a, &cancel, done).await?;
    done += a.size;
    emit_progress(model, &app, "downloading", done, None);
  }

  ensure_bundled_runtime_at(&dir)?;
  let zip = llama_zip_asset();
  if !(fs::metadata(cli_path(&dir)).map(|m| m.is_file()).unwrap_or(false) && is_executable(&cli_path(&dir))) {
    let zip_final = dir.join(zip.rel_path);
    if !fs::metadata(&zip_final).map(|m| m.len() == zip.size).unwrap_or(false) {
      download_asset(&report, &client, &dir, zip, &cancel, done).await?;
    }
    let dir2 = dir.clone();
    tokio::task::spawn_blocking(move || extract_runtime_archive(&dir2, Runtime::Cpu))
      .await
      .map_err(|e| e.to_string())??;
    let _ = fs::remove_file(&zip_final); // archive no longer needed
  }
  Ok(())
}

/// Extract the archive into bin/<LLAMA_BUILD>/, flattening every entry to its
/// basename, and mark extracted files executable on unix (the CLI needs it; the
/// bundled dylibs don't care). Flattening keeps us independent of the archive's
/// top-level folder naming across llama.cpp releases -- adjust ONLY if the
/// Task-3 Step-1 rpath check demanded preserved structure.
///
/// Symlinks MUST be recreated, not skipped: macOS/Linux llama.cpp ships each
/// versioned dylib/.so as a real file (libX.0.0.9960.dylib) PLUS a compatibility
/// symlink (libX.0.dylib) that is the install-name the executables link against.
/// Dropping those symlinks (the pre-2026-07 bug: `!is_file() { continue }` ate
/// them) left dyld unable to resolve @rpath/libX.0.dylib, so llama-mtmd-cli
/// SIGABRT'd on the FIRST clean download. It hid in dev because that machine's
/// bin/ had been laid out by a manual `tar` extraction, which keeps symlinks.
///
/// macOS/Linux releases are gzip-compressed tarballs; Windows releases are a
/// real zip (Task 2 finding) -- so the two platforms use different crates.
#[cfg(unix)]
fn extract_runtime_archive(base: &Path, runtime: Runtime) -> Result<(), String> {
  use std::os::unix::fs::PermissionsExt;
  let asset = runtime_asset(runtime).ok_or("no runtime archive for this platform")?;
  let archive_path = base.join(asset.rel_path);
  let out_dir = runtime_bin_dir(base, runtime);
  fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
  let file = fs::File::open(&archive_path).map_err(|e| e.to_string())?;
  let gz = flate2::read::GzDecoder::new(file);
  let mut archive = tar::Archive::new(gz);
  for entry in archive.entries().map_err(|e| e.to_string())? {
    let mut entry = entry.map_err(|e| e.to_string())?;
    let entry_type = entry.header().entry_type();
    let entry_path = entry.path().map_err(|e| e.to_string())?.into_owned();
    let Some(name) = entry_path.file_name().map(|n| n.to_owned()) else { continue };
    let out_path = out_dir.join(&name);

    // Compat symlink (libX.0.dylib -> libX.0.0.9960.dylib): recreate it,
    // flattening the target to a basename to match our same-dir flattened
    // layout (llama's targets are already same-dir). Creating it before the
    // target file lands is fine -- a dangling symlink resolves once the real
    // file is written later in this same loop.
    if entry_type.is_symlink() {
      if let Some(target) = entry
        .link_name()
        .map_err(|e| e.to_string())?
        .and_then(|t| t.file_name().map(|n| n.to_owned()))
      {
        let _ = fs::remove_file(&out_path); // replace any stale entry
        std::os::unix::fs::symlink(&target, &out_path).map_err(|e| e.to_string())?;
      }
      continue;
    }
    if !entry_type.is_file() {
      continue;
    }
    let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    fs::set_permissions(&out_path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
  }
  if !fs::metadata(runtime_cli_path(base, runtime)).map(|m| m.is_file()).unwrap_or(false) {
    return Err("archive did not contain llama-mtmd-cli".into());
  }
  write_runtime_stamp(base, runtime);
  Ok(())
}

#[cfg(windows)]
fn extract_runtime_archive(base: &Path, runtime: Runtime) -> Result<(), String> {
  let asset = runtime_asset(runtime).ok_or("no runtime archive for this platform")?;
  let zip_path = base.join(asset.rel_path);
  let out_dir = runtime_bin_dir(base, runtime);
  fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
  let file = fs::File::open(&zip_path).map_err(|e| e.to_string())?;
  let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
  for i in 0..archive.len() {
    let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
    if entry.is_dir() {
      continue;
    }
    let Some(name) = Path::new(entry.name()).file_name().map(|n| n.to_owned()) else { continue };
    let out_path = out_dir.join(name);
    let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
    std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
  }
  if !fs::metadata(runtime_cli_path(base, runtime)).map(|m| m.is_file()).unwrap_or(false) {
    return Err("archive did not contain llama-mtmd-cli".into());
  }
  write_runtime_stamp(base, runtime);
  Ok(())
}

async fn download_asset(
  on_progress: &(dyn Fn(u64) + Sync),
  client: &reqwest::Client,
  dir: &Path,
  asset: &Asset,
  cancel: &CancellationToken,
  done_bytes: u64,
) -> Result<(), String> {
  let part_path = dir.join(format!("{}.part", asset.rel_path));
  if let Some(parent) = part_path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }

  let mut last_err = String::new();
  let urls = ordered_urls(asset);
  for (index, url) in urls.iter().copied().enumerate() {
    let has_fallback = index + 1 < urls.len();
    if cancel.is_cancelled() {
      return Err("DOWNLOAD_CANCELLED".into());
    }
    let offset = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    // A .part larger than the target is corrupt — restart it. One exactly at
    // the target size may be a finished stream that died before verification
    // (sha256 of ~800MB takes seconds) — skip straight to verification and
    // salvage it instead of asking the server for `bytes=<size>-` (HTTP 416).
    let offset = if offset > asset.size { 0 } else { offset };
    let stream_result = if offset == asset.size {
      Ok(())
    } else {
      stream_to_part(on_progress, client, url, &part_path, offset, asset, cancel, done_bytes, has_fallback).await
    };
    match stream_result {
      Ok(()) => {
        let got = fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        if got != asset.size {
          last_err = format!("{}: size mismatch {got} != {}", asset.rel_path, asset.size);
          let _ = fs::remove_file(&part_path);
          continue;
        }
        let path_for_hash = part_path.clone();
        let hash = tokio::task::spawn_blocking(move || -> Result<String, String> {
          let mut hasher = sha2::Sha256::new();
          let mut reader = fs::File::open(&path_for_hash).map_err(|e| e.to_string())?;
          std::io::copy(&mut reader, &mut hasher).map_err(|e| e.to_string())?;
          Ok(format!("{:x}", hasher.finalize()))
        })
        .await
        .map_err(|e| e.to_string())??;
        if hash != asset.sha256 {
          last_err = format!("{}: sha256 mismatch", asset.rel_path);
          let _ = fs::remove_file(&part_path);
          continue;
        }
        fs::rename(&part_path, dir.join(asset.rel_path)).map_err(|e| e.to_string())?;
        return Ok(());
      }
      Err(err) if err == "DOWNLOAD_CANCELLED" => return Err(err),
      Err(err) => {
        // Keep the .part -- the next source (byte-identical) resumes it.
        last_err = format!("{url}: {err}");
        log::warn!("asset download source failed: {last_err}");
      }
    }
  }
  Err(format!("failed to download {}: {last_err}", asset.rel_path))
}

#[allow(clippy::too_many_arguments)]
async fn stream_to_part(
  on_progress: &(dyn Fn(u64) + Sync),
  client: &reqwest::Client,
  url: &str,
  part_path: &Path,
  offset: u64,
  asset: &Asset,
  cancel: &CancellationToken,
  done_bytes: u64,
  has_fallback: bool,
) -> Result<(), String> {
  use std::io::Write;

  let mut request = client.get(url);
  if offset > 0 {
    request = request.header(reqwest::header::RANGE, format!("bytes={offset}-"));
  }
  let response = tokio::select! {
    _ = cancel.cancelled() => return Err("DOWNLOAD_CANCELLED".into()),
    response = tokio::time::timeout(DOWNLOAD_STALL_TIMEOUT, request.send()) => {
      response.map_err(|_| "no response".to_string())?.map_err(|e| e.to_string())?
    }
  };
  let status = response.status();
  if !status.is_success() {
    return Err(format!("HTTP {status}"));
  }
  let append = offset > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT;
  let mut out = fs::OpenOptions::new()
    .create(true)
    .append(append)
    .write(true)
    .truncate(!append)
    .open(part_path)
    .map_err(|e| e.to_string())?;
  let mut written = if append { offset } else { 0 };
  let mut last_emit = written;

  let mut response = response;
  let started = std::time::Instant::now();
  let mut speed_checked = !has_fallback;
  loop {
    let chunk = tokio::select! {
      _ = cancel.cancelled() => return Err("DOWNLOAD_CANCELLED".into()),
      chunk = tokio::time::timeout(DOWNLOAD_STALL_TIMEOUT, response.chunk()) => {
        chunk.map_err(|_| format!("stalled for {}s", DOWNLOAD_STALL_TIMEOUT.as_secs()))?.map_err(|e| e.to_string())?
      }
    };
    let Some(chunk) = chunk else { break };
    out.write_all(&chunk).map_err(|e| e.to_string())?;
    written += chunk.len() as u64;
    if !speed_checked && started.elapsed() >= DOWNLOAD_SLOW_WINDOW {
      speed_checked = true;
      let streamed = written - if append { offset } else { 0 };
      if source_too_slow(streamed, started.elapsed()) {
        out.flush().map_err(|e| e.to_string())?;
        return Err(format!("too slow ({} KB in {}s)", streamed / 1024, started.elapsed().as_secs()));
      }
    }
    if written - last_emit >= PROGRESS_EMIT_STEP {
      last_emit = written;
      on_progress(done_bytes + written.min(asset.size));
    }
  }
  out.flush().map_err(|e| e.to_string())?;
  Ok(())
}

/// Settings "delete model": stop the Qwen worker, then remove only Qwen files.
fn delete_qwen_model(model: &str) -> Result<(), String> {
  shutdown_resident_worker();
  let dir = local_asr_dir().map_err(|e| e.to_string())?;
  delete_qwen_assets_at(&dir, model)
}

fn delete_qwen_assets_at(dir: &Path, model: &str) -> Result<(), String> {
  // Both Qwen sizes share the runtime. Deleting one must preserve the other.
  for asset in qwen_assets(model) {
    for path in [dir.join(asset.rel_path), dir.join(format!("{}.part", asset.rel_path))] {
      match fs::remove_file(path) {
        Ok(()) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(error.to_string()),
      }
    }
  }
  Ok(())
}

pub fn model_status_for(model: &str, downloading: bool) -> ModelStatus {
  match normalize_local_model_id(model) {
    NEMOTRON_MODEL_ID => crate::nemotron_asr::model_status(downloading),
    _ => qwen_status(model, downloading),
  }
}

pub async fn download_model_for(
  model: &str,
  app: tauri::AppHandle,
  cancel: CancellationToken,
) -> Result<(), String> {
  match normalize_local_model_id(model) {
    NEMOTRON_MODEL_ID => crate::nemotron_asr::download_model(app, cancel).await,
    _ => download_qwen_model(model, app, cancel).await,
  }
}

pub fn delete_model_for(model: &str) -> Result<(), String> {
  match normalize_local_model_id(model) {
    NEMOTRON_MODEL_ID => crate::nemotron_asr::delete_model(),
    _ => delete_qwen_model(model),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn worker_identity_rejects_model_and_runtime_switches() {
    assert!(worker_identity_matches(QWEN_LARGE_MODEL_ID, Runtime::Cpu, QWEN_LARGE_MODEL_ID, Runtime::Cpu));
    assert!(!worker_identity_matches(QWEN_MODEL_ID, Runtime::Cpu, QWEN_LARGE_MODEL_ID, Runtime::Cpu));
    assert!(!worker_identity_matches(QWEN_LARGE_MODEL_ID, Runtime::Cpu, QWEN_MODEL_ID, Runtime::Cpu));
    assert!(!worker_identity_matches(QWEN_LARGE_MODEL_ID, Runtime::Gpu, QWEN_LARGE_MODEL_ID, Runtime::Cpu));
  }

  #[test]
  fn large_qwen_has_independent_assets_and_deletion() {
    assert_eq!(normalize_local_model_id(QWEN_LARGE_MODEL_ID), QWEN_LARGE_MODEL_ID);
    assert_eq!(qwen_assets(QWEN_LARGE_MODEL_ID).iter().map(|a| a.size).sum::<u64>(), 2_520_744_288);
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    fs::create_dir_all(dir.join("models")).unwrap();
    for asset in MODEL_ASSETS.iter().chain(LARGE_MODEL_ASSETS) {
      fs::File::create(dir.join(asset.rel_path)).unwrap().set_len(asset.size).unwrap();
    }
    let cli = cli_path(dir);
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(&cli, "runtime").unwrap();
    #[cfg(unix)] {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(qwen_ready_at(dir, QWEN_LARGE_MODEL_ID));
    assert!(qwen_ready_at(dir, QWEN_MODEL_ID));
    assert_eq!(qwen_status_at(dir, QWEN_LARGE_MODEL_ID, false).state, "ready");
    delete_qwen_assets_at(dir, QWEN_LARGE_MODEL_ID).unwrap();
    assert!(!qwen_ready_at(dir, QWEN_LARGE_MODEL_ID));
    assert!(qwen_ready_at(dir, QWEN_MODEL_ID));
    assert!(cli.exists());
  }

  #[test]
  fn device_list_keeps_names_and_drops_the_header() {
    let listed = parse_device_list(
      "Available devices:\n  Vulkan0: Intel(R) HD Graphics 630 (12243 MiB, 11475 MiB free)\n  Vulkan1: NVIDIA GeForce RTX 4070 (12282 MiB, 11000 MiB free)\n",
    );
    assert_eq!(listed, vec!["Intel(R) HD Graphics 630", "NVIDIA GeForce RTX 4070"]);
  }

  #[test]
  fn device_list_is_empty_when_no_device_is_reported() {
    // What a machine without a Vulkan driver prints — the pack is installed and
    // runs, it simply sees nothing, and the UI has to distinguish that from
    // "not downloaded".
    assert!(parse_device_list("Available devices:\n").is_empty());
    assert!(parse_device_list("").is_empty());
  }

  #[test]
  fn unknown_compute_preferences_fall_back_to_auto() {
    // The config file is user-editable, so an unrecognised value must never
    // select a backend.
    assert_eq!(ComputePreference::parse("gpu"), ComputePreference::Gpu);
    assert_eq!(ComputePreference::parse(" cpu "), ComputePreference::Cpu);
    assert_eq!(ComputePreference::parse("auto"), ComputePreference::Auto);
    assert_eq!(ComputePreference::parse("CUDA"), ComputePreference::Auto);
    assert_eq!(ComputePreference::parse(""), ComputePreference::Auto);
  }

  #[test]
  fn the_two_runtimes_never_share_a_directory() {
    // Both packs can be installed at once; switching back to CPU must not
    // re-download anything, and neither extraction may overwrite the other.
    let base = Path::new("base");
    assert_ne!(runtime_bin_dir(base, Runtime::Cpu), runtime_bin_dir(base, Runtime::Gpu));
    assert_eq!(runtime_bin_dir(base, Runtime::Cpu), bin_dir(base));
    assert_ne!(runtime_cli_path(base, Runtime::Cpu), runtime_cli_path(base, Runtime::Gpu));
  }

  #[test]
  fn an_uninstalled_gpu_pack_is_not_reported_as_installed() {
    let temp = tempfile::TempDir::new().unwrap();
    assert!(!gpu_runtime_ready_at(temp.path()));

    // A CLI dropped in by hand, or left by the pre-1.12 manual Vulkan installer,
    // carries no stamp saying which archive produced it — so it does not count.
    let dir = runtime_bin_dir(temp.path(), Runtime::Gpu);
    fs::create_dir_all(&dir).unwrap();
    fs::write(runtime_cli_path(temp.path(), Runtime::Gpu), b"not the real cli").unwrap();
    assert!(!gpu_runtime_ready_at(temp.path()));
  }

  #[test]
  fn only_an_explicit_gpu_choice_with_an_installed_pack_leaves_the_cpu() {
    let temp = tempfile::TempDir::new().unwrap();
    let previous = compute_preference();
    for value in ["auto", "cpu", "gpu"] {
      COMPUTE_PREFERENCE.store(ComputePreference::parse(value).code(), Ordering::Relaxed);
      // No pack is installed under this temp dir, so even "gpu" stays on CPU
      // rather than pointing at a runtime that does not exist.
      assert_eq!(selected_runtime(temp.path()), Runtime::Cpu, "preference {value}");
    }
    COMPUTE_PREFERENCE.store(previous.code(), Ordering::Relaxed);
  }

  #[test]
  fn pipeline_phase_transition_emits_one_line_with_previous_duration() {
    struct CaptureLogger(Mutex<Vec<String>>);
    impl log::Log for CaptureLogger {
      fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.target() == "typealoud_lifecycle"
      }
      fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
          let line = record.args().to_string();
          if line.contains("operation=transition-test ") {
            self.0.lock().unwrap().push(line);
          }
        }
      }
      fn flush(&self) {}
    }
    static LOGGER: CaptureLogger = CaptureLogger(Mutex::new(Vec::new()));
    log::set_logger(&LOGGER).expect("this test owns the process logger");
    log::set_max_level(log::LevelFilter::Info);
    let progress = PipelineProgress::new("transition-test", Some(77), Some(4));
    LOGGER.0.lock().unwrap().clear();
    progress.enter("resident-decode");
    progress.finished.store(true, Ordering::Relaxed);
    let lines = LOGGER.0.lock().unwrap().clone();
    assert_eq!(lines.len(), 1, "a phase change needs only one persisted event");
    assert!(lines[0].contains("phase=resident-decode event=start"));
    assert!(lines[0].contains("previous_phase=inference-queue"));
    assert!(lines[0].contains("previous_elapsed_ms="));
    assert!(lines[0].contains("total_ms="));
  }

  #[tokio::test]
  async fn pipeline_deadline_releases_a_slot_held_during_an_unbounded_wait() {
    let semaphore = Semaphore::new(1);
    let progress = PipelineProgress::new("decode", Some(7), Some(0));
    let result: Result<()> = with_pipeline_deadline(
      async {
        let _permit = semaphore.acquire().await.unwrap();
        progress.enter("child-exit");
        std::future::pending().await
      },
      Duration::from_millis(10),
      &progress,
    ).await;
    let message = result.unwrap_err().to_string();
    assert!(message.contains("timed out"));
    assert!(message.contains("child-exit"));
    assert_eq!(semaphore.available_permits(), 1);
  }

  #[tokio::test]
  async fn pipeline_deadline_covers_waiting_for_the_inference_slot() {
    let semaphore = Semaphore::new(1);
    let held = semaphore.acquire().await.unwrap();
    let progress = PipelineProgress::new("decode", Some(8), None);
    let result: Result<()> = with_pipeline_deadline(
      async {
        let _permit = semaphore.acquire().await.unwrap();
        Ok(())
      },
      Duration::from_millis(10),
      &progress,
    ).await;
    assert!(result.unwrap_err().to_string().contains("inference-queue"));
    drop(held);
    assert!(semaphore.try_acquire().is_ok());
  }

  #[tokio::test]
  async fn pipeline_deadline_preserves_success_and_ordinary_errors() {
    let progress = PipelineProgress::new("decode", Some(9), None);
    assert_eq!(with_pipeline_deadline(async { Ok(42) }, Duration::from_secs(1), &progress).await.unwrap(), 42);
    let progress = PipelineProgress::new("prewarm", None, None);
    let result: Result<()> = with_pipeline_deadline(
      async { anyhow::bail!("test failure") }, Duration::from_secs(1), &progress
    ).await;
    assert_eq!(result.unwrap_err().to_string(), "test failure");
  }

  #[cfg(unix)]
  #[tokio::test]
  async fn pipeline_deadline_cleans_up_when_child_outlives_both_pipes() {
    let directory = tempfile::TempDir::new().unwrap();
    let path = directory.path().join("request.wav");
    fs::write(&path, b"test audio").unwrap();
    let pid = std::sync::atomic::AtomicU32::new(0);
    let progress = PipelineProgress::new("decode", Some(10), Some(0));
    let result: Result<()> = with_pipeline_deadline(async {
      let _temp_file = TempFile(path.clone());
      let mut child = tokio::process::Command::new("/bin/sh")
        .args(["-c", "exec 1>&- 2>&-; exec sleep 60"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
      pid.store(child.id().unwrap(), Ordering::Relaxed);
      let mut stdout = child.stdout.take().unwrap();
      let mut stderr = child.stderr.take().unwrap();
      let mut out = Vec::new();
      let mut err = Vec::new();
      tokio::try_join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err))?;
      progress.enter("child-exit");
      child.wait().await?;
      Ok(())
    }, Duration::from_secs(1), &progress).await;
    assert!(result.unwrap_err().to_string().contains("child-exit"));
    assert!(!path.exists(), "timing out removes the owned temporary audio");
    let child_pid = pid.load(Ordering::Relaxed).to_string();
    tokio::time::timeout(Duration::from_secs(2), async {
      loop {
        let alive = tokio::process::Command::new("/bin/kill")
          .args(["-0", &child_pid])
          .stdout(Stdio::null()).stderr(Stdio::null())
          .status().await.unwrap().success();
        if !alive { break; }
        tokio::time::sleep(Duration::from_millis(20)).await;
      }
    }).await.expect("kill_on_drop must terminate the child");
  }

  #[test]
  fn manifest_is_filled_and_totals_are_sane() {
    assert_eq!(MODEL_ASSETS.len(), 2);
    for a in MODEL_ASSETS.iter().chain(std::iter::once(llama_zip_asset())) {
      assert_eq!(a.sha256.len(), 64, "{} sha256 must be real", a.rel_path);
      assert!(a.size > 0, "{} size must be real", a.rel_path);
      assert!(!a.urls.is_empty() || a.bundled.is_some());
    }
    let total = total_download_bytes();
    // ~1.02GB models + a 10-80MB zip
    assert!(total > 1_020_000_000 && total < 1_150_000_000, "total = {total}");
    assert_ne!(LLAMA_BUILD, "<FILL-STEP-1>");
  }

  #[test]
  fn qwen_models_list_hugging_face_first_with_a_china_mirror() {
    for a in MODEL_ASSETS.iter().chain(LARGE_MODEL_ASSETS) {
      assert!(a.urls[0].starts_with("https://huggingface.co/"), "{}", a.rel_path);
      assert!(a.urls.iter().any(|url| is_cn_mirror(url)), "{}", a.rel_path);
    }
  }

  #[test]
  fn runtime_archives_list_github_first_with_a_china_mirror() {
    let mut runtimes = vec![llama_zip_asset()];
    runtimes.extend(gpu_zip_asset());
    for a in runtimes {
      assert!(a.urls[0].starts_with("https://github.com/"), "{}", a.rel_path);
      assert!(a.urls.iter().any(|url| is_cn_mirror(url)), "{}", a.rel_path);
    }
  }

  #[test]
  fn china_mirrors_lead_only_in_mainland_time_zones() {
    let urls: &[&'static str] = &["https://huggingface.co/a", "https://modelscope.cn/b", "https://github.com/c"];
    assert_eq!(ordered_urls_for(urls, false), urls.to_vec());
    assert_eq!(
      ordered_urls_for(urls, true),
      vec!["https://modelscope.cn/b", "https://huggingface.co/a", "https://github.com/c"]
    );
    for tz in ["Asia/Shanghai", "Asia/Urumqi", "PRC"] {
      assert!(is_mainland_china_time_zone(tz), "{tz}");
    }
    for tz in ["Asia/Hong_Kong", "Asia/Macau", "Asia/Taipei", "Australia/Adelaide", "UTC"] {
      assert!(!is_mainland_china_time_zone(tz), "{tz}");
    }
    assert!(is_cn_mirror("https://cdn-lfs-cn-1.modelscope.cn/x"));
    assert!(!is_cn_mirror("https://evil.com/modelscope.cn"));
    assert!(!is_cn_mirror("https://notmodelscope.cn/x"));
  }

  #[test]
  fn slow_sources_give_way_only_after_the_window() {
    assert!(!source_too_slow(0, Duration::from_secs(14)));
    assert!(source_too_slow(1024 * 1024, Duration::from_secs(15)));
    assert!(!source_too_slow(4 * 1024 * 1024, Duration::from_secs(15)));
  }

  #[test]
  fn local_model_ids_normalize_to_qwen_without_clobbering_nemotron() {
    assert_eq!(normalize_local_model_id(""), QWEN_MODEL_ID);
    assert_eq!(normalize_local_model_id("unknown-model"), QWEN_MODEL_ID);
    assert_eq!(normalize_local_model_id(QWEN_MODEL_ID), QWEN_MODEL_ID);
    assert_eq!(normalize_local_model_id(NEMOTRON_MODEL_ID), NEMOTRON_MODEL_ID);
  }

  #[test]
  fn model_readiness_is_independent_for_qwen_and_nemotron() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();

    for asset in MODEL_ASSETS {
      let path = dir.join(asset.rel_path);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      fs::File::create(path).unwrap().set_len(asset.size).unwrap();
    }
    let cli = cli_path(dir);
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(&cli, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    }

    assert!(assets_ready_for_at(dir, QWEN_MODEL_ID));
    assert!(!assets_ready_for_at(dir, NEMOTRON_MODEL_ID));
  }
  #[test]
  fn a_repeated_transcript_is_flagged_including_an_empty_one() {
    assert!(!repeats_previous(None, "hello"), "nothing to compare on the first decode");
    assert!(!repeats_previous(None, ""), "an empty first decode is not a repeat");
    assert!(repeats_previous(Some("hello"), "hello"));
    assert!(!repeats_previous(Some("hello"), "goodbye"));
    // What an is_empty() guard used to let through. A worker serving stale
    // state twice is still stale, and retiring it on the empty repeat is what
    // stops the decode after it from returning real words belonging to the
    // previous clip.
    assert!(repeats_previous(Some(""), ""), "an empty repeat is still a repeat");
    assert!(!repeats_previous(Some(""), "hello"));
  }

  #[test]
  fn worker_reuse_never_crosses_a_recording_session() {
    let active = 81_001;
    let other = 81_002;
    assert_eq!(
      session_reuse_miss(Some(active), Some(other)),
      Some("session_mismatch")
    );
    assert_eq!(session_reuse_miss(Some(active), Some(active)), None);

    // A decode with no session must never inherit a worker, and an unowned
    // worker is never handed on — including to another unowned decode, which a
    // plain `Option == Option` would have called a match.
    assert_eq!(session_reuse_miss(None, None), Some("unowned"));
    assert_eq!(session_reuse_miss(Some(active), None), Some("unowned"));
    assert_eq!(session_reuse_miss(None, Some(active)), Some("session_mismatch"));

    assert!(!finish_resident_session(active));
    assert_eq!(
      session_reuse_miss(Some(active), Some(active)),
      Some("session_finished")
    );
  }

  #[test]
  fn assets_ready_requires_models_at_exact_size_and_an_executable_cli() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();
    assert!(!assets_ready_at(dir));
    for a in MODEL_ASSETS {
      let p = dir.join(a.rel_path);
      fs::create_dir_all(p.parent().unwrap()).unwrap();
      fs::File::create(&p).unwrap().set_len(a.size).unwrap(); // sparse, fast
    }
    assert!(!assets_ready_at(dir), "still missing the cli binary");
    let cli = cli_path(dir);
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(&cli, b"#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      // Not executable yet -> not ready on unix.
      assert!(!assets_ready_at(dir));
      fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(assets_ready_at(dir));
    // Truncate one model -> not ready.
    fs::File::create(dir.join(MODEL_ASSETS[0].rel_path)).unwrap().set_len(1).unwrap();
    assert!(!assets_ready_at(dir));
  }

  // Byte-exact stdout captured 2026-07-13 from a real llama-mtmd-cli run
  // (Task 3 Step 1): bin/b9960/llama-mtmd-cli -m models/Qwen3-ASR-0.6B-Q8_0.gguf
  // --mmproj models/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf --audio <wav> -p "a" -c 2048.
  #[test]
  fn parse_extracts_text_after_the_asr_marker() {
    let sample = "\nlanguage Chinese<asr_text>然后这次是我输入了命令之后啊，讲一次哈。我觉得Unity。\n\n\n";
    assert_eq!(parse_mtmd_output(sample), "然后这次是我输入了命令之后啊，讲一次哈。我觉得Unity。");
  }

  #[test]
  fn parse_silence_yields_empty() {
    let sample = "\nlanguage None<asr_text>\n\n\n";
    assert_eq!(parse_mtmd_output(sample), "");
  }

  #[test]
  fn parse_without_marker_falls_back_to_trimmed_whole() {
    assert_eq!(parse_mtmd_output("  plain text out  \n"), "plain text out");
    assert_eq!(parse_mtmd_output(""), "");
  }

  #[test]
  fn partial_text_waits_for_the_marker_then_tracks_the_tail() {
    // Nothing to show until the marker lands: the `language <lang>` prefix is
    // chat-template noise, not transcript.
    assert_eq!(partial_text(b"\nlangua"), None);
    assert_eq!(partial_text(b"\nlanguage Chinese"), None);
    // Marker present but no tokens yet -> empty, not None.
    assert_eq!(partial_text("\nlanguage Chinese<asr_text>".as_bytes()), Some(String::new()));
    // Tokens arriving.
    assert_eq!(
      partial_text("\nlanguage Chinese<asr_text>今天我想".as_bytes()),
      Some("今天我想".into())
    );
    // A read can split a multi-byte char; the partial tail must be dropped
    // rather than surfaced as U+FFFD garbage in the UI.
    let full = "\nlanguage Chinese<asr_text>今天".as_bytes();
    let truncated = &full[..full.len() - 1]; // chop one byte off 天
    assert_eq!(partial_text(truncated), Some("今".into()));
  }

  #[test]
  fn partial_event_payload_includes_the_recording_session() {
    let payload = partial_event_payload(Some(7), None, "hello");

    assert_eq!(payload["sessionId"], 7);
    assert_eq!(payload["text"], "hello");
  }

  #[test]
  fn legacy_assets_are_removed_without_touching_current_models() {
    let root = std::env::temp_dir().join(format!(
      "typealoud-legacy-assets-{}-{}",
      std::process::id(),
      TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let legacy_onnx = root.join("models/qwen3-asr-0.6b-int8");
    let current_model = root.join("local-asr/models/Qwen3-ASR-0.6B-Q8_0.gguf");
    let legacy_runtime = root.join("local-asr/bin/b9960");
    let current_runtime = root.join("local-asr/bin").join(LLAMA_BUILD);
    fs::create_dir_all(&legacy_onnx).unwrap();
    fs::create_dir_all(current_model.parent().unwrap()).unwrap();
    fs::create_dir_all(&legacy_runtime).unwrap();
    fs::create_dir_all(&current_runtime).unwrap();
    fs::write(legacy_onnx.join("encoder.int8.onnx"), b"old").unwrap();
    fs::write(&current_model, b"current").unwrap();

    cleanup_legacy_assets_at(&root).unwrap();

    assert!(!legacy_onnx.exists());
    assert!(current_model.exists());
    assert!(current_runtime.exists());
    if LLAMA_BUILD != "b9960" {
      assert!(!legacy_runtime.exists());
    }
    fs::remove_dir_all(root).unwrap();
  }

  #[test]
  fn ctx_scales_with_clip_length_within_bounds() {
    // 16 kHz mono 16-bit WAV = 32000 bytes/s after a 44-byte header.
    let wav = |secs: f64| 44 + (secs * 32000.0) as usize;
    // Short clips stay at the floor (== the old fixed 2048), so their memory
    // footprint is unchanged; empty/sub-header input must not underflow.
    assert_eq!(ctx_size_for_wav(wav(1.0)), CTX_FLOOR);
    assert_eq!(ctx_size_for_wav(wav(60.0)), CTX_FLOOR); // 60*20+512=1712 < floor
    // Keep this paired with chunk-decision.mjs HARD_MAX_S. Every live chunk
    // must fit the same resident worker created at recording start.
    assert_eq!(ctx_size_for_wav(wav(75.0)), CTX_FLOOR);
    assert_eq!(ctx_size_for_wav(0), CTX_FLOOR);
    assert_eq!(ctx_size_for_wav(10), CTX_FLOOR); // shorter than the WAV header
    // ~135 s failed at the old fixed 2048; the formula lifts it clear (verified
    // end-to-end: 135 s–300 s clips that failed at 2048 decode cleanly here).
    assert_eq!(ctx_size_for_wav(wav(135.0)), 135 * 20 + 512);
    assert!(ctx_size_for_wav(wav(135.0)) > CTX_FLOOR);
    // A pathological clip clamps to the cap rather than ballooning the KV cache.
    assert_eq!(ctx_size_for_wav(wav(900.0)), CTX_CAP); // 900*20+512 > cap
  }

  #[test]
  fn local_inference_disables_per_process_device_fitting() {
    assert_eq!(FIT_ARGS, ["--fit", "off"]);
  }

  #[tokio::test]
  async fn local_inference_semaphore_allows_only_one_decode() {
    let first = LOCAL_INFERENCE.acquire().await.unwrap();
    assert_eq!(LOCAL_INFERENCE.available_permits(), 0);
    assert!(
      tokio::time::timeout(Duration::from_millis(10), LOCAL_INFERENCE.acquire())
        .await
        .is_err(),
      "a second local decode must wait"
    );

    drop(first);
    let second = tokio::time::timeout(Duration::from_millis(100), LOCAL_INFERENCE.acquire())
      .await
      .expect("released slot should wake the next decode")
      .unwrap();
    drop(second);
    assert_eq!(LOCAL_INFERENCE.available_permits(), 1);
  }

  #[test]
  fn prewarm_deadline_outlives_the_frontend_hard_chunk_limit() {
    assert!(PREWARM_IDLE_TIMEOUT > Duration::from_secs(75));
  }

  #[test]
  fn first_byte_deadline_scales_with_clip_length_over_a_base() {
    // 16 kHz mono 16-bit WAV = 32000 bytes/s after a 44-byte header.
    let wav = |secs: f64| 44 + (secs * 32000.0) as usize;
    // Empty / sub-header input must not underflow — just the base.
    assert_eq!(first_byte_deadline(0), FIRST_BYTE_BASE);
    assert_eq!(first_byte_deadline(10), FIRST_BYTE_BASE); // shorter than the header
    // Base + 0.1 s per audio-second. Measured first byte was 2.4 s for an 82 s
    // clip and 7.7 s for a 5.5 min one, so these deadlines keep ~5-10x margin.
    assert_eq!(first_byte_deadline(wav(82.0)), FIRST_BYTE_BASE + Duration::from_millis(8200));
    assert_eq!(first_byte_deadline(wav(330.0)), FIRST_BYTE_BASE + Duration::from_millis(33000));
    // Longer clip => longer grace, and it stays under the hard cap.
    assert!(first_byte_deadline(wav(780.0)) > first_byte_deadline(wav(82.0)));
    assert!(first_byte_deadline(wav(780.0)) < TRANSCRIBE_TIMEOUT);
  }

  #[test]
  fn stall_check_flags_a_missing_first_byte_past_the_clip_grace() {
    let wav = |secs: f64| 44 + (secs * 32000.0) as usize;
    let clip = wav(82.0);
    let grace = first_byte_deadline(clip); // 23.2 s
    // Before the grace elapses, a silent process is still just encoding.
    assert_eq!(
      stall_check(false, grace - Duration::from_secs(1), grace - Duration::from_secs(1), clip),
      StallCheck::Ok
    );
    // Past the grace with still no byte -> wedged during encode.
    assert_eq!(
      stall_check(false, grace + Duration::from_secs(1), grace + Duration::from_secs(1), clip),
      StallCheck::HungBeforeFirstByte
    );
  }

  #[test]
  fn stall_check_flags_a_stalled_decode_after_first_byte() {
    let clip = 44 + 82 * 32000;
    // Tokens flowing recently -> Ok, regardless of total elapsed.
    assert_eq!(
      stall_check(true, Duration::from_secs(300), NO_PROGRESS_TIMEOUT - Duration::from_secs(1), clip),
      StallCheck::Ok
    );
    // Silent past the no-progress window -> wedged mid-decode.
    assert_eq!(
      stall_check(true, Duration::from_secs(300), NO_PROGRESS_TIMEOUT + Duration::from_secs(1), clip),
      StallCheck::HungMidDecode
    );
  }

  #[test]
  fn model_status_reports_absent_partial_ready() {
    let temp = tempfile::TempDir::new().unwrap();
    let dir = temp.path();
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "absent");
    assert_eq!(s.total_bytes, total_download_bytes());
    assert_eq!(s.downloaded_bytes, 0);

    // One finished GGUF + one .part -> partial, bytes add up.
    let a0 = &MODEL_ASSETS[0];
    let p = dir.join(a0.rel_path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::File::create(&p).unwrap().set_len(a0.size).unwrap();
    let part = dir.join(format!("{}.part", MODEL_ASSETS[1].rel_path));
    fs::create_dir_all(part.parent().unwrap()).unwrap();
    fs::File::create(&part).unwrap().set_len(1000).unwrap();
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "partial");
    assert_eq!(s.downloaded_bytes, a0.size + 1000);

    assert_eq!(model_status_at(dir, true).state, "downloading");

    // Everything in place (incl. executable cli) -> ready. The zip itself is
    // deleted after extraction, so "ready" ignores it; its bytes count as
    // downloaded when the cli exists.
    for a in MODEL_ASSETS {
      let p = dir.join(a.rel_path);
      fs::create_dir_all(p.parent().unwrap()).unwrap();
      fs::File::create(&p).unwrap().set_len(a.size).unwrap();
    }
    let cli = cli_path(dir);
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(&cli, b"x").unwrap();
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let s = model_status_at(dir, false);
    assert_eq!(s.state, "ready");
    assert_eq!(s.downloaded_bytes, s.total_bytes);
  }

  // Regression for the fresh-download SIGABRT: the tar extractor used to drop
  // the versioned-dylib compatibility symlinks, so dyld could not resolve
  // @rpath/libX.0.dylib and llama-mtmd-cli aborted on every clean download.
  #[cfg(unix)]
  #[test]
  fn extract_recreates_dylib_symlinks() {
    use flate2::{write::GzEncoder, Compression};

    let temp = tempfile::TempDir::new().unwrap();
    let base = temp.path();
    let archive_path = base.join(llama_zip_asset().rel_path);
    fs::create_dir_all(archive_path.parent().unwrap_or(base)).unwrap();

    // A .tar.gz mimicking llama's macOS layout under a top-level folder (to
    // exercise basename-flattening): real versioned dylib + compat symlink + CLI.
    {
      let gz = GzEncoder::new(fs::File::create(&archive_path).unwrap(), Compression::fast());
      let mut b = tar::Builder::new(gz);

      let real = b"real-dylib-bytes";
      let mut h = tar::Header::new_gnu();
      h.set_entry_type(tar::EntryType::Regular);
      h.set_size(real.len() as u64);
      h.set_mode(0o644);
      b.append_data(&mut h, "llama/build/bin/libllama-common.0.0.9960.dylib", &real[..]).unwrap();

      let mut h = tar::Header::new_gnu();
      h.set_entry_type(tar::EntryType::Symlink);
      h.set_size(0);
      h.set_mode(0o777);
      b.append_link(&mut h, "llama/build/bin/libllama-common.0.dylib", "libllama-common.0.0.9960.dylib")
        .unwrap();

      let cli = b"#!/bin/sh\n";
      let mut h = tar::Header::new_gnu();
      h.set_entry_type(tar::EntryType::Regular);
      h.set_size(cli.len() as u64);
      h.set_mode(0o755);
      b.append_data(&mut h, "llama/build/bin/llama-mtmd-cli", &cli[..]).unwrap();

      b.into_inner().unwrap().finish().unwrap();
    }

    extract_runtime_archive(base, Runtime::Cpu).unwrap();

    let link = bin_dir(base).join("libllama-common.0.dylib");
    assert!(
      fs::symlink_metadata(&link).unwrap().file_type().is_symlink(),
      "compat symlink must be recreated, not skipped"
    );
    assert_eq!(
      fs::read(&link).unwrap(),
      b"real-dylib-bytes",
      "symlink must resolve to the real versioned dylib"
    );
  }

  /// Real-hardware check for the GPU pack: install it, ask it what devices this
  /// machine has, and decode one clip on it. Everything below the settings UI.
  /// Needs the real model assets, plus the Vulkan archive either already
  /// extracted, sitting in the app-data dir, or pointed at by
  /// `TYPEALOUD_TEST_VULKAN_ZIP` (this test never goes to the network). Run:
  ///   cargo test real_gpu_runtime_decodes -- --ignored --nocapture
  #[test]
  #[ignore]
  fn real_gpu_runtime_decodes() {
    let base = local_asr_dir().expect("assets dir");
    ensure_bundled_runtime_at(&base).expect("install bundled runtime");
    assert!(assets_ready_at(&base), "lay out the model assets first");
    let asset = gpu_zip_asset().expect("this platform ships a GPU pack");

    if !gpu_runtime_ready_at(&base) {
      let archive = base.join(asset.rel_path);
      if !archive.exists() {
        let source = std::env::var("TYPEALOUD_TEST_VULKAN_ZIP").expect(
          "GPU pack not installed: set TYPEALOUD_TEST_VULKAN_ZIP to the downloaded archive",
        );
        fs::copy(&source, &archive).expect("stage the archive");
      }
      extract_runtime_archive(&base, Runtime::Gpu).expect("extract the GPU runtime");
      // download_gpu_runtime removes the archive once extracted; this staging
      // path has to do the same or it leaves 33 MB behind in app data.
      let _ = fs::remove_file(&archive);
    }
    assert!(
      gpu_runtime_ready_at(&base),
      "extraction must leave a stamp that marks the pack installed"
    );

    let rt = tokio::runtime::Runtime::new().unwrap();
    let devices = rt.block_on(gpu_devices());
    println!("GPU devices: {devices:?}");
    assert!(
      !devices.is_empty(),
      "no Vulkan device on this machine — the pack cannot be exercised here"
    );

    // 5s of silence, the same clip real_subprocess_smoke uses: shorter digital
    // silence makes the model hallucinate a filler token.
    let mut wav = Vec::new();
    let data_len = 160_000u32;
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&16000u32.to_le_bytes());
    wav.extend_from_slice(&32000u32.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.resize(wav.len() + data_len as usize, 0);

    let temp = tempfile::TempDir::new().unwrap();
    let clip = temp.path().join("silence.wav");
    fs::write(&clip, &wav).unwrap();

    let started = std::time::Instant::now();
    let mut worker = rt
      .block_on(ResidentWorker::spawn(&base, CTX_FLOOR, Some(9_003), Runtime::Gpu, QWEN_MODEL_ID))
      .expect("a GPU worker must start once the pack is installed");
    let spawn_ms = started.elapsed().as_millis();
    let decode_started = std::time::Instant::now();
    let text = rt
      .block_on(worker.transcribe(&clip, wav.len(), &mut |_: &str| {}))
      .expect("GPU decode ok");
    println!(
      "GPU spawn {spawn_ms} ms, decode {} ms",
      decode_started.elapsed().as_millis()
    );
    assert_eq!(text, "", "silence must yield empty text on the GPU too");
  }

  /// Needs the real assets laid out. Prewarms, decodes once, and proves session
  /// finalization retires the parked worker. Multi-audio isolation is measured
  /// separately by `real_reuse_contamination_rate` below. Run:
  ///   cargo test real_subprocess_smoke -- --ignored --nocapture
  #[test]
  #[ignore]
  fn real_subprocess_smoke() {
    let base = local_asr_dir().expect("assets dir");
    ensure_bundled_runtime_at(&base).expect("install bundled runtime");
    assert!(assets_ready_at(&base), "lay out the model assets first");
    let rt = tokio::runtime::Runtime::new().unwrap();
    // 5s of silence WAV (44-byte header + zeros), built inline. Duration
    // matters here: measured 2026-07-13, pure-digital-zero clips <=2s make
    // the model hallucinate a filler "嗯。" instead of returning empty text
    // (0.5s/1s/2s all hallucinate; 5s/10s decode cleanly to ""). 5s clears
    // that threshold with margin.
    let mut wav = Vec::new();
    let data_len = 160_000u32; // 5s * 16000Hz * 2 bytes
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());          // PCM
    wav.extend_from_slice(&1u16.to_le_bytes());          // mono
    wav.extend_from_slice(&16000u32.to_le_bytes());      // rate
    wav.extend_from_slice(&32000u32.to_le_bytes());      // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes());          // block align
    wav.extend_from_slice(&16u16.to_le_bytes());         // bits
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    wav.resize(wav.len() + data_len as usize, 0);
    let starts_before = RESIDENT_STARTS.load(Ordering::Relaxed);
    let session_id = 9_001;
    let prewarm = rt
      .block_on(prewarm_resident_worker(session_id, || Ok(true)))
      .expect("resident prewarm ok");
    assert_eq!(prewarm, ResidentPrewarmOutcome::Spawned);
    assert_eq!(
      RESIDENT_STARTS.load(Ordering::Relaxed) - starts_before,
      1,
      "prewarm must start exactly one resident worker"
    );
    let first = rt
      .block_on(transcribe_wav(None, Some(session_id), Some(0), &wav))
      .expect("first resident decode ok");
    assert_eq!(first, "", "silence must yield empty text");

    assert_eq!(
      RESIDENT_STARTS.load(Ordering::Relaxed) - starts_before,
      1
    );
    assert!(RESIDENT_WORKER.lock().unwrap().is_some());
    let retired = finish_resident_session(session_id);
    assert!(retired);
    assert!(
      RESIDENT_WORKER.lock().unwrap().is_none(),
      "the session's worker is destroyed as soon as the dictation is done"
    );
    shutdown_resident_worker();
    // Temp file cleaned up:
    let leftovers = fs::read_dir(std::env::temp_dir()).unwrap()
      .filter_map(|e| e.ok())
      .filter(|e| e.file_name().to_string_lossy().starts_with("typealoud-asr-"))
      .count();
    assert_eq!(leftovers, 0, "temp wav files must be removed");
  }

  /// How often upstream b9960 hands a reused worker the *previous* audio. That
  /// rate is the whole case for session-scoped reuse, so this measures it
  /// rather than gating on it: the only assertion is the invariant that a
  /// contaminated decode is never **accepted**, which holds at any rate, and
  /// the rate itself is printed for a human to read.
  ///
  /// Why it has to be measured rather than reasoned about: vendor's
  /// README records "every decode after the first returned the previous clip's
  /// transcript" on Windows against stock b9960, with `/clear` in between
  /// exactly as `ResidentWorker::transcribe` sends it. If that still holds,
  /// reuse is a net loss — every second chunk pays a rejected decode plus a
  /// cold one-shot, where retiring after each decode paid one hidden model
  /// load. If it is rare, reuse saves a model load per chunk. Nothing between
  /// those two conclusions is decidable from the source.
  ///
  /// The loop mirrors production: one worker serves a session's chunks, and a
  /// rejected decode retires it so the next chunk starts a fresh process.
  ///
  /// Needs the real assets plus two 16 kHz mono WAVs of *different* speech —
  /// identical clips cannot tell contamination from a correct repeat:
  ///   TYPEALOUD_TEST_WAV_A=a.wav TYPEALOUD_TEST_WAV_B=b.wav \
  ///     cargo test real_reuse_contamination_rate -- --ignored --nocapture
  ///
  /// Optional: `TYPEALOUD_TEST_REUSE_SESSIONS` (default 3) and
  /// `TYPEALOUD_TEST_REUSE_CHUNKS` (default 8) size the sample.
  #[test]
  #[ignore]
  fn real_reuse_contamination_rate() {
    let base = local_asr_dir().expect("assets dir");
    ensure_bundled_runtime_at(&base).expect("install bundled runtime");
    assert!(assets_ready_at(&base), "lay out the model assets first");
    let path_a = std::env::var("TYPEALOUD_TEST_WAV_A").expect("set TYPEALOUD_TEST_WAV_A");
    let path_b = std::env::var("TYPEALOUD_TEST_WAV_B").expect("set TYPEALOUD_TEST_WAV_B");
    let wav_a = fs::read(&path_a).expect("read TYPEALOUD_TEST_WAV_A");
    let wav_b = fs::read(&path_b).expect("read TYPEALOUD_TEST_WAV_B");
    assert_ne!(wav_a, wav_b, "the two clips must differ");
    let ctx = ctx_size_for_wav(wav_a.len());
    assert_eq!(ctx, ctx_size_for_wav(wav_b.len()), "both clips must map to one context");

    let sample = |key: &str, default: usize| {
      std::env::var(key).ok().and_then(|value| value.parse().ok()).unwrap_or(default)
    };
    let sessions = sample("TYPEALOUD_TEST_REUSE_SESSIONS", 3);
    let chunks = sample("TYPEALOUD_TEST_REUSE_CHUNKS", 8);
    assert!(sessions >= 1, "measure at least one session");
    assert!(chunks >= 2, "a session needs two chunks before anything is reused");

    let rt = tokio::runtime::Runtime::new().unwrap();
    let clips = [("A", &path_a, wav_a.len()), ("B", &path_b, wav_b.len())];

    // Ground truth. The first audio in a process cannot be contaminated —
    // there is no previous one — so one fresh worker per clip gives the
    // transcripts that make a *silently wrong* decode recognisable below. The
    // repeat check inside `transcribe` only sees adjacent decodes; these
    // references see all of them.
    let reference: Vec<String> = clips
      .iter()
      .map(|(label, path, len)| {
        let mut worker = rt
          .block_on(ResidentWorker::spawn(&base, ctx, Some(9_002), Runtime::Cpu, QWEN_MODEL_ID))
          .expect("reference worker");
        let text = rt
          .block_on(worker.transcribe(Path::new(*path), *len, &mut |_: &str| {}))
          .unwrap_or_else(|error| panic!("reference decode for clip {label} failed: {error:#}"));
        assert!(!text.trim().is_empty(), "clip {label} must transcribe to speech");
        text
      })
      .collect();
    assert_ne!(
      reference[0], reference[1],
      "both clips transcribe to the same text, so contamination would be invisible — \
       use clips with different speech",
    );

    // Two populations. A decode on a worker that has already served one can be
    // contaminated; the first decode in a process cannot be, so its failures
    // are the machine's own baseline — a loaded box trips the `/audio`
    // deadline whether or not anything is reused. Counting them separately is
    // what makes the reused rate attributable to reuse instead of to load.
    let mut reused_decodes = 0usize;
    let mut reused_contaminated = 0usize;
    let mut reused_other_failures = 0usize;
    let mut fresh_decodes = 0usize;
    let mut fresh_failures = 0usize;
    // Sessions cut short because the machine could not start a worker at all.
    let mut spawn_failures = 0usize;

    for session in 0..sessions {
      let session_id = 9_100 + session as u64;
      let mut worker = rt
        .block_on(ResidentWorker::spawn(&base, ctx, Some(session_id), Runtime::Cpu, QWEN_MODEL_ID))
        .expect("session worker");
      let mut served = 0usize;

      for chunk in 0..chunks {
        let (label, path, len) = clips[chunk % clips.len()];
        let reused = served > 0;
        if reused { reused_decodes += 1 } else { fresh_decodes += 1 }

        match rt.block_on(worker.transcribe(Path::new(path), len, &mut |_: &str| {})) {
          Ok(text) => {
            served += 1;
            let mine = &reference[chunk % clips.len()];
            let theirs = &reference[(chunk + 1) % clips.len()];
            assert_ne!(
              &text, theirs,
              "session {session} chunk {chunk} (clip {label}): the OTHER clip's transcript was \
               returned and accepted — the contamination guard let a wrong result through",
            );
            if &text != mine {
              eprintln!(
                "session {session} chunk {chunk} clip {label}: accepted, but drifted from this \
                 clip's reference transcript",
              );
            }
          }
          Err(error) => {
            let message = format!("{error:#}");
            match (reused, message.contains("contaminated")) {
              (true, true) => reused_contaminated += 1,
              (true, false) => reused_other_failures += 1,
              (false, _) => fresh_failures += 1,
            }
            let population = if reused { "reused" } else { "fresh" };
            eprintln!("session {session} chunk {chunk} clip {label} [{population}]: rejected: {message}");
            // Production retires a rejected worker and re-decodes one-shot, so
            // the next chunk here starts a fresh process too.
            worker = match rt.block_on(ResidentWorker::spawn(&base, ctx, Some(session_id), Runtime::Cpu, QWEN_MODEL_ID)) {
              Ok(replacement) => replacement,
              Err(spawn_error) => {
                // A box already saturated by this loop can fail to start a
                // worker at all. That is the machine, not reuse — record it and
                // end this session instead of aborting the whole measurement,
                // which would throw away every sample collected so far.
                eprintln!(
                  "session {session} chunk {chunk}: no replacement worker, ending session \
                   early: {spawn_error:#}",
                );
                spawn_failures += 1;
                break;
              }
            };
            served = 0;
          }
        }
      }
    }

    let pct = |part: usize, whole: usize| {
      if whole == 0 { 0.0 } else { part as f64 * 100.0 / whole as f64 }
    };
    let reused_failures = reused_contaminated + reused_other_failures;
    eprintln!(
      "\n=== reuse contamination rate ===\n\
       fresh decodes (control): {fresh_decodes:>4}, rejected {fresh_failures:>4}  ({:.1}%)\n\
       reused decodes:          {reused_decodes:>4}, rejected {reused_failures:>4}  ({:.1}%)\n\
         of which contaminated: {reused_contaminated:>4}              ({:.1}% of reused)\n\
         of which died/timed out:{reused_other_failures:>4}\n\
       sessions cut short (no worker could start): {spawn_failures}\n\
       \n\
       A first decode cannot be contaminated, so the control rate is what this machine \
       costs under load. Reuse is worth keeping only while the reused rate stays close to \
       it: every rejected reused decode pays a wasted decode plus a cold one-shot, where \
       retiring after each decode paid one model load hidden under the user's speech.",
      pct(fresh_failures, fresh_decodes),
      pct(reused_failures, reused_decodes),
      pct(reused_contaminated, reused_decodes),
    );
  }
}

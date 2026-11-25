//! Install replacement runtimes without taking an existing offline engine down.
use super::*;

const PREVIOUS_BUILD: &str = "b9960";

fn previous_dir(base: &Path, runtime: Runtime) -> PathBuf {
  let suffix = if runtime == Runtime::Gpu { "-vulkan" } else { "" };
  base.join("bin").join(format!("{PREVIOUS_BUILD}{suffix}"))
}

fn previous_hash(runtime: Runtime) -> Option<&'static str> {
  // SHA-256 pins shipped in v1.22.0. Do not adopt arbitrary old extractions.
  match runtime_asset(runtime)?.rel_path {
    "llama-macos-arm64.tar.gz" => Some("7a8c6b6ae3395e15b5cc330ed2938cc0aa4510905db1189658fd022035734b48"),
    "llama-macos-x64.tar.gz" => Some("d42000ae003fd61d7db50997af0e80f421524e30b534856c66573d064a478c1d"),
    "llama-win-x64.zip" => Some("795333e29cedf9f9ef9ae91324bfa423e338d39d75cc63a8dd76d1686c32ced6"),
    "llama-linux-x64.tar.gz" => Some("542732e344420ff904c1d72acfeef6341f509232c5d131809421943235a818a2"),
    "llama-win-vulkan-x64.zip" => Some("712ccd52eb6d2a77cf79e44d1645f6860990ea9295ca06e2d9609ee741b62616"),
    _ => None,
  }
}

fn previous_cli(base: &Path, runtime: Runtime) -> Option<PathBuf> {
  let cli = previous_dir(base, runtime).join(CLI_NAME);
  verified_cli(&cli, previous_hash(runtime)?).then_some(cli)
}

pub(super) fn usable_cli(base: &Path, runtime: Runtime) -> Option<PathBuf> {
  if runtime_is_installed(base, runtime) {
    Some(runtime_cli_path(base, runtime))
  } else {
    previous_cli(base, runtime)
  }
}

pub(super) fn remove_previous(base: &Path, runtime: Runtime) -> Result<()> {
  remove_legacy_dir(&previous_dir(base, runtime))
}

// Manual downloads and maintenance share one writer per pack, not the inference
// permit. A network outage must never hold a dictation behind a download.
#[derive(Default)]
struct InstallGate {
  writer: tokio::sync::Mutex<()>,
  background_network: Mutex<Option<CancellationToken>>,
}

impl InstallGate {
  async fn manual(&self) -> tokio::sync::MutexGuard<'_, ()> {
    let wait = self.writer.lock();
    tokio::pin!(wait);
    // Join the FIFO before inspecting the background token: once queued, no
    // background try_lock can slip in between cancellation and acquisition.
    if let std::task::Poll::Ready(guard) = futures_util::poll!(&mut wait) {
      return guard;
    }
    if let Some(network) = self.background_network.lock().unwrap().take() {
      network.cancel();
    }
    wait.await
  }

  fn background(&self) -> Option<(tokio::sync::MutexGuard<'_, ()>, CancellationToken)> {
    // Publish the token atomically with taking the writer. A manual waiter
    // observing a busy writer must see this token, even on another thread.
    let mut slot = self.background_network.lock().unwrap();
    let writer = self.writer.try_lock().ok()?;
    let network = CancellationToken::new();
    *slot = Some(network.clone());
    Some((writer, network))
  }
}

fn install_gate(runtime: Runtime) -> &'static InstallGate {
  static CPU: OnceLock<InstallGate> = OnceLock::new();
  static GPU: OnceLock<InstallGate> = OnceLock::new();
  match runtime { Runtime::Cpu => &CPU, Runtime::Gpu => &GPU }.get_or_init(InstallGate::default)
}

pub(super) async fn gpu_install_guard() -> tokio::sync::MutexGuard<'static, ()> {
  install_gate(Runtime::Gpu).manual().await
}

// Called with the lock held. Always hash a cached archive too: a matching
// length alone cannot justify stamping the extracted files as verified.
async fn install_locked(
  base: &Path, runtime: Runtime, client: &reqwest::Client, cancel: &CancellationToken,
  report: &(dyn Fn(u64) + Sync), done: u64,
) -> Result<(), String> {
  if runtime_is_installed(base, runtime) { return Ok(()); }
  let asset = runtime_asset(runtime).ok_or("Runtime unavailable on this platform")?;
  let archive = base.join(asset.rel_path);
  if archive.exists() {
    // Feed a complete cached file back through the downloader's existing SHA
    // verification without issuing a request. A bad or old file is replaced.
    if fs::metadata(&archive).map(|m| m.len() == asset.size).unwrap_or(false) {
      let part = base.join(format!("{}.part", asset.rel_path));
      if !part.exists() {
        fs::rename(&archive, part).map_err(|e| e.to_string())?;
      }
    }
    if archive.exists() { fs::remove_file(&archive).map_err(|e| e.to_string())?; }
  }
  download_asset(report, client, base, asset, cancel, done).await?;
  let dir = base.to_owned();
  tokio::task::spawn_blocking(move || {
    // A previous failed extraction must not supply a missing binary or dylib.
    remove_legacy_dir(&runtime_bin_dir(&dir, runtime)).map_err(|e| e.to_string())?;
    extract_runtime_archive(&dir, runtime)
  }).await.map_err(|e| e.to_string())??;
  let _ = fs::remove_file(archive);
  Ok(())
}

pub(super) async fn install(
  base: &Path, runtime: Runtime, client: &reqwest::Client, cancel: &CancellationToken,
  report: &(dyn Fn(u64) + Sync), done: u64,
) -> Result<(), String> {
  let _guard = tokio::select! {
    guard = install_gate(runtime).manual() => guard,
    _ = cancel.cancelled() => return Err("DOWNLOAD_CANCELLED".into()),
  };
  install_locked(base, runtime, client, cancel, report, done).await
}

fn pending(base: &Path, runtime: Runtime) -> bool {
  !runtime_is_installed(base, runtime) && previous_cli(base, runtime).is_some()
}

async fn upgrade_if_installed(base: &Path, runtime: Runtime, client: &reqwest::Client) -> Result<(), String> {
  if !pending(base, runtime) { return Ok(()); }
  let (_guard, cancel) = install_gate(runtime).background().ok_or("runtime install busy")?;
  // A manual install or removal may have won between the check and try_lock.
  if !pending(base, runtime) { return Ok(()); }
  install_locked(base, runtime, client, &cancel, &|_| {}, 0).await
}

pub(crate) fn start() {
  tauri::async_runtime::spawn(async {
    let Ok(base) = local_asr_dir() else { return };
    let Ok(client) = reqwest::Client::builder().connect_timeout(Duration::from_secs(15)).build() else { return };
    loop {
      let mut retry = false;
      for runtime in [Runtime::Cpu, Runtime::Gpu] {
        if let Err(error) = upgrade_if_installed(&base, runtime, &client).await {
          log::warn!("local-asr: {} runtime upgrade deferred: {error}", runtime.label());
          retry = true;
        }
      }
      if !retry { return; }
      tokio::time::sleep(Duration::from_secs(3600)).await;
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn stage_previous(base: &Path, runtime: Runtime) -> PathBuf {
    let cli = previous_dir(base, runtime).join(CLI_NAME);
    crate::local_asr::tests::stage_test_cli(&cli, previous_hash(runtime).unwrap());
    cli
  }

  fn offline_client() -> reqwest::Client {
    reqwest::Client::builder()
      .proxy(reqwest::Proxy::all("http://127.0.0.1:0").unwrap())
      .timeout(Duration::from_secs(1)).build().unwrap()
  }

  #[tokio::test]
  async fn manual_requests_preempt_only_background_network_and_wait_for_safe_handoff() {
    let gate = InstallGate::default();
    let other = InstallGate::default();
    let (_other_guard, other_network) = other.background().unwrap();
    let (writing, background_network) = gate.background().unwrap();
    let mut manual = Box::pin(gate.manual());
    tokio::select! {
      biased;
      _ = &mut manual => panic!("must wait for the current writer to finish"),
      _ = std::future::ready(()) => {}
    }
    assert!(background_network.is_cancelled(), "wake a slow network immediately");
    assert!(!other_network.is_cancelled(), "independent CPU/Vulkan pack");
    drop(writing);
    assert!(gate.background().is_none(), "do not start maintenance ahead of a waiting user");
    let first = manual.await;
    let mut second = Box::pin(gate.manual());
    tokio::select! {
      biased;
      _ = &mut second => panic!("manual writes must be serialized"),
      _ = std::future::ready(()) => {}
    }
    drop(first);
    drop(second);
    assert!(gate.background().is_some(), "a cancelled waiter cannot starve retries");
  }

  static TEST_PACKS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

  #[tokio::test]
  async fn a_real_background_transfer_yields_to_a_manual_install() {
    use std::sync::Arc;
    struct StalledDns(tokio::sync::Notify);
    impl reqwest::dns::Resolve for StalledDns {
      fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
        self.0.notify_one();
        Box::pin(std::future::pending())
      }
    }

    let _packs = TEST_PACKS.lock().await;
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path();
    let previous = stage_previous(base, Runtime::Cpu);
    let stalled = Arc::new(StalledDns(tokio::sync::Notify::new()));
    let slow = reqwest::Client::builder().no_proxy().dns_resolver(stalled.clone()).build().unwrap();
    let fast = offline_client();
    let cancel = CancellationToken::new();
    let foreground = async {
      stalled.0.notified().await;
      install(base, Runtime::Cpu, &fast, &cancel, &|_| {}, 0).await
    };

    let (background, manual) = tokio::time::timeout(Duration::from_secs(3), async {
      tokio::join!(upgrade_if_installed(base, Runtime::Cpu, &slow), foreground)
    }).await.expect("manual request must not wait for stalled DNS or a network timeout");
    assert_eq!(background.unwrap_err(), "DOWNLOAD_CANCELLED");
    assert_ne!(manual.unwrap_err(), "DOWNLOAD_CANCELLED", "only the background download was cancelled");
    assert_eq!(usable_cli(base, Runtime::Cpu), Some(previous));
  }

  #[tokio::test]
  async fn offline_upgrade_preserves_old_cli_and_skips_uninstalled_packs() {
    let _packs = TEST_PACKS.lock().await;
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path();
    let client = offline_client();
    for runtime in [Runtime::Cpu, Runtime::Gpu] {
      upgrade_if_installed(base, runtime, &client).await.unwrap();
      if runtime_asset(runtime).is_none() { continue; }
      let previous = stage_previous(base, runtime);
      assert!(upgrade_if_installed(base, runtime, &client).await.is_err());
      assert_eq!(usable_cli(base, runtime).as_ref(), Some(&previous));
      assert!(!runtime_is_installed(base, runtime));
    }
    assert!(!base.join("models").exists());
  }

  #[cfg(windows)]
  #[test]
  fn vulkan_and_cpu_upgrades_retire_only_the_pack_that_has_a_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().join("local-asr");
    let old_cpu = stage_previous(&base, Runtime::Cpu);
    let old_gpu = stage_previous(&base, Runtime::Gpu);
    let current_gpu = runtime_cli_path(&base, Runtime::Gpu);
    crate::local_asr::tests::stage_test_cli(&current_gpu, gpu_zip_asset().unwrap().sha256);
    cleanup_legacy_assets_at(temp.path()).unwrap();
    assert!(!old_gpu.exists());
    assert_eq!(usable_cli(&base, Runtime::Cpu), Some(old_cpu));
    assert_eq!(usable_cli(&base, Runtime::Gpu), Some(current_gpu));
  }

  // A cached official archive runs the actual hash, extraction, selection and
  // next-launch cleanup without network access or touching the user's data.
  #[tokio::test]
  #[ignore]
  async fn verified_cached_archive_survives_concurrent_manual_and_automatic_upgrade() {
    let _packs = TEST_PACKS.lock().await;
    let temp = tempfile::tempdir().unwrap();
    let base = temp.path().join("local-asr");
    let previous = stage_previous(&base, Runtime::Cpu);
    let asset = llama_zip_asset();
    fs::copy(std::env::var("TYPEALOUD_TEST_RUNTIME_ARCHIVE").unwrap(), base.join(asset.rel_path)).unwrap();
    let client = offline_client();
    let cancel = CancellationToken::new();
    let (automatic, manual) = tokio::join!(
      upgrade_if_installed(&base, Runtime::Cpu, &client),
      install(&base, Runtime::Cpu, &client, &cancel, &|_| {}, 0),
    );
    // If the manual request won or cancelled a pending HTTP request,
    // maintenance defers to it; neither interrupts verified extraction.
    assert!(automatic.is_ok() || matches!(automatic.as_ref().map_err(String::as_str), Err("runtime install busy" | "DOWNLOAD_CANCELLED")));
    manual.unwrap();
    assert_eq!(usable_cli(&base, Runtime::Cpu), Some(runtime_cli_path(&base, Runtime::Cpu)));
    assert!(previous.exists(), "in-flight workers retain their old files");
    assert!(!base.join("models").exists());
    cleanup_legacy_assets_at(temp.path()).unwrap();
    assert!(!previous.exists());
  }
}

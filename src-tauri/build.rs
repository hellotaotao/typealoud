use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn git(args: &[&str]) -> Option<String> {
  let out = Command::new("git").args(args).output().ok()?;
  if !out.status.success() {
    return None;
  }
  Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn main() {
  // The legacy objc macros still reference this feature gate on newer rustc.
  println!("cargo:rustc-check-cfg=cfg(feature, values(\"cargo-clippy\"))");

  // Build channel: official only when CI injects TYPEALOUD_OFFICIAL_BUILD
  // (release.yml); every local build — dev mode or packaged — stays "dev",
  // so a local build can never pass itself off as a release.
  println!("cargo:rerun-if-env-changed=TYPEALOUD_OFFICIAL_BUILD");
  let channel = if std::env::var_os("TYPEALOUD_OFFICIAL_BUILD").is_some() {
    "official"
  } else {
    "dev"
  };
  println!("cargo:rustc-env=TYPEALOUD_BUILD_CHANNEL={channel}");

  // Git provenance for the dev badge tooltip. Dirty-state changes alone don't
  // retrigger this script, but every packaged build bumps .dev-build-number
  // (below) which does, so packaged builds always embed fresh values.
  println!("cargo:rerun-if-changed=../.git/HEAD");
  let hash = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".into());
  let dirty = git(&["status", "--porcelain"]).map(|s| !s.is_empty()).unwrap_or(false);
  println!("cargo:rustc-env=TYPEALOUD_GIT_HASH={hash}");
  println!("cargo:rustc-env=TYPEALOUD_GIT_DIRTY={dirty}");

  let build_time = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0);
  println!("cargo:rustc-env=TYPEALOUD_BUILD_TIME={build_time}");

  // Local dev build counter, bumped by scripts/bump-dev-build.js before every
  // packaged build. Absent in CI and on fresh clones → 0 (never displayed on
  // the official channel anyway).
  println!("cargo:rerun-if-changed=../.dev-build-number");
  let build_number = std::fs::read_to_string("../.dev-build-number")
    .ok()
    .and_then(|s| s.trim().parse::<u64>().ok())
    .unwrap_or(0);
  println!("cargo:rustc-env=TYPEALOUD_BUILD_NUMBER={build_number}");

  tauri_build::build()
}

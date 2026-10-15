//! Platform implementation for non-macOS targets (Windows, Linux).
//!
//! * text insertion: synthetic Unicode typing via `enigo` (SendInput on Windows,
//!   XTEST/libxdo on Linux/X11) — layout-independent, no special permission,
//!   works with CJK/emoji.
//! * Accessibility requires no separate grant. Windows microphone observations
//!   are tracked by the command layer; Linux keeps its existing permission stub.
//! * Windows clipboard and microphone Settings use native APIs; Linux clipboard
//!   and autostart remain unwired.
//!
//! Shared by Windows and Linux while their behavior is identical; splits into
//! `windows` / `linux` when Linux needs Wayland-specific handling.

use super::InsertResult;
use anyhow::Result;
#[cfg(not(windows))]
use anyhow::anyhow;
use enigo::{Enigo, Keyboard, Settings};

pub fn accessibility_required() -> bool {
  false
}

pub fn accessibility_granted(_prompt: bool) -> bool {
  true
}

pub fn microphone_status() -> String {
  if cfg!(windows) { "unknown".into() } else { "granted".into() }
}

pub fn open_accessibility_settings() {}

pub fn open_microphone_settings() -> Result<()> {
  #[cfg(windows)]
  return super::windows::open_microphone_settings();
  #[cfg(not(windows))]
  Ok(())
}

pub fn reveal_app_in_finder() {}

/// Non-macOS platforms have no Accessibility grant, so there is no drag cloud either.
pub fn app_bundle_path() -> Option<std::path::PathBuf> {
  None
}

/// No drag cloud off macOS.
pub fn attach_app_drag_source(_ns_view: *mut std::ffi::c_void) -> bool {
  false
}

pub fn copy_to_clipboard(text: &str) -> Result<()> {
  #[cfg(windows)]
  return super::windows::copy_to_clipboard(text);
  #[cfg(not(windows))]
  {
    let _ = text;
    Err(anyhow!("Clipboard write is not supported on this platform"))
  }
}

pub fn insert_text(text: &str) -> InsertResult {
  // enigo drives SendInput (KEYEVENTF_UNICODE) on Windows and XTEST/libxdo on
  // Linux/X11 — layout-independent Unicode, so CJK/emoji go through. No special
  // permission needed. On any failure the transcription is still in History, so
  // report Failed and let the prompt offer the manual "Copy" affordance.
  let mut enigo = match Enigo::new(&Settings::default()) {
    Ok(enigo) => enigo,
    Err(error) => {
      log::warn!("failed to initialize enigo for text insertion: {error}");
      return InsertResult::Failed;
    }
  };
  match enigo.text(text) {
    Ok(()) => InsertResult::Inserted {
      method: "enigo_text",
    },
    Err(error) => {
      log::warn!("enigo text insertion failed: {error}");
      InsertResult::Failed
    }
  }
}

pub fn focused_window_center() -> Option<(f64, f64)> {
  // No AX equivalent wired up yet (Windows: GetForegroundWindow + GetWindowRect;
  // Linux/X11: _NET_ACTIVE_WINDOW). The caller falls back to the mouse pointer,
  // which already puts the prompt on the right screen in the common case.
  None
}

pub fn set_auto_launch(_enabled: bool) -> Result<()> {
  Ok(())
}

/// No login item exists off macOS, so there is nothing to carry over.
pub fn migrate_legacy_login_item(_legacy_label: &str) {}

/// No activation hook off macOS. Windows and Linux both keep a taskbar entry
/// that restores the window, so there is no "frontmost with nothing on screen"
/// state to rescue the user from.
pub fn watch_app_activation(_on_activate: super::ActivationCallback) {}

pub fn supports_local_first() -> bool {
  // Local-first is the product policy on every supported desktop platform.
  // Engine-specific availability remains gated separately by each backend.
  true
}

/// Open an http(s) URL in the default browser. The exit status is ignored on
/// purpose: `explorer` reports 1 even when it succeeds, so only a failure to
/// launch at all is an error.
pub fn open_url(url: &str) -> Result<()> {
  #[cfg(windows)]
  let program = "explorer";
  #[cfg(not(windows))]
  let program = "xdg-open";
  std::process::Command::new(program).arg(url).status()?;
  Ok(())
}

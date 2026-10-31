//! Platform abstraction layer.
//!
//! Every OS-specific capability the app needs — synthetic text insertion,
//! permission checks, clipboard writes, and the login-item autostart — lives
//! behind this module so the command/handler layer (`commands.rs`,
//! `settings.rs`) stays platform-agnostic. The right implementation is selected
//! at compile time:
//!
//! * `macos`    — the real macOS implementation (CGEvent insertion, AX /
//!                AVFoundation permission checks, pbcopy, LaunchAgent).
//! * `fallback` — Windows/Linux insertion and permission behavior, with Windows
//!                clipboard and Settings integration in `windows`.
//!
//! ## Contract
//!
//! Each backing module MUST provide these free functions with identical
//! signatures (the compiler enforces it via the call sites below when built for
//! that target):
//!
//! ```ignore
//! fn accessibility_required() -> bool;
//! fn accessibility_granted(prompt: bool) -> bool;
//! fn microphone_status() -> String;
//! fn open_accessibility_settings();
//! fn open_microphone_settings() -> anyhow::Result<()>;
//! fn reveal_app_in_finder();
//! fn open_url(url: &str) -> anyhow::Result<()>;
//! fn app_bundle_path() -> Option<std::path::PathBuf>;
//! fn attach_app_drag_source(ns_view: *mut std::ffi::c_void) -> bool;
//! fn copy_to_clipboard(text: &str) -> anyhow::Result<()>;
//! fn insert_text(text: &str) -> InsertResult;
//! fn focused_window_center() -> Option<(f64, f64)>;
//! fn set_auto_launch(enabled: bool) -> anyhow::Result<()>;
//! fn migrate_legacy_login_item(legacy_label: &str);
//! fn supports_local_first() -> bool;
//! fn watch_app_activation(on_activate: ActivationCallback);
//! ```

#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "macos", test))]
mod macos_insert_guard;
#[cfg(target_os = "macos")]
mod activation;
#[cfg(target_os = "macos")]
mod drag_cloud;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
mod fallback;
#[cfg(not(target_os = "macos"))]
pub use fallback::*;

#[cfg(any(windows, test))]
mod windows;

/// True for the Microsoft Store (MSIX) install on Windows. The Store installs
/// and updates that package, so the app's own updater stays off there.
pub fn is_store_install() -> bool {
  #[cfg(windows)]
  return windows::has_package_identity();
  #[cfg(not(windows))]
  false
}

/// Run when the OS reports the app was brought to the front. Stored in a
/// `static` on the platform side (the macOS callback comes from ObjC and has
/// nowhere to carry Rust state), hence `Send + Sync + 'static`.
pub type ActivationCallback = Box<dyn Fn() + Send + Sync + 'static>;

/// Outcome of a synthetic text-insertion attempt.
///
/// Platforms report *what happened*; the caller (`commands::type_text`) maps
/// each variant to the user-facing message, so all the copy stays in one place.
#[derive(Debug)]
pub enum InsertResult {
  /// Text was injected directly. `method` names the mechanism (e.g.
  /// `"cgevent_unicode"` on macOS, `"enigo_text"` on Windows/Linux) for the
  /// frontend / diagnostics.
  Inserted { method: &'static str },
  /// The mechanism is available, but nothing editable is focused — the
  /// keystrokes would land nowhere, so the prompt should offer "copy" instead.
  /// Only macOS detects this (Accessibility focus check), so it reads as dead
  /// code on non-macOS builds.
  #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
  NoEditableTarget,
  /// Insertion was attempted and failed, or the permission it needs is not
  /// granted. The transcription is still saved to History.
  Failed,
}

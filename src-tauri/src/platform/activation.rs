//! "The app was activated" hook for macOS.
//!
//! Why objc is unavoidable: Cmd+Tab (and the app switcher, and Mission Control)
//! only *activates* the app. macOS sends the Launch Services reopen event that
//! `RunEvent::Reopen` rides on for Dock clicks / Spotlight / `open -a`, but a
//! plain activation sends nothing — so with every window hidden, TypeAloud comes
//! to the front owning the menu bar and showing no window at all, which reads
//! as a broken app. AppKit's `NSApplicationDidBecomeActiveNotification` is the
//! only signal that covers activation, and Tauri does not surface it.

use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};
use std::sync::{Once, OnceLock};

use super::ActivationCallback;

/// Set once by `watch`. The ObjC callback has no place to carry Rust state, so
/// the closure lives here instead of in an ivar.
static CALLBACK: OnceLock<ActivationCallback> = OnceLock::new();

extern "C" fn did_become_active(_this: &mut Object, _cmd: Sel, _notification: *mut Object) {
  if let Some(callback) = CALLBACK.get() {
    callback();
  }
}

fn observer_class() -> &'static Class {
  static REGISTER: Once = Once::new();
  static mut CLASS: *const Class = std::ptr::null();

  unsafe {
    REGISTER.call_once(|| {
      let superclass = class!(NSObject);
      let mut decl = ClassDecl::new("TypeAloudActivationObserver", superclass)
        .expect("TypeAloudActivationObserver already registered");
      decl.add_method(
        sel!(typeAloudAppDidBecomeActive:),
        did_become_active as extern "C" fn(&mut Object, Sel, *mut Object),
      );
      CLASS = decl.register();
    });
    &*CLASS
  }
}

/// Register the observer. Notifications are posted on the main thread, so the
/// callback runs there too and may touch windows directly. Calling this twice
/// is a no-op — a second observer would just double-fire the callback.
pub fn watch(callback: ActivationCallback) {
  if CALLBACK.set(callback).is_err() {
    log::warn!("activation: watcher already installed");
    return;
  }

  unsafe {
    // The observer is deliberately never released or removed: it must outlive
    // every notification, and it dies with the process.
    let observer: *mut Object = msg_send![observer_class(), new];
    let center: *mut Object = msg_send![class!(NSNotificationCenter), defaultCenter];
    let _: () = msg_send![
      center,
      addObserver: observer
      selector: sel!(typeAloudAppDidBecomeActive:)
      name: NSApplicationDidBecomeActiveNotification
      object: std::ptr::null::<Object>()
    ];
  }
  log::info!("activation: watching NSApplicationDidBecomeActive");
}

#[link(name = "AppKit", kind = "framework")]
extern "C" {
  static NSApplicationDidBecomeActiveNotification: *const Object;
}

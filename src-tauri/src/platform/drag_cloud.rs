//! Native drag source for the Accessibility drag cloud.
//!
//! Why objc is unavoidable: macOS's privacy list accepts a dragged-in `.app`
//! file (equivalent to clicking "+"), but the drag source must put a
//! `public.file-url` on the drag pasteboard, and **WKWebView's HTML5 drag
//! cannot** (security limit — JS can't fabricate a file-url for an arbitrary
//! path). So we overlay a custom NSView on top of the webview to own the drag
//! gesture.

use std::ffi::c_void;
use std::path::Path;
use std::sync::Once;

use objc::declare::ClassDecl;
use objc::runtime::{Class, Object, Sel};
use objc::{class, msg_send, sel, sel_impl};

/// Must match ax-cloud.css's `#closeBtn` size — change one, change the other.
const CLOSE_BUTTON_SIZE: f64 = 28.0;
const NS_DRAG_OPERATION_COPY: u64 = 1;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct NSPoint {
  pub x: f64,
  pub y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct NSSize {
  pub width: f64,
  pub height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct NSRect {
  pub origin: NSPoint,
  pub size: NSSize,
}

unsafe impl objc::Encode for NSPoint {
  fn encode() -> objc::Encoding {
    unsafe { objc::Encoding::from_str("{CGPoint=dd}") }
  }
}

unsafe impl objc::Encode for NSSize {
  fn encode() -> objc::Encoding {
    unsafe { objc::Encoding::from_str("{CGSize=dd}") }
  }
}

unsafe impl objc::Encode for NSRect {
  fn encode() -> objc::Encoding {
    unsafe { objc::Encoding::from_str("{CGRect={CGPoint=dd}{CGSize=dd}}") }
  }
}

/// The bundle path is stashed in an ivar; the drag reads it back to build an NSURL.
const IVAR_BUNDLE_PATH: &str = "_typeAloudBundlePath";

fn nsstring(value: &str) -> *mut Object {
  // stringWithUTF8String: needs a NUL-terminated C string; CString guarantees it.
  let c = match std::ffi::CString::new(value) {
    Ok(c) => c,
    Err(_) => return std::ptr::null_mut(),
  };
  unsafe {
    let cls = class!(NSString);
    msg_send![cls, stringWithUTF8String: c.as_ptr()]
  }
}

/// `mouseDragged:` — the drag starts here. NSEvent is a ready parameter and does
/// not pass through IPC, so the event context the old `dragFile:` API needs is
/// valid right here.
extern "C" fn mouse_dragged(this: &mut Object, _cmd: Sel, event: *mut Object) {
  unsafe {
    let path: *mut Object = *this.get_ivar(IVAR_BUNDLE_PATH);
    if path.is_null() {
      return;
    }
    let bounds: NSRect = msg_send![this, bounds];
    let _: bool = msg_send![
      this,
      dragFile: path
      fromRect: bounds
      slideBack: true
      event: event
    ];
  }
}

/// Drag operation type: Copy (add the app to the list, don't move it).
extern "C" fn source_operation_mask(
  _this: &Object,
  _cmd: Sel,
  _session: *mut Object,
  _context: i64,
) -> u64 {
  NS_DRAG_OPERATION_COPY
}

/// The top-right 28×28 returns nil so the click passes through to the HTML close
/// button underneath. The cloud is focus:false (no keyboard events), so this is
/// the only manual close affordance and must stay clickable. Note AppKit's
/// origin is bottom-left, so "top-right" is large x, large y.
extern "C" fn hit_test(this: &Object, _cmd: Sel, point: NSPoint) -> *mut Object {
  unsafe {
    let bounds: NSRect = msg_send![this, bounds];
    let in_close_x = point.x >= bounds.size.width - CLOSE_BUTTON_SIZE;
    let in_close_y = point.y >= bounds.size.height - CLOSE_BUTTON_SIZE;
    if in_close_x && in_close_y {
      return std::ptr::null_mut();
    }
    let this_ptr: *const Object = this;
    this_ptr as *mut Object
  }
}

fn overlay_class() -> &'static Class {
  static REGISTER: Once = Once::new();
  static mut CLASS: *const Class = std::ptr::null();

  unsafe {
    REGISTER.call_once(|| {
      let superclass = class!(NSView);
      let mut decl = ClassDecl::new("TypeAloudDragCloudOverlay", superclass)
        .expect("TypeAloudDragCloudOverlay already registered");
      decl.add_ivar::<*mut Object>(IVAR_BUNDLE_PATH);
      decl.add_method(
        sel!(mouseDragged:),
        mouse_dragged as extern "C" fn(&mut Object, Sel, *mut Object),
      );
      decl.add_method(
        sel!(draggingSession:sourceOperationMaskForDraggingContext:),
        source_operation_mask as extern "C" fn(&Object, Sel, *mut Object, i64) -> u64,
      );
      decl.add_method(
        sel!(hitTest:),
        hit_test as extern "C" fn(&Object, Sel, NSPoint) -> *mut Object,
      );
      CLASS = decl.register();
    });
    &*CLASS
  }
}

/// Overlay a full-area drag layer on the given NSView. Returns whether it was attached.
pub fn attach(ns_view: *mut c_void, bundle_path: &Path) -> bool {
  if ns_view.is_null() {
    return false;
  }
  let Some(path_str) = bundle_path.to_str() else {
    return false;
  };

  unsafe {
    let parent = ns_view as *mut Object;
    let bounds: NSRect = msg_send![parent, bounds];

    let overlay: *mut Object = msg_send![overlay_class(), alloc];
    let overlay: *mut Object = msg_send![overlay, initWithFrame: bounds];
    if overlay.is_null() {
      return false;
    }

    let path_obj = nsstring(path_str);
    if path_obj.is_null() {
      return false;
    }
    let _: () = msg_send![path_obj, retain];
    (*overlay).set_ivar(IVAR_BUNDLE_PATH, path_obj);

    // Track the parent view's size changes (the window can't resize, but Retina
    // switches etc. still relayout). NSViewWidthSizable(2) | NSViewHeightSizable(16)
    let _: () = msg_send![overlay, setAutoresizingMask: 18u64];
    let _: () = msg_send![parent, addSubview: overlay];
    true
  }
}

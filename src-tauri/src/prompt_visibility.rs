//! Showing the recording overlay must leave keyboard focus in the dictation target.

use tauri::WebviewWindow;

#[cfg(not(windows))]
pub(crate) fn set_visible(window: &WebviewWindow, visible: bool) -> tauri::Result<()> {
  if visible { window.show() } else { window.hide() }
}

#[cfg(windows)]
pub(crate) fn set_visible(window: &WebviewWindow, visible: bool) -> tauri::Result<()> {
  let prompt = window.clone();
  window.run_on_main_thread(move || {
    let result = prompt.hwnd().and_then(|hwnd| {
      set_native_visibility(hwnd.0, visible).map_err(Into::into)
    });
    if let Err(error) = result {
      log::warn!("prompt: set visible={visible} failed: {error}");
    }
  })
}

// Called on the UI thread after Tauri creates the hidden WebView2 host.
#[cfg(windows)]
pub(crate) fn initialize(prompt: &WebviewWindow) -> tauri::Result<()> {
  use windows_sys::Win32::UI::WindowsAndMessaging::*;
  let hwnd = prompt.hwnd()?.0;
  if repair_frame_styles(hwnd)? {
    let flags = SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE;
    if unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, 0, 0, flags) } == 0 {
      return Err(std::io::Error::last_os_error().into());
    }
  }
  Ok(())
}

#[cfg(windows)]
fn repair_frame_styles(hwnd: windows_sys::Win32::Foundation::HWND) -> std::io::Result<bool> {
  use windows_sys::Win32::{Foundation::{GetLastError, SetLastError}, UI::WindowsAndMessaging::*};

  // tao 0.37 leaves WS_CAPTION | WS_SYSMENU and WS_EX_WINDOWEDGE on undecorated
  // top-level windows. It normally hides the non-client frame via WM_NCCALCSIZE.
  // Set a real popup style on this HWND only; preserve composition and hit testing.
  let mut changed = false;
  for (slot, remove, add) in [
    (GWL_STYLE, WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX, WS_POPUP),
    (GWL_EXSTYLE, WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE | WS_EX_DLGMODALFRAME, WS_EX_NOACTIVATE),
  ] {
    unsafe {
      SetLastError(0);
      let old = GetWindowLongW(hwnd, slot) as u32;
      if old == 0 && GetLastError() != 0 { return Err(std::io::Error::last_os_error()); }
      let new = (old & !remove) | add;
      if new != old {
        SetLastError(0);
        if SetWindowLongW(hwnd, slot, new as i32) == 0 && GetLastError() != 0 {
          return Err(std::io::Error::last_os_error());
        }
        changed = true;
      }
    }
  }
  Ok(changed)
}

#[cfg(windows)]
fn set_native_visibility(hwnd: windows_sys::Win32::Foundation::HWND, visible: bool) -> std::io::Result<()> {
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE,
  };

  // Use this helper for both directions: tao caches visibility, but is_visible()
  // queries the HWND.
  if !visible {
    // Preserve normal activation handoff if the user clicked the Copy button.
    // ShowWindow returns the previous visibility, not a success indicator.
    unsafe { ShowWindow(hwnd, SW_HIDE); }
    return Ok(());
  }
  // tao's SW_SHOW would activate the prompt. Raise it above other topmost
  // windows without moving the caret out of the application being dictated into.
  let mut flags = SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW;
  if repair_frame_styles(hwnd)? { flags |= SWP_FRAMECHANGED; }
  let ok = unsafe { SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags) };
  if ok == 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(all(test, windows))]
mod tests {
  use super::set_native_visibility;
  use std::ptr::{null, null_mut};
  use windows_sys::Win32::{
    Foundation::HWND,
    UI::{
      Input::KeyboardAndMouse::{GetActiveWindow, GetFocus, SetActiveWindow, SetFocus},
      WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetWindow, IsWindowVisible, ShowWindow, GW_HWNDPREV, SW_HIDE, SW_SHOW,
        WS_CHILD, WS_EX_TOPMOST, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_VISIBLE,
      },
    },
  };

  struct TestWindow(HWND);

  impl TestWindow {
    fn new(class: *const u16, style: u32, ex_style: u32, parent: HWND) -> Self {
      let hwnd = unsafe {
        CreateWindowExW(ex_style, class, null(), style, 0, 0, 100, 50, parent,
          null_mut(), null_mut(), null())
      };
      assert!(!hwnd.is_null(), "{}", std::io::Error::last_os_error());
      Self(hwnd)
    }
  }

  impl Drop for TestWindow {
    fn drop(&mut self) {
      unsafe { DestroyWindow(self.0); }
    }
  }

  // Compare only our two test windows, not absolute desktop z-order.
  fn is_above(upper: HWND, lower: HWND) -> bool {
    let mut hwnd = lower;
    for _ in 0..1024 {
      hwnd = unsafe { GetWindow(hwnd, GW_HWNDPREV) };
      if hwnd == upper { return true; }
      if hwnd.is_null() { break; }
    }
    false
  }

  #[test]
  fn prompt_visibility_preserves_the_active_editor_and_keyboard_focus() {
    let editor = TestWindow::new(windows_sys::w!("STATIC"), WS_OVERLAPPEDWINDOW, 0, null_mut());
    let field = TestWindow::new(windows_sys::w!("EDIT"), WS_CHILD | WS_VISIBLE, 0, editor.0);
    let prompt = TestWindow::new(windows_sys::w!("STATIC"), WS_POPUP, WS_EX_TOPMOST, null_mut());

    unsafe {
      ShowWindow(editor.0, SW_SHOW);
      SetActiveWindow(editor.0);
      SetFocus(field.0);
      assert_eq!(GetFocus(), field.0);

      // Control: this is the Win32 operation used by the old Tauri show path.
      ShowWindow(prompt.0, SW_SHOW);
      assert_eq!(GetActiveWindow(), prompt.0);
      assert_ne!(GetFocus(), field.0);
      ShowWindow(prompt.0, SW_HIDE);
      SetActiveWindow(editor.0);
      SetFocus(field.0);

      let other = TestWindow::new(windows_sys::w!("STATIC"), WS_POPUP, WS_EX_TOPMOST, null_mut());
      for visible in [true, false, true, false] {
        if visible {
          set_native_visibility(other.0, true).unwrap();
          assert!(is_above(other.0, prompt.0));
        }
        set_native_visibility(prompt.0, visible).unwrap();
        assert_eq!(IsWindowVisible(prompt.0) != 0, visible);
        assert_eq!(GetActiveWindow(), editor.0);
        assert_eq!(GetFocus(), field.0);
        if visible { assert!(is_above(prompt.0, other.0)); }
      }

      // A deliberate click on a recovery control may activate the prompt.
      set_native_visibility(prompt.0, true).unwrap();
      SetActiveWindow(prompt.0);
      assert_eq!(GetActiveWindow(), prompt.0);
      set_native_visibility(prompt.0, false).unwrap();
      assert_eq!(IsWindowVisible(prompt.0), 0);
      assert_ne!(GetActiveWindow(), prompt.0);
    }
  }
}

#[cfg(all(windows, test))]
mod windows_smoke;

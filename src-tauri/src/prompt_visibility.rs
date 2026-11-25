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

#[cfg(windows)]
fn set_native_visibility(hwnd: windows_sys::Win32::Foundation::HWND, visible: bool) -> std::io::Result<()> {
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    SetWindowPos, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
  };

  // After creation tao uses SW_SHOW, which activates the window even with
  // focus:false in the config. Pair native show and hide: tao caches visibility.
  let flags = SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER
    | if visible { SWP_SHOWWINDOW } else { SWP_HIDEWINDOW };
  let ok = unsafe { SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, 0, 0, flags) };
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
        CreateWindowExW, DestroyWindow, IsWindowVisible, ShowWindow, SW_HIDE, SW_SHOW,
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

      for visible in [true, false, true, false] {
        set_native_visibility(prompt.0, visible).unwrap();
        assert_eq!(IsWindowVisible(prompt.0) != 0, visible);
        assert_eq!(GetActiveWindow(), editor.0);
        assert_eq!(GetFocus(), field.0);
      }
    }
  }
}

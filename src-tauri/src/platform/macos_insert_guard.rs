//! Pure policy for macOS's best-effort insertion guard; no native APIs.

pub(super) fn accepts_text(role: Option<&str>, value_settable: bool, process_path: Option<&str>) -> bool {
  // An unreadable role is uncertainty, and the guard only blocks on a verdict.
  role.is_none()
    || value_settable
    || matches!(role, Some("AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"))
    || (role == Some("AXWindow") && process_path.is_some_and(is_self_drawn_text_app))
}

/// The last path component: unlike the full path, it is safe to log.
pub(super) fn executable_name(path: &str) -> &str {
  path.rsplit('/').next().unwrap_or_default()
}

/// Apps that draw all their text themselves, so Accessibility sees only a bare
/// window, yet accept synthetic Unicode keystrokes. Zed was checked on a real
/// machine on 2026-10-31; add an app only after the same check, because the
/// frameworks of remote desktops and games may ignore the Unicode string and
/// type the event's key code instead.
fn is_self_drawn_text_app(path: &str) -> bool {
  // Compare the complete executable basename, never a substring of a path.
  // WezTerm's CLI (`wezterm`) is not the process that owns its GUI window.
  let name = executable_name(path);
  ["wezterm-gui", "alacritty", "kitty", "ghostty", "zed"]
    .iter()
    .any(|app| name.eq_ignore_ascii_case(app))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn self_drawn_app_windows_accept_text() {
    for executable in ["wezterm-gui", "Alacritty", "kitty", "ghostty", "zed"] {
      let path = format!("/Applications/Terminal.app/Contents/MacOS/{executable}");
      assert!(accepts_text(Some("AXWindow"), false, Some(&path)), "{executable}");
    }
  }

  #[test]
  fn an_unreadable_role_is_not_a_block_verdict() {
    assert!(accepts_text(None, false, None));
  }

  #[test]
  fn executable_name_drops_the_directories() {
    assert_eq!(executable_name("/Applications/Zed.app/Contents/MacOS/zed"), "zed");
    assert_eq!(executable_name("zed"), "zed");
    assert_eq!(executable_name(""), "");
  }

  #[test]
  fn other_windows_and_failed_process_lookups_still_block() {
    for path in [None, Some(""), Some("/"), Some("/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"),
      Some("/tmp/wezterm-gui-helper"), Some("/tmp/not-ghostty"), Some("/tmp/kitty/python"), Some("/tmp/wezterm"),
      Some("/tmp/zed/python")] {
      assert!(!accepts_text(Some("AXWindow"), false, path), "{path:?}");
    }
  }

  #[test]
  fn app_identity_does_not_allow_buttons_or_other_non_text_roles() {
    for role in [Some("AXButton"), Some("AXToolbar"), Some("AXApplication"), Some("AXGroup")] {
      assert!(!accepts_text(role, false, Some("/Applications/WezTerm.app/Contents/MacOS/wezterm-gui")));
    }
  }

  #[test]
  fn existing_text_roles_do_not_need_a_known_process() {
    for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"] {
      assert!(accepts_text(Some(role), false, None), "{role}");
    }
  }

  #[test]
  fn settable_values_keep_existing_behavior() {
    for role in [None, Some("AXWindow"), Some("AXGroup")] {
      assert!(accepts_text(role, true, None));
    }
  }
}

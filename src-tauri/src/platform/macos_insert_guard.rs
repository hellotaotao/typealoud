//! Pure policy for macOS's best-effort insertion guard; no native APIs.

pub(super) fn accepts_text(role: Option<&str>, value_settable: bool, process_path: Option<&str>) -> bool {
  value_settable
    || matches!(role, Some("AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"))
    || (role == Some("AXWindow") && process_path.is_some_and(is_terminal_executable))
}

fn is_terminal_executable(path: &str) -> bool {
  // Compare the complete executable basename, never a substring of a path.
  // WezTerm's CLI (`wezterm`) is not the process that owns its GUI window.
  let name = path.rsplit('/').next().unwrap_or_default();
  ["wezterm-gui", "alacritty", "kitty", "ghostty"]
    .iter()
    .any(|terminal| name.eq_ignore_ascii_case(terminal))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn gpu_terminal_windows_accept_text() {
    for executable in ["wezterm-gui", "Alacritty", "kitty", "ghostty"] {
      let path = format!("/Applications/Terminal.app/Contents/MacOS/{executable}");
      assert!(accepts_text(Some("AXWindow"), false, Some(&path)), "{executable}");
    }
  }

  #[test]
  fn other_windows_and_failed_process_lookups_still_block() {
    for path in [None, Some(""), Some("/"), Some("/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"),
      Some("/tmp/wezterm-gui-helper"), Some("/tmp/not-ghostty"), Some("/tmp/kitty/python"), Some("/tmp/wezterm")] {
      assert!(!accepts_text(Some("AXWindow"), false, path), "{path:?}");
    }
  }

  #[test]
  fn terminal_identity_does_not_allow_buttons_or_other_non_text_roles() {
    for role in [None, Some("AXButton"), Some("AXToolbar"), Some("AXApplication"), Some("AXGroup")] {
      assert!(!accepts_text(role, false, Some("/Applications/WezTerm.app/Contents/MacOS/wezterm-gui")));
    }
  }

  #[test]
  fn existing_text_roles_do_not_need_a_terminal_process() {
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

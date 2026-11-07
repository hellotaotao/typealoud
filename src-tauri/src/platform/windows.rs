//! Windows-only integration: explicit clipboard copy, privacy Settings,
//! package identity, "Start with system" and the WebView2 runtime check.

/// The StartupTask the MSIX manifest declares (build/msix/AppxManifest.template.xml,
/// filled from scripts/msix-lib.mjs, whose test keeps the two equal).
#[cfg_attr(not(windows), allow(dead_code))]
const STARTUP_TASK_ID: &str = "TypeAloudStartup";

/// Value name under the per-user Run key for the direct (NSIS) install. Tauri's
/// NSIS uninstaller deletes the value named after the product, so keep it equal.
#[cfg(windows)]
const RUN_VALUE_NAME: &str = "TypeAloud";
#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// Microsoft's Evergreen Bootstrapper, the small online installer for WebView2.
#[cfg(windows)]
const WEBVIEW2_DOWNLOAD_URL: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

#[cfg(windows)]
pub fn open_microphone_settings() -> anyhow::Result<()> {
  use windows_sys::Win32::UI::Shell::ShellExecuteW;
  use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

  let operation: Vec<u16> = "open\0".encode_utf16().collect();
  let uri: Vec<u16> = "ms-settings:privacy-microphone\0".encode_utf16().collect();
  // Launch the registered Settings URI directly, without a console subprocess.
  // Both UTF-16 buffers remain alive and NUL-terminated throughout the call.
  let result = unsafe {
    ShellExecuteW(
      std::ptr::null_mut(),
      operation.as_ptr(),
      uri.as_ptr(),
      std::ptr::null(),
      std::ptr::null(),
      SW_SHOWNORMAL,
    )
  };
  settings_launch_result(result as isize).map_err(anyhow::Error::msg)
}

fn settings_launch_result(code: isize) -> Result<(), String> {
  // ShellExecuteW returns a compatibility code, not a real HINSTANCE.
  if code > 32 {
    Ok(())
  } else {
    Err(format!("Failed to open microphone Settings (Windows shell code {code})"))
  }
}

/// Whether this process runs with package identity, i.e. was installed from an
/// MSIX (the Microsoft Store build). The same exe ships in the NSIS installer,
/// so this is a runtime check rather than a build flag.
#[cfg(windows)]
pub fn has_package_identity() -> bool {
  use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;

  let mut length = 0u32;
  // A zero-length probe: the return code alone tells packaged from unpackaged.
  let code = unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) };
  package_identity_from_code(code)
}

fn package_identity_from_code(code: u32) -> bool {
  const ERROR_SUCCESS: u32 = 0;
  const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
  // An unpackaged process gets APPMODEL_ERROR_NO_PACKAGE (15700). Anything
  // unexpected counts as unpackaged, which keeps the self-updater working.
  code == ERROR_INSUFFICIENT_BUFFER || code == ERROR_SUCCESS
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
  text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// "Start with system". The Store package can't write the Run key for its own
/// exe (package files live in a protected folder and the registry write would
/// be virtualized), so it uses the manifest's StartupTask, which also lists it
/// under Task Manager's Startup apps. The direct install uses the Run key.
#[cfg(windows)]
pub fn set_auto_launch(enabled: bool) -> anyhow::Result<()> {
  if has_package_identity() {
    set_startup_task(enabled)
  } else {
    set_run_key(enabled)
  }
}

#[cfg(windows)]
fn startup_task() -> ::windows::core::Result<::windows::ApplicationModel::StartupTask> {
  use ::windows::ApplicationModel::StartupTask;
  StartupTask::GetAsync(&::windows::core::HSTRING::from(STARTUP_TASK_ID))?.join()
}

#[cfg(windows)]
fn set_startup_task(enabled: bool) -> anyhow::Result<()> {
  use anyhow::Context;
  let task = startup_task().context("Failed to find the TypeAloud startup task")?;
  if !enabled {
    return task.Disable().context("Failed to turn off the TypeAloud startup task");
  }
  // A packaged desktop app gets no consent dialog here; the call returns the
  // resulting state, which stays off when the user or a policy turned it off.
  let state = task
    .RequestEnableAsync()
    .and_then(|operation| operation.join())
    .context("Failed to turn on the TypeAloud startup task")?;
  startup_task_outcome(state.0).map_err(anyhow::Error::msg)
}

/// Maps a `Windows.ApplicationModel.StartupTaskState` after an enable request.
#[cfg_attr(not(windows), allow(dead_code))]
fn startup_task_outcome(state: i32) -> Result<(), String> {
  match state {
    // Enabled, EnabledByPolicy
    2 | 4 => Ok(()),
    // DisabledByUser: only the user can turn it back on, in Windows itself.
    1 => Err(
      "TypeAloud is turned off as a startup app in Windows. Turn it on in Settings > Apps > Startup."
        .into(),
    ),
    3 => Err("A Windows policy on this PC keeps TypeAloud from starting with Windows.".into()),
    other => Err(format!("Windows did not turn on the startup task (state {other})")),
  }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn startup_task_state_name(state: i32) -> &'static str {
  match state {
    0 => "disabled",
    1 => "disabledByUser",
    2 => "enabled",
    3 => "disabledByPolicy",
    4 => "enabledByPolicy",
    _ => "unknown",
  }
}

/// Logs the Store package's startup task once at launch. It confirms the
/// manifest declares the task the app looks up (msix.yml waits for this line)
/// and shows when Windows has it in a different state than the setting. The
/// lifecycle target keeps the line in release logs; it holds only fixed labels.
#[cfg(windows)]
pub fn log_startup_task_state() {
  if !has_package_identity() {
    return;
  }
  match startup_task().and_then(|task| task.State()) {
    Ok(state) => log::info!(
      target: "typealoud_lifecycle",
      "autostart:startup-task state={}",
      startup_task_state_name(state.0)
    ),
    Err(error) => log::warn!("autostart:startup-task unavailable error={error}"),
  }
}

#[cfg(windows)]
fn set_run_key(enabled: bool) -> anyhow::Result<()> {
  use anyhow::Context;
  use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
  use windows_sys::Win32::System::Registry::{
    RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
  };

  let key = wide(RUN_KEY);
  let name = wide(RUN_VALUE_NAME);
  let code = if enabled {
    let exe = std::env::current_exe().context("Failed to locate TypeAloud.exe")?;
    let command = wide(&run_command(&exe.to_string_lossy()));
    // REG_SZ data is the UTF-16 string including its terminating NUL.
    unsafe {
      RegSetKeyValueW(
        HKEY_CURRENT_USER,
        key.as_ptr(),
        name.as_ptr(),
        REG_SZ,
        command.as_ptr().cast(),
        (command.len() * 2) as u32,
      )
    }
  } else {
    match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) } {
      ERROR_FILE_NOT_FOUND => ERROR_SUCCESS,
      code => code,
    }
  };
  if code != ERROR_SUCCESS {
    anyhow::bail!(
      "Failed to {} the Windows startup entry (error {code})",
      if enabled { "add" } else { "remove" }
    );
  }
  Ok(())
}

/// The Run value: the exe path, quoted because it usually has spaces.
#[cfg_attr(not(windows), allow(dead_code))]
fn run_command(exe: &str) -> String {
  format!("\"{exe}\"")
}

/// Checks for the WebView2 runtime before any window exists. The direct
/// installer bootstraps it, but the Store package can't, and Windows 10 may not
/// have it. Without it the app would exit without a word, so this explains what
/// to install and offers the download. Returns false when the runtime is missing.
#[cfg(windows)]
pub fn ensure_webview2_runtime() -> bool {
  use windows_sys::Win32::Globalization::GetUserDefaultUILanguage;
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDOK, MB_ICONERROR, MB_OKCANCEL, MB_SETFOREGROUND,
  };

  if wry::webview_version().is_ok_and(|version| webview2_version_usable(&version)) {
    return true;
  }
  let ui_language = crate::settings::read_config()
    .map(|config| config.ui_language)
    .unwrap_or_default();
  let chinese = prefers_chinese(&ui_language, unsafe { GetUserDefaultUILanguage() });
  let text = wide(missing_webview2_message(chinese));
  let caption = wide("TypeAloud");
  let choice = unsafe {
    MessageBoxW(
      std::ptr::null_mut(),
      text.as_ptr(),
      caption.as_ptr(),
      MB_OKCANCEL | MB_ICONERROR | MB_SETFOREGROUND,
    )
  };
  if choice == IDOK {
    let _ = super::open_url(WEBVIEW2_DOWNLOAD_URL);
  }
  false
}

/// The loader reports an installed runtime as a version such as
/// "131.0.2903.70"; an empty or all-zero version means nothing usable.
#[cfg_attr(not(windows), allow(dead_code))]
fn webview2_version_usable(version: &str) -> bool {
  version.split('.').any(|part| part.trim().parse::<u32>().is_ok_and(|number| number > 0))
}

/// The dialog runs before the web UI, so it follows the same rule as
/// i18n.js: an explicit interface language wins, "auto" follows Windows.
#[cfg_attr(not(windows), allow(dead_code))]
fn prefers_chinese(ui_language: &str, windows_ui_language: u16) -> bool {
  const LANG_CHINESE: u16 = 0x04;
  let setting = ui_language.trim().to_ascii_lowercase();
  if setting.is_empty() || setting == "auto" {
    windows_ui_language & 0x3ff == LANG_CHINESE
  } else {
    setting.starts_with("zh")
  }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn missing_webview2_message(chinese: bool) -> &'static str {
  if chinese {
    "TypeAloud 需要 Microsoft Edge WebView2 运行时，这台电脑上还没有安装。\n\n\
     点「确定」从微软官网下载安装程序，安装完成后重新打开 TypeAloud。"
  } else {
    "TypeAloud needs the Microsoft Edge WebView2 Runtime, which isn't installed on this PC.\n\n\
     Select OK to download the installer from Microsoft, then open TypeAloud again once it's installed."
  }
}

#[cfg(windows)]
pub fn copy_to_clipboard(text: &str) -> anyhow::Result<()> {
  use anyhow::Context;
  let mut clipboard = arboard::Clipboard::new().context("Failed to open Windows clipboard")?;
  clipboard.set_text(text).context("Failed to write text to Windows clipboard")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn settings_launch_rejects_shell_failure_codes() {
    for code in [0, 2, 3, 5, 8, 26, 27, 28, 29, 30, 31, 32] {
      let error = settings_launch_result(code).unwrap_err();
      assert!(error.contains(&code.to_string()));
    }
  }

  #[test]
  fn only_a_packaged_probe_result_counts_as_package_identity() {
    assert!(package_identity_from_code(122));
    assert!(package_identity_from_code(0));
    assert!(!package_identity_from_code(15700));
    assert!(!package_identity_from_code(5));
  }

  #[test]
  fn only_an_enabled_startup_task_counts_as_turned_on() {
    assert!(startup_task_outcome(2).is_ok());
    assert!(startup_task_outcome(4).is_ok());
    assert!(startup_task_outcome(1).unwrap_err().contains("Settings > Apps > Startup"));
    assert!(startup_task_outcome(3).unwrap_err().contains("policy"));
    assert!(startup_task_outcome(0).is_err());
    assert_eq!(startup_task_state_name(1), "disabledByUser");
    assert_eq!(startup_task_state_name(9), "unknown");
  }

  #[test]
  fn run_command_quotes_the_exe_path() {
    assert_eq!(
      run_command(r"C:\Program Files\TypeAloud\TypeAloud.exe"),
      r#""C:\Program Files\TypeAloud\TypeAloud.exe""#
    );
  }

  #[test]
  fn only_a_nonzero_webview2_version_counts_as_installed() {
    assert!(webview2_version_usable("131.0.2903.70"));
    assert!(!webview2_version_usable(""));
    assert!(!webview2_version_usable("0.0.0.0"));
  }

  #[test]
  fn webview2_message_follows_the_interface_language_setting() {
    const ZH_CN: u16 = 0x0804;
    const EN_US: u16 = 0x0409;
    assert!(prefers_chinese("auto", ZH_CN));
    assert!(!prefers_chinese("auto", EN_US));
    assert!(prefers_chinese("", 0x0404));
    assert!(prefers_chinese("zh", EN_US));
    assert!(!prefers_chinese("en", ZH_CN));
    assert!(missing_webview2_message(true).contains("WebView2"));
    assert!(missing_webview2_message(false).contains("WebView2"));
  }

  #[test]
  fn settings_launch_accepts_only_codes_above_32() {
    assert!(settings_launch_result(33).is_ok());
    assert!(settings_launch_result(42).is_ok());
  }

  #[cfg(windows)]
  #[test]
  #[ignore = "Requires an interactive Windows desktop and replaces clipboard contents"]
  fn explicit_clipboard_copy_round_trips_unicode() {
    let text = "TypeAloud 中文 🎙️\nSecond line";
    copy_to_clipboard(text).unwrap();
    assert_eq!(arboard::Clipboard::new().unwrap().get_text().unwrap(), text);
  }
}

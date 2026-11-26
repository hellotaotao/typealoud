// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  typealoud_lib::run();
}

#[cfg(all(windows, test, feature = "windows-desktop-test"))]
#[test]
#[ignore = "requires a dedicated interactive Windows desktop"]
fn configured_webview_preserves_external_editor() {
  let tmp = tempfile::tempdir().unwrap();
  typealoud_lib::windows_prompt_smoke::run(tmp.path().into());
}

//! Isolated Windows desktop only. Exercise the actual configured WebView2 HWND,
//! not a substitute popup, with a harmless edit field in a separate process.
use std::{process::{Child, Command, Stdio}, sync::{mpsc, Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tauri::Manager;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

struct Editor(Child);
impl Drop for Editor {
  fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

fn exercise(prompt: &tauri::WebviewWindow, tmp: &std::path::Path) -> anyhow::Result<()> {
  use anyhow::ensure;
  let ready = tmp.join("ready");
  let received = tmp.join("received");
  let hwnd = prompt.hwnd()?.0;
  let style = || unsafe { GetWindowLongW(hwnd, GWL_STYLE) as u32 };
  let ex = || unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 };
  ensure!(unsafe { IsWindowVisible(hwnd) } == 0, "initialization showed the prompt");
  ensure!(style() & WS_CAPTION == 0 && ex() & WS_EX_WINDOWEDGE == 0, "initial native frame");

  prompt.set_position(tauri::PhysicalPosition::new(160, 150))?;
  let _editor = Editor(Command::new("powershell.exe").args(["-NoLogo", "-NoProfile", "-STA",
    "-NonInteractive", "-Command", include_str!("windows_test_editor.ps1")])
    .env("TYPEALOUD_TEST_READY", &ready).env("TYPEALOUD_TEST_TEXT", &received)
    .stdin(Stdio::null()).spawn()?);
  let deadline = Instant::now() + Duration::from_secs(25);
  let target = loop {
    if let Some(value) = std::fs::read_to_string(&ready).ok().and_then(|s| s.trim().parse::<usize>().ok()) {
      break value as windows_sys::Win32::Foundation::HWND;
    }
    ensure!(Instant::now() < deadline, "test editor did not open");
    std::thread::sleep(Duration::from_millis(30));
  };

  let mut rect = windows_sys::Win32::Foundation::RECT::default();
  ensure!(unsafe { GetWindowRect(hwnd, &mut rect) } != 0);
  let pixel = |x, y| unsafe {
    use windows_sys::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC};
    let dc = GetDC(std::ptr::null_mut());
    let color = GetPixel(dc, x, y);
    ReleaseDC(std::ptr::null_mut(), dc);
    color
  };
  let corner = (rect.left + 6, rect.top + 6);
  let center = ((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
  let bg = 0xff00ff; // Solid magenta from the external editor, never a desktop screenshot.
  let end = Instant::now() + Duration::from_secs(3);
  while pixel(corner.0, corner.1) != bg || pixel(center.0, center.1) != bg {
    ensure!(Instant::now() < end, "test editor background not visible beneath prompt");
    std::thread::sleep(Duration::from_millis(50));
  }


  // Reintroduce the caption between holds, as a framework style rewrite could.
  // Only the show path (not initialization) can repair it this time.
  for (index, expected) in ["x", "xx"].iter().enumerate() {
    if index == 1 {
      unsafe { SetWindowLongW(hwnd, GWL_STYLE, (style() | WS_CAPTION | WS_SYSMENU) as i32); }
    }
    let theme = if index == 0 { "elegant" } else { "midnight" };
    prompt.eval(format!("document.documentElement.dataset.theme='{theme}';document.getElementById('inputPrompt').classList.add('visible','recording')"))?;
    ensure!(unsafe { GetForegroundWindow() } == target, "test editor not foreground before show");
    crate::prompt_visibility::set_visible(prompt, true)?;
    ensure!(prompt.is_visible()?, "prompt not visible");
    ensure!(style() & (WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX) == 0,
      "native frame/buttons after show: {:08x}", style());
    ensure!(style() & WS_POPUP != 0 && ex() & WS_EX_NOACTIVATE != 0, "not a nonactivating popup");
    ensure!(ex() & (WS_EX_TRANSPARENT | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE) == 0, "click-through or edged");
    let end = Instant::now() + Duration::from_secs(5);
    loop {
      let outside = pixel(corner.0, corner.1);
      let inside = pixel(center.0, center.1);
      if outside == bg && inside != bg && inside != u32::MAX { break; }
      ensure!(Instant::now() < end, "expected card on transparent canvas; corner={outside:06x} center={inside:06x}");
      std::thread::sleep(Duration::from_millis(50));
    }
    ensure!(unsafe { GetForegroundWindow() } == target, "show stole foreground");
    crate::prompt_visibility::set_visible(prompt, false)?;
    ensure!(!prompt.is_visible()? && unsafe { GetForegroundWindow() } == target, "hide changed target");
    // Only dispatch synthetic input to this test's own identified foreground window.
    ensure!(matches!(crate::platform::insert_text("x", false), crate::platform::InsertResult::Inserted { .. }),
      "native insertion failed");
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
      if std::fs::read_to_string(&received).unwrap_or_default() == *expected { break; }
      ensure!(Instant::now() < deadline, "text did not arrive in the external editor");
      std::thread::sleep(Duration::from_millis(25));
    }
  }

  Ok(())
}

pub fn run(tmp: std::path::PathBuf) {
  assert_eq!(std::env::var("TYPEALOUD_TEST_DESKTOP").as_deref(), Ok("isolated"));
  let mut context = tauri::generate_context!();
  context.config_mut().identifier = "com.tao.typealoud.test-prompt".into();
  context.config_mut().app.windows.retain(|w| w.label == "input-prompt");
  let (tx, rx) = mpsc::channel();
  let loaded = Arc::new(AtomicBool::new(false));
  let on_load = loaded.clone();
  let app = tauri::Builder::default().any_thread().on_page_load(move |w, p| {
    if w.label() == "input-prompt" && p.event() == tauri::webview::PageLoadEvent::Finished {
      on_load.store(true, Ordering::Release);
    }
  }).build(context).unwrap();
  app.run_return(move |app, event| {
    if let tauri::RunEvent::Ready = event {
      let prompt = app.get_webview_window("input-prompt").unwrap();
      let hwnd = prompt.hwnd().unwrap().0;
      eprintln!("configured HWND before repair: style={:08x} ex={:08x}", unsafe {
        GetWindowLongW(hwnd, GWL_STYLE) as u32
      }, unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 });
      let init = crate::prompt_visibility::initialize(&prompt);
      let (app, tx, loaded, tmp) = (app.clone(), tx.clone(), loaded.clone(), tmp.clone());
      std::thread::spawn(move || {
        let result = (|| -> anyhow::Result<()> {
          init?;
          let end = Instant::now() + Duration::from_secs(20);
          while !loaded.load(Ordering::Acquire) {
            anyhow::ensure!(Instant::now() < end, "WebView2 page never finished loading");
            std::thread::sleep(Duration::from_millis(50));
          }
          exercise(&prompt, &tmp)
        })();
        let _ = tx.send(result);
        app.exit(0);
      });
    }
  });
  rx.try_recv().unwrap().unwrap();
}

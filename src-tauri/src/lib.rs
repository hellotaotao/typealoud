mod ax_cloud;
mod commands;
mod dictionary;
mod filler;
mod glass;
mod history;
mod hardware;
mod retry_error;
mod hotkey;
mod local_asr;
mod local_speed;
mod microphone;
mod native_capture;
mod nemotron_asr;
mod scrub;
mod platform;
mod recording_archive;
mod settings;
mod state;
mod terms;
mod tray;
mod updater;
mod usage;

use tauri::{webview::PageLoadEvent, Manager, WindowEvent};

const MAIN_ENTRY_SCRIPT: &str = include_str!("../../src/views/main.js");
const INPUT_PROMPT_ENTRY_SCRIPT: &str = include_str!("../../src/views/input-prompt.js");
const AX_CLOUD_ENTRY_SCRIPT: &str = include_str!("../../src/views/ax-cloud.js");

// Launching the app activates it too, so an activation this soon after startup
// is the launch itself and not the user reaching for the window — ignoring it
// is what keeps "start minimized" actually minimized. See the
// `watch_app_activation` call in `setup`.
const LAUNCH_ACTIVATION_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Before anything resolves the data directory under the current identifier.
  settings::migrate_legacy_app_data();
  tauri::Builder::default()
    // single-instance MUST be the first plugin. A second launch hands off to
    // the already-running instance (which surfaces its window) and then exits,
    // instead of running a duplicate that would register a second global hotkey
    // and transcribe/insert every utterance twice.
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      tray::show_main_window(app);
    }))
    .manage(state::AppState::default())
    .manage(native_capture::NativeCaptureState::default())
    .on_page_load(|webview, payload| {
      let label = webview.label().to_string();
      let event = payload.event();
      if cfg!(debug_assertions) {
        let url = payload.url().to_string();
        log::info!(
          "webview:page-load label={} event={:?} url={}",
          label,
          event,
          url
        );
      }

      if event != PageLoadEvent::Finished {
        return;
      }

      let entry_injection = match label.as_str() {
        "main" => Some(("data-main-js-ran", MAIN_ENTRY_SCRIPT)),
        "input-prompt" => Some(("data-input-prompt-js-ran", INPUT_PROMPT_ENTRY_SCRIPT)),
        "ax-cloud" => Some(("data-ax-cloud-js-ran", AX_CLOUD_ENTRY_SCRIPT)),
        _ => None,
      };

      if let Some((marker, script)) = entry_injection {
        let injection = format!(
          r#"
(() => {{
  const html = document.documentElement;
  if (html?.getAttribute('{marker}')) {{
    return;
  }}

  {script}
}})()
"#,
          marker = marker,
          script = script
        );

        if let Err(error) = webview.eval(&injection) {
          log::error!(
            "webview:page-entry-injection-failed label={} marker={} error={}",
            label,
            marker,
            error
          );
        }
      }
    })
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        let label = window.label();
        if label == "main" {
          api.prevent_close();
          let _ = window.hide();
        }
      }
    })
    .setup(|app| {
      // Logging: dev → Info to stdout; release → Warn+ and count-only lifecycle
      // Info events to a size-capped rotating
      // file at ~/Library/Logs/com.tao.typealoud/TypeAloud.log, so a shipped build
      // still leaves diagnostics when a user reports "nothing happened" (these
      // log calls were previously no-ops in release). API keys and transcribed
      // text are never logged, so the file holds no sensitive content.
      let log_plugin = if cfg!(debug_assertions) {
        tauri_plugin_log::Builder::default()
          // Builder::default() pre-adds [Stdout, LogDir]; without clearing,
          // our .target() below is appended and every line is logged twice.
          .clear_targets()
          .level(log::LevelFilter::Info)
          .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
          ))
          .build()
      } else {
        tauri_plugin_log::Builder::default()
          // clear the default [Stdout, LogDir] so we only write our TypeAloud.log
          // (otherwise lines duplicate and a stray default-named log is created).
          .clear_targets()
          .level(log::LevelFilter::Warn)
          // Lifecycle events contain only fixed labels, IDs and timings. Keep
          // stage entry/exit in release so an unfinished await is diagnosable.
          .level_for("typealoud_lifecycle", log::LevelFilter::Info)
          .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
              file_name: Some("TypeAloud".into()),
            },
          ))
          // Keep two archived logs plus the active file, about 6 MB in total.
          // A rollover must not erase the only trace of an unfinished session.
          .max_file_size(2_000_000)
          .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(2))
          .build()
      };
      app.handle().plugin(log_plugin)?;
      hardware::local_tier();

      if let Err(error) = local_asr::cleanup_legacy_assets() {
        log::warn!("local-asr: legacy asset cleanup failed: {error:#}");
      }

      // Auto-update: checks GitHub Releases' latest.json and verifies packages
      // against our minisign pubkey (docs/superpowers/specs/2026-07-13-auto-update-design.md).
      #[cfg(desktop)]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

      tray::create(&app.handle())?;

      let config = settings::read_config().unwrap_or_default();
      commands::sync_local_runtime(&app.handle(), &config);
      let accessibility = commands::current_accessibility_granted();
      *app.state::<state::AppState>().accessibility.lock().unwrap() = Some(accessibility);

      let hotkey_handle = hotkey::start_listener(&app.handle(), config.shortcut.clone());
      *app.state::<state::AppState>().hotkey.lock().unwrap() = Some(hotkey_handle);

      updater::spawn_periodic_checks(app.handle().clone());
      usage::spawn_periodic_sends();

      // Cmd+Tab only *activates* the app; macOS sends no reopen event for it, so
      // without this the app comes to the front owning the menu bar with every
      // window still hidden and nothing on screen. Mirror AppKit's own reopen
      // rule — activated with no visible window → bring the main window back.
      // No-op off macOS.
      {
        let handle = app.handle().clone();
        let launched_at = std::time::Instant::now();
        platform::watch_app_activation(Box::new(move || {
          if launched_at.elapsed() < LAUNCH_ACTIVATION_GRACE {
            return;
          }
          // Any visible window means the activation had somewhere to land —
          // e.g. clicking the recording prompt's "Copy" button activates the
          // app, and popping the main window on top of that would be rude.
          let anything_visible = handle
            .webview_windows()
            .values()
            .any(|window| window.is_visible().unwrap_or(false));
          if anything_visible {
            return;
          }
          log::info!("activation: no visible window, showing main");
          tray::show_main_window(&handle);
        }));
      }

      if let Some(window) = app.get_webview_window("main") {
        glass::install_main_backdrop(&window);
      }

      if !config.start_minimized {
        if let Some(window) = app.get_webview_window("main") {
          let _ = window.show();
          let _ = window.set_focus();
        }
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::get_settings,
      commands::report_recording_startup,
      commands::report_audio_probe,
      commands::probe_native_capture,
      commands::start_native_capture,
      commands::stop_native_capture,
      commands::report_transcription_lifecycle,
      commands::prewarm_qwen_worker,
      commands::finish_qwen_worker_session,
      commands::get_diagnostic_log,
      commands::get_api_keys,
      commands::save_settings,
      commands::get_app_version,
      commands::get_build_info,
      commands::hide_input_prompt,
      commands::get_native_glass,
      commands::set_glass_regions,
      commands::set_glass_appearance,
      commands::release_recording_lock,
      commands::cleanup_microphone,
      commands::cancel_transcription,
      commands::record_assembled_transcription,
      commands::save_recovered_transcription,
      commands::start_live_transcription,
      commands::push_live_audio,
      commands::finish_live_transcription,
      commands::cancel_live_transcription,
      commands::transcribe_audio,
      commands::save_pending_transcription,
      commands::retranscribe_pending,
      commands::type_text,
      commands::show_permission_dialog,
      commands::open_microphone_settings,
      commands::reveal_app_in_finder,
      commands::open_release_page,
      commands::show_ax_cloud,
      commands::hide_ax_cloud,
      commands::dismiss_ax_cloud,
      commands::copy_to_clipboard,
      commands::check_microphone_permission,
      commands::report_microphone_capture,
      commands::check_accessibility_permission,
      commands::request_accessibility_permission,
      commands::recheck_accessibility_permission,
      commands::get_recent_activities,
      commands::read_debug_audio,
      commands::delete_history_item,
      commands::clear_history,
      commands::get_dictionary,
      commands::save_dictionary,
      commands::set_onboarding_completed,
      commands::set_usage_stats,
      commands::record_onboarding_step,
      commands::get_usage_preview,
      commands::save_onboarding_api_key,
      commands::set_provider,
      commands::set_local_model,
      commands::open_local_model_panel,
      commands::download_local_model,
      commands::cancel_local_model_download,
      commands::get_local_model_status,
      commands::get_local_speed,
      commands::delete_local_model,
      commands::get_gpu_runtime_status,
      commands::download_gpu_runtime,
      commands::cancel_gpu_runtime_download,
      commands::delete_gpu_runtime,
      commands::check_for_updates,
      commands::get_update_status,
      commands::install_update_and_restart,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|_app_handle, _event| {
      if matches!(
        &_event,
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
      ) {
        local_asr::shutdown_resident_worker();
        nemotron_asr::shutdown();
      }
      // macOS: clicking the Dock icon (or relaunching the app) when no window
      // is visible — e.g. after starting minimized — should bring the main
      // window back, matching standard macOS behavior.
      #[cfg(target_os = "macos")]
      if let tauri::RunEvent::Reopen { .. } = &_event {
        tray::show_main_window(_app_handle);
      }
    });
}

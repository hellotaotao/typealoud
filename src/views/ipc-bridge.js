(function () {
  const BRIDGE_GLOBAL = "__TYPEALOUD_IPC__";

  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-ipc-bridge-ran", "1");
  }

  if (typeof window !== "undefined" && window[BRIDGE_GLOBAL]) {
    return;
  }

  const TAURI_READY_TIMEOUT_MS = 3000;
  const TAURI_READY_POLL_MS = 25;

  const tauriCommands = {
    "get-settings": "get_settings",
    "report-recording-startup": "report_recording_startup",
    "report-transcription-lifecycle": "report_transcription_lifecycle",
    "report-audio-probe": "report_audio_probe",
    "probe-native-capture": "probe_native_capture",
    "start-native-capture": "start_native_capture",
    "stop-native-capture": "stop_native_capture",
    "prewarm-qwen-worker": "prewarm_qwen_worker",
    "finish-qwen-worker-session": "finish_qwen_worker_session",
    "get-diagnostic-log": "get_diagnostic_log",
    "get-api-keys": "get_api_keys",
    "save-settings": "save_settings",
    "get-app-version": "get_app_version",
    "get-build-info": "get_build_info",
    "hide-input-prompt": "hide_input_prompt",
    "release-recording-lock": "release_recording_lock",
    "cleanup-microphone": "cleanup_microphone",
    "cancel-transcription": "cancel_transcription",
    "record-assembled-transcription": "record_assembled_transcription",
    "save-recovered-transcription": "save_recovered_transcription",
    "start-live-transcription": "start_live_transcription",
    "push-live-audio": "push_live_audio",
    "finish-live-transcription": "finish_live_transcription",
    "cancel-live-transcription": "cancel_live_transcription",
    "transcribe-audio": "transcribe_audio",
    "save-pending-transcription": "save_pending_transcription",
    "retranscribe-pending": "retranscribe_pending",
    "type-text": "type_text",
    "show-permission-dialog": "show_permission_dialog",
    "open-microphone-settings": "open_microphone_settings",
    "reveal-app-in-finder": "reveal_app_in_finder",
    "show-ax-cloud": "show_ax_cloud",
    "hide-ax-cloud": "hide_ax_cloud",
    "dismiss-ax-cloud": "dismiss_ax_cloud",
    "copy-to-clipboard": "copy_to_clipboard",
    "check-microphone-permission": "check_microphone_permission",
    "report-microphone-capture": "report_microphone_capture",
    "check-accessibility-permission": "check_accessibility_permission",
    "request-accessibility-permission": "request_accessibility_permission",
    "recheck-accessibility-permission": "recheck_accessibility_permission",
    "get-recent-activities": "get_recent_activities",
    "read-debug-audio": "read_debug_audio",
    "delete-history-item": "delete_history_item",
    "clear-history": "clear_history",
    "get-dictionary": "get_dictionary",
    "save-dictionary": "save_dictionary",
    "set-onboarding-completed": "set_onboarding_completed",
    "set-usage-stats": "set_usage_stats",
    "record-onboarding-step": "record_onboarding_step",
    "get-usage-preview": "get_usage_preview",
    "save-onboarding-api-key": "save_onboarding_api_key",
    "set-provider": "set_provider",
    "set-local-model": "set_local_model",
    "open-local-model-panel": "open_local_model_panel",
    "download-local-model": "download_local_model",
    "get-local-speed": "get_local_speed",
    "cancel-local-model-download": "cancel_local_model_download",
    "get-local-model-status": "get_local_model_status",
    "delete-local-model": "delete_local_model",
    "get-gpu-runtime-status": "get_gpu_runtime_status",
    "download-gpu-runtime": "download_gpu_runtime",
    "cancel-gpu-runtime-download": "cancel_gpu_runtime_download",
    "delete-gpu-runtime": "delete_gpu_runtime",
    "check-for-updates": "check_for_updates",
    "get-update-status": "get_update_status",
    "install-update-and-restart": "install_update_and_restart",
    "open-release-page": "open_release_page",
  };

  const tauriArgs = {
    "report-microphone-capture": [["outcome"]],
    "report-recording-startup": [["timing"]],
    "report-transcription-lifecycle": [["report"]],
    "report-audio-probe": [["report"]],
    "probe-native-capture": [["seconds"]],
    "start-native-capture": [
      ["sessionId", "session_id"],
      ["microphone"],
      ["onAudio", "on_audio"],
    ],
    "stop-native-capture": [["sessionId", "session_id"]],
    "prewarm-qwen-worker": [["sessionId", "session_id"]],
    "finish-qwen-worker-session": [["sessionId", "session_id"]],
    "cancel-transcription": [["sessionId", "session_id"]],
    "release-recording-lock": [["lockId", "lock_id"]],
    "start-live-transcription": [
      ["sessionId", "session_id"],
      ["sampleRate", "sample_rate"],
    ],
    "record-assembled-transcription": [["text"]],
    "save-recovered-transcription": [["recovery"]],
    "finish-live-transcription": [
      ["sessionId", "session_id"],
      ["captureIncomplete", "capture_incomplete"],
    ],
    "cancel-live-transcription": [["sessionId", "session_id"]],
    "save-settings": [["settings", "settingsInput", "settings_input"]],
    "delete-history-item": [["id"]],
    "read-debug-audio": [["id"]],
    "retranscribe-pending": [["id"]],
    "type-text": [["text"], ["shape"]],
    "save-dictionary": [["text"]],
    "copy-to-clipboard": [["text"], ["shape"]],
    "save-onboarding-api-key": [["provider"], ["apiKey", "api_key"]],
    "set-provider": [["provider"]],
    "set-usage-stats": [["enabled"]],
    "record-onboarding-step": [["step"]],
    "open-release-page": [["version"]],
    "set-local-model": [["model"]],
    "open-local-model-panel": [["model"]],
    "download-local-model": [["model"], ["switchWhenReady", "switch_when_ready"]],
    "get-local-model-status": [["model"]],
    "delete-local-model": [["model"]],
  };

  // Channels whose first arg is binary and is sent as the RAW IPC body (Tauri's
  // application/octet-stream fast path) instead of a JSON number array; the
  // remaining positional args become request headers the Rust command reads via
  // Request::headers(). Without this a Vec<u8> arg is JSON-encoded as
  // "[12,34,...]" — and the camel+snake aliasing above would send it twice.
  // (Needs input-prompt.html's CSP to allow both IPC origins: `ipc:` on
  // macOS/Linux and `http://ipc.localhost` on Windows WebView2. Otherwise Tauri
  // falls back to the postMessage transport and JSON-encodes it anyway.)
  const tauriRawBody = {
    "push-live-audio": {
      body: 0,
      headers: { "session-id": 1 },
    },
    "transcribe-audio": {
      body: 0, // args[0] = audio bytes (Uint8Array / ArrayBuffer)
      headers: {
        "mime-type": 1,
        "session-id": 2,
        "chunk-index": 3, // chunked local path only; omitted for whole-clip decodes
        "capture-incomplete": 4, // partial capture is persisted through recovery
        "failure-id": 5, // stable across transcribeWithRetry's automatic retry
        "session-provider": 6, // recording-start provider snapshot
      },
    },
    "save-pending-transcription": {
      body: 0, // args[0] = audio bytes (the failed clip's WAV)
      headers: { "mime-type": 1, "recovery-id": 2 }, // optional stable id for late audio
    },
  };

  function hasWindow() {
    return typeof window !== "undefined";
  }

  function getTauriApi() {
    if (!hasWindow()) {
      return null;
    }

    const api = window.__TAURI__;
    if (
      api &&
      api.core &&
      typeof api.core.invoke === "function" &&
      api.event &&
      typeof api.event.listen === "function"
    ) {
      return api;
    }

    return null;
  }

  function getTauriInternals() {
    if (!hasWindow()) {
      return null;
    }

    const internals = window.__TAURI_INTERNALS__;
    if (
      internals &&
      typeof internals.invoke === "function" &&
      typeof internals.transformCallback === "function"
    ) {
      return internals;
    }

    return null;
  }

  function hasTauriEventInternals() {
    return (
      hasWindow() &&
      !!window.__TAURI_EVENT_PLUGIN_INTERNALS__ &&
      typeof window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener ===
        "function"
    );
  }

  function hasTauriRuntimeHint() {
    return hasWindow() && (!!window.__TAURI__ || !!window.__TAURI_INTERNALS__);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForTauriApi() {
    let api = getTauriApi();
    let internals = getTauriInternals();
    if (api || internals) {
      return { api, internals };
    }

    const deadline = Date.now() + TAURI_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(TAURI_READY_POLL_MS);
      api = getTauriApi();
      internals = getTauriInternals();
      if (api || internals) {
        return { api, internals };
      }
    }

    api = getTauriApi();
    internals = getTauriInternals();
    return api || internals ? { api, internals } : null;
  }

  function buildTauriPayload(channel, args) {
    const argNames = tauriArgs[channel] || [];
    const payload = {};

    argNames.forEach((names, index) => {
      const aliases = Array.isArray(names) ? names : [names];
      aliases.forEach((name) => {
        payload[name] = args[index];
      });
    });

    return payload;
  }

  async function invoke(channel, ...args) {
    const tauriRuntime =
      (getTauriApi() || getTauriInternals()) && {
        api: getTauriApi(),
        internals: getTauriInternals(),
      };
    const resolvedRuntime = tauriRuntime || (await waitForTauriApi());
    if (resolvedRuntime) {
      const command = tauriCommands[channel];
      if (!command) {
        throw new Error(`ipc-bridge: unknown Tauri command for channel \"${channel}\"`);
      }

      const rawSpec = tauriRawBody[channel];
      if (rawSpec) {
        const body = args[rawSpec.body];
        const headers = {};
        for (const name in rawSpec.headers) {
          const value = args[rawSpec.headers[name]];
          if (value !== undefined && value !== null) {
            headers[name] = String(value);
          }
        }
        const options = { headers };
        if (resolvedRuntime.api && resolvedRuntime.api.core) {
          return resolvedRuntime.api.core.invoke(command, body, options);
        }
        if (resolvedRuntime.internals) {
          return resolvedRuntime.internals.invoke(command, body, options);
        }
      }

      const payload = buildTauriPayload(channel, args);
      if (resolvedRuntime.api && resolvedRuntime.api.core) {
        return resolvedRuntime.api.core.invoke(command, payload);
      }
      if (resolvedRuntime.internals) {
        return resolvedRuntime.internals.invoke(command, payload);
      }
    }

    throw new Error(`ipc-bridge: runtime unavailable for channel \"${channel}\"`);
  }

  async function listenWithTauriInternals(channel, handler, internals) {
    if (!hasTauriEventInternals()) {
      throw new Error(
        `ipc-bridge: event internals unavailable for channel \"${channel}\"`
      );
    }

    const eventId = await internals.invoke("plugin:event|listen", {
      event: channel,
      target: { kind: "Any" },
      handler: internals.transformCallback(handler),
    });

    return () => {
      try {
        window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(
          channel,
          eventId
        );
      } catch (error) {
        console.warn(`Failed to unregister frontend listener for ${channel}:`, error);
      }

      internals
        .invoke("plugin:event|unlisten", {
          event: channel,
          eventId,
        })
        .catch((error) => {
          console.warn(`Failed to unlisten Tauri event ${channel}:`, error);
        });
    };
  }

  function on(channel, handler) {
    let disposed = false;
    let cleanup = null;

    const attach = async () => {
      const resolvedRuntime =
        (getTauriApi() || getTauriInternals()) && {
          api: getTauriApi(),
          internals: getTauriInternals(),
        };
      const tauri = resolvedRuntime || (await waitForTauriApi());
      if (disposed) {
        return;
      }

      if (tauri) {
        if (tauri.api && tauri.api.event && typeof tauri.api.event.listen === "function") {
          cleanup = await tauri.api.event.listen(channel, (event) => {
            handler(null, event.payload);
          });
          return;
        }

        if (tauri.internals) {
          cleanup = await listenWithTauriInternals(channel, (event) => {
            handler(null, event.payload);
          }, tauri.internals);
          return;
        }

        return;
      }

      throw new Error(`ipc-bridge: runtime unavailable for event \"${channel}\"`);
    };

    attach().catch((error) => {
      console.error(`Failed to attach IPC listener for ${channel}:`, error);
    });

    return () => {
      disposed = true;
      if (typeof cleanup === "function") {
        cleanup();
      }
    };
  }

  // Tauri Channels preserve ordering and carry raw Rust response bytes as an
  // ArrayBuffer. Native microphone PCM uses this instead of JSON events, whose
  // number-array encoding is roughly an order of magnitude larger.
  function createChannel(handler) {
    const api = getTauriApi();
    if (!api?.core || typeof api.core.Channel !== "function") {
      throw new Error("ipc-bridge: Tauri Channel API unavailable");
    }
    return new api.core.Channel(handler);
  }

  window[BRIDGE_GLOBAL] = {
    invoke,
    on,
    createChannel,
    get isTauri() {
      return !!getTauriApi() || !!getTauriInternals() || hasTauriRuntimeHint();
    },
  };

  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-ipc-bridge-ready", "1");
  }
})();

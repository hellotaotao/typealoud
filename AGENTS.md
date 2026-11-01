# AGENTS.md

Guidance for coding agents working in this repository. Codex reads this file directly; Claude Code
reads it through `CLAUDE.md`, which only imports it. Keep shared rules here so both tools follow
the same instructions.

> **Note:** TypeAloud is a **Tauri 2 + Rust** desktop app (migrated from Electron, which has been fully removed). Don't reintroduce Electron dependencies.

This file holds the rules and invariants to respect when changing code. The reasons, measurements
and history behind them live in the documents below; read the relevant one before re-deriving or
overturning a rule.

## Where things are documented

| Topic | Document |
|---|---|
| Product direction, current priorities, what not to build | `docs/PRODUCT_PATHWAY.md` |
| Real-device acceptance cases, offline log report | `docs/RELIABILITY_ACCEPTANCE.md` |
| Releasing, signing, notarization, updater e2e, distribution, Microsoft Store | `RELEASING.md` |
| Local engines: Qwen/Nemotron, llama.cpp worker, chunking, GPU | `docs/local-asr.md` |
| Audio capture per platform, WebKit findings, no NS/AGC | `docs/audio-capture.md` |
| Failure, retry and recovery rules | `docs/dictation-recovery.md` |
| Cloud models, punctuation research | `docs/cloud-transcription.md` |
| Third-party components and their licenses | `THIRD_PARTY_NOTICES.md` |
| Network connections, anonymous usage statistics (public) | `PRIVACY.md` |
| Upstream llama.cpp worker-reuse bug | `vendor/llama.cpp/README.md` |
| Past feature designs (each starts with a status line) | `docs/superpowers/specs/` |
| Parked ideas (local file, gitignored — never commit) | `TODO.md` |
| Promotion, launch plans, post drafts, trial recruiting (local folder, untracked — never commit; the repo holds only the product) | `promo/` |

## Development Commands

```bash
npm install            # Install JS tooling (only @tauri-apps/cli)
npm run dev            # Run the app in dev mode (tauri dev)
npm start              # Alias for tauri dev
npm test               # All src/views/*.test.mjs and scripts/*.test.mjs (CI uses the same entry)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust unit tests

npm run build          # Build for the current host (on macOS also archives the dmg to dist/)
npm run build:mac      # Build for macOS (aarch64-apple-darwin) → archives dmg to dist/
npm run build:mac:install  # Same as build:mac, then install the app into /Applications
npm run build:win      # Build for Windows (x86_64-pc-windows-msvc)
npm run build:linux    # Build for Linux (x86_64-unknown-linux-gnu)
```

Building requires a **Rust toolchain** (`rustup`) in addition to Node + `@tauri-apps/cli`.
`npm run version:tauri:patch` bumps the patch version, or pass an explicit version —
`node scripts/bump-tauri-version.js 1.2.0` — across `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`. Run it **manually** when cutting a release;
builds never auto-bump.

`build`, `build:mac` and `build:mac:install` set `CI=true` (tauri's Finder-prettifying AppleScript
fails in non-interactive shells) and run `scripts/collect-artifacts.js`, which **always copies the
built `.dmg` into `dist/`**, the kept archive of every version's installer, so don't skip it.
`build:mac:install` also mounts that dmg, copies `TypeAloud.app` over the one in `/Applications` and
relaunches it.

**Dev vs official build identity:** `src-tauri/build.rs` embeds a channel at compile time. CI's
release workflow sets `TYPEALOUD_OFFICIAL_BUILD=1` → channel `official` → the UI shows `v1.6.1`. Any
local build (dev mode or packaged) defaults to `dev` (fail-safe) and shows `v1.6.1 · dev.42` in the
main-window sidebar and the settings updates panel, with git hash/dirty/build time in the tooltip.
The counter lives in `.dev-build-number` (repo root, gitignored) and is bumped by
`scripts/bump-dev-build.js` before every packaged `build*` script; `tauri dev` doesn't bump it. The
semver is never suffixed, so updater version comparison is unaffected. Wire: `get_build_info` →
`BuildInfo` (camelCase).

**Local code signing:** `build:mac` and `build:mac:install` source an untracked `scripts/sign.env`
(copy from `scripts/sign.env.example`) exporting `APPLE_SIGNING_IDENTITY`. A stable identity keeps
macOS's Accessibility/Microphone grants across rebuilds. Ad-hoc signing (the default without the
file) changes the cdhash every build, which silently drops the Accessibility grant and with it the
global hotkey. Local builds are not notarized.

## Releasing

Push a `vX.Y.Z` tag. `.github/workflows/release.yml` builds macOS (universal; signed and notarized
when the Apple secrets are set, otherwise it warns and builds unsigned), Windows and Linux, emits
minisign-signed updater artifacts plus `latest.json` into a draft, and **publishes it automatically
once all three legs have uploaded** (the `publish` job). Publishing is the auto-update rollout:
installed clients poll `releases/latest/download/latest.json`, so a draft keeps them from seeing a
`latest.json` that lacks their platform. A failed leg leaves the draft unpublished until its jobs are
re-run. The workflow builds the version in the tagged commit, so bump and commit first:

```bash
npm run version:tauri:patch
git commit -am "chore(release): bump version to X.Y.Z"
git tag vX.Y.Z && git push origin main --tags
```

Secrets, AI release notes, verification, rollback and the localhost updater e2e harness are in
`RELEASING.md`.

## Architecture Overview

TypeAloud is a Tauri 2 voice-input app: a **Rust backend** (`src-tauri/src/`) hosting a **web
frontend** (`src/views/`). It runs in the system tray with a global hold-to-record hotkey,
transcribes locally by default (Qwen3-ASR through llama.cpp, or Nemotron) or through an optional
cloud provider (Groq/OpenAI), and inserts the text into the focused app.

### Rust backend (`src-tauri/src/`)

- `main.rs` — thin entry, calls `typealoud_lib::run()`.
- `lib.rs` — builds the app: manages `AppState`; on `setup` creates the tray, reads config, checks
  Accessibility and starts the hotkey listener; hides `main` on close instead of quitting;
  **injects each window's entry script** (`main.js` / `input-prompt.js` / `ax-cloud.js`, guarded by
  a marker attribute so it doesn't run twice) on page load; registers all `#[tauri::command]`
  handlers; configures logging.
- `commands.rs` — all Tauri commands: settings, window control, `transcribe_audio` (routes to local
  or cloud), `cancel_transcription`, `type_text`, permissions, history, dictionary and recovery.
  - `type_text` delegates to `platform::insert_text`. **There is no clipboard fallback, by design.**
    A failed insert points the user to History, where every transcription is already saved, and the
    prompt offers a manual Copy (`copy_to_clipboard`).
  - **Recovery invariants** (reasons and the complete rules: `docs/dictation-recovery.md`):
    - A failed transcription writes **one** History row carrying both reason and clip
      (`record_failed_transcription`, `pending: true`), in release builds too. Three cases belong to
      the frontend instead, and the backend must not write them: chunked dictation, a local
      `capture_incomplete` session, and a hang or timeout in a local-origin session
      (`frontend_owns_hang_recovery`).
    - Automatic retries of one recording share a `failure-id`; a later success converts that row in
      place. Never create a second row or clip for the same recording.
    - `retranscribe_pending` uses the engine configured **now**, not the one that failed. Updates
      read the row under the History lock and only touch rows that are still pending.
    - Only a confirmed `NotFound` clears a row's audio fields; any other read error keeps retry
      available. Filesystem paths stay in logs, never in History or toasts.
    - `RETRY_*` codes (`retry_error.rs`) are persisted in users' History: keep old translations when
      retiring a code, and migrate stored rows before renaming or reusing one.
- `local_asr.rs` — local Qwen3-ASR (0.6B default, 1.7B optional) through upstream llama.cpp
  `b9960`'s `llama-mtmd-cli`: assets and downloader, resident worker, stdout parser. **Invariants**
  (reasons and measurements: `docs/local-asr.md`):
  - Always pass an explicit `-c` sized by `ctx_size_for_wav` (otherwise ~7 GiB of KV cache) and
    `-p "a"` (an empty prompt hangs). Input is 16 kHz mono PCM16 WAV only.
  - A worker's lease is one hotkey hold (`session_id`); never hand it to another dictation.
    `repeats_previous` must keep rejecting a verbatim repeat (upstream reuse bug).
  - Chunks stay ≤ 75 s so every chunk maps to ctx 2048 and one worker serves the whole session.
  - Drain stdout and stderr concurrently. Partial text is visible progress, not streaming ASR.
  - Trust an extracted runtime only when its `.typealoud-runtime-sha256` stamp matches.
  - Qwen gets neither the language setting nor the dictionary prompt (term matching and replacement
    rules still
    apply to its final text).
  - GPU (Windows) is a separate Vulkan pack and `auto` resolves to CPU. A failing GPU worker
    disables GPU for the process and the same recording retries on CPU.
- `nemotron_asr.rs` — Nemotron 3.5 streaming engine (NVIDIA `nemo-speech` sidecar), available only
  on macOS arm64 and Windows x64 (`supported()`). Its batch and live requests carry the saved
  `language` (empty means `auto`). Settings enables the language picker for Nemotron and cloud
  engines, and disables it only for Qwen. The dictionary prompt doesn't reach Nemotron.
- `native_capture.rs` — macOS-only CoreAudio capture (cpal) that streams 16 kHz PCM16 to the
  frontend over a binary Channel; see `docs/audio-capture.md`.
- `updater.rs` — auto-update: background check of `latest.json` at startup and every 24 h (skipped
  in debug builds; GitHub first, the `typealoud.app/download` mirror first in mainland China
  time zones, see `RELEASING.md` "Distribution"), silent download, a single `update-status` event channel
  (idle | checking | downloading | ready | upToDate | error | storeManaged); install + restart only
  on user action (tray entry / settings button). The Microsoft Store (MSIX) install is the same exe:
  it detects its package identity at run time (`platform::is_store_install`), reports
  `storeManaged` and never self-updates. Updates are minisign-verified against the pubkey in
  `tauri.conf.json`. `createUpdaterArtifacts` lives only in `tauri.release.conf.json` (CI) and
  `tauri.updater-e2e.conf.json` (localhost harness), so local builds never need the key. Design:
  `docs/superpowers/specs/2026-07-13-auto-update-design.md`.
- `hotkey.rs` — global hold-to-record: a CGEventTap on macOS (only when Accessibility is trusted),
  `rdev::listen` elsewhere. Parses the modifier-only record shortcut (default `Ctrl+Shift`) and
  emits start/stop/cancel events. `STOP_DEBOUNCE` (250 ms) absorbs an accidental
  release; keep it. A press under `CANCEL_THRESHOLD` (500 ms) is a tap: with no second press within
  `DOUBLE_TAP_WINDOW` (350 ms) it emits `tap-recording` (the prompt re-inserts a visible failure
  card's text at the caret, otherwise it cancels); a second press emits `lock-recording` and the
  recording runs hands-free until the next press, Escape or `LOCKED_MAX` (12 min). A lock the
  frontend ended itself is released through `release_recording_lock`.
- `settings.rs` — JSON config in the app data dir, shortcut normalization, auto-launch, model
  defaults and API keys.
- `history.rs` — the History store (`{ "activities": [...] }`, 200-entry `HISTORY_CAP`, atomic
  writes), including pending audio.
- `retry_error.rs` — typed registry of the persisted `RETRY_*` codes.
- `recording_archive.rs` — development-only copy of every clip sent to `transcribe_audio`, kept 7
  days in `debug-dictations/` for offline chunking and decoding tests. It needs the hand-set
  config.json key `"debugSaveAudio": true` and is ignored in official builds.
- `usage.rs` — anonymous usage statistics: per-day counts in `usage-stats.json`, sent to PostHog
  (EU) as one `daily_usage` row per finished day plus a few one-off onboarding events. `PRIVACY.md`
  is the public promise, so a change to what is recorded or sent must update it in the same commit.
  Only counts and fixed labels, never text, audio, paths, device names or keys. Sends only from
  official builds with `TYPEALOUD_POSTHOG_KEY` compiled in, and only after the onboarding privacy page
  was passed or onboarding completed. Turning `usage_stats` off deletes the file, ID included.
- `scrub.rs` — strips known ASR boilerplate and prompt leaks and always corrects a short built-in
  list of misheard names ("cloud code" → "Claude Code"). `finalize_transcription` then removes
  hesitation fillers (`filler.rs`, when `remove_filler_words` is enabled) and merges space-separated
  single letters (when `merge_spelled_letters` is enabled); both default on. Run it only on
  complete results before History/insertion, never on individual chunks or live partials.
- `dictionary.rs` — parses the user dictionary (one stored string, same separators as the
  Dictionary page). Plain entries and the wanted side of `heard => wanted` rules form the cloud
  prompt; the rules rewrite every engine's final text after `finalize_transcription`. Users never
  type that syntax: the page edits rules in a two-field "Automatic replacements" form.
- `terms.rs` — corrects every engine's final text against known spellings: the built-in list in
  `data/builtin-terms.txt` plus the dictionary's plain entries and rule targets (the user's win). It
  runs last, after the replacement rules. A heard form is rewritten when it equals a term apart from
  case and spacing, or is one letter off (two for terms of 8+ letters). **Keep it conservative:** a
  miss can be fixed later, a wrong rewrite cannot. Anything that reads as ordinary English stays
  ("Cloud", "cursor", "linked in"), judged by the embedded `data/english-words.txt`; identifiers,
  paths and URLs are skipped. A sound-alike made of real words ("parrot kit") belongs in
  `scrub.rs`'s `correct_known_terms` or a user rule, not here.
- `filler.rs` — removes 嗯/呃 (and a standalone 额) together with their pause punctuation, keeping
  the strongest mark. A filler inside quotation marks (quoted speech is verbatim) or one that is
  listed, named or used as a word stays; when unsure, keep it. 啊/呀/哦 are never removed. Rules and the real transcripts behind them are in its header.
- `ax_cloud.rs` — window lifecycle for the Accessibility drag cloud.
- `glass.rs` — macOS Liquid Glass backdrops: `NSGlassEffectView`s placed below the WKWebView,
  showing wherever the page leaves its background transparent (`html.native-glass`, set by
  `native-glass.js` after `get_native_glass`). `main` gets one view filling the window (sidebar
  vibrancy before macOS 26) under an Overlay title bar; `input-prompt` gets one view per surface
  (box and transcription bubble) that follows the rect and opacity the page reports through
  `set_glass_regions`, so those surfaces animate by fading and resizing, never by transform.
  Set the glass appearance on the views, never on the window: a window appearance also pins the
  webview's `prefers-color-scheme` and breaks the "auto" theme.
- `tray.rs`, `state.rs` — system tray and shared app state.
- `platform/` — the platform abstraction (`mod.rs` contract + `macos.rs` / `fallback.rs`, plus the
  macOS-only `activation.rs`, `drag_cloud.rs` and `macos_insert_guard.rs`, the pure policy that decides
  whether the focused element can take text; add an app that draws its own text there only after
  testing it on a real machine). It owns text insertion, permission checks,
  clipboard write and autostart. Non-macOS (`fallback.rs`, shared by Windows/Linux): insertion via
  `enigo`, Accessibility requires no separate grant, and autostart is a stub. Windows delegates
  explicit clipboard copy and microphone Settings to `windows.rs`; microphone status is a
  process-local capture observation (`microphone.rs`), initially unknown. Linux microphone status
  and clipboard remain stubs. Other
  platform-specific code keeps its own `#[cfg]` gates beside the feature: the hotkey event sources
  (`hotkey.rs`), native capture (`native_capture.rs`), runtime archives and GPU (`local_asr.rs`),
  Nemotron runtimes (`nemotron_asr.rs`) and the drag-cloud window (`ax_cloud.rs`). See
  `docs/superpowers/specs/2026-07-01-cross-platform-support-design.md`.

### Frontend (`src/views/`)

- Plain HTML/CSS/JS, no bundler and no JS runtime dependency. Three windows are declared in
  `src-tauri/tauri.conf.json` (served from `frontendDist: ../src/views`): `main` (home, History, and
  the Settings page, which `main.html` loads as `settings.js`), `input-prompt` (the floating
  recording window) and `ax-cloud` (the Accessibility drag cloud).
- `input-prompt.js` — the recording session state machine: capture, Qwen chunking
  (`chunk-decision.mjs`), Nemotron live audio, the VAD gate (`vad-gate.js`), retries, recovery and
  the insertion FIFO.
- `ipc-bridge.js` — the IPC abstraction. Exposes `window.__TYPEALOUD_IPC__` with
  `invoke(channel, ...args)` and `on(channel, handler)`, mapping renderer channel names
  (e.g. `transcribe-audio`) to Tauri commands (`transcribe_audio`) and event listeners.
- `i18n.js` — all UI strings (add new copy here), including the `RETRY_*` renderer.

### Polish relay (in the website repository)

`POST https://typealoud.app/v1/polish` forwards dictated text to the polish model and returns the
cleaned text. Its code, prompt, limits and eval cases live in the public `hellotaotao/typealoud-web`
repository (`api/polish.js`, `relay/`, `scripts/polish-eval/`), which is the Vercel project behind
typealoud.app. The app does not call it yet. Design and measurements:
`docs/superpowers/specs/2026-10-13-cloud-polish-design.md`. The relay never stores or logs text,
and its prompt and model parameters are fixed on the server; keep both true when changing it.

### Engine selection and onboarding invariants

- Dictation requests use the recording-start `session-provider` (`local`, `groq`, or `openai`),
  including chunks and automatic retries. Missing or unknown providers are rejected; never infer
  a cloud destination from the latest settings. Explicit History retranscription still uses the
  current configuration.
- Local engines may be selected before assets are ready. `engineReady` / `engineBlocker` describe
  readiness independently from provider/model intent. Download completion does not switch engines,
  with one exception: a download requested with `switchWhenReady` (Settings' "Download 1.7B" while
  Qwen is in use) switches to that model only if the engine is still the one in use at the request.
- Qwen is one engine with two sizes. Home and Settings show Qwen and OpenAI; Groq and Nemotron sit
  behind "More" unless one is in use. `qwenModel` (config `qwen_model`) remembers the last Qwen size,
  so returning to Qwen restores it. The 1.7B suggestion comes from this machine's measured 0.6B
  decode speed (`local_speed.rs`, `get_local_speed`), never from the chip name.
- New-install defaults come from `settings::fresh_config_for` and cached hardware tiers, only when
  the config file is absent. Do not change `AppConfig::default` or serde defaults to implement this
  policy; existing installations must retain their selected engine.

### IPC contract

Renderer → Rust: `bridge.invoke("type-text", text)` → Tauri `invoke("type_text", { text })`.
Rust → Renderer: `app.emit("shortcut-updated", …)` and similar, received via `bridge.on(...)`.

**When adding a new IPC command, update three places:** the `#[tauri::command]` in `commands.rs`,
its registration in the `generate_handler!` list in `lib.rs`, and the `tauriCommands` map in
`ipc-bridge.js` (plus `tauriArgs` or `tauriRawBody` when it takes arguments).
`scripts/ipc-contract.test.mjs` fails CI when one is missed.

Raw audio bytes travel as an octet-stream request body with headers (`tauriRawBody`), not as JSON
arrays; the input-prompt CSP allows `connect-src 'self' ipc: http://ipc.localhost` for this.

The frontend registers every listener with target `{ kind: "Any" }`, and **an `Any` listener
receives targeted events too**: Tauri's `match_any_or_filter` short-circuits on `EventTarget::Any`
before comparing labels (checked against the locked tauri source: 2.10.3 on 2026-08-31, 2.12.2
on 2026-10-19). So `emit`
and `emit_to` both work here. An earlier version of these instructions claimed `emit_to` was
silently dropped; that was wrong, so don't "fix" a working `emit_to` on its authority. `emit` is
still the natural default for events more than one window may want.

## Platform-Specific Considerations

- **macOS** requires Microphone and Accessibility permissions; entitlements are at
  `build/entitlements.mac.plist` (referenced by `tauri.conf.json`). It is the main platform and gets
  the most real-machine testing.
- **Windows**: hotkey (`rdev`), capture and insertion (`enigo`) work end to end, checked by hand on one
  old, slow Windows machine (reported 2026-11-02); expect slow local transcription on weak CPUs.
- **Linux**: insertion and the hotkey are implemented but not verified end to end; CI builds its
  installers. Recording is blocked on WebKitGTK `getUserMedia`.
- **macOS-only native APIs must be `#[cfg(target_os = "macos")]`-gated**, or the Windows/Linux CI and
  release legs fail to compile. Release builds are universal, so macOS-gated code must also cover
  `x86_64`; `cargo check --target x86_64-apple-darwin` reproduces that leg locally.
- **Audio capture:** every platform opens the microphone per dictation and closes it on release:
  macOS through a native CoreAudio stream, Windows/Linux through webview `getUserMedia` with
  `echoCancellation`/`noiseSuppression`/`autoGainControl` all pinned `false`. Don't keep a stream open
  between dictations (it keeps the OS microphone indicator lit and holds Bluetooth headsets in call
  mode), don't add noise suppression, AGC or pre-denoising, and don't re-enable echo cancellation. The
  measurements behind this are in `docs/audio-capture.md`.
- Reset macOS permissions when re-testing:
  ```
  tccutil reset Accessibility com.tao.typealoud
  tccutil reset Microphone com.tao.typealoud
  ```

## Coding Style

- Match the surrounding code: 2-space indentation in Rust and JS, semicolons in JS, descriptive
  names. The Rust is formatted by hand and the repo has no `rustfmt.toml`, so `cargo fmt` would
  rewrite whole files; leave it out.
- UI strings go in `src/views/i18n.js`. Window scripts reach the backend only through
  `ipc-bridge.js` (`window.__TYPEALOUD_IPC__`), never through Tauri APIs directly.

## Commits and Pull Requests

Use short imperative messages with conventional prefixes (`feat:`, `fix(settings):`, `docs:`).
Include testing notes, and screenshots for UI changes. Call out macOS Accessibility/Microphone
permission changes and platform-specific behavior explicitly.

## Security and Configuration

- API keys are entered in the app and stored in its JSON config via `settings.rs`. Never commit
  secrets; the signing credentials live in the gitignored `scripts/sign.env`.
- If you change permissions or entitlements, update `build/entitlements.mac.plist` and document new
  OS prompts in `README.md`.
- When you vendor a file, add a downloaded runtime or model, or pull in a crate under an unusual
  license, update `THIRD_PARTY_NOTICES.md`.

## Development Notes

- Hold `Ctrl+Shift` to record, or double-tap it to record hands-free until the next press; Escape
  cancels. There is no translate mode; the Shift+Alt
  translation was removed on 2026-09-25 as unused.
- Rust unit tests sit beside the code. A few tests that need real model assets are `#[ignore]` and
  run manually.
- Lifecycle logs (the `typealoud_lifecycle` target) never contain transcript text;
  `node scripts/dictation-report.mjs <log>` summarizes them offline.
- When judging capture health, measure the signal level over time, not how quickly a call returns.

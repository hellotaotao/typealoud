# Automatic Updates — Design

**Date:** 2026-07-13
**Status:** Implemented (`a5e3c15` onward; v1.4.0 was the first updater-capable release). Design record; later changes are not reflected here. In particular, the draft-then-Publish rollout gate described below was replaced by direct publishing (`releaseDraft: false`, see RELEASING.md).

## Problem

TypeAloud now has a complete signed + notarized release pipeline (CI builds a
universal DMG on every `v*` tag, signs with Developer ID, notarizes, and opens
a draft GitHub Release). But installed copies never learn about new versions:
the app is tray-resident and may run for weeks, and the only upgrade path is
manually downloading a DMG. The natural next step is in-app automatic updates.

## Decision: official `tauri-plugin-updater` + GitHub Releases

Use the official Tauri v2 updater plugin with GitHub Releases hosting the
update manifest (`latest.json`). The public repo's
`https://github.com/hellotaotao/typealoud/releases/latest/download/latest.json`
endpoint is free, serverless, and natively integrated with the existing
`tauri-action` pipeline (one switch + a signing key).

Rejected alternatives:

- **Check-only notifier** (poll GitHub API, deep-link to the download page) —
  lighter, but strictly worse UX and barely less code once UI is counted.
- **Sparkle** (native macOS updater) — awkward to embed in Tauri, macOS-only,
  duplicates what the official plugin already does.

### User decisions (2026-07-13)

1. **UX: auto-download + prompt to restart.** Background check finds an
   update → download it silently → show a low-key "restart to update" prompt.
   No pre-download confirmation dialog, no fully-silent install.
2. **Check timing: on startup + every 24 h.** Startup-only would miss the
   tray-resident weeks-without-restart case.
3. **Platform scope: all three platforms configured now.** The release
   workflow expands from macOS-only to the full matrix. Windows/Linux update
   channels are configured but remain **unverified on real machines**, same
   status as the rest of Win/Linux support.

## Update flow

```
git tag v1.3.6 → release.yml (3-platform matrix)
  → each leg builds + emits updater artifacts + minisign signatures
  → tauri-action generates/merges latest.json onto the draft release
  → manual Publish on GitHub (= the release gate)
  → clients poll latest/download/latest.json (startup + every 24 h)
  → version newer → background download → tray/settings "restart to update"
  → user clicks → install + relaunch
```

The existing **draft → manual Publish** flow is unchanged and doubles as the
update release gate: GitHub's `latest/download/` endpoint only serves
published releases, so while a release is a draft, clients still see the
previous version's manifest.

## Updater signing key (separate from Apple signing)

- `tauri signer generate` produces a minisign keypair. The **public key** is
  committed in `tauri.conf.json`; the **private key + password** become two
  new GitHub secrets: `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Clients only install updates signed by this key. This is the anti-tamper
  layer, complementary to notarization (Apple vouches "safe to run"; this key
  vouches "actually shipped by Tao").
- **Losing the private key means installed clients can never auto-update
  again** (they'd need a manual reinstall). Back it up outside the repo
  (password manager + local untracked `scripts/sign.env`).

## Configuration & artifacts

- `tauri.conf.json` gains `plugins.updater` with `pubkey` and the single
  GitHub `latest.json` endpoint.
- `bundle.createUpdaterArtifacts: true` lives **only in a CI overlay config**
  (`src-tauri/tauri.release.conf.json`, merged via `tauri build --config`).
  Rationale: once that flag is on, builds **fail** without the private key in
  the environment; keeping it out of the main config leaves local
  `npm run build:mac` untouched.
- Per-platform updater artifacts:
  - **macOS:** `TypeAloud.app.tar.gz` + `.sig` from the universal build; the
    `darwin-aarch64` and `darwin-x86_64` manifest keys point at the same
    universal archive.
  - **Windows:** NSIS `.exe` + `.sig` (`updaterJsonPreferNsis: true` for a
    deterministic choice; `bundle.targets: "all"` also produces an MSI).
  - **Linux:** `.AppImage` + `.sig`. deb/rpm installs cannot auto-update
    (Tauri limitation); they remain downloadable but outside the channel.

## Release workflow changes (`release.yml`)

- Single macOS job becomes a **matrix**: `macos-latest`
  (`--target universal-apple-darwin`), `windows-latest`, `ubuntu-22.04`. The
  Linux system-dependency step is copied verbatim from `ci.yml`.
- Every leg passes `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` to `tauri-action`,
  adds the `--config src-tauri/tauri.release.conf.json` overlay to `args`,
  and sets `includeUpdaterJson: true` + `updaterJsonPreferNsis: true`.
  tauri-action merges all platforms into one `latest.json` on the shared
  draft release.
- The "Configure Apple signing" step gets `if: matrix.os == 'macos-latest'`.
- The AI release-notes step moves to a **separate job** (`needs: release`) so
  it runs exactly once after all legs finish. Consequence: `latest.json`'s
  `notes` field snapshots the placeholder release body (notes are written to
  the release afterwards) — acceptable because the v1 prompt shows only the
  version number.

## Client logic (Rust, new module `updater.rs`)

Follows the house architecture: all logic in Rust, frontend is display-only.

- **Dependencies:** `tauri-plugin-updater` only — restart is Rust-side
  `AppHandle::restart()`, so `tauri-plugin-process` (which only exposes
  restart to JS) is not needed.
- **Auto check:** on `setup`, spawn an async task — first check ~30 s after
  startup, then every 24 h. Skipped entirely under `debug_assertions` (dev
  runs never self-update).
- **Update found:** download immediately in the background; store the
  `Update` object + downloaded bytes in `AppState.pending_update`; emit an
  `update-status` event (single channel for all states:
  idle | checking | downloading | ready | upToDate | error; "ready" carries
  the version).
- **Install:** the `install_update_and_restart` command calls
  `update.install(bytes)`, then `app.restart()` on macOS/Linux; on Windows
  the NSIS installer takes over and relaunches itself.
- **New IPC commands** (registered in all three places per the house rule —
  `commands.rs`, `lib.rs` `invoke_handler!`, `ipc-bridge.js` maps):
  - `check_for_updates` — manual trigger, returns the outcome.
  - `install_update_and_restart`.
  - `get_update_status` — current state for the settings page.
- **New events:** `update-status` (single status channel consumed by settings).

## UI (low-key by design)

- **Tray menu:** when an update is ready, dynamically insert a
  "Restart to update to vX.Y.Z" item; clicking installs + relaunches. The
  tray is the natural surface for a tray-resident app.
- **Settings page:** new "About / Updates" block — current version, a
  "Check for updates" button, and a status line
  (checking / up-to-date / downloading / ready / error).
- **No system-notification plugin** (YAGNI: solo user; tray + settings
  suffice; revisit only if updates go unnoticed in practice).
- New strings in `i18n.js` (EN + 中文).

## Platform notes

- **macOS:** the updater replaces the `.app` in place. The new bundle carries
  the same Developer ID signature (same Team ID + bundle ID), so
  **Accessibility/Microphone TCC grants persist across updates** — the direct
  payoff of the stable-signing-identity decision. The archive isn't a browser
  download (no quarantine attribute), so Gatekeeper doesn't re-prompt.
- **Windows:** install mode `passive` (progress bar, no interaction).
  Unverified on real hardware.
- **Linux:** AppImage-only channel; WebKitGTK recording remains a separate
  known blocker. Unverified on real hardware.

## Error handling

- Automatic check/download failures: silent, logged, retried at the next 24 h
  cycle. Never a dialog.
- Signature verification failure: the plugin refuses the install; logged.
- Manual check failures: human-readable error shown on the settings page.

## Verification

1. `cargo test` + existing CI as usual.
2. **End-to-end before shipping (macOS, real machine):** serve a hand-crafted
   `latest.json` + updater archive from a local static server, point the
   endpoint at localhost via a dev overlay config, and walk the full chain:
   check → download → tray prompt → click → app relaunches as the new
   version.
3. **Live fire:** publish the next release and update from the previous
   installed version. Note the bootstrap: the first updater-equipped version
   must itself be installed manually — auto-update only works from that
   version onward.

## Out of scope (YAGNI)

Delta/differential updates, beta/release channels, rollback, a pre-install
changelog dialog (the manifest's `notes` field holds the placeholder body
anyway, since AI notes are written after manifest generation — the v1 prompt
shows the version number only).

# Dev build identifier — design

2026-07-18 · **Status:** implemented (`6416df5`); design record, later changes are not reflected here

## Problem

`build:mac:install` puts a locally built release into /Applications that is
visually identical to a CI-published official release — once open, there is no
way to tell which one is running. The existing `isDev = cfg!(debug_assertions)`
only identifies `tauri dev`, not local *packaged* builds.

## Decisions

- **Fail-safe channel**: default is `dev`; only builds where CI injected
  `TYPEALOUD_OFFICIAL_BUILD=1` (release.yml → tauri-action env) compile as
  `official`. A local build can never masquerade as a release.
- **Semver untouched**: `tauri.conf.json`/`Cargo.toml` versions get no suffix,
  so tauri-plugin-updater's version comparison is unaffected. The dev marker is
  display-only.
- **Dev badge** = `v1.6.1 · dev.42`: an incrementing local counter
  (`.dev-build-number`, repo root, gitignored — same precedent as
  `scripts/sign.env`), bumped by `scripts/bump-dev-build.js` at the front of
  every packaged `build*` npm script. `tauri dev` does not bump (shows the last
  number). Git short hash + dirty flag + build time (Unix secs, formatted by
  the frontend) go in the badge's hover tooltip; debug builds append `debug`.
- **Updater behavior unchanged** (user-chosen): dev builds still receive
  official-release update prompts; accepting one replaces the dev build —
  that's the easy path back to the official channel.
- CI has no counter file → build number 0, never displayed on `official`.

## Mechanics

`src-tauri/build.rs` emits `cargo:rustc-env` for channel / git hash / dirty /
build time / build number (rerun-if: the env flag, the counter file,
`../.git/HEAD`; dirty-only changes don't retrigger, but packaged builds always
bump the counter so they always re-embed). `get_build_info` command
(commands.rs → lib.rs `generate_handler!` → ipc-bridge `tauriCommands`) returns
`BuildInfo` (camelCase). Display: main-window sidebar `#appVersion` (main.js)
and the settings updates panel's current-version strings (settings.js);
remote-version strings (downloading/ready) untouched. `get_app_version` remains
for the updater path.

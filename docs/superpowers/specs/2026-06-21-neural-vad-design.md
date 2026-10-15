# Neural VAD for TypeAloud — Design

**Date:** 2026-06-21 · **Branch:** `feat/neural-vad` · **Status:** implemented (`1e13fd1`–`3b8f29a`); design record, later changes are not reflected here

## Problem

Whisper hallucinates on silent / near-silent audio. Because we pass the user dictionary as the
Whisper `prompt` (`src-tauri/src/commands.rs:500`), the classic degenerate output is the prompt
**echoed back verbatim**. Confirmed pain (scenario A): a misfire or a long stretch of no speech
produces severe hallucination / prompt echo that gets inserted as if it were dictation.

Push-to-talk semantics ("hold key = I intend to speak") mean the dominant failure is **the whole
clip being (near-)silent**, not speech-with-internal-gaps.

## Goals / Non-goals

- **Goal:** when a recording contains *no speech*, skip transcription entirely (gate-only) — kill
  silence hallucination + prompt echo — **without** dropping quiet-but-real speech.
- **Goal:** neural-quality detection (level-robust), cross-platform-clean packaging.
- **Non-goal (v1):** trimming internal / leading / trailing silence from clips that *do* contain
  speech. Deferred to Phase 2 and likely unnecessary — Whisper anchors on surrounding real speech,
  so internal pauses rarely hallucinate.
- **Non-goal:** real-time / streaming VAD. We are offline: record fully, then process.

## Decision: Route B — frontend WASM neural VAD

The three desirable properties **{neural-Silero, cross-platform-clean, pure-Rust/no-JS}** cannot be
had together (see Spike findings). We **drop pure-Rust** and keep the other two.

- Run **Silero VAD v5** via **`@ricky0123/vad-web`** (onnxruntime-web, WASM) inside the **existing
  WKWebView**. Ships once, runs in each platform's webview; **no native dylib, no signing/notarization
  changes**; the Rust backend is left untouched.
- **Why not pure-Rust `tract`:** a Phase-0 spike proved tract cannot build a runnable Silero v5 graph
  (shape inference fails through the model's nested `If` control flow + LSTM `decoder/Squeeze`). Every
  maintained Rust Silero crate uses `ort`, none use tract.
- **Why not Rust `ort`:** needs a per-platform native onnxruntime library + macOS notarization of that
  `.dylib` — the cross-platform tax we most want to avoid (cross-platform is the top priority).
- **Accepted cost:** adds a JS/WASM dependency, breaking the project's "JS-runtime-free / no bundler"
  convention. **Mitigation:** vendor the assets (no bundler, no npm runtime step) under
  `src/views/vendor/` and import via `<script type="module">`, preserving static serving.

## Architecture & data flow

Capture is unchanged (`getUserMedia` → `MediaRecorder` → `Blob`, mp4/AAC on macOS).

**New frontend gate** — in `input-prompt.js`, after recording stops, *before* invoking `transcribe-audio`:

1. `Blob` → `AudioContext.decodeAudioData` → `AudioBuffer`.
2. `OfflineAudioContext` render → **mono Float32 PCM @ 16 kHz** (resample; VAD-internal only — see note).
3. `NonRealTimeVAD.run(pcm16k, 16000)` → speech segments `[{start, end}, …]`.
4. Sum speech durations. **If total < `vad_min_speech_ms` (default 250 ms) → NO SPEECH:** do not call
   `transcribe-audio`; show a brief **"no speech detected"** status (new i18n string
   `inputPrompt.noSpeech`, ~1 s), then clean up the mic and return to idle; **write no history entry**.
   Otherwise → proceed exactly as today, uploading the **original, untouched** blob.

With the gate in the frontend, **the Rust backend is untouched** by this feature (no change to
`transcribe_audio`). *(An earlier idea — a backend guard that drops a transcript equal to the dictionary
`prompt` — was rejected: dictionary content can legitimately **be** the correct transcription, e.g. when
the user dictates a single word that is in their dictionary; suppressing it would make that word
un-sayable. The VAD gate already removes the silence root-cause that triggers prompt echo.)*

**On sample rate:** recording stays at the native capture rate (~48 kHz) and we upload the original
compressed blob. Whisper resamples to 16 kHz server-side regardless, so capturing at 16 kHz would buy
nothing for quality; the 16 kHz step above is **VAD-internal only**. Forcing 16 kHz capture in WKWebView
is also unreliable (the `sampleRate` constraint is often ignored), so you would resample anyway. **On upload
size:** there is no cheap lever here — measured that WebKit's MediaRecorder **ignores
`audioBitsPerSecond`** (a 32 kbps request still produced ~155 kbps AAC-LC / 48 kHz / stereo, identical to
the default). Real reduction would require re-encoding (WebCodecs or a backend encoder) — extra CPU +
complexity not worth it for short dictation clips, so the recording is left as-is.

## Components & boundaries

- **`src/views/vendor/vad/`** — vendored `@ricky0123/vad-web` ESM + onnxruntime-web `.wasm` + Silero v5
  `.onnx`. Pinned versions + provenance recorded in a `PROVENANCE.md` there. `onnxruntime-web`'s
  `wasmPaths` and the vad model path point at these local asset URLs.
- **`src/views/vad-gate.js`** (new, small) — single purpose: `async hasSpeech(blob) →
  { speech: boolean, totalSpeechMs, segments }`. Encapsulates decode → resample → VAD → threshold.
  Lazy-loads the WASM/model on first use (no load cost until the first recording). Clean, testable
  boundary: input a `Blob`, output a decision; consumers don't see onnxruntime.
- **`input-prompt.js`** — calls `hasSpeech()` in the stop→transcribe path and branches; renders the
  `inputPrompt.noSpeech` status on the skip path.
- **`i18n.js`** — new `inputPrompt.noSpeech` string.
- **Config** (`settings.rs` / settings JSON): `vad_enabled` (default `true`), `vad_min_speech_ms`
  (default `250`), `vad_threshold` (Silero positive-speech threshold, default `0.5`). UI toggle is
  optional and can come later; defaults ship working.

The Rust backend (`commands.rs` / `transcribe_audio`) is **not** modified by this feature.

## Phases

**Phase 0 — de-risk the runtime (FIRST; mirrors the tract spike).**
The new unverified assumption is: *does onnxruntime-web + vad-web actually load and run inside WKWebView*
(Tauri asset protocol; SIMD/threads / SharedArrayBuffer availability)? Before building the full feature:
vendor the assets; in the input-prompt webview, lazy-load `NonRealTimeVAD` and run it on a known buffer
(a bundled speech clip and a silence buffer); **surface the result through the existing file logger** so
we read it from the log file rather than the webview console (see the dev-verification gotcha memory).
- **PASS:** loads without error in WKWebView; speech clip → segments, silence → none.
- If ort-web wants SharedArrayBuffer/COOP-COEP that Tauri doesn't provide, confirm it falls back to
  single-threaded WASM (fine for offline 30 s clips). A hard blocker → reconsider Route A (`ort`) / C
  (`webrtc-vad`).

**Phase 1 — gate-only integration.** `vad-gate.js` module + `input-prompt.js` wiring (incl. the
`noSpeech` status) + config keys + tests.

**Phase 2 — optional, only if scenario B is observed in real use.** Trim internal/leading/trailing
silence (re-assemble PCM → WAV/re-encode before upload) + a UI sensitivity control.

## Testing

- **`vad-gate.js` decision logic:** unit-test the pure threshold function (segments + threshold →
  `speech` bool / `totalSpeechMs`) with no model.
- **Real-model check:** a small dev-webview harness that runs the real VAD over bundled `speech` and
  `silence` fixtures and asserts the gate's verdict (this is also the Phase-0 deliverable, promoted).
- **Manual, the core worry:** quiet / far-from-mic real speech must **not** be dropped; misfire / silence
  **must** be dropped. Tune defaults to err toward *keeping*.

## Risks

1. **onnxruntime-web in WKWebView** — resolved by Phase 0. Includes `.wasm` MIME/path under the Tauri
   asset protocol (ort-web falls back from `instantiateStreaming` to arraybuffer if MIME is off).
2. **Resample correctness** — confirm vad-web's expected input rate; we feed 16 kHz Float32 via
   `OfflineAudioContext` and pass `sampleRate = 16000` (a no-op if it resamples internally).
3. **Threshold tuning** — defaults must favor keeping real speech; validate against far/quiet samples.
4. **Bundle size** — ort-web `.wasm` + Silero `.onnx` (~2 MB) added to the app bundle. Acceptable.
5. **Vendoring maintenance** — pinned versions, documented provenance, manual updates (solo project).

## Spike findings (settled facts, 2026-06-21)

- `tract` (pure Rust) **cannot** run Silero v5 (nested-`If` shape-inference failure). Rust + neural ⇒
  native onnxruntime (`ort`) dylib is mandatory — hence Route B.
- `symphonia` (pure Rust, `isomp4`+`aac`) decodes the app's mp4/AAC cleanly — relevant only if we ever
  move VAD to the backend.
- Recordings are 48 kHz; the VAD path resamples to 16 kHz for Silero (VAD-internal; recording unchanged).

## Execution refinements (Task 0.1, 2026-06-22)

Vendoring the library (vad-web 0.0.30 + onnxruntime-web 1.27.0) refined a few details above; the committed
`src/views/vendor/vad/PROVENANCE.md` is the source of truth for the exact files + load recipe:

- The offline API `NonRealTimeVAD` loads the **Silero *legacy*** model (`silero_vad_legacy.onnx`, 1536-sample
  / 96 ms frames), not v5 — fine for a speech-presence gate. (The tract spike that killed pure-Rust was on
  the v5 graph; that finding stands.)
- vad-web **resamples internally** — pass the decoded **native-rate** (~48 kHz) mono `Float32` to
  `run(pcm, nativeSampleRate)`; no `OfflineAudioContext` resampling needed (simplifies the data flow above).
- `run()` yields `{ audio, start, end }` with **start/end in milliseconds** (verified in source:
  `(frameIndex * 1536) / 16`), so `MIN_SPEECH_MS = 250` is correct.
- Loading is **two classic scripts**: `ort.wasm.min.js` (→ `window.ort`) then `bundle.min.js` (→ `window.vad`,
  which externalizes ort as `window.ort`). Set `ort.env.wasm.numThreads = 1` to pre-empt the
  SharedArrayBuffer / COOP-COEP requirement under WKWebView.
- Real vendored size is **~15 MB** (13 MB onnxruntime-web wasm runtime), not the ~2 MB estimated under Risks. Accepted.

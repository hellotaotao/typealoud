# Audio capture

How TypeAloud records a dictation on each platform and why, checked against `a183354` (1.15.1) on
2026-09-11. It merges the capture sections that used to live in `CLAUDE.md` with the 2026-09-05
native-capture handover (now only in git history).

## Current design

**macOS: native CoreAudio, one stream per dictation** (`native_capture.rs`, since `67a7f0c`). Rust
opens the device named by the `microphone` setting (or the current default; there is no picker in
the UI yet, so in practice it is the system default), takes the first channel
as mono, resamples with a windowed-sinc filter to 16 kHz, and streams ordered PCM16LE blocks to
`input-prompt.js` over a binary Tauri `Channel`; JSON events would bloat the audio about tenfold. The
frontend keeps the Qwen chunking, Nemotron streaming, waveform, onset diagnostics, recovery,
cancellation and insertion state machines, and whole-clip or cloud uploads are a WAV assembled from
the same PCM. A stream error is sent to the frontend and stops that session; there is no attempt to
migrate to another device mid-recording. The stream closes on release, so the orange microphone
indicator doesn't stay lit between dictations and Bluetooth headsets aren't held in HFP mode.

**Windows and Linux: webview `getUserMedia`, one stream per dictation**, opened when the hotkey is
pressed and stopped on release, with every processing constraint in `AUDIO_CONSTRAINTS` pinned to
`false`. No background stream is opened before the first dictation. A user-triggered microphone
check in onboarding or Settings briefly opens a stream and stops every track before reporting the
result; it does not encode or transcribe audio. Windows runs WebView2 (Chromium).
Linux runs WebKitGTK, whose `getUserMedia` support currently blocks recording there.

Windows microphone readiness is the last capture observation in this process, not a permanent OS
grant. It starts `unknown`; capture/check success reports `granted`, permission rejection reports
`denied`, missing devices report `unavailable`, and other capture failures report `error`. Normal
recording reports asynchronously so IPC cannot delay capture startup. The shared status event
refreshes Home, onboarding and Settings. Opening Windows microphone privacy Settings invalidates
the observation to `unknown`; the user can then check again. No readiness check keeps a stream alive.

Until 2026-09-14 these platforms kept one stream open for the whole process: the WKWebView workaround
described below, left in place after macOS moved to native capture. The 3.0 s attenuation it guarded
against did not reproduce on Windows, but its costs applied there too: a microphone-in-use indicator
that never went out and Bluetooth headsets held in hands-free mode. Whether a cold WebView2 stream
drops the first words is not measured yet; check `audio-onset` on a Windows machine, speaking
immediately after pressing, before keeping a stream open again.

**Format.** Native macOS capture produces PCM16 WAV, 16 kHz mono, 256 kbps (32 KB/s). That is about
65% larger than the old WKWebView AAC, but it's already what local ASR consumes and needs no codec
dependency. WKWebView's `MediaRecorder` produced AAC-LC 48 kHz stereo at ~155 kbps (a 10 s clip is
about 200 KB) and ignored `audioBitsPerSecond`; Chromium honors it. Sample rate barely matters for
the cloud models, which resample to 16 kHz anyway.

## Why macOS stopped using WKWebView capture

### A fresh WKWebView stream is ~32 dB down for exactly 3.0 s

Reported on an M1 MacBook Air's built-in microphone: the first ~3 seconds of every dictation were
missing, and the waveform barely moved during them. It did not reproduce on Windows or on the Mac
mini's USB mic, so it is probably device-class dependent (unverified).

Measured with a constant 440 Hz tone through the speakers, three output volumes, two runs each:

| Output volume | 0–3.0 s | After 3.0 s | Gap |
|---|---|---|---|
| 25 | −66, −66 dB | −34, −33 dB | 32 dB |
| 50 | −58, −58 dB | −26, −25 dB | 32 dB |
| 90 | −47, −47 dB | −15, −16 dB | 31 dB |

The level during the window tracks the source, so the signal is attenuated, not muted. With the same
machine, microphone, tone and volume, native cpal/CoreAudio read about −17 dB with ~+24 dB SNR from
the first 500 ms, identically cold or warm, and `ffmpeg` via avfoundation showed a flat level from
t=0. Once WebKit recovers, its steady state matches native (−16/−17 dB, +21/22 dB SNR). The defect
is in WebKit's capture path, not the device.

Three plausible causes were tested directly and ruled out:

| Candidate | Test | Result |
|---|---|---|
| Qwen prewarm starving the process (it also takes ~3 s) | 531 ms prewarm vs 3105 ms prewarm | step still at exactly 3.0 s |
| Paint / JS stall | analyser ticks per 500 ms bucket | uniform 7–8 throughout |
| WebKit's resampler | forced the track to 48 kHz | step still at 3.0 s |

`AudioContext.state === "suspended"` looks like a second bug and isn't. The window is raised by the
Rust event tap, so no user gesture ever reaches the webview, and every recording logs
`ctx_state_before=suspended`. A build with `resume()` removed still got audio from ~8 ms with the same
envelope, because WebKit auto-starts a context that has a live capture source. `resume()` stays as
belt-and-braces. The giveaway was logical rather than instrumental: a context that never rendered
would stay silent, not recover cleanly at 3.0 s.

### How it stayed hidden for three months

`3eeec04` (2026-06-19, shipped in v1.3.0) removed warm-keep, the reuse of a recently used stream
whose comment said the cold start "is what drops the first words", and replaced it with a
launch-time prime. The investigation behind that commit measured `getUserMedia` call latency
(~150 ms cold, 18–28 ms settled). The call really does return quickly; it just hands back a quiet
track, which a latency probe can't see. The launch prime never ran either, because the input-prompt
page doesn't load until its window is first shown (no prime was logged in 35 s after a restart).
Before v1.3.0 only the first dictation per launch was affected, which is why older versions seemed
fine.

The first mitigation (`1a49a8a`) kept one WebKit stream open for the whole process. That fixed every
recording after the first, at the cost of a permanently lit microphone indicator and Bluetooth HFP.
Native capture removes both costs. The shared stream then lingered as the Windows/Linux path until
2026-09-14, when those platforms went back to one stream per dictation too.

Lessons that came out of this and an earlier investigation:

- Measure the quantity that matters (signal level over time, or SNR), not the easy one (how fast a
  promise resolves).
- Ask what behavior sits behind a report. The user had learned to wait three seconds before speaking,
  so "the transcript was complete" didn't mean the audio was.
- Rule out hardware early and don't trust a single sample. In a June 2026 "recording quality"
  investigation the culprit was a faulty microphone, found only when the user swapped mics, after a
  dropout detector had mistaken natural 30–90 ms word gaps for dropped frames. The 3.0 s finding above
  holds up because it compared WebKit and native capture on the same mic with a controlled tone.

## Why echo cancellation is off

On macOS, WebKit maps `echoCancellation: true` onto the VoiceProcessingIO audio unit, which
cold-starts in ~1–2 s on USB or external mics and emits silence meanwhile, so the first second or two
of speech was lost. Built-in laptop mics hide this because that voice path is pre-warmed. WebKit
supports only `echoCancellation`: `getSupportedConstraints()` reports `noiseSuppression` and
`autoGainControl` as false and `getSettings()` as undefined, so NS/AGC were never active on macOS.
Turning EC off dropped getUserMedia plus first audio from ~1100 ms to ~180 ms with no quality change.
Dictation has no echo source, so EC was never useful.

| Engine | Used by | EC cost | NS / AGC |
|---|---|---|---|
| WebKit (macOS) | WKWebView, Safari | ~1–2 s (VoiceProcessingIO) | unsupported |
| Chromium | Windows WebView2, Chrome, Electron | ~65 ms (software AEC3) | supported, ~0 ms |

## Decision: no noise suppression, AGC or pre-denoising

Researched 2026-06-22. Processing audio before a modern ASR model is neutral to harmful:

- End-to-end models learned noise and level robustness. Whisper trained on 680k hours of noisy audio
  and normalizes its input level, so external AGC is largely redundant, and OpenAI positions its
  transcribe models for noisy backgrounds.
- *When De-noising Hurts* ([arXiv 2512.17562](https://arxiv.org/abs/2512.17562)) found speech
  enhancement degraded ASR in all 40 configurations (4 models × 10 noise conditions), by +1.1 to
  +46.6% absolute semWER, with a penalty even on clean audio; Whisper was the most sensitive
  ([arXiv 2603.04710](https://arxiv.org/html/2603.04710v1)). The causes are denoiser artifacts, a
  mismatch with the training distribution, and removal of cues the model relies on.
- So WebKit's missing NS/AGC was never a real deficiency, and it was not a reason to consider Electron.

If a measured quality problem ever shows up in noisy or far-field conditions, first feed the same clip
raw and processed through the actual model and compare. The cheapest lever after that would be
RNNoise in an AudioWorklet (`@jitsi/rnnoise-wasm`) or Rust `nnnoiseless`; the full WebRTC processing
stack is much heavier.

## Diagnostics

Three log lines on the `typealoud_lifecycle` target survive release-level filtering:

```bash
grep -aE "audio-capture|audio-onset|audio-envelope" ~/Library/Logs/com.tao.typealoud/TypeAloud.log | tail
```

- `audio-capture`: device, `getSettings()`, AudioContext state and `mic_ms`, how long opening the
  microphone took.
- `audio-onset`: blocks, `captured_ms` vs `hold_ms`, and first non-zero / first signal / first speech,
  all on the audio timeline so main-thread jank can't smear them.
- `audio-envelope`: per-500 ms RMS (`env_db`), per-bucket SNR against a 440 Hz tone (`snr_db`),
  analyser ticks (`frames`), and `clipped` / `clipped_pct`. `snr_db` only means something while a
  440 Hz tone is playing.

`probe_native_capture` exercises the native path directly. A recording can be driven without a human
by posting `flagsChanged` CGEvents for Ctrl+Shift, as long as the app's event tap is alive. An
ad-hoc-signed local build silently loses the Accessibility grant; `CGGetEventTapList` shows whether
TypeAloud's tap exists. For per-session lifecycle counts, use the offline report described in
[RELIABILITY_ACCEPTANCE.md](RELIABILITY_ACCEPTANCE.md).

## Open items

- **Clipping is unmeasured.** On the M1 the user's speech recordings peaked above full scale
  (1.23 to 5.05) with macOS input volume at 100, and cpal showed a peak of 1.38 on a synthetic source
  too, so this is input gain rather than the capture API. `encodeWavPcm16` hard-clips at ±1; check
  what the native conversion does before changing anything. Scaling by `1/peak` before quantization
  would be lossless linear scaling, not the kind of processing rejected above. No real `clipped_pct`
  numbers from speech have been collected.
- Whether the 3.0 s window exists on other Macs and input devices. Everything was measured on one M1
  built-in mic.
- Left open by the handover: whether chunking should move into Rust now that PCM originates there
  (shipping PCM to the frontend only to send chunks back is a round trip, chosen to minimize
  disruption), and whether `cpal` or a thin CoreAudio binding is the better long-term dependency.
- After capture changes, re-run the real-device gate: speak immediately after pressing, check first
  words, live waveform, final insertion, indicator shutdown and Bluetooth playback recovery (cases
  R01 and R06 in RELIABILITY_ACCEPTANCE.md).
- Windows first words with one stream per dictation (since 2026-09-14): not yet measured on a real
  machine.

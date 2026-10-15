# Local ASR

Reference for TypeAloud's on-device transcription, checked against `a183354` (1.15.1) on
2026-09-11. It replaces four older documents that now live only in git history: the Qwen3-ASR
design (2026-07-12), the long-audio chunking design (2026-07-22), the `--no-warmup` macOS TODO
and the MLX evaluation (2026-07-30).

`AGENTS.md` lists the rules an edit to `local_asr.rs` must not break; this file keeps the reasons
and the measurements. The upstream worker-reuse bug is written up in
[`vendor/llama.cpp/README.md`](../vendor/llama.cpp/README.md).

## Engines

| Engine | Model id | Runtime | Platforms | Role |
|---|---|---|---|---|
| Qwen3-ASR 0.6B Q8_0 | `qwen3-asr-0.6b-q8_0` | upstream llama.cpp `b9960`, `llama-mtmd-cli` | macOS (Metal); Windows x64 and Linux x64 on CPU, optional Vulkan on Windows | Default, recommended |
| Qwen3-ASR 1.7B Q8_0 | `qwen3-asr-1.7b-q8_0` | same | same | Experimental since 1.15.0. About 2.52 GB to download, about 2.9 GB peak process memory measured on an M4 / 24 GB |
| Nemotron 3.5 streaming 0.6B Q8_0 | `nemotron-3.5-asr-streaming-0.6b-q8_0` | NVIDIA `nemo-speech` 0.1.0 sidecar (`nemotron_asr.rs`) | macOS arm64 (Metal), Windows x64 (CPU); unavailable elsewhere | Text appears while speaking; noticeably less accurate |

Local engineering effort goes into Qwen. In the maintainer's own use Nemotron's accuracy was not
acceptable as a main engine, so it stays available but is not treated as the answer to Qwen's
latency.

### 0.6B vs 1.7B speed and memory

Measured 2026-09-10 on an M4 / 24 GB with the production resident-worker arguments
(`--no-warmup --fit off -c 2048`). Each trial started a fresh worker, then sent `/clear`, the audio
and `a`; five repeats per model per clip, alternating model order. The long clip is five
recordings joined together, not one continuous utterance.

| Clip | Model | Load (median) | Transcribe (median) | Peak RSS |
|---|---|---|---|---|
| 6.13 s | 0.6B | 0.68 s | 0.30 s | 1.39 GB |
| 6.13 s | 1.7B | 0.99 s | 0.71 s | 2.89 GB |
| 30.55 s | 0.6B | 0.71 s | 0.96 s | 1.38 GB |
| 30.55 s | 1.7B | 1.11 s | 2.07 s | 2.89 GB |

1.7B takes a little over twice as long to transcribe and 0.3–0.4 s longer to load. Transcribe time
excludes the load, neither figure includes capture, VAD, IPC or insertion, and in the app the
prewarm overlaps the load with speech. RSS counts the file-backed model pages. Whether 1.7B is
more accurate on real dictation has not been measured.

## Hardware tiers and fresh defaults

The fresh-install policy uses a cached hardware profile, not a runtime benchmark.
`hardware::tier_for` is pure; `settings::fresh_config_for` applies its result only when the config
file does not exist. Existing configs and serde defaults retain their compatibility behavior.

| Profile | Tier | Fresh engine / onboarding placement |
|---|---|---|
| Known memory below 8 GiB or fewer than 4 logical cores | `cloud-default` | OpenAI `gpt-transcribe`; 0.6B remains available with a speed warning |
| Everything else | `qwen` | Qwen 0.6B |
| Hardware detection fails | `qwen` | 0.6B; failure never selects cloud by itself |

Onboarding never offers 1.7B; first run only chooses local or cloud. Groq and supported Nemotron
builds sit under "more" in onboarding, Home and Settings.

## Suggesting 1.7B from measured speed

Until 2026-09-25 the 1.7B placement came from the chip name (Apple M4 with 16 GiB offered it, M5 put
it forward). That was a guess, and it said nothing about Windows, where CPU, integrated and discrete
GPUs differ by an order of magnitude. Settings now suggests 1.7B from this machine's own dictations:

- `local_speed.rs` keeps the last 20 resident decodes per Qwen model as decode seconds per second of
  audio (clips under 2 s are skipped), in `local-speed.json` in the app data dir. Only timings.
- 1.7B is estimated at 2.2x the 0.6B time, from the M4 measurements above (2.16x on the 30.55 s
  clip, 2.37x on the 6.13 s one). The factor is unmeasured on other runtimes.
- After at least 10 samples, if 1.7B would answer a 15-second sentence within 1.5 s, the Qwen drawer
  suggests it. On an M4 (0.6B at 0.031 s per second of audio) the estimate is about 1.0 s; on the
  Windows i5-7400 CPU (about 0.4) it is about 13 s, so no suggestion.
- Once 1.7B is in use, its own samples decide: 5 samples above 3 s for 15 s of speech suggest going
  back to 0.6B.
- "Download 1.7B" keeps 0.6B working during the download and switches when it finishes, unless the
  engine was changed meanwhile (`download_local_model`'s `switch_when_ready`).

## Why a llama.cpp subprocess

Decided 2026-07-13 after two rounds of measurement on the maintainer's machines.

| Candidate | Outcome |
|---|---|
| llama.cpp subprocess, official `ggml-org/Qwen3-ASR-*-GGUF` | **Chosen.** On an M4: Metal decode RTF 0.05–0.18, peak RSS about 1.34 GB and flat, no slowdown with the CPU saturated. Cancelling means killing the child. |
| sherpa-onnx in-process, int8 | Rejected. Quality matched, but CPU-only: RTF about 0.30, 2.1 GB decode peak, 1.6 GB resident that TypeAloud would have to unload itself, and it degraded badly when the machine was busy. |
| antirez/qwen-asr (C + BLAS) | Rejected: BF16 only, 2.77 GiB static memory, no Windows. |
| second-state/qwen3_asr_rs | Rejected: libtorch/MLX underneath, very large dynamic libraries to ship. |
| MLX via `mlx-audio` (evaluated 2026-07-30) | Not adopted. It needs a Python/MLX runtime and separate weights, since the GGUF files can't be loaded. Bar for revisiting: at least 20% faster than the llama.cpp worker on both warm decode and first partial, no quality loss, idle memory actually released, no orphan workers, and only as an optional macOS backend that leaves the ~1 GB default download alone. |
| Native Swift rewrite | Rejected. The Metal speed comes from llama.cpp, not from the host language. |

Every platform runs the same code path; only the downloaded archive differs. llama.cpp must be at
least `b9173`, which fixed a Qwen3-ASR repetition loop (llama.cpp #22357). TypeAloud pins `b9960`,
and an upgrade needs a regression pass.

Quality notes from the original comparison (M4, 2026-07-12/13): on clean speech Q8_0 matched sherpa
int8 (a 60 s passage fully correct with 23 punctuation marks, where Groq Whisper produced none). On
hard audio the error patterns differed, e.g. an occasional homophone swap (轮胎 → 轮台). Five
seconds or more of digital silence or white noise returned empty text, and real room-noise silence
was clean at every duration, but 2 s or less of pure digital silence hallucinated "嗯。". The VAD
gate drops no-speech clips on the whole-clip path; the chunked path relies on Qwen's empty output,
except for a short final remainder (below).

The spike and benchmark reports from that period were local working files, never committed, and
have since been discarded. The figures in this section are what was kept from them.

## Assets and runtime

- Nothing ships in the installer. Assets download on demand into `<app-data>/local-asr/`. For 0.6B
  that is `Qwen3-ASR-0.6B-Q8_0.gguf` (804,749,248 B) plus `mmproj-Qwen3-ASR-0.6B-Q8_0.gguf`
  (214,392,480 B), about 972 MB, plus the llama.cpp archive. The official repo has no Q4 variant.
- Downloads resume with HTTP Range, keep the `.part` file on cancel, and are sha256-checked. The app
  fetches the archive itself, so there is no quarantine attribute and Gatekeeper never prompts.
- The extracted runtime is stamped with its archive's sha256
  (`bin/<LLAMA_BUILD>/.typealoud-runtime-sha256`) and re-extracted on mismatch. A CLI being present
  says nothing about which archive produced it.
- Assets are separated by canonical model id, and model identity is part of worker reuse, so
  switching between 0.6B and 1.7B never reuses the other model's worker.
- `SettingsPayload.engine_ready` reports availability independently of selection. For local engines,
  missing assets produce `engine_blocker = "local-model-missing"`; selecting that engine is still allowed.
- TypeAloud briefly built its own patched llama.cpp. The private builds shipped link and CPU-variant
  defects that upstream's packs don't have, so it went back to upstream; see
  `vendor/llama.cpp/README.md`.

## Invocation rules

- **An explicit `-c` is mandatory.** Without it the model metadata's ctx of 65536 preallocates about
  7 GiB of KV cache (RSS 8.2 GB). `ctx_size_for_wav` computes `seconds × 20 + 512`, clamped to
  [2048, 16384]. The old fixed `-c 2048` failed past roughly 2 minutes of audio, with
  `failed to decode audio`, or `failed to decode token` when the audio fit but audio plus text did not.
- **`-p "a"` is mandatory.** An empty prompt drops the CLI into interactive mode, where it hangs.
  Otherwise the prompt is ignored: four very different prompts produced byte-identical output. So
  there is no `condition_on_previous_text` equivalent and no way to carry context between chunks.
- `--fit off` skips repeated device fitting. `--no-warmup` skips llama.cpp's dummy warmup; on a
  Windows i5-7400 a 3.2 s clip went from 5.40 s to 4.62 s. Both flags are passed on the resident and
  the one-shot path.
- Output looks like `language <lang><asr_text>…`; `parse_mtmd_output` strips the prefix. Silence
  gives empty text.
- Input must be 16 kHz mono PCM16 WAV, because mtmd's miniaudio decoder can't read AAC/m4a. macOS
  native capture already produces that; on the WebKit path `vad-gate.js` encodes it
  (`forceWav` / `encodeFullWav`). Anything else is an explicit error.

## Worker lifecycle

- **Prewarm under speech.** Once a hotkey hold outlasts the 500 ms mis-trigger probation
  (`QWEN_PREWARM_PROBATION_MS`), the frontend requests a chat-mode worker, so the model loads while
  the user is still talking. On a Windows i5-7400 the load is 2.7 s warm / 6.0 s cold, and a 9 s
  clip went from 6.3 s one-shot to 3.9 s prewarmed. On an M4, the same 6.13 s WAV five times gave a
  fresh-process median of 559 ms against a resident decode median of 255 ms. An M1's fresh-process
  load was about 0.99 s and has not been re-measured with the current implementation.
- **A lease lasts one uninterrupted hotkey hold** (`session_id`, minted by the frontend as
  `++recordingSessionId`). The worker can serve every chunk of that recording but is never handed to
  another dictation: `session_reuse_miss` refuses on a mismatched id, a finished session or an
  unowned decode. `finish_qwen_worker_session` ends the lease and kills the process.
  `PREWARM_IDLE_TIMEOUT` (80 s, longer than the 75 s hard chunk cut) only guards against a lease that
  never gets closed.
- **One inference at a time.** `LOCAL_INFERENCE` is a one-permit semaphore shared by prewarm and
  decode, so two ~1.3 GB workers never exist at once.
- **Reuse is a speed bet, not a correctness risk.** Upstream leaves an mtmd media batch on the chat
  context, so a second decode can be handed the previous audio's embedding; on Windows with stock
  `b9960`, every decode after the first returned the previous transcript. `repeats_previous` rejects
  a verbatim repeat, logs `POLLUTION DETECTED`, retires the worker and re-runs one-shot, so a wrong
  transcript is never inserted. If contamination turns out to be frequent, reuse is slower than
  retiring after every decode. `real_reuse_contamination_rate` (`#[ignore]`, needs real assets and
  two clips of different speech) measures it; it has not been run at real chunk cadence.
- **Deadlines.** First output byte within `15 s + 0.1 s per audio second` (`first_byte_deadline`),
  plus a stall check once output has started (`stall_check`); 180 s per attempt
  (`TRANSCRIBE_TIMEOUT`); 420 s for the whole native request including queueing, startup, fallback
  and exit (`PIPELINE_TIMEOUT`); 30 s for prewarm. A hung decode is retried once automatically; what
  happens after that is in [dictation-recovery.md](dictation-recovery.md).
- Cancel means kill (`kill_on_drop`). A chat-protocol error or timeout throws the worker away and
  retries through the one-shot `--audio … -p "a"` path.

## Partial text is progress, not streaming

stdout is pumped incrementally rather than with `wait_with_output()`, because the CLI prints the
transcript token by token. `transcribe_wav` forwards the text so far as
`local-transcription-partial { sessionId, chunkIndex, text }`, throttled to 100 ms. Both pipes must
be drained concurrently or the child blocks on a full one.

This only makes progress visible. Qwen3-ASR is an encoder-decoder, so the whole clip is encoded
before token 1: the first byte arrived 2.4 s into a 6.5 s decode of an 82 s clip, and 7.7 s into
31.7 s for a 5.5-minute one. Total latency and peak memory are unchanged, and since `-p` is ignored
no prompt trick changes that. True streaming was evaluated and rejected for the same reason.

## Long dictation: chunking during recording

### The problem

Decoding a whole clip, measured 2026-07-22 on Metal:

| Audio | ctx | Peak RSS | Decode |
|---|---|---|---|
| 60 s | 2048 | 1284 MiB | 2.4 s |
| 5 min | 6512 | ~2.0 GiB | ~7 s |
| ~13 min | 16384 (cap) | ~3.1 GiB | ~27 s |
| 25 min | 16384 (cap) | ~3.4 GiB | **fails**: `Unable to decode media chunk` |

Memory never runs away, because the ctx cap bounds it. The real problems were a correctness cliff
past roughly 13 minutes of speech, where the whole dictation was lost, and doing all the decoding
after release (much worse on CPU, where the 180 s timeout used to hit at around 10 minutes of
audio). Qwen does not segment internally.

### How it works (implemented 2026-08-29)

- PCM captured during recording is cut into chunks of 20–75 s (`chunk-decision.mjs`:
  `EARLY_TARGET_S = 20`, `SOFT_TARGET_S = 55`, `HARD_MAX_S = 75`). From 20 s on, a long enough
  pause closes the chunk: consecutive audio at or below `loudRef × QUIET_RATIO` lasting
  `EARLY_PAUSE_S` (1.0 s) at 20 s, shrinking linearly to `MIN_PAUSE_S` (100 ms) at 55 s. If no
  pause arrives by 75 s, the cut goes after the quietest 100 ms stretch of the 55–75 s window. Both are
  measured in samples, because capture blocks are 40 ms on macOS but ~2.7 ms on the WebKit path,
  where one quiet block (the closure of a stop consonant) used to count as a pause. `loudRef`
  resets after each cut, so the rule behaves the same at any mic gain.
- Cut points use RMS energy, not Silero. Picking the quietest frame in a 60-second window is a
  different job from sentence-level VAD cutting, which was rejected because the maintainer pauses
  mid-sentence to pick words. Here a bad seam costs one seam's punctuation, and the audio on both
  sides is still transcribed.
- Each closed chunk becomes a 16 kHz mono WAV. macOS native capture already delivers 16 kHz PCM16;
  on the WebKit path the chunk is resampled from hardware-rate Float32 with `OfflineAudioContext`.
- Chunks decode one at a time through the session's worker, over the existing `transcribe-audio`
  raw-body IPC with `session-id`, `chunk-index` and the required `session-provider` headers.
  The provider is captured at recording start and retained across retries; missing or invalid
  providers are rejected rather than falling back to a cloud engine. The floating window shows finalized
  chunks plus the live partial of the chunk in flight.
- On release: flush the remainder as the final chunk, drain the queue, join the texts, insert once,
  save one History row. The joiner adds no space when either side of a seam is CJK/full-width, and
  one space between Latin chunks.
- The post-release VAD gate is skipped on this path. Its trimming exists for Whisper's silence
  boilerplate, a cloud problem; Qwen returns empty text for silence.
- One exception: when a cut happened during recording and the final remainder is 3 s or shorter,
  Silero checks it first (`remainderIsSilent`, `TypeAloudVadGate.hasSpeech`) and a remainder without
  speech is dropped instead of decoded. A cut shortly before release can leave only the pause's
  tail, and Qwen turned such 0.02–0.5 s remainders into "嗯。" or "no." in an offline A/B on
  synthesized Chinese (2026-09-30). There Silero dropped all 39 silent remainders, kept every
  remainder with speech, and detected all 48 isolated short answers (186–808 ms, "对"/"不"/"好的").
  It costs ~10 ms per second of audio. Any VAD failure or a verdict slower than 1.5 s decodes the
  remainder as before.
- Cancel stops dispatching chunks, kills the in-flight decode, clears the queue and discards
  partials. One chunk failing does not abort the session.

### Why 75 s

Worker reuse requires an identical ctx, and only clips up to 76.8 s land on the 2048 floor, so a
75 s cap keeps every chunk on one worker. The floor itself holds more. Measured with the app's exact
arguments on trimmed Chinese TTS:

| Speech rate | Last success | First failure | Error |
|---|---|---|---|
| 4.4 chars/s (normal dictation) | 125 s | 135 s | `failed to decode token` |
| 9.3 chars/s (far faster than anyone dictates) | 105 s | 110 s | `failed to decode token` |
| 4.4 chars/s | — | 160 s | `failed to decode audio` |

Audio costs a fixed ~15 tokens per second whatever is said, which gives a content-independent
ceiling of 2048 / 15 ≈ 136 s. Transcript tokens depend on the content, which is why the real cliff
moves with speech rate. So 75 s leaves 1.4× margin against the fastest case measured and 1.7×
against normal dictation, and pauses add only audio tokens. The one uncovered case is a degenerate
repetition loop, which chunking confines to a single chunk.

### Evidence so far

- On the maintainer's machine, about a minute into a real dictation the window showed decoded
  earlier text while capture continued, so the first cut, mid-recording decode, rendering and
  uninterrupted capture all worked end to end.
- Controlled seam A/B on an M4: a 738-word English script synthesized to 272.47 s was cut into five
  chunks (55.157, 55.000, 55.115, 55.029, 52.172 s), all at quiet frames. Whole clip at ctx 5961:
  WER 1.47%, 15.85 s wall time including process start. Five chunks on one ctx-2048 worker: WER
  1.20%, 11.37 s decode plus 0.42 s prewarm, last chunk 2.18 s. All four seams kept the words in
  order with nothing lost or duplicated. The slightly lower chunked WER is normal variation, not an
  improvement.
- Early cuts (2026-10-12). Before them nothing was cut until 55 s, so in ~550 logged dictations
  on the maintainer's machine (1.7B) a 30–60 s hold waited 3.3 s after release at the median
  (4.9 s at p90), longer than a hold past 60 s (2.4 s); decode costs about 85 ms per second of
  the last chunk. Replayed on 60 archived real clips of 30–62 s (`debugSaveAudio`), cutting from
  20 s takes the last chunk of a 30–45 s clip from 36.5 s to 11.0 s at the median (41 s to 21 s at
  p90), an estimated 3.4 s to 1.2 s of waiting. Whole clip against chunks, 1.7B one-shot, punctuation
  ignored: with a 0.5 s early pause 98 cuts changed 0.88% of characters, with 1.0 s 79 cuts changed
  0.64%, with 1.5 s 72 cuts changed 0.64%. The changes go both ways (a name fixed in one clip,
  garbled in another) and there is no ground truth, so this measures disturbance, not error rate.
  0.5 s barely selects anything: the clips are 43% quiet frames with about 15 pauses of 0.5 s per
  minute, and 16 of 60 were already inside one on reaching 20 s.
- The same replay showed a silent remainder longer than the 3 s VAD limit: holding the key for
  ~9 s of silence after a cut made Qwen emit a 22–57 character Spanish sentence. A release
  remainder is now also VAD-checked, whatever its length, when under 0.3 s of it is louder than
  the previous chunk's pause level (`REMAINDER_QUIET_LOUD_S`); in the replay silent remainders
  measured ≤ 0.04 s and spoken ones ≥ 0.44 s. The VAD verdict still decides, and fails open.
- Not yet verified: real multi-minute microphone dictation, seam punctuation, release-tail p50/p95,
  and whether the old 13-minute cliff is gone on real speech.

## GPU on Windows

GPU is a packaging choice, not a flag (`AppConfig.local_compute`: `auto` | `cpu` | `gpu`,
Settings → Transcription, Qwen only). `b9960` defaults `-ngl` to `auto` and offloads every layer by
itself, so the backend is decided by the archive the process starts from. The required pack is
upstream's `win-cpu-x64`; choosing GPU downloads `win-vulkan-x64` (32.9 MB) into
`bin/<LLAMA_BUILD>-vulkan/` beside it. Vulkan covers NVIDIA, AMD and Intel in 32.9 MB, where CUDA
13.3 plus cudart is 553 MB for NVIDIA alone. macOS has no GPU row because upstream's macOS packs
already use Metal. Linux would need its own verified pack.

`auto` resolves to CPU on purpose. The only signal available without a new platform dependency is
`--list-devices`, which reports an integrated GPU's shared system memory as if it were VRAM (an
Intel HD 630 lists 12 GiB), so a memory threshold would choose the GPU on exactly the hardware
where it loses. On the i5-7400 + HD 630, 19.5 s clip, alternating and both primed, n=10 each: CPU
median 7.92 s, Vulkan median 15.12 s, all 20 transcripts byte-identical, spreads 0.87 s and 0.67 s.
The heavy CPU tail once recorded against TypeAloud's own single-variant build does not reproduce on
upstream's per-arch pack. Changing the default needs numbers from discrete GPUs.

A GPU worker that fails to start or dies mid-decode sets `GPU_DISABLED` for the process
(`disable_gpu_for_process`), and the same recording retries on CPU. A parked worker whose backend no
longer matches is rejected as `runtime_mismatch`. An installed pack that lists no device is shown in
Settings instead of silently running on CPU. Each runtime directory has its own sha256 stamp, so the
pre-1.12 manual `bin/b9960-vulkan` extraction (unstamped) is reinstalled rather than trusted.

## Limits

- Qwen takes no language parameter (it auto-detects) and has no dictionary channel. Nemotron's batch
  and live requests carry the saved `language` (empty means `auto`). Settings enables language
  selection for Nemotron and cloud engines, and disables it only for Qwen; whether Nemotron
  follows the parameter hasn't been checked.
  The dictionary's words reach cloud providers as a prompt. For every engine, local ones included,
  `terms.rs` corrects the final text against those words and a built-in list when a heard form is
  nearly the term, and the automatic replacements apply as well.
- The CPU paths on Windows and Linux are not verified end to end on real machines.

## Open measurements

- `real_reuse_contamination_rate` at real chunk cadence, which decides whether in-session reuse pays.
- `--no-warmup` on Apple Silicon. It is passed on every platform, but the A/B was only run on
  Windows, back when every dictation started a fresh process; with prewarmed workers the saving may
  be smaller. A fair Mac test: same machine, `b9960`, 0.6B Q8_0, three fixed WAVs (3–5 s, ~30 s,
  60–90 s), each configuration at least 5 times in alternating order, cold and warm separately,
  recording total time, first partial, peak RSS, output equality and any Metal/GGML errors, plus 20
  consecutive short dictations. Keep it on macOS only if the short-clip median improves by at least
  5% or 100 ms with no regression; otherwise gate it to Windows with `#[cfg(target_os = "windows")]`.
- M1 fresh-process load with the current implementation.
- Discrete-GPU numbers before `auto` could ever mean GPU.
- 1.7B accuracy on real dictation, and its end-to-end latency (the benchmark above covers only the
  engine).

# The llama.cpp reset patch — kept as a record, no longer built

TypeAloud downloads the official llama.cpp `b12651` archives. Neither this
patch nor a private engine is built or included in the installer.
[Upstream PR #31165](https://github.com/ggml-org/llama.cpp/pull/31165)
fixed the batch lifetime described below; the fix is in the pinned build.

## The bug

`llama-mtmd-cli` stores `mtmd::batch_ptr` on the long-lived chat context while
the chunks that batch references belong to one `eval_message()` call. After the
call returns, the batch can retain dangling chunk pointers, and a later audio
request may reuse the same address and receive the previous audio's embedding.

Measured on Windows against stock `b9960`, feeding one process alternating clips
with `/clear` between them exactly as TypeAloud does:

- every decode after the first returned the **previous** clip's transcript;
- the process aborted on the third with `0xC0000409`
  (`STATUS_STACK_BUFFER_OVERRUN` — memory corruption caught by /GS).

`/clear` does not help: upstream's implementation does not reset media state.

## Why TypeAloud no longer patches around it

The patch made the media batch request-local and expanded `/clear` to reset
queued media, sampler state, pending content, chat history, and model memory.
It worked. Building it did not.

A private runtime meant reproducing distribution work upstream had already done,
and each omission shipped as a defect: an OpenSSL link inherited from the build
machine (broke Windows on release, and had silently broken macOS for anyone
without homebrew's `openssl@3`), an OpenMP runtime imported but not shipped, and
a single CPU variant compiled for whatever the CI runner happened to support —
one build required AVX-512 and would not start on the development machine.
Upstream's packs carry per-arch CPU dispatch, a bundled OpenMP runtime, and no
stray links.

The larger win never needed the patch. Starting a worker at shortcut-down puts
the model load *under* the user's speech instead of after it — about 2.7 s on a
Windows i5-7400, 0.2–0.33 s on an M4 — and prewarming is safe on stock `b9960`
because a prewarmed worker's first decode is still the only audio that process
has seen. That alone was not worth a private native build.

## Where reuse stands now

A worker can serve multiple chunks of the same recording, never a different
recording. The upstream fix keeps the media batch local to a single request.
On the old build, the repeated-text guard could reject the previous clip's
transcript and retry, but it could not prevent the engine itself from aborting.
See [TypeAloud PR #23](https://github.com/hellotaotao/typealoud/pull/23)
for the Windows CPU/Vulkan comparison.

Keep the different-speech regression when changing the engine again:

```
TYPEALOUD_TEST_WAV_A=a.wav TYPEALOUD_TEST_WAV_B=b.wav \
  cargo test real_reuse_contamination_rate -- --ignored --nocapture
```

Inspect the printed counts as well as the exit status: the test checks that
stale text is never accepted, but a decode recovered by starting a new worker
still counts as a failed reuse.

## If it is ever revisited

`git log -- vendor/llama.cpp scripts/build-patched-llama.mjs` has the whole
pipeline: the build script with its relocatability and self-contained-import
guards, the `runtime.json` build manifest, and the CI job. Any revival should start from upstream's CMake configuration
rather than a hand-picked subset — `GGML_BACKEND_DL=ON`,
`GGML_CPU_ALL_VARIANTS=ON`, bundled libomp — since every defect above came from
diverging from it.

`0001-reset-per-audio-state.patch` applies to
`a935fbffe1a3d31509c325c116454ab5d56b2eb8` (`b9960`).

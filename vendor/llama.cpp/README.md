# The llama.cpp reset patch — kept as a record, no longer built

TypeAloud ships **upstream's own llama.cpp `b9960` releases** on every platform.
Nothing here is built or bundled. The patch and this note stay because the bug
they describe is real, still present upstream, and TypeAloud now reuses a worker
across the chunks of one recording session — so the measurement below is the
thing that decides whether that reuse is a win.

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

TypeAloud no longer retires the worker after every decode: it is leased to one
recording session and serves that session's chunks, which saves a model load per
chunk on a long dictation. That deliberately runs into the bug above, so the
guard is `repeats_previous` in `local_asr.rs` — a decode returning the previous
transcript verbatim is rejected, the worker is destroyed, and the chunk is
re-decoded one-shot. **A wrong transcript is never inserted**; what the bug costs
is time.

Whether the trade pays depends entirely on the contamination *rate*, and the
measurement above (every decode after the first) was taken with alternating
clips back-to-back, not at TypeAloud's real chunk cadence. If it still holds at
that cadence, reuse is a net loss: each reused chunk pays a rejected decode plus
a cold one-shot, where retiring after each decode paid one hidden load.

`real_reuse_contamination_rate` in `local_asr.rs` measures it — `#[ignore]`d,
needs the real assets plus two clips of different speech:

```
TYPEALOUD_TEST_WAV_A=a.wav TYPEALOUD_TEST_WAV_B=b.wav \
  cargo test real_reuse_contamination_rate -- --ignored --nocapture
```

It prints the rate and stays green either way; the invariant it asserts is that
a contaminated decode is never accepted. Note that the `0xC0000409` abort on the
third decode is out of reach in production: contamination is caught on the second
and the worker dies before a third.

## If it is ever revisited

`git log -- vendor/llama.cpp scripts/build-patched-llama.mjs` has the whole
pipeline: the build script with its relocatability and self-contained-import
guards, the `runtime.json` build manifest, and the CI job. Any revival should start from upstream's CMake configuration
rather than a hand-picked subset — `GGML_BACKEND_DL=ON`,
`GGML_CPU_ALL_VARIANTS=ON`, bundled libomp — since every defect above came from
diverging from it.

`0001-reset-per-audio-state.patch` applies to
`a935fbffe1a3d31509c325c116454ab5d56b2eb8` (`b9960`).

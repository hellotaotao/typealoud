# Dictation lifecycle and recovery

What happens to a dictation that fails, stalls or is cancelled, checked against `a183354` (1.15.1)
on 2026-09-11. It combines the recovery rules that used to sit inside `CLAUDE.md`'s `commands.rs`
entry with the 1.9.1 finalization contract (`docs/superpowers/plans/2026-08-30-dictation-finalization.md`,
now only in git history).

The promise behind all of it: a failure is visible, and whatever was captured or recognized is kept
somewhere the user can retry or copy it. How to test this on real devices is in
[RELIABILITY_ACCEPTANCE.md](RELIABILITY_ACCEPTANCE.md).

## Session completion and cancellation

- Each recording session owns its microphone resources, lifecycle state, stop timers and a single
  finalization promise. Recorder completion is separate from transcription completion, and duplicate
  or late events cannot insert the same dictation twice.
- Chunked and live paths finalize as soon as release closes their PCM queues. On the WebKit path they
  don't wait for the `MediaRecorder` blob or its stop event; a separate 2 s watch
  (`RECORDER_STOP_TIMEOUT_MS`) only logs a missing stop callback.
- WebKit batch recordings log a warning at 2 s and keep waiting until a 15 s hard deadline
  (`BATCH_RECORDER_STOP_TIMEOUT_MS`). A hard timeout releases the FIFO slot and reports failure. If a
  complete local recording arrives later, it is encoded to 16 kHz WAV and saved to
  pending History for manual retry; it is never inserted automatically and never repaints a newer
  session.
- Escape during activity cancels the selected recording or the latest transcription without
  discarding older valid work. Escape on an idle recovery card only dismisses the card; text awaiting
  persistence is kept.
- Insertion is irreversible once dispatched. Only the real reply releases the insertion FIFO, and no
  JavaScript timeout may let a later insertion overtake it. There is no clipboard fallback: a failed
  insert shows a Copy button and the text stays in History. While that card shows, clicking the
  target field and tapping the hotkey re-inserts the card's text through `type_text`. That tap skips
  macOS's focused-element guard, because the user chose the target and the guard can't see into apps
  that draw their own text; a second failure brings the same card back.

## Final text formatting

- Complete batch results, assembled chunked results, Nemotron live finals and History retries use
  the same final-text formatter before saving. History and normal insertion receive its returned
  text. Individual chunks and live previews are not formatted: they keep fillers and letter
  spacing.
- Settings has a common "Merge spelled-out letters" toggle (`mergeSpelledLetters`), enabled by
  default for new and existing configurations. Disabling it preserves letter spacing without
  disabling the existing hallucination filter.
- Independent ASCII letters separated only by ordinary spaces merge without a dictionary: two or
  more capitals (`A P I` becomes `API`), or three or more letters in any case (`c p p` becomes
  `cpp`), since the engine picks the case. Two letters with a lowercase one stay apart (`a b`,
  `I a`). Punctuation, tabs and line breaks interrupt the run;
  cleanup and chunk joining preserve these separators. Incomplete recovery keeps its existing
  preservation path rather than treating partial text as a successful final.
- Settings has a "Remove filler words" toggle (`removeFillerWords`), enabled by default. It runs
  before letter merging and removes 嗯, 呃 and a standalone 额 with the pause marks around them
  (`觉得，呃，我们` becomes `觉得，我们`), except inside quotation marks, where speech is quoted
  verbatim. A result that was only fillers becomes empty and is handled
  as no speech. Details in `src-tauri/src/filler.rs`.

## Failed transcriptions keep their audio

- `record_failed_transcription` writes **one** History row carrying both the reason and the clip
  (`pending: true`, `audioId`), never a text-only failure next to an audio-only
  placeholder. This runs in release builds, so recordings of failed dictations do land under
  `<app-data>`. A clip is released only when a retry produces text, when the row is deleted or
  cleared, or when it falls off the 200-entry `HISTORY_CAP`.
- Route resolution (`resolve_transcription_route`) is inside that net. A missing API key fails before
  any request is built, and it's exactly the kind of failure a user fixes and retries.
- Two cases are not recorded there because the frontend owns them: chunked dictation
  (`chunk_index.is_some()`), and a local `capture_incomplete` session
  (`preserveRecoveryAudio` runs before the request). Cloud capture-incomplete failures are
  saved by Rust, including route-resolution errors.
- A successful retry of incomplete cloud capture refreshes the pending reason to
  incomplete/no-speech and keeps the clip, while the frontend preserves the partial text.
- Incomplete and hang recovery use the provider snapshot taken when recording started
  (`session-provider`), so changing Settings mid-recording doesn't change which side owns recovery.
- A hung decode is handed to the frontend only for local-origin sessions
  (`frontend_owns_hang_recovery`), matching the frontend's gate `provider === "local"`.
  Gating on `is_hang_error` alone once made every cloud timeout vanish from History, with no row and
  no audio.

## Automatic retries share one row

- `transcribeWithRetry` retries a hung or timed-out upload once, and `isRetryableTranscriptionError`
  doesn't look at the provider, so cloud timeouts are re-uploaded too.
- Both attempts carry the same `failure-id` header (`failed-<millis>-<sessionId>`, validated by
  `valid_stable_recovery_id` because it becomes a filename). A second failure refreshes the first
  attempt's row. A second attempt that succeeds turns that row into the success in place
  (`history::record_transcription`) and only then drops the clip. Without the shared id, one recording
  left two rows and two clips, and a successful retry left the failure row orphaned next to its own
  text.
- The success path resolves or appends under one lock and one read, and builds debug audio only for a
  new row. Debug audio is written after the History lock is released and attached only if the row
  still exists; otherwise the clip is cleaned up.
- An empty retry result refreshes the reason to "No speech detected" and keeps the pending row and
  clip.
- An id whose row has already settled is never reused for a failure; a fresh id is minted. A late
  automatic success aimed at a settled row appends a new row, because its text is still returned for
  insertion and has to stay findable.

## Manual retry from History

- `retranscribe_pending` runs the clip through whichever engine is configured **now**, not the one
  that failed. The cause is usually a key, network or model the user has since fixed, and pinning the
  row to its original provider would lock the clip to the thing that broke.
- Every failure after loading the row goes through `refresh_failed_row`, so the stored reason never
  keeps blaming a cause the user already fixed. A toast doesn't survive closing the window.
- Success and failure both read the current row under the History lock and only update a row that is
  still pending, so a late manual retry can't overwrite an automatic retry's text, and a manual retry
  never overwrites a settled row. `history::finish_pending_transcription` keeps audio on empty text and
  deletes it only after saving non-empty text.
- Audio reads keep the I/O error kind. Only a confirmed `NotFound` clears `pending`, `audioId` and
  `audioMime`; any other read error leaves retry available. Detailed filesystem errors go to the log,
  and History and toasts get a path-free explanation.

## Retry error codes are a persisted format

Built-in retry errors are stored and returned as `RETRY_*` codes from the typed registry in
`retry_error.rs`. `RetryFailure` tells built-in codes apart from engine text without inspecting
prefixes, and `i18n.js` exports the bilingual renderer `main.js` uses. Because the codes live in
users' History files, keep old translations when retiring a code, and migrate stored rows before
renaming or reusing one. The Node contract test checks every registry code and an append-only
legacy-code fixture.

## Recovered text

- Only a failure belonging to the current session shows its Copy card, which auto-hides after 15 s. A
  newer successful dictation closes normally, and old recovery text never reopens the card. Hiding,
  Copy and idle Escape don't delete unacknowledged text; later recording or result events retry
  persistence in the background without blocking transcription or insertion.
- `save-recovered-transcription` accepts a strict `{id, text, kind}` payload from the input-prompt
  window: kind `incomplete` or `insert-failed`, a stable id, non-empty text capped at 1 MiB
  (`MAX_RECOVERED_TEXT_BYTES`), unknown fields rejected. A success response is a real History write
  acknowledgement and errors never become one. A late acknowledgement after a renderer timeout
  releases only the exact recovery object it belongs to.
- Text writes are idempotent under the History lock. Complete failed-insertion text can reuse the
  latest matching successful row instead of duplicating it; incomplete text is stored separately with
  `success: false`.
- Late local audio uses an optional stable `recovery-id` on `save-pending-transcription`, so retrying
  an unacknowledged save reuses the pending row and audio. Different bytes or MIME under the same id
  are rejected, and a failed History write rolls back its unreferenced audio.

## Deadlines

| What | Limit |
|---|---|
| Resampling / encoding (`AUDIO_STAGE_TIMEOUT_MS`) | 30 s |
| One transcription IPC call (`TRANSCRIPTION_STAGE_TIMEOUT_MS`) | 450 s |
| Best-effort History / recovery IPC (`HISTORY_STAGE_TIMEOUT_MS`) | 5 s |
| Native Qwen request end to end (`PIPELINE_TIMEOUT`) | 420 s |
| Qwen prewarm (`PREWARM_TIMEOUT`) | 30 s |
| One decode attempt (`TRANSCRIBE_TIMEOUT`) | 180 s, plus first-byte and stall watchdogs |

A healthy multi-chunk dictation drains serially with no aggregate deadline. Dropping a timed-out
native future releases its semaphore permit, child process and temporary WAV.

## Logging

Lifecycle logs use fixed phase/event labels plus numeric ids, counts and timings, never transcripts
or free-form renderer errors. Release builds enable this target at Info and everything else at Warn.
Log files rotate at 2 MB with two archives kept, about 6 MB in total. A timeout without a later
callback only shows that the frontend didn't observe the callback; it doesn't identify a root cause
by itself. `scripts/dictation-report.mjs` summarizes these lines offline without exporting content.

## Known gaps

- In-memory recovery doesn't survive quitting the app; recovery is durable only after a persistence
  acknowledgement.
- Cloud incomplete audio that never reaches `transcribe_audio`, or whose request succeeds,
  is held only in frontend memory (`routeDeferred`). Rust persists the clip only when the request
  fails. Partial text has its own acknowledged path (`preserveCompletedChunks`).
- Cloud audio that arrives after the hard recorder deadline stays in memory. It is neither
  persisted as raw audio nor silently sent through a possibly changed provider.
- If a pending row was already retranscribed manually, a stale retry of the original save returns an
  error instead of overwriting it.

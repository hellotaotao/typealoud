# Dictation reliability acceptance

Current priority and scope: [Product pathway](PRODUCT_PATHWAY.md).

## Evidence rules

- Record the commit/build, OS, hardware, microphone, engine/runtime, target app, test ID and result for every manual run.
- Use non-sensitive scripted speech containing distinct opening, middle and ending markers. Compare audio, transcript and actual target text separately. Model recognition mistakes are not automatically capture/queue defects.
- A successful API call, equal sample counts or a History entry does not prove complete recognition or target delivery.
- Mark each case PASS, FAIL, BLOCKED or NOT RUN. No inferred passes from another platform. Failure records include recovery behavior and whether the next dictation worked.
- Keep consented audio/text fixtures local and out of Git. Share only reviewed diagnostic summaries by default.

## Repeatable cases

| ID | Exercise | Acceptance |
| --- | --- | --- |
| R01 | Cold start, press and immediately speak a short marked sentence; repeat warm | Opening and ending audible in captured audio; compare recognition and actual insertion |
| R02 | Three rapid dictations while earlier decoding is pending | Each valid result handled once and in the intended order; no stale UI/state affecting the next run |
| R03 | Qwen speech beyond the current 55 s target and 75 s hard chunk boundary, with distinct tail markers; release mid-decode | All captured samples accounted for; tail markers compared against audio, History and target; no silent partial insertion on detected coverage error |
| R04 | Cancel during startup, recording and decoding separately | Cancel affects the intended active/latest task; earlier valid work is preserved; next dictation works |
| R05 | Idle for an hour, then dictate; sleep/wake and repeat | Usable first recording, no stuck capture/worker; correct final result |
| R06 | Change microphone; disconnect selected microphone during capture | Clear outcome; captured content recoverable where available; next valid device works |
| R07 | Repeat in daily browser editor, native editor and IDE; switch focus while decoding | Without a focus change, final text lands exactly once in the intended field. Current behavior targets the focused field at insertion time, not the recording-start field. Set that expectation before the focus-switch test; if a different product contract is desired, mark that subcase BLOCKED pending a decision. Confirm actual target text, not merely posted events |
| R08 | Induce an engine failure in an isolated test environment | Bounded failure; explicit incomplete state, retained recoverable content, working retry, no duplicate History result |
| R09 | Test recovery save failure using automated injection; retry after restoring storage | No false saved acknowledgement or silent discard; stable recovery identity |
| R10 | Fresh settings, model not ready, denied permissions, then resolve | User can identify and resolve each blocker without developer instructions |
| R11 | Local dictation with no cloud credentials | Local remains usable; no silent cloud fallback |

Run relevant cases on both engines and supported target hardware; Qwen chunk accounting is not a Nemotron requirement. Do not disrupt the maintainer's active recording or permissions to automate these cases. Fault injection belongs in tests or a separate test instance.

## Report template

```text
Date / tester:
Commit / installed build:
OS / hardware / microphone:
Engine / runtime / target application:
Test ID / steps:
Result: PASS | FAIL | BLOCKED | NOT RUN
Captured audio evidence:
Recognized text evidence:
Actual target delivery evidence:
Recovery / next dictation:
Diagnostic report reference (local):
Remaining uncertainty:
```

## Automated baseline

From the repository root, run `npm test`. For runtime Rust changes also run `cargo test --manifest-path src-tauri/Cargo.toml`. Relevant existing suites include `src/views/input-prompt.test.mjs`, `scripts/retry-recovery.test.mjs`, and `scripts/native-capture-contract.test.mjs`.

These do not replace the manual cases above. No manual case is marked passed by creating this checklist.

## Offline diagnostic report

Run from the repository root:

```sh
node scripts/dictation-report.mjs --help
node scripts/dictation-report.mjs "$HOME/Library/Logs/com.tao.typealoud/TypeAloud.log" > /private/tmp/typealoud-dictation-report.json
```

For Windows/Linux, pass the actual local log-file path. The macOS command above is only a path example, not a cross-platform location guarantee.

The tool reads at most 16 MiB and 50,000 recognized events, performs no network requests, and emits only allowlisted lifecycle/chunk enums, numeric counters and booleans. It omits raw lines, free-form errors, transcript text, device names and file paths. Review the resulting JSON before sharing; operational counters are still usage metadata.

`evidenceGaps` names observations or missing evidence, not a confirmed defect count. Duplicate capture starts can happen inside one recording. Session IDs reset on app/window runs, so combined logs may be ambiguous; the tool does not invent run boundaries. Empty model output is not automatically classified as a failure.

No gaps means only that the recognized records passed these checks. Logs may be rotated, truncated or from an older build. The report does not establish audio quality, word completeness, or actual delivery into the target application. It is an offline maintainer tool, not a new in-app export button or telemetry service.

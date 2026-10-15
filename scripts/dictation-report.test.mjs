import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDictationReport } from './dictation-report.mjs';

const line = body => `[2026-09-09][typealoud_lifecycle][INFO] ${body}`;
const lifecycle = (phase, event, id = 7, metadata = '') => line(`frontend session_id=${id} phase=${phase} event=${event} elapsed_ms=10 chunk_index=None pending_count=Some(1) ${metadata}`);
const final = tail => line(`audio-chunk session_id=7 event=final reason=complete accepted=16000 queued=16000 submitted=16000 completed=16000 queued_chunks=1 submitted_chunks=1 completed_chunks=1 buffered=0 stopped=1 ${tail || ''}`);
const report = lines => createDictationReport(lines.join('\n'));
const cli = fileURLToPath(new URL('./dictation-report.mjs', import.meta.url));
const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('records lifecycle and coverage without asserting content or delivery', () => {
  const result = report([lifecycle('capture', 'start'), final(), lifecycle('finalize', 'complete'), lifecycle('session', 'complete'), lifecycle('insert', 'complete')]);
  assert.equal(result.sessions[0].observed.insertionApiCompletions, 1);
  assert.equal(result.sessions[0].events[0].pending_count, 1);
  assert.equal(result.sessions[0].coverage[0].completed, 16000);
  assert.deepEqual(result.sessions[0].evidenceGaps, []);
  assert.equal(result.contentCompleteness, 'not-established');
  assert.equal(result.targetDelivery, 'not-established');
  assert.equal(result.sessions[0].identity, 'run-boundary-unverified');
});

test('ignores freeform content, paths, unknown labels and malformed numeric values', () => {
  const secret = 'PRIVATE_TRANSCRIPT';
  const result = report([
    lifecycle('capture', 'start', 7, `text=${secret} detail=${secret} path=/Users/${secret}`),
    line(`frontend session_id=7 phase=${secret} event=start elapsed_ms=0`),
    line(`frontend session_id=7 phase=history event=${secret} elapsed_ms=0`),
    line(`audio-chunk session_id=7 event=final reason=${secret} accepted=${secret} completed=1e6 chars=9007199254740992`),
    line(`audio-chunk:complete session_id=7 chunk_index=0 raw_chars=4 final_chars=4 empty=false text=${secret}`),
    `[private-target] ${secret}`,
  ]);
  const json = JSON.stringify(result);
  assert.ok(!json.includes(secret));
  assert.ok(!json.includes('/Users/'));
  assert.equal(result.sessions[0].coverage[0].reason, undefined);
  assert.equal(result.sessions[0].coverage[0].completed, undefined);
  assert.equal(result.sessions[0].coverage[0].chars, undefined);
  assert.equal(result.sessions[0].events.at(-1).empty, false);
});

test('mismatched sample and chunk counters are evidence gaps, not failure verdicts', () => {
  const result = report([final().replace('completed=16000', 'completed=8000').replace('completed_chunks=1', 'completed_chunks=0')]);
  assert.ok(result.sessions[0].evidenceGaps.includes('coverage-mismatch-observed'));
  assert.equal(result.sessions[0].status, undefined);
  const explicit = report([line('audio-chunk:slow session_id=7 event=final reason=coverage-mismatch')]);
  assert.ok(explicit.sessions[0].evidenceGaps.includes('coverage-mismatch-observed'));
  assert.ok(explicit.sessions[0].evidenceGaps.includes('coverage-counters-missing'));
});

test('missing final evidence and observed errors remain distinct', () => {
  const result = report([lifecycle('capture', 'start'), lifecycle('chunk-ipc', 'timeout', 7, 'chunk_index=Some(0)'), line('audio-chunk:received session_id=7 chunk_index=0 bytes=100')]);
  const gaps = result.sessions[0].evidenceGaps;
  assert.ok(gaps.includes('session-terminal-not-observed'));
  assert.ok(gaps.includes('finalization-terminal-not-observed'));
  assert.ok(gaps.includes('error-or-timeout-observed'));
  assert.equal(result.sessions[0].events[1].chunk_index, undefined, 'duplicate fields are dropped');
});

test('intentional cancellation does not require successful finalization or equal counters', () => {
  const result = report([lifecycle('capture', 'start'), line('audio-chunk session_id=7 event=final reason=cancelled accepted=100 completed=0'), lifecycle('session', 'cancel')]);
  assert.equal(result.sessions[0].observed.cancellation, true);
  assert.deepEqual(result.sessions[0].evidenceGaps, []);
});

test('repeated session IDs are explicitly ambiguous instead of merged success claims', () => {
  const result = report([lifecycle('capture', 'start'), lifecycle('session', 'complete'), lifecycle('capture', 'start'), lifecycle('session', 'cancel')]);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].identity, 'repeated-or-ambiguous');
  assert.ok(result.sessions[0].evidenceGaps.includes('session-id-reuse-or-duplicate-events'));
  assert.equal(result.runBoundaries, 'not-established');
});

test('Rust Some metadata, backend chunks, and alternate level ordering parse safely', () => {
  const result = report([
    '[2026-09-09][INFO][typealoud_lifecycle] frontend session_id=8 phase=chunk-ipc event=complete elapsed_ms=14 chunk_index=Some(2) pending_count=None',
    line('audio-chunk:received session_id=8 chunk_index=2 bytes=100'),
    line('audio-chunk:complete session_id=none chunk_index=2 final_chars=10'),
  ]);
  assert.equal(result.recognizedEvents, 2);
  assert.equal(result.sessions[0].events[0].chunk_index, 2);
  assert.equal(result.sessions[0].events[1].bytes, 100);
});

test('duplicate identifiers and invalid identifiers cannot create sessions', () => {
  const result = report([
    line('frontend session_id=1 session_id=2 phase=capture event=start'),
    line('frontend session_id=-1 phase=capture event=start'),
    line('frontend session_id=9007199254740992 phase=capture event=start'),
  ]);
  assert.equal(result.sessions.length, 0);
});

test('input and recognized event count are bounded', () => {
  assert.throws(() => createDictationReport('x'.repeat(16 * 1024 * 1024 + 1)), /input-too-large/);
  assert.throws(() => createDictationReport(`${lifecycle('capture', 'start')}\n`.repeat(50001)), /too-many-events/);
});

test('CLI help, argument validation, and errors never echo private paths', () => {
  assert.equal(run(['--help']).status, 0);
  assert.equal(run([]).status, 2);
  assert.equal(run(['--unknown']).status, 2);
  const missing = run(['/not-found/PRIVATE_TRANSCRIPT.log']);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr, 'cannot-read-log\n');
});

test('CLI reads a fixture and writes privacy-safe JSON only to stdout', () => {
  const directory = mkdtempSync(join(tmpdir(), 'typealoud-report-'));
  try {
    const path = join(directory, 'private.log');
    writeFileSync(path, lifecycle('capture', 'start', 7, 'text=PRIVATE_TRANSCRIPT'));
    const result = run([path]);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).sessions[0].sessionId, 7);
    assert.ok(!result.stdout.includes('PRIVATE_TRANSCRIPT'));
    assert.equal(run([directory]).stderr, 'not-regular-file\n');
    writeFileSync(path, Buffer.alloc(16 * 1024 * 1024 + 1));
    assert.equal(run([path]).stderr, 'input-too-large\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source line numbers preserve incident lookup without raw prefixes', () => {
  const result = report(['ignored-private-prefix', '', lifecycle('capture', 'start'), 'ignored', final()]);
  assert.equal(result.sessions[0].events[0].sourceLine, 3);
  assert.equal(result.sessions[0].events[1].sourceLine, 5);
  assert.equal(result.sessions[0].coverage[0].sourceLine, 5);
  assert.ok(!JSON.stringify(result).includes('ignored-private-prefix'));
});

test('backend-only chunk evidence still requires a frontend final observation', () => {
  const result = report([line('audio-chunk:received session_id=7 chunk_index=0 bytes=100')]);
  assert.ok(result.sessions[0].evidenceGaps.includes('chunk-final-not-observed'));
});

test('legitimate empty transcription is not an error or coverage mismatch', () => {
  const result = report([
    lifecycle('capture', 'start'),
    line('audio-chunk:complete session_id=7 chunk_index=0 raw_chars=0 final_chars=0 empty=true'),
    final(),
    lifecycle('finalize', 'complete'),
    lifecycle('session', 'complete'),
  ]);
  assert.equal(result.sessions[0].events[1].empty, true);
  assert.equal(result.sessions[0].events[1].raw_chars, 0);
  assert.equal(result.sessions[0].events[1].final_chars, 0);
  assert.deepEqual(result.sessions[0].evidenceGaps, []);
});

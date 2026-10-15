import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_EVENTS = 50000;
const PHASES = new Set(['capture', 'recorder-stop', 'finalize', 'resample', 'chunk-ipc', 'history', 'insert', 'recovery', 'session']);
const EVENTS = new Set(['start', 'complete', 'timeout', 'cancel', 'error', 'fallback', 'late']);
const CHUNK_EVENTS = new Set(['queued', 'request-start', 'request-result', 'seal', 'final', 'stop']);
const REASONS = new Set(['manual', 'silence', 'forced', 'release', 'cancelled', 'complete', 'no-speech', 'error', 'decode-error', 'coverage-mismatch', 'capture-incomplete']);
const NUMBERS = new Set(['elapsed_ms', 'chunk_index', 'pending_count', 'chunk', 'rate', 'hold_ms', 'last_pcm_gap_ms', 'start', 'end', 'input_samples', 'wav_bytes', 'wav_frames', 'chars', 'accepted', 'buffered', 'queued', 'submitted', 'completed', 'queued_chunks', 'submitted_chunks', 'completed_chunks', 'native_samples', 'bytes', 'raw_chars', 'final_chars']);

function fields(tail) {
  const result = Object.create(null);
  const duplicates = new Set();
  for (const token of tail.trim().split(/\s+/)) {
    const match = /^([a-z_]+)=([^\s]+)$/.exec(token);
    if (!match) continue;
    const [, key, value] = match;
    if (Object.hasOwn(result, key)) duplicates.add(key);
    result[key] = value;
  }
  for (const key of duplicates) delete result[key];
  return result;
}

function integer(value, minimum = 0) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? number : undefined;
}

function parseLine(line) {
  const match = /\[typealoud_lifecycle\]\s*(?:\[(?:INFO|WARN|ERROR|DEBUG|TRACE)\]\s*)?(frontend|audio-chunk(?::(?:received|complete|slow))?)\s+(.+)$/.exec(line);
  if (!match) return null;
  const [, kind, tail] = match;
  const data = fields(tail);
  const sessionId = integer(data.session_id);
  if (sessionId === undefined) return null;
  const event = {};
  if (kind === 'frontend') {
    if (!PHASES.has(data.phase) || !EVENTS.has(data.event)) return null;
    event.kind = 'lifecycle';
    event.phase = data.phase;
    event.event = data.event;
  } else if (kind === 'audio-chunk:received' || kind === 'audio-chunk:complete') {
    event.kind = 'chunk-backend';
    event.event = kind.endsWith(':received') ? 'received' : 'complete';
  } else {
    if (!CHUNK_EVENTS.has(data.event)) return null;
    event.kind = 'chunk-coverage';
    event.event = data.event;
    if (REASONS.has(data.reason)) event.reason = data.reason;
  }
  for (const key of NUMBERS) {
    const raw = /^(?:chunk_index|pending_count)$/.test(key) ? data[key]?.replace(/^Some\((\d+)\)$/, '$1') : data[key];
    const value = integer(raw, -1);
    if (value !== undefined) event[key] = value;
  }
  if (data.empty === 'true' || data.empty === 'false') event.empty = data.empty === 'true';
  if (data.stopped === '0' || data.stopped === '1') event.stopped = data.stopped === '1';
  return { sessionId, event };
}

function summarize(session) {
  const events = session.events;
  const count = (phase, event) => events.filter(item => item.kind === 'lifecycle' && item.phase === phase && item.event === event).length;
  const finals = events.filter(item => item.kind === 'chunk-coverage' && item.event === 'final');
  const cancelled = count('session', 'cancel') > 0 || finals.some(item => item.reason === 'cancelled');
  const terminalCount = count('session', 'complete') + count('session', 'cancel') + count('session', 'error');
  const gaps = new Set();
  if (!count('capture', 'start')) gaps.add('capture-start-not-observed');
  if (!terminalCount) gaps.add('session-terminal-not-observed');
  if (!cancelled && !events.some(item => item.phase === 'finalize' && ['complete', 'error', 'cancel'].includes(item.event))) gaps.add('finalization-terminal-not-observed');
  if (events.some(item => ['error', 'timeout'].includes(item.event) || ['error', 'decode-error', 'capture-incomplete'].includes(item.reason))) gaps.add('error-or-timeout-observed');
  if (events.some(item => ['chunk-coverage', 'chunk-backend'].includes(item.kind)) && !finals.length) gaps.add('chunk-final-not-observed');
  for (const final of finals) {
    if (final.reason === 'cancelled') continue;
    const samples = ['accepted', 'queued', 'submitted', 'completed'];
    const chunks = ['queued_chunks', 'submitted_chunks', 'completed_chunks'];
    const required = [...samples, ...chunks, 'buffered'];
    if (!required.every(key => Number.isSafeInteger(final[key]) && final[key] >= 0) || final.stopped === undefined) gaps.add('coverage-counters-missing');
    const unequal = keys => keys.every(key => final[key] >= 0) && new Set(keys.map(key => final[key])).size > 1;
    if (final.reason === 'coverage-mismatch' || unequal(samples) || unequal(chunks) || final.buffered > 0 || final.stopped === false || (final.native_samples >= 0 && final.accepted >= 0 && final.native_samples !== final.accepted)) gaps.add('coverage-mismatch-observed');
  }
  session.identity = count('capture', 'start') > 1 || terminalCount > 1 ? 'repeated-or-ambiguous' : 'run-boundary-unverified';
  if (session.identity === 'repeated-or-ambiguous') gaps.add('session-id-reuse-or-duplicate-events');
  session.observed = { captureStarts: count('capture', 'start'), sessionTerminals: terminalCount, cancellation: cancelled, insertionApiCompletions: count('insert', 'complete'), chunkFinals: finals.length };
  session.coverage = finals;
  session.evidenceGaps = [...gaps];
  return session;
}

export function createDictationReport(log) {
  if (Buffer.byteLength(log, 'utf8') > MAX_BYTES) throw new Error('input-too-large');
  const sessions = new Map();
  let recognizedEvents = 0;
  let ignoredLines = 0;
  let sourceLine = 0;
  for (const line of log.split(/\r?\n/)) {
    sourceLine++;
    if (!line) continue;
    const parsed = parseLine(line);
    if (!parsed) { ignoredLines++; continue; }
    if (++recognizedEvents > MAX_EVENTS) throw new Error('too-many-events');
    if (!sessions.has(parsed.sessionId)) sessions.set(parsed.sessionId, { sessionId: parsed.sessionId, events: [] });
    parsed.event.sourceLine = sourceLine;
    sessions.get(parsed.sessionId).events.push(parsed.event);
  }
  return {
    schemaVersion: 1,
    evidenceScope: 'observed-log-events-only',
    contentCompleteness: 'not-established',
    targetDelivery: 'not-established',
    runBoundaries: 'not-established',
    recognizedEvents,
    ignoredLines,
    sessions: [...sessions.values()].map(summarize),
  };
}

export async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write('Usage: node scripts/dictation-report.mjs <log-file>\nOffline privacy-safe JSON; max 16 MiB / 50000 events. No content or target-delivery verification. Session IDs may repeat across app runs.\n');
    return;
  }
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('Usage: node scripts/dictation-report.mjs <log-file>\n');
    process.exitCode = 2;
    return;
  }
  let handle;
  try {
    handle = await open(args[0], 'r');
    if (!(await handle.stat()).isFile()) throw new Error('not-regular-file');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error('input-too-large');
    process.stdout.write(`${JSON.stringify(createDictationReport(buffer.toString('utf8', 0, size)), null, 2)}\n`);
  } catch (error) {
    const code = ['input-too-large', 'too-many-events', 'not-regular-file'].includes(error.message) ? error.message : 'cannot-read-log';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await handle?.close();
    } catch {
      process.stderr.write('cannot-close-log\n');
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));

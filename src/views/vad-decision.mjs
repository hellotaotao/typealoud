// Pure VAD decision logic. No DOM, no WASM — unit-tested with node:test.
// A "segment" is { start, end } in milliseconds (vad-web NonRealTimeVAD yields ms).

export function totalSpeechMs(segments) {
  let total = 0;
  for (const s of segments) {
    const d = s.end - s.start;
    if (d > 0) total += d;
  }
  return total;
}

export function decideSpeech(segments, minSpeechMs) {
  const ms = totalSpeechMs(segments);
  return { speech: ms >= minSpeechMs, totalSpeechMs: ms };
}

// The keep-range around detected speech: first segment start minus padStartMs
// to last segment end plus padEndMs, clamped to the clip. Padding protects
// against Silero clipping soft onsets/decays — cutting a real word is worse
// than leaving some silence. Returns null when there is nothing to anchor on.
export function trimRangeMs(segments, durationMs, { padStartMs, padEndMs }) {
  if (!segments.length) return null;
  let first = Infinity;
  let last = -Infinity;
  for (const s of segments) {
    if (s.start < first) first = s.start;
    if (s.end > last) last = s.end;
  }
  return {
    startMs: Math.max(0, first - padStartMs),
    endMs: Math.min(durationMs, last + padEndMs),
  };
}

// Only re-encode when the cut actually removes enough silence to matter —
// otherwise send the original recording untouched (zero added risk).
export function shouldTrim(range, durationMs, minSavingsMs) {
  if (!range) return false;
  return durationMs - (range.endMs - range.startMs) >= minSavingsMs;
}

// Minimal WAV writer: mono 16-bit PCM. Whisper resamples server-side anyway,
// so a 16 kHz mono WAV loses nothing for ASR while staying small (~32 KB/s).
export function encodeWavPcm16(pcm, sampleRate) {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i]));
    const sample = Math.max(-32768, Math.min(32767, Math.round(clamped * 32768)));
    view.setInt16(44 + i * 2, sample, true);
  }
  return bytes;
}

if (typeof window !== "undefined") {
  window.TypeAloudVad = { decideSpeech, totalSpeechMs, trimRangeMs, shouldTrim, encodeWavPcm16 };
}

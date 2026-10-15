// Frontend VAD gate. Classic script. Exposes window.TypeAloudVadGate.analyze(blob):
// no-speech verdict for the whole clip, plus — when the clip carries enough
// leading/trailing silence — a head/tail-trimmed 16 kHz mono WAV to upload
// instead of the raw recording. Trimming exists because Whisper (zh) fills
// silence gaps with training-data boilerplate ("明镜与点点" outros — TODO #10);
// cutting the silence around the detected speech removes the main trigger.
// Lazy-loads the vendored onnxruntime-web + vad-web bundles on first use; the
// recording is decoded and resampled to 16 kHz mono ONCE (OfflineAudioContext),
// so the Silero segment timestamps line up 1:1 with the PCM we slice for the WAV.
//
// Asset paths MUST be absolute URLs: onnxruntime-web loads its wasm glue via dynamic
// import(), which rejects bare/relative specifiers like "vendor/vad/" (verified failing
// then passing in the WebKit smoke). So derive an absolute base from document.baseURI.
(function () {
  const VENDOR = new URL("vendor/vad/", document.baseURI).href;
  const MIN_SPEECH_MS = 250; // start/end are milliseconds (vad-web NonRealTimeVAD source)
  const TARGET_RATE = 16000; // Whisper's native rate; the server resamples to it anyway
  // Generous padding: cutting a soft first/last word is worse than leaving
  // silence (same trade-off as hotkey.rs STOP_DEBOUNCE). Skip re-encoding
  // entirely unless trimming actually removes a meaningful stretch.
  const PAD_START_MS = 300;
  const PAD_END_MS = 450;
  const MIN_TRIM_SAVINGS_MS = 500;
  let vadPromise = null;
  let analysisTail = Promise.resolve();

  // NonRealTimeVAD owns one stateful FrameProcessor. A later run resets that
  // processor when it ends, so sharing the cached model across overlapping
  // recordings is safe only when the whole analysis is single-flight. Keeping
  // decode and WAV encoding inside the same queue also bounds peak PCM memory.
  function runExclusive(task) {
    const run = analysisTail.then(task, task);
    analysisTail = run.catch(() => {});
    return run;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }

  async function getVad() {
    if (!vadPromise) {
      vadPromise = (async () => {
        if (!window.ort) await loadScript(VENDOR + "ort.wasm.min.js"); // -> window.ort
        window.ort.env.wasm.wasmPaths = VENDOR; // absolute URL (import() needs it)
        window.ort.env.wasm.numThreads = 1; // avoid SharedArrayBuffer / COOP-COEP
        if (!window.vad) await loadScript(VENDOR + "bundle.min.js"); // -> window.vad (externalizes ort)
        return window.vad.NonRealTimeVAD.new({ modelURL: VENDOR + "silero_vad_legacy.onnx" });
      })().catch((e) => {
        vadPromise = null; // allow retry on the next recording
        throw e;
      });
    }
    return vadPromise;
  }

  // Decode the recording and resample to 16 kHz mono in one pass. The
  // OfflineAudioContext both mixes down to one channel and resamples, and its
  // output is the SAME stream the VAD timestamps refer to (vad.run at 16 kHz
  // resamples as a no-op), so slicing it by segment milliseconds is exact.
  async function blobToPcm16k(blob) {
    const buf = await blob.arrayBuffer();
    const ctx = new AudioContext();
    let audio;
    try {
      audio = await ctx.decodeAudioData(buf);
    } finally {
      try { ctx.close(); } catch (_) {}
    }
    const length = Math.ceil((audio.length * TARGET_RATE) / audio.sampleRate);
    const offline = new OfflineAudioContext(1, length, TARGET_RATE);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  // Analyze one recording: speech verdict + (when worthwhile) a head/tail
  // trimmed 16 kHz mono WAV. `wav` is null when trimming was skipped — too
  // little silence to matter — and the caller sends the original recording.
  // opts.forceWav: the local ASR backend needs PCM WAV regardless of whether
  // trimming saves anything — encode even when the trim is skipped.
  async function analyze(blob, opts) {
    return runExclusive(async () => {
      const forceWav = !!(opts && opts.forceWav);
      const vad = await getVad();
      const pcm = await blobToPcm16k(blob);
      const durationMs = (pcm.length / TARGET_RATE) * 1000;
      const segments = [];
      for await (const seg of vad.run(pcm, TARGET_RATE)) {
        segments.push({ start: seg.start, end: seg.end });
      }
      const verdict = window.TypeAloudVad.decideSpeech(segments, MIN_SPEECH_MS);
      let wav = null;
      let trimmedMs = 0;
      if (verdict.speech) {
        const range = window.TypeAloudVad.trimRangeMs(segments, durationMs, {
          padStartMs: PAD_START_MS,
          padEndMs: PAD_END_MS,
        });
        if (window.TypeAloudVad.shouldTrim(range, durationMs, MIN_TRIM_SAVINGS_MS)) {
          const startSample = Math.max(0, Math.floor((range.startMs / 1000) * TARGET_RATE));
          const endSample = Math.min(pcm.length, Math.ceil((range.endMs / 1000) * TARGET_RATE));
          wav = window.TypeAloudVad.encodeWavPcm16(pcm.subarray(startSample, endSample), TARGET_RATE);
          trimmedMs = Math.round(durationMs - (range.endMs - range.startMs));
        } else if (forceWav) {
          wav = window.TypeAloudVad.encodeWavPcm16(pcm, TARGET_RATE);
        }
      }
      return { speech: verdict.speech, totalSpeechMs: verdict.totalSpeechMs, durationMs, wav, trimmedMs };
    });
  }

  // Prewarm: load the wasm runtime + Silero model (and run one short silent
  // buffer to warm the inference path) so the first real recording doesn't pay
  // the ~0.5-1s init. Best-effort — any failure just falls back to lazy-loading.
  async function warmup() {
    return runExclusive(async () => {
      try {
        const vad = await getVad();
        const silence = new Float32Array(8000); // 0.5 s @ 16 kHz
        for await (const seg of vad.run(silence, 16000)) { void seg; }
      } catch (e) {
        console.warn("VAD warmup failed; will lazy-load on first use:", e);
      }
    });
  }

  // Local-backend fallback: WAV without the VAD. Plain WebAudio decode +
  // resample (blobToPcm16k) doesn't depend on Silero/ort, so even when the
  // VAD path fails the local engine can still get its PCM.
  async function encodeFullWav(blob) {
    return runExclusive(async () => {
      const pcm = await blobToPcm16k(blob);
      return window.TypeAloudVad.encodeWavPcm16(pcm, TARGET_RATE);
    });
  }

  // Speech verdict for PCM that is already 16 kHz mono, such as the short
  // remainder a chunked local dictation leaves after its last cut. Any segment
  // counts as speech: a missed word would cost the user text, while a false
  // alarm only costs the decode that would have happened anyway.
  async function hasSpeech(pcm16k) {
    return runExclusive(async () => {
      const vad = await getVad();
      let found = false;
      // Drain the generator so the shared frame processor ends in its reset state.
      for await (const seg of vad.run(pcm16k, TARGET_RATE)) {
        void seg;
        found = true;
      }
      return found;
    });
  }

  window.TypeAloudVadGate = { analyze, warmup, encodeFullWav, hasSpeech };
})();

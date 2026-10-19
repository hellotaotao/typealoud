if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.setAttribute("data-input-prompt-js-ran", "1");
}

const ipc = window.__TYPEALOUD_IPC__;
const { initI18n, setLanguage, applyI18n, t } = window.TypeAloudI18n;

let isDev = false;

const DEFAULT_RECORD_SHORTCUT = "Ctrl+Shift";
const DEBUG_MICROPHONE_CLEANUP = false;
// Mirror of commands.rs perform_transcription_request model selection, so the
// badge shows the model that will ACTUALLY run (incl. the empty-model default).
// Keep in sync with the Rust side.
const RECORD_DEFAULT_MODEL = { openai: "gpt-transcribe", groq: "whisper-large-v3-turbo" };
const QWEN_LOCAL_MODEL_ID = "qwen3-asr-0.6b-q8_0";
const QWEN_LARGE_LOCAL_MODEL_ID = "qwen3-asr-1.7b-q8_0";
const NEMOTRON_LOCAL_MODEL_ID = "nemotron-3.5-asr-streaming-0.6b-q8_0";
// Keep this paired with hotkey.rs CANCEL_THRESHOLD. Preloading a model-sized
// worker before probation ends would make a discarded mis-trigger hold memory.
const QWEN_PREWARM_PROBATION_MS = 500;
const RECORDER_STOP_TIMEOUT_MS = 2000;
const BATCH_RECORDER_STOP_TIMEOUT_MS = 15000;
// Allow IPC round-trip and channel drainage beyond the backend's 5 s stop deadline.
const NATIVE_CAPTURE_STOP_TIMEOUT_MS = 8000;
const AUDIO_STAGE_TIMEOUT_MS = 30000;
// A chunked dictation's final remainder at or under this length is checked with
// the neural VAD first. A cut shortly before release can leave only the pause's
// tail, and Qwen turns a fraction of a second of room noise into "嗯。" or "no.".
// Silero takes ~10 ms per second of audio, so longer remainders are not worth
// holding the post-release path for; they contain speech almost always.
const REMAINDER_VAD_MAX_S = 3;
// A longer remainder is checked too when it holds less than this much audio
// above the previous chunk's pause level. Holding the key through a long
// silence after a cut leaves seconds of room noise, which Qwen has turned into
// a full Spanish sentence. Speech-bearing remainders measured 0.44 s or more
// and silent ones 0.04 s or less, and the VAD still makes the actual call.
const REMAINDER_QUIET_LOUD_S = 0.3;
const REMAINDER_VAD_TIMEOUT_MS = 1500;
// Native transcription has its own 420 s whole-request deadline. Leave time
// for IPC delivery without imposing one deadline on a multi-chunk recording.
const TRANSCRIPTION_STAGE_TIMEOUT_MS = 450000;
const HISTORY_STAGE_TIMEOUT_MS = 5000;
// A hold recording this long shows the double-tap tip, a few times at most and
// never again once the user has locked a recording.
const LOCK_TIP_AFTER_MS = 30000;
const LOCK_TIP_MAX_SHOWS = 3;
const LOCK_TIP_STORAGE_KEY = "typealoud.lockTip";
const MODEL_LABEL = {
  "gpt-transcribe": "OpenAI GPT Transcribe",
  // Retired from the picker 2026-09; kept so old history rows still render a name.
  "gpt-4o-transcribe": "OpenAI GPT-4o",
  "gpt-4o-mini-transcribe": "OpenAI GPT-4o mini",
  "whisper-1": "OpenAI Whisper",
  "whisper-large-v3": "Groq Whisper v3",
  "whisper-large-v3-turbo": "Groq Whisper v3 Turbo",
  [QWEN_LOCAL_MODEL_ID]: "Qwen3 · Local",
  [QWEN_LARGE_LOCAL_MODEL_ID]: "Qwen3 1.7B · Local",
  [NEMOTRON_LOCAL_MODEL_ID]: "Nemotron 3.5 · Live Local",
};
// Audio capture constraints, shared by the launch prime and every recording.
const AUDIO_CONSTRAINTS = {
  audio: {
    // Whisper resamples everything to 16 kHz mono anyway, so capturing at
    // 16 kHz (instead of 44.1 kHz) shrinks the upload with no quality loss.
    // Treated as a hint — browsers that ignore it still work.
    sampleRate: 16000,
    channelCount: 1,
    // echoCancellation routes capture through macOS's VoiceProcessingIO audio
    // unit, which cold-starts in ~1–2s on an external/USB mic and swallows the
    // first second(s) of speech. Dictation needs no echo cancellation, so keep
    // it off. (noiseSuppression/autoGainControl don't exist in this WebKit build
    // — getSettings() reports them undefined — but are pinned off for clarity.)
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
};

// --- Audio onset probe -------------------------------------------------------
// One question only: when the opening seconds of a dictation come back empty,
// did the AudioWorklet receive NO blocks (the graph never ran) or blocks full
// of silence (the device handed us zeros)? The analyser cannot tell those
// apart — getByteTimeDomainData is 8-bit, so its smallest step is ~-42 dBFS and
// ordinary room tone quantizes to an exact zero. This float tap can.
//
// Onset positions are measured on the AUDIO timeline (samples seen so far), not
// on wall clock, so main-thread jank cannot smear the reading. Pairing that with
// the wall clock of the first block is what separates the two causes:
//   device silence  -> first_signal_ms ~= 3000, first_block_wall_ms ~= 0
//   graph ran late  -> first_signal_ms ~= 0,    first_block_wall_ms ~= 3000
const PROBE_SIGNAL_RMS = 1e-4; // ~-80 dBFS: above the noise floor of a live mic
const PROBE_SPEECH_RMS = 0.01; // ~-40 dBFS: unmistakably someone talking
const PROBE_BUCKET_MS = 500;
// Diagnostic only: a Goertzel filter locked to a 440 Hz reference tone. RMS
// alone cannot say whether the 3.0 s attenuation happens before or after the
// ADC — room tone is acoustic, so it scales in both cases. Per-bucket SNR can:
// a digital gain scales signal and converter noise together and leaves SNR
// untouched, while an analog attenuation adds a fixed converter floor
// afterwards and craters SNR inside the window.
const PROBE_TONE_HZ = 440;
const PROBE_BUCKETS = 24; // first 12 s; longer holds just stop extending it
// The level at the very end tells a release after the speaker stopped from one
// in mid-sentence (a keyboard dropout reads as the keys lifting). Two rolling
// windows of this length, so the reported tail covers the last 250-500 ms.
const PROBE_TAIL_WINDOW_MS = 250;

function createOnsetProbe(sampleRate, originMs) {
  return {
    sampleRate,
    originMs,
    connectedAtMs: null,
    firstBlockWallMs: null,
    blocks: 0,
    samples: 0,
    zeroLeadBlocks: 0,
    quietLeadBlocks: 0,
    firstNonZeroMs: null,
    firstSignalMs: null,
    firstSpeechMs: null,
    peak: 0,
    analyserFrames: 0,
    analyserSilentFrames: 0,
    ctxStateAtSignal: null,
    ctxTimeAtSignal: null,
    // Coarse level-over-time, so "the bar barely moves" can be told apart from
    // "the bar isn't being painted": envSum/envCount are RMS accumulators on the
    // AUDIO timeline, frameCounts is how many analyser ticks the rAF loop
    // actually ran in the same wall-clock bucket. A stalled compositor shows
    // full frame counts with a healthy envelope; a genuinely quiet opening
    // shows full frame counts with a low envelope.
    envSum: new Float64Array(PROBE_BUCKETS),
    envCount: new Int32Array(PROBE_BUCKETS),
    gzS1: new Float64Array(PROBE_BUCKETS),
    gzS2: new Float64Array(PROBE_BUCKETS),
    gzCoeff: 2 * Math.cos((2 * Math.PI * PROBE_TONE_HZ) / sampleRate),
    frameCounts: new Int32Array(PROBE_BUCKETS),
    clipped: 0,
    tailSum: 0,
    tailCount: 0,
    tailPrevSum: 0,
    tailPrevCount: 0,
    reported: false,
  };
}

function pushOnsetBlock(probe, samples, audioContext) {
  if (!probe || !samples.length) return;
  // Position of THIS block on the audio timeline, before it is counted.
  const positionMs = (probe.samples / probe.sampleRate) * 1000;
  if (probe.firstBlockWallMs === null) {
    probe.firstBlockWallMs = performance.now() - probe.originMs;
  }
  probe.blocks += 1;
  probe.samples += samples.length;

  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    const magnitude = value < 0 ? -value : value;
    if (magnitude > peak) peak = magnitude;
    // Float capture is not clamped; encodeWavPcm16 hard-clips anything past 1.
    if (magnitude > 1) clipped += 1;
    sumSquares += value * value;
  }
  if (peak > probe.peak) probe.peak = peak;
  probe.clipped += clipped;
  const rms = Math.sqrt(sumSquares / samples.length);

  probe.tailSum += sumSquares;
  probe.tailCount += samples.length;
  if (probe.tailCount >= (probe.sampleRate * PROBE_TAIL_WINDOW_MS) / 1000) {
    probe.tailPrevSum = probe.tailSum;
    probe.tailPrevCount = probe.tailCount;
    probe.tailSum = 0;
    probe.tailCount = 0;
  }

  const bucket = Math.floor(positionMs / PROBE_BUCKET_MS);
  if (bucket >= 0 && bucket < PROBE_BUCKETS) {
    probe.envSum[bucket] += sumSquares;
    probe.envCount[bucket] += samples.length;
    // Goertzel state carries across blocks within a bucket. A block spans
    // ~2.7 ms, so attributing the whole block to its opening bucket is exact
    // enough for a 500 ms window.
    const coeff = probe.gzCoeff;
    let s1 = probe.gzS1[bucket];
    let s2 = probe.gzS2[bucket];
    for (let i = 0; i < samples.length; i++) {
      const s0 = samples[i] + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    probe.gzS1[bucket] = s1;
    probe.gzS2[bucket] = s2;
  }

  if (probe.firstNonZeroMs === null) {
    if (peak > 0) probe.firstNonZeroMs = positionMs;
    else probe.zeroLeadBlocks += 1;
  }
  if (probe.firstSignalMs === null) {
    if (rms > PROBE_SIGNAL_RMS) {
      probe.firstSignalMs = positionMs;
      probe.ctxStateAtSignal = audioContext ? audioContext.state : null;
      probe.ctxTimeAtSignal = audioContext ? audioContext.currentTime : null;
    } else {
      probe.quietLeadBlocks += 1;
    }
  }
  if (probe.firstSpeechMs === null && rms > PROBE_SPEECH_RMS) {
    probe.firstSpeechMs = positionMs;
  }
}

function pcm16LeToFloat(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    const value = view.getInt16(index * 2, true);
    samples[index] = value < 0 ? value / 32768 : value / 32767;
  }
  return samples;
}

function encodePcm16LeWav(blocks, sampleCount, sampleRate) {
  const dataBytes = sampleCount * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const block of blocks) {
    wav.set(block, offset);
    offset += block.byteLength;
  }
  return wav;
}

const THEME_PREFS = new Set(["auto", "midnight", "elegant"]);
let currentThemePref = "elegant";

function normalizeThemePref(value) {
  return THEME_PREFS.has(value) ? value : "elegant";
}

function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function concreteTheme(pref) {
  const normalized = normalizeThemePref(pref);
  return normalized === "auto" ? (systemPrefersDark() ? "midnight" : "elegant") : normalized;
}

function applyTheme(value) {
  currentThemePref = normalizeThemePref(value);
  document.documentElement.setAttribute("data-theme", concreteTheme(currentThemePref));
}

function watchSystemTheme() {
  if (!window.matchMedia) {
    return;
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentThemePref === "auto") {
      document.documentElement.setAttribute("data-theme", concreteTheme(currentThemePref));
    }
  });
}

function logMicrophoneCleanup(...args) {
  if (!DEBUG_MICROPHONE_CLEANUP) {
    return;
  }
  console.log(...args);
}

function hasMeaningfulText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeMilliseconds(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function normalizeRecordingStartPayload(payload, receivedAtUnixMs = Date.now()) {
  if (!payload || typeof payload !== "object") {
    return {
      nativeMs: 0,
      eventDeliveryMs: 0,
    };
  }

  const dispatchedAtUnixMs = Number(payload.dispatchedAtUnixMs);
  return {
    nativeMs: nonNegativeMilliseconds(Number(payload.nativeMs)),
    eventDeliveryMs: Number.isFinite(dispatchedAtUnixMs)
      ? nonNegativeMilliseconds(receivedAtUnixMs - dispatchedAtUnixMs)
      : 0,
  };
}

// Extracts a human-readable message from a Tauri command rejection, which may
// be a raw string (Result<_, String>) or an Error.
function errorMessage(error) {
  return typeof error === "string"
    ? error
    : typeof error?.message === "string"
      ? error.message
      : String(error ?? "");
}

// Stable native IPC contract; messages are diagnostic text, not control flow.
const NATIVE_CAPTURE_ERROR_CODES = new Set([
  "NATIVE_CAPTURE_BUSY",
  "NATIVE_CAPTURE_START_TIMEOUT",
  "NATIVE_CAPTURE_STOP_TIMEOUT",
  "NATIVE_CAPTURE_NOT_ACTIVE",
  "NATIVE_CAPTURE_FAILED",
]);

function nativeCaptureError(error) {
  return Object.assign(new Error(errorMessage(error)), {
    code: NATIVE_CAPTURE_ERROR_CODES.has(error?.code) ? error.code : "NATIVE_CAPTURE_FAILED",
    deviceReleased: error?.deviceReleased === true,
  });
}

// Whether a failed transcription is worth one automatic retry. A hung/timed-out
// decode is transient — the local watchdog (local_asr.rs) aborts a wedged
// subprocess with a "treating as hung" message, and a network/hard timeout is
// likewise worth one more shot. Deterministic failures (bad key, clip too long,
// cancelled) must NOT be retried: a retry only re-fails after doubling the wait.
function isRetryableTranscriptionError(message) {
  return /treating as hung/i.test(message) || /timed out/i.test(message);
}

// Shape-only text metric (counts, never content) sent alongside type-text /
// copy-to-clipboard; the backend logs it next to its own count of the received
// string, so a mismatch pins text corruption to the JS→Rust IPC leg. Must
// mirror text_shape() in commands.rs.
function textShape(text) {
  let chars = 0;
  let cjk = 0;
  let latin1 = 0;
  for (const ch of text) {
    chars += 1;
    const c = ch.codePointAt(0);
    if (c >= 0x3000 && c <= 0x9fff) {
      cjk += 1;
    } else if (c >= 0x80 && c <= 0xff) {
      latin1 += 1;
    }
  }
  return `chars=${chars} cjk=${cjk} latin1sup=${latin1}`;
}

class VoiceInputPrompt {
  constructor() {
    this.isRecording = false;
    this.audioContext = null;
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.analyser = null;
    this.dataArray = null;
    this.nativeCapture = null;
    this.animationId = null;
    this.starting = false;
    this.stopRequested = false;
    this.recordingStartedAt = null;
    this.cancelledShortPress = false;
    this.cancelInProgress = false;
    this.cancelGateToken = null;
    this.transcriptionInProgressCount = 0;
    this.activeTranscriptionSessionIds = new Set();
    this.cancelledTranscriptionSessionIds = new Set();
    this.localTranscriptionTail = Promise.resolve();
    this.recordingSessionId = 0;
    this.activeRecordingSession = null;
    this.recordingSessions = new Map();
    this.recoverableTranscriptions = new Map();
    this.recoverableAudioSessions = new Map();
    this.recoverySequence = 0;
    this.pendingRecoveryUi = null;
    this.pendingInsertionOrder = [];
    this.pendingInsertionsById = new Map();
    this.isFlushingInsertQueue = false;
    this.recordingTimerId = null;
    this.hidePromptTimerId = null;
    this.actualHideTimerId = null;
    this.recordShortcut = DEFAULT_RECORD_SHORTCUT;
    this.pageStartedAt = performance.now();

    this.promptElement = document.getElementById("inputPrompt");
    this.promptText = document.getElementById("promptText");
    this.waveContainer = document.getElementById("waveContainer");
    this.statusText = document.getElementById("statusText");
    this.transcriptionText = document.getElementById("transcriptionText");
    this.transcriptionTextInner = document.getElementById("transcriptionTextInner");
    this.modelBadge = document.getElementById("modelBadge");
    this.copyBtn = document.getElementById("copyBtn");
    this.copyBtnLabel = document.getElementById("copyBtnLabel");
    this.localModelBtn = document.getElementById("localModelBtn");
    this.currentProvider = null;
    this.currentModel = "";
    this.currentMicrophone = "default";
    this._failedText = "";
    // Text of the failure card that was showing when the current recording
    // started. A hotkey tap (tap-recording) inserts it instead of recording.
    this.tapInsertCandidate = null;
    // Set while the hotkey has locked the current recording (hands-free).
    this.recordingLockId = null;
    this.lockTipShown = false;
    this.startRecordingPromise = null;

    this.createWaveBars();
    this.setupEventListeners();
    this.settingsReady = this.syncShortcutFromSettings();
    this.primeVad();
  }

  // Prewarm the neural VAD (onnxruntime wasm + Silero model) at launch to move
  // the ~0.5-1s first load off the user's first dictation. It touches no audio
  // device. window.TypeAloudVadGate is defined by vad-gate.js (loaded first).
  primeVad() {
    window.TypeAloudVadGate?.warmup?.();
  }

  // `successorQueued` says a chunk is already sitting behind the current one,
  // which is knowledge `isRecording` cannot carry. On reset-safe runtimes this
  // merely renews the same session-owned worker; elsewhere it creates the next
  // one-audio worker while there is still speech to hide the load behind.
  prewarmQwenWorker(recordingSession, { successorQueued = false } = {}) {
    if (
      (!this.isRecording && !successorQueued) ||
      this.activeRecordingSession !== recordingSession ||
      !recordingSession.qwenSession ||
      this.currentProvider !== "local" ||
      this.currentModel === NEMOTRON_LOCAL_MODEL_ID
    ) {
      return;
    }
    void ipc.invoke("prewarm-qwen-worker", recordingSession.id).catch((error) => {
      if (isDev) console.warn("Failed to prewarm Qwen worker:", error);
    });
  }

  finishQwenWorkerSession(recordingSession) {
    if (!recordingSession?.qwenSession || recordingSession.qwenWorkerFinishRequested) {
      return Promise.resolve(false);
    }
    recordingSession.qwenWorkerFinishRequested = true;
    return ipc.invoke("finish-qwen-worker-session", recordingSession.id).catch((error) => {
      recordingSession.qwenWorkerFinishRequested = false;
      if (isDev) console.warn("Failed to finish Qwen worker session:", error);
      return false;
    });
  }

  scheduleQwenPrewarm(recordingSession, elapsedSinceHotkeyMs) {
    const delayMs = Math.max(
      0,
      QWEN_PREWARM_PROBATION_MS - nonNegativeMilliseconds(elapsedSinceHotkeyMs)
    );
    if (delayMs === 0) {
      this.prewarmQwenWorker(recordingSession);
      return;
    }
    setTimeout(() => this.prewarmQwenWorker(recordingSession), delayMs);
  }

  createWaveBars() {
    // Enough bars to fill the 120px container (3px bar + 2px gap ≈ 5px each).
    for (let i = 0; i < 24; i++) {
      const bar = document.createElement("div");
      bar.className = "wave-bar";
      bar.style.height = "3px";
      this.waveContainer.appendChild(bar);
    }
  }

  setupEventListeners() {
    // Qwen emits preview text while decoding after release; Nemotron emits it
    // during recording. Preview text is never inserted. The selected engine's
    // authoritative final replaces it before insertion and history storage.
    ipc.on("local-transcription-partial", (event, payload) => {
      const text = payload && payload.text;
      if (!text || !this.transcriptionText) {
        return;
      }
      const sessionMatches = Number(payload.sessionId) === this.recordingSessionId;
      if (sessionMatches && ["ready", "completed", "cancelled", "failed"].includes(
        this.activeRecordingSession?.lifecycle?.state)) return;
      // Chunked local decoding streams a chunk's tokens while later audio is
      // still being captured, so route by chunk slot instead of overwriting the
      // whole preview with one chunk's text.
      const chunked = this.activeRecordingSession?.chunked;
      if (payload.chunkIndex != null && chunked) {
        if (sessionMatches && !chunked.aborted && chunked.inFlightChunkIndex === Number(payload.chunkIndex)) {
          chunked.livePartial = { index: Number(payload.chunkIndex), text };
          this.renderChunkedPreview(chunked);
        }
        return;
      }
      const isLiveNemotron =
        sessionMatches &&
        this.activeRecordingSession?.live?.sessionId === Number(payload.sessionId) &&
        (this.isRecording || this.starting || this.transcriptionInProgressCount > 0);
      if (!sessionMatches || (!isLiveNemotron && this.transcriptionInProgressCount <= 0)) {
        return;
      }
      if (!isLiveNemotron && (this.isRecording || this.starting)) {
        return;
      }
      this.setTranscriptionPreview(text);
    });

    ipc.on("shortcut-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      this.updateShortcutHint(payload.recordShortcut || DEFAULT_RECORD_SHORTCUT);
      if (payload.provider !== undefined) this.currentProvider = payload.provider;
      if (payload.model !== undefined) this.currentModel = payload.model;
      this.updateModelBadge();
    });

    ipc.on("ui-language-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      setLanguage(payload.language);
      applyI18n(document);
      this.updateShortcutHint(this.recordShortcut);
    });

    ipc.on("ui-theme-updated", (event, payload) => {
      if (!payload) {
        return;
      }
      applyTheme(payload.theme);
    });

    // Listen for start recording from main process
    ipc.on("start-recording", async (event, payload = false) => {
      if (this.isRecording || this.starting) {
        return;
      }
      const startupTiming = normalizeRecordingStartPayload(payload);
      this.stopRequested = false;
      this.updateModelBadge();
      this.startRecordingPromise = this.startRecording(startupTiming);
      await this.startRecordingPromise;
    });

    // Listen for stop recording from main process
    ipc.on("stop-recording", () => {
      this.tapInsertCandidate = null;
      this.stopRequested = true;
      this.stopRecording();
    });

    ipc.on("cancel-recording", () => {
      this.tapInsertCandidate = null;
      this.cancelRecording();
    });

    // A short press that no second press followed.
    ipc.on("tap-recording", () => {
      void this.handleHotkeyTap();
    });

    // A double tap: keep recording until the hotkey is pressed again.
    ipc.on("lock-recording", (event, payload) => {
      this.handleRecordingLock(payload?.lockId);
    });

    // Listen for cleanup microphone signal
    ipc.on("cleanup-microphone", () => {
      // Ignore stale cleanup if a new recording is already in flight,
      // otherwise it would tear down the freshly acquired mediaStream.
      if (this.isRecording || this.starting) {
        return;
      }
      this.cleanup();
    });

    // Legacy support for toggle recording
    ipc.on("toggle-recording", async () => {
      if (!this.isRecording) {
        await this.startRecording();
      } else {
        this.stopRecording();
      }
    });

    // ESC key to cancel recording when window is focused
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.cancelRecording();
      }
    });

    // Add window beforeunload event to ensure cleanup
    window.addEventListener("beforeunload", () => {
      const native = this.activeRecordingSession?.nativeCapture;
      if (native && !native.stopped && !native.stopPromise) {
        native.accepting = false;
        void ipc.invoke("stop-native-capture", native.sessionId).catch(() => {});
      }
      this.cleanup();
    });

    // Insertion-failure "Copy" affordance — explicit click only (no auto copy).
    if (this.copyBtn) {
      this.copyBtn.addEventListener("click", () => this.copyFailedText());
    }
    if (this.localModelBtn) {
      this.localModelBtn.addEventListener("click", async () => {
        try {
          await ipc.invoke("open-local-model-panel", this.localModelSetupModel);
        } catch (error) {
          console.error("Failed to open local model settings:", error);
        }
      });
    }
  }

  async syncShortcutFromSettings() {
    try {
      const settings = await ipc.invoke("get-settings");
      if (!settings) {
        return;
      }
      this.osName = settings.os || this.osName;
      this.currentProvider = settings.provider || "local";
      this.currentModel = settings.model || "";
      this.currentMicrophone = settings.microphone || "default";
      this.updateShortcutHint(settings.shortcut || DEFAULT_RECORD_SHORTCUT);
      this.updateModelBadge();
    } catch (error) {
      console.error("Failed to load shortcut hint settings:", error);
      this.updateShortcutHint(this.recordShortcut);
    }
  }

  formatShortcutLabel(shortcut) {
    if (typeof shortcut !== "string") {
      return "";
    }
    // Non-breaking spaces: a wrapped hint must never split "Ctrl + / Shift".
    const label = shortcut.replace(/\+/g, " + ");
    // macOS labels Alt as Option; Windows/Linux keep Alt. Use the backend `os`
    // field (set in syncShortcutFromSettings), falling back to navigator only
    // before settings have loaded.
    const isMac = this.osName
      ? this.osName === "macos"
      : /Mac/i.test(window.navigator?.platform || "");
    return isMac ? label.replace(/Alt/g, "Option") : label;
  }

  updateShortcutHint(recordShortcut) {
    if (!this.promptText) {
      return;
    }
    const safeRecordShortcut =
      recordShortcut || this.recordShortcut || DEFAULT_RECORD_SHORTCUT;
    this.recordShortcut = safeRecordShortcut;
    this.promptText.textContent = t("inputPrompt.hint", {
      record: this.formatShortcutLabel(safeRecordShortcut),
    });
  }

  resolveActiveModel() {
    if (this.currentProvider == null) {
      return null; // settings not loaded yet
    }
    if (this.currentProvider === "local") {
      const model = this.currentModel === NEMOTRON_LOCAL_MODEL_ID
        ? NEMOTRON_LOCAL_MODEL_ID
        : this.currentModel === QWEN_LARGE_LOCAL_MODEL_ID ? QWEN_LARGE_LOCAL_MODEL_ID : QWEN_LOCAL_MODEL_ID;
      return MODEL_LABEL[model];
    }
    const provider = this.currentProvider === "groq" ? "groq" : "openai";
    const model = String(this.currentModel || "").trim()
      ? this.currentModel
      : RECORD_DEFAULT_MODEL[provider];
    return MODEL_LABEL[model] || model || "";
  }

  updateModelBadge() {
    if (!this.modelBadge) {
      return;
    }
    this.modelBadge.textContent = this.resolveActiveModel() || "";
  }

  // --- Insertion-failure "click to Copy" UI (never an automatic clipboard touch) ---
  showInsertFailed(text) {
    this.clearHidePromptTimer();
    this._failedText = typeof text === "string" ? text : "";
    this.promptElement.classList.remove("recording");
    this.promptElement.classList.add("insert-failed");
    this.promptText.textContent = t("inputPrompt.insertFailedTitle");
    this.statusText.textContent = t("inputPrompt.insertFailedHint", this.shortcutValues());
    this.statusText.style.color = "var(--status-warning)";
    if (this.copyBtnLabel) {
      this.copyBtnLabel.textContent = t("inputPrompt.copyButton");
    }
    // Swap the (now-stopped) waveform for the Copy button.
    if (this.waveContainer) this.waveContainer.style.display = "none";
    if (this.copyBtn) this.copyBtn.hidden = false;
    // Safety net: don't let an always-on-top overlay sit forever if ignored.
    this.scheduleHidePrompt(15000);
  }

  async copyFailedText() {
    if (!hasMeaningfulText(this._failedText)) {
      return;
    }
    const text = this._failedText;
    const recoveryId = this.recoveryShownId;
    const recordingId = this.recordingSessionId;
    try {
      const copied = await ipc.invoke("copy-to-clipboard", text, textShape(text));
      if (copied === false) throw new Error("Clipboard write was rejected");
      if (recordingId !== this.recordingSessionId || this.isRecording || this.starting ||
          recoveryId !== this.recoveryShownId || text !== this._failedText) return;
      if (recoveryId != null) {
        if (this.recoveryShownId === recoveryId) this.recoveryShownId = null;
      }
      if (recordingId !== this.recordingSessionId || this.isRecording || this.starting) return;
      this.pendingRecoveryUi = null;
      this.statusText.textContent = t("inputPrompt.copied");
      this.statusText.style.color = "var(--status-success)";
      if (this.copyBtn) this.copyBtn.hidden = true;
      this.scheduleHidePrompt(1200);
    } catch (error) {
      console.error("Clipboard copy failed:", error);
      if (recordingId !== this.recordingSessionId || this.isRecording || this.starting ||
          recoveryId !== this.recoveryShownId || text !== this._failedText) return;
      this.statusText.textContent = t("inputPrompt.copyFailed");
      this.statusText.style.color = "var(--status-warning-strong)";
      if (this.copyBtn) this.copyBtn.hidden = false;
      this.scheduleHidePrompt(15000);
    }
  }

  clearInsertFailedUi() {
    this._failedText = "";
    this.recoveryShownId = null;
    this.pendingRecoveryUi = null;
    if (this.copyBtn) this.copyBtn.hidden = true;
    if (this.localModelBtn) this.localModelBtn.hidden = true;
    this.localModelSetupModel = null;
    if (this.waveContainer) this.waveContainer.style.display = "";
    if (this.promptElement) this.promptElement.classList.remove("insert-failed", "engine-blocked");
  }

  shortcutValues() {
    return { record: this.formatShortcutLabel(this.recordShortcut || DEFAULT_RECORD_SHORTCUT) };
  }

  // A tap of the hotkey while a failure card was showing re-inserts that card's
  // text at the caret: the user clicks the target field, then taps. The tap
  // also started a recording, which is always discarded. Without a card it is
  // just the old mis-trigger cancel.
  async handleHotkeyTap() {
    const text = this.tapInsertCandidate;
    this.tapInsertCandidate = null;
    this.cancelRecording();
    if (!hasMeaningfulText(text)) return;
    // Let the cancelled startup settle first: its late hide must not close a
    // card that a failed insertion re-shows.
    try {
      await this.startRecordingPromise;
    } catch {
      // Startup errors are already handled by startRecording.
    }
    if (this.isRecording || this.starting || this.isFlushingInsertQueue ||
      this.pendingInsertionOrder.length || this.transcriptionInProgressCount > 0) return;
    this.clearHidePromptTimer();
    this.promptText.textContent = t("inputPrompt.inserting");
    this.statusText.textContent = "";
    // Holds the insertion FIFO like any other native insertion.
    this.isFlushingInsertQueue = true;
    let result;
    try {
      result = await this.typeText(text, { suppressUi: true });
    } catch (error) {
      result = { ok: false, message: errorMessage(error) };
    } finally {
      this.isFlushingInsertQueue = false;
    }
    if (this.pendingInsertionOrder.length) {
      void this.flushPendingInsertions();
      return;
    }
    if (this.isRecording || this.starting) return;
    if (result?.ok) {
      this.hidePrompt();
      return;
    }
    this.showInsertFailed(text);
  }

  handleRecordingLock(lockId) {
    this.tapInsertCandidate = null;
    if (!this.isRecording && !this.starting) {
      // The recording already ended on its own (e.g. the microphone failed).
      void this.releaseRecordingLock(lockId);
      return;
    }
    this.recordingLockId = lockId;
    this.rememberLockUsed();
    if (this.isRecording) this.promptText.textContent = this.recordingPromptText();
  }

  // Tells the hotkey that a locked recording is over, so its next press
  // starts a new recording. A no-op when the hotkey itself ended it.
  releaseRecordingLock(lockId = this.recordingLockId) {
    if (lockId === this.recordingLockId) this.recordingLockId = null;
    if (lockId == null) return Promise.resolve();
    return Promise.resolve(ipc.invoke("release-recording-lock", lockId)).catch(() => {});
  }

  recordingPromptText() {
    return this.recordingLockId != null
      ? t("inputPrompt.lockedHint", this.shortcutValues())
      : t("inputPrompt.listening");
  }

  readLockTipState() {
    try {
      const value = JSON.parse(window.localStorage?.getItem(LOCK_TIP_STORAGE_KEY) || "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  writeLockTipState(value) {
    try {
      window.localStorage?.setItem(LOCK_TIP_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Storage is a convenience; without it the tip may simply show again.
    }
  }

  rememberLockUsed() {
    this.writeLockTipState({ ...this.readLockTipState(), used: true });
  }

  maybeShowLockTip() {
    if (!this.isRecording || this.recordingLockId != null || this.lockTipShown) return;
    if (Date.now() - (this.recordingStartedAt || Date.now()) < LOCK_TIP_AFTER_MS) return;
    this.lockTipShown = true;
    const state = this.readLockTipState();
    const shows = Number(state.shows) || 0;
    if (state.used || shows >= LOCK_TIP_MAX_SHOWS) return;
    this.writeLockTipState({ ...state, shows: shows + 1 });
    this.promptText.textContent = t("inputPrompt.lockTip", this.shortcutValues());
  }

  formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  getReadyInsertionCount() {
    let count = 0;
    for (const sessionId of this.pendingInsertionOrder) {
      if (this.pendingInsertionsById.has(sessionId)) {
        count += 1;
      }
    }
    return count;
  }

  updateStatusText() {
    if (!this.statusText) {
      return;
    }

    if (this.isFlushingInsertQueue) {
      this.statusText.textContent = t("inputPrompt.inserting");
      this.statusText.style.color = "var(--status-success)";
      return;
    }

    if (this.isRecording) {
      const duration = this.formatDuration(
        Date.now() - (this.recordingStartedAt || Date.now())
      );
      let status = t("inputPrompt.recordingWithDuration", { duration });
      if (this.transcriptionInProgressCount > 0) {
        status += `${t("inputPrompt.statusSeparator")}${t(
          "inputPrompt.transcribing"
        )}`;
      }
      this.statusText.textContent = status;
      this.statusText.style.color = "";
      return;
    }

    if (this.transcriptionInProgressCount > 0) {
      this.statusText.textContent = t("inputPrompt.transcribing");
      this.statusText.style.color = "";
      return;
    }

    this.statusText.textContent = "";
    this.statusText.style.color = "";
  }

  startRecordingTimer() {
    this.stopRecordingTimer();
    this.updateStatusText();
    this.recordingTimerId = setInterval(() => {
      if (!this.isRecording) {
        return;
      }
      this.updateStatusText();
      this.maybeShowLockTip();
    }, 200);
  }

  stopRecordingTimer() {
    if (this.recordingTimerId) {
      clearInterval(this.recordingTimerId);
      this.recordingTimerId = null;
    }
  }

  clearHidePromptTimer() {
    if (this.hidePromptTimerId) {
      clearTimeout(this.hidePromptTimerId);
      this.hidePromptTimerId = null;
    }
  }

  scheduleHidePrompt(delayMs) {
    this.clearHidePromptTimer();
    this.hidePromptTimerId = setTimeout(() => {
      this.hidePromptTimerId = null;
      // A scheduled hide always belongs to a terminal state. If a recording
      // (re)started in the meantime, firing now would tear down the live mic
      // and clear the insertion queue — drop the stale hide instead. (Any
      // legitimate hide during recording is a direct hidePrompt() call.)
      if (
        this.isRecording ||
        this.starting ||
        this.transcriptionInProgressCount > 0 ||
        this.pendingInsertionOrder.length > 0 ||
        this.isFlushingInsertQueue
      ) {
        return;
      }
      this.hidePrompt();
    }, delayMs);
  }

  clearActualHideTimer() {
    if (this.actualHideTimerId) {
      clearTimeout(this.actualHideTimerId);
      this.actualHideTimerId = null;
    }
  }

  removePendingInsertion(sessionId) {
    this.pendingInsertionsById.delete(sessionId);
    this.pendingInsertionOrder = this.pendingInsertionOrder.filter(
      (id) => id !== sessionId
    );
  }

  ensureRecordingSession(recordingSession) {
    if (!recordingSession.lifecycle) {
      recordingSession.lifecycle = {
        state: "recording",
        startedAt: Date.now(),
        stopTimer: null,
        hardStopTimer: null,
        stopWatchTimer: null,
        stopSeen: false,
        processPromise: null,
        cancelWaiters: new Set(),
      };
    }
    this.recordingSessions ||= new Map();
    const state = recordingSession.lifecycle.state;
    if (!["completed", "cancelled", "failed"].includes(state)) {
      this.recordingSessions.set(recordingSession.id, recordingSession);
    }
    if (recordingSession.chunked) {
      recordingSession.chunked.recordingSession = recordingSession;
    }
    return recordingSession.lifecycle;
  }

  reportLifecycle(recordingSession, phase, event, elapsedMs = 0, chunkIndex) {
    if (!Number.isSafeInteger(recordingSession?.id)) return;
    const payload = {
      sessionId: recordingSession.id,
      phase,
      event,
      elapsedMs: nonNegativeMilliseconds(elapsedMs),
      pendingCount: this.pendingInsertionOrder.length,
    };
    if (Number.isSafeInteger(chunkIndex)) payload.chunkIndex = chunkIndex;
    // A diagnostic failure must never become part of the transcription chain.
    try {
      void Promise.resolve(ipc.invoke("report-transcription-lifecycle", payload)).catch(() => {});
    } catch {
      // The bridge may be unavailable while the window is shutting down.
    }
  }


  reportAudioProbe(recordingSession, stage, detail, slow = false) {
    if (!Number.isSafeInteger(recordingSession?.id)) return;
    // A diagnostic failure must never become part of the transcription chain.
    try {
      void Promise.resolve(ipc.invoke("report-audio-probe", {
        sessionId: recordingSession.id,
        stage,
        detail,
        slow,
      })).catch(() => {});
    } catch {
      // The bridge may be unavailable while the window is shutting down.
    }
  }

  // Emitted once per recording, from whichever of stop/finalize runs first.
  reportAudioOnset(recordingSession) {
    const probe = recordingSession?.onsetProbe;
    if (!probe || probe.reported) return;
    probe.reported = true;
    const ms = (value) => (value === null ? -1 : Math.round(value));
    const capturedMs = Math.round((probe.samples / probe.sampleRate) * 1000);
    const tailCount = probe.tailPrevCount + probe.tailCount;
    const tailRms = tailCount ? Math.sqrt((probe.tailPrevSum + probe.tailSum) / tailCount) : 0;
    const holdMs = Math.round(performance.now() - probe.originMs);
    const detail = [
      `chunked=${!!recordingSession.chunked}`,
      `blocks=${probe.blocks}`,
      `captured_ms=${capturedMs}`,
      `hold_ms=${holdMs}`,
      `missing_ms=${Math.max(0, holdMs - capturedMs)}`,
      `connect_ms=${ms(probe.connectedAtMs)}`,
      `first_block_wall_ms=${ms(probe.firstBlockWallMs)}`,
      `first_nonzero_ms=${ms(probe.firstNonZeroMs)}`,
      `first_signal_ms=${ms(probe.firstSignalMs)}`,
      `first_speech_ms=${ms(probe.firstSpeechMs)}`,
      `zero_lead_blocks=${probe.zeroLeadBlocks}`,
      `quiet_lead_blocks=${probe.quietLeadBlocks}`,
      `peak=${probe.peak.toFixed(4)}`,
      `tail_db=${tailRms > 0 ? Math.round(20 * Math.log10(tailRms)) : -99}`,
      `tail_speech=${tailRms > PROBE_SPEECH_RMS}`,
      `ctx_state_at_signal=${probe.ctxStateAtSignal || "none"}`,
      `ctx_time_at_signal=${probe.ctxTimeAtSignal === null ? -1 : probe.ctxTimeAtSignal.toFixed(3)}`,
      `analyser_frames=${probe.analyserFrames}`,
      `analyser_silent_frames=${probe.analyserSilentFrames}`,
    ].join(" ");
    const slow = probe.firstSignalMs === null || probe.firstSignalMs > 500;
    this.reportAudioProbe(recordingSession, "onset", detail, slow);

    const used = Math.min(
      PROBE_BUCKETS,
      Math.ceil((probe.samples / probe.sampleRate) * 1000 / PROBE_BUCKET_MS)
    );
    const envDb = [];
    const frames = [];
    const snrDb = [];
    for (let i = 0; i < used; i++) {
      const count = probe.envCount[i];
      const rms = count ? Math.sqrt(probe.envSum[i] / count) : 0;
      envDb.push(rms > 0 ? Math.round(20 * Math.log10(rms)) : -99);
      frames.push(probe.frameCounts[i]);
      // Mean-square power of the reference tone, and everything that is not it.
      if (count) {
        const s1 = probe.gzS1[i];
        const s2 = probe.gzS2[i];
        const toneMs = Math.max(
          (2 * (s1 * s1 + s2 * s2 - probe.gzCoeff * s1 * s2)) / (count * count),
          0
        );
        const totalMs = probe.envSum[i] / count;
        const noiseMs = Math.max(totalMs - toneMs, 1e-20);
        snrDb.push(toneMs > 0 ? Math.round(10 * Math.log10(toneMs / noiseMs)) : -99);
      } else {
        snrDb.push(-99);
      }
    }
    this.reportAudioProbe(recordingSession, "envelope", [
      `bucket_ms=${PROBE_BUCKET_MS}`,
      // Native capture clamps in Rust before quantising to PCM16, so by the
      // time these samples reach the renderer nothing can exceed full scale and
      // this counter would always read 0 — next to the native-capture line's
      // real count, that is worse than useless. The authoritative numbers are
      // `peak` and `clipped` on `native-capture stopped`.
      ...(recordingSession.nativeCapture
        ? ["clipped=see-native-capture-line"]
        : [
          `clipped=${probe.clipped}`,
          `clipped_pct=${probe.samples ? (probe.clipped / probe.samples * 100).toFixed(2) : "0"}`,
        ]),
      `env_db=${envDb.join(",")}`,
      `snr_db=${snrDb.join(",")}`,
      `frames=${frames.join(",")}`,
    ].join(" "), false);
  }

  isSessionCancelled(recordingSession) {
    return recordingSession?.lifecycle?.state === "cancelled" ||
      this.cancelledTranscriptionSessionIds.has(recordingSession?.id);
  }

  assertSessionActive(recordingSession) {
    if (this.isSessionCancelled(recordingSession)) {
      const error = new Error("TRANSCRIPTION_CANCELLED");
      error.name = "TranscriptionCancelledError";
      throw error;
    }
  }

  async waitForSessionStage(recordingSession, phase, operation, timeoutMs, chunkIndex) {
    const lifecycle = this.ensureRecordingSession(recordingSession);
    this.assertSessionActive(recordingSession);
    const startedAt = Date.now();
    this.reportLifecycle(recordingSession, phase, "start", 0, chunkIndex);
    let timer = null;
    let cancelWaiter;
    try {
      const value = await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (handler, result) => {
          if (settled) return;
          settled = true;
          handler(result);
        };
        cancelWaiter = () => {
          const error = new Error("TRANSCRIPTION_CANCELLED");
          error.name = "TranscriptionCancelledError";
          settle(reject, error);
        };
        lifecycle.cancelWaiters.add(cancelWaiter);
        if (timeoutMs) {
          timer = setTimeout(() => {
            const error = new Error(`Transcription stage timed out: ${phase}`);
            error.name = "TranscriptionStageTimeoutError";
            error.phase = phase;
            settle(reject, error);
          }, timeoutMs);
        }
        Promise.resolve().then(() => {
          this.assertSessionActive(recordingSession);
          return operation();
        }).then(
          (value) => {
            if (settled) {
              this.reportLifecycle(recordingSession, phase, "late", Date.now() - startedAt, chunkIndex);
            }
            settle(resolve, value);
          },
          (error) => settle(reject, error)
        );
      });
      this.assertSessionActive(recordingSession);
      this.reportLifecycle(recordingSession, phase, "complete", Date.now() - startedAt, chunkIndex);
      return value;
    } catch (error) {
      const event = error?.name === "TranscriptionStageTimeoutError" ? "timeout" :
        error?.name === "TranscriptionCancelledError" ? "cancel" : "error";
      this.reportLifecycle(recordingSession, phase, event, Date.now() - startedAt, chunkIndex);
      throw error;
    } finally {
      if (timer !== null) clearTimeout(timer);
      lifecycle.cancelWaiters.delete(cancelWaiter);
    }
  }

  completeRecordingSession(recordingSession, state = "completed") {
    const lifecycle = this.ensureRecordingSession(recordingSession);
    if (lifecycle.stopTimer !== null) clearTimeout(lifecycle.stopTimer);
    if (lifecycle.hardStopTimer !== null) clearTimeout(lifecycle.hardStopTimer);
    lifecycle.stopTimer = null;
    lifecycle.hardStopTimer = null;
    lifecycle.state = state;
    this.recordingSessions.delete(recordingSession.id);
    this.reportLifecycle(recordingSession, "session", state === "cancelled" ? "cancel" :
      state === "failed" ? "error" : "complete", Date.now() - lifecycle.startedAt);
  }

  cancelRecordingSession(recordingSession) {
    const lifecycle = this.ensureRecordingSession(recordingSession);
    if (["completed", "cancelled", "failed"].includes(lifecycle.state)) return;
    recordingSession.captureRecoveryWav = null;
    this.cancelledTranscriptionSessionIds.add(recordingSession.id);
    this.completeRecordingSession(recordingSession, "cancelled");
    for (const cancelWaiter of lifecycle.cancelWaiters) cancelWaiter();
    this.cancelNemotronLive(recordingSession);
    if (recordingSession.chunked) {
      this.cancelChunkedLocal(recordingSession);
    } else {
      void ipc.invoke("cancel-transcription", recordingSession.id).catch(() => {});
    }
    this.removePendingInsertion(recordingSession.id);
    this.discardSessionRecovery(recordingSession.id);
    void this.finishQwenWorkerSession(recordingSession);
    if (!lifecycle.processPromise || lifecycle.processingFinished) {
      this.cancelledTranscriptionSessionIds.delete(recordingSession.id);
    }
  }

  finalizeRecordingSession(recordingSession, reason = "onstop") {
    if (!recordingSession) return Promise.resolve();
    this.reportAudioOnset(recordingSession);
    if (reason === "onstop" && this.isRecording && this.activeRecordingSession === recordingSession) {
      // An ended track can stop the recorder before the hotkey is released.
      // Close the matching PCM capture before joining its queue as a final.
      this.stopRecording();
    }
    const lifecycle = this.ensureRecordingSession(recordingSession);
    if (reason === "onstop") {
      lifecycle.stopSeen = true;
      if (lifecycle.stopWatchTimer !== null) clearTimeout(lifecycle.stopWatchTimer);
      lifecycle.stopWatchTimer = null;
    }
    // "release" finalizes without waiting for the recorder, so it must not
    // report the recorder as having stopped: a real stop still logs its own
    // event, and the watch timer logs its absence. Conflating the two would
    // hide exactly the dropped event this whole change is about.
    if (reason !== "release") {
      this.reportLifecycle(recordingSession, "recorder-stop",
        ["timeout", "hard-timeout"].includes(reason) ? "timeout" : lifecycle.processPromise ? "late" : "complete",
        lifecycle.stopRequestedAt ? Date.now() - lifecycle.stopRequestedAt : 0);
    }
    if (lifecycle.stopTimer !== null) clearTimeout(lifecycle.stopTimer);
    lifecycle.stopTimer = null;
    if (reason === "timeout" && !recordingSession.chunked && !recordingSession.live) {
      // Large batch containers can take longer to finish. Two seconds is a
      // diagnostic warning; only the separate hard deadline fails the session.
      return Promise.resolve();
    }
    if (lifecycle.hardStopTimer !== null) clearTimeout(lifecycle.hardStopTimer);
    lifecycle.hardStopTimer = null;
    if (reason === "onstop" && lifecycle.recoverLateRecorder) {
      return this.adoptLateRecorderAudio(recordingSession);
    }
    if (lifecycle.processPromise || ["completed", "cancelled", "failed"].includes(lifecycle.state)) {
      return lifecycle.processPromise || Promise.resolve();
    }
    if (reason === "hard-timeout") {
      // Periodic dataavailable blobs do not prove the media container is final.
      recordingSession.finalizationError = new Error("Audio recorder did not finish");
      lifecycle.recoverLateRecorder = true;
      this.preserveRecoveryAudio(recordingSession, { waitingRecorder: true });
    }
    return this.processRecording(recordingSession);
  }

  processRecording(recordingSession) {
    if (!recordingSession) return Promise.resolve();
    recordingSession.provider ||= this.currentProvider;
    const lifecycle = this.ensureRecordingSession(recordingSession);
    if (lifecycle.processPromise || ["completed", "cancelled", "failed"].includes(lifecycle.state)) {
      return lifecycle.processPromise || Promise.resolve();
    }
    lifecycle.state = "processing";
    this.reportLifecycle(recordingSession, "finalize", "start");
    lifecycle.processPromise = this.processRecordingOnce(recordingSession);
    return lifecycle.processPromise;
  }

  storeTranscriptionResult(sessionId, transcription) {
    const session = this.recordingSessions?.get(sessionId);
    if (this.cancelledTranscriptionSessionIds.has(sessionId) || this.isSessionCancelled(session)) return;
    this.retryRecoveryPersistence();
    this.pendingInsertionsById.set(sessionId, transcription);
    if (sessionId === this.recordingSessionId && !this.isRecording && !this.starting) {
      this.setTranscriptionPreview(transcription);
    }
  }

  preserveCompletedChunks(recordingSession) {
    const text = recordingSession.finalText || (recordingSession.chunked &&
      window.TypeAloudChunk.joinChunkTexts(recordingSession.chunked.results));
    if (!hasMeaningfulText(text)) return false;
    this.preserveRecoveryText(recordingSession.id, text, "incomplete");
    return true;
  }

  preserveRecoveryText(sessionId, text, kind) {
    this.recoverableTranscriptions ||= new Map();
    let recovery = this.recoverableTranscriptions.get(sessionId);
    if (!recovery || recovery.text !== text || recovery.kind !== kind) {
      this.recoverySequence = (this.recoverySequence || 0) + 1;
      recovery = { id: `recovery-${Date.now()}-${sessionId}-${this.recoverySequence}`, text, kind };
      this.recoverableTranscriptions.set(sessionId, recovery);
    }
    if (sessionId === this.recordingSessionId && !this.isRecording && !this.starting) {
      this.pendingRecoveryUi = { sessionId, recovery };
    }
    void this.persistRecoveryText(sessionId, recovery);
  }

  async persistRecoveryText(sessionId, recovery) {
    if (recovery.saving || recovery.persisted || recovery.discarded) return;
    recovery.saving = true;
    const startedAt = Date.now();
    const session = { id: sessionId };
    this.reportLifecycle(session, "recovery", "start");
    let timer;
    try {
      const request = Promise.resolve().then(() => {
        if (recovery.discarded) throw new Error("TRANSCRIPTION_CANCELLED");
        return ipc.invoke("save-recovered-transcription", {
          id: recovery.id, text: recovery.text, kind: recovery.kind,
        });
      }).then((historyId) => {
        if (typeof historyId !== "string" || !historyId.trim()) {
          throw new Error("Missing recovery persistence acknowledgment");
        }
        recovery.persisted = true;
        // A delayed ACK belongs to this exact immutable recovery, not a newer
        // value that may have replaced it under the same recording session id.
        if (this.recoverableTranscriptions.get(sessionId) === recovery) {
          this.recoverableTranscriptions.delete(sessionId);
        }
        if (this.pendingRecoveryUi?.recovery === recovery &&
          this.recoveryShownId === sessionId && sessionId === this.recordingSessionId &&
          !this.isRecording && !this.starting) {
          this.statusText.textContent = t("inputPrompt.recoverySavedHint", this.shortcutValues());
        }
        this.reportLifecycle(session, "recovery", "complete", Date.now() - startedAt);
      });
      await Promise.race([request, new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Recovery persistence timed out");
          error.name = "TranscriptionStageTimeoutError";
          reject(error);
        }, HISTORY_STAGE_TIMEOUT_MS);
      })]);
    } catch (error) {
      this.reportLifecycle(session, "recovery",
        error?.name === "TranscriptionStageTimeoutError" ? "timeout" : "error", Date.now() - startedAt);
    } finally {
      clearTimeout(timer);
      recovery.saving = false;
    }
  }

  preserveRecoveryAudio(session, { blob = null, wav = null, waitingRecorder = false } = {}) {
    this.recoverableAudioSessions ||= new Map();
    session.audioRecovery ||= {
      id: `pending-${Date.now()}-${session.id}`, blob, wav, waitingRecorder,
    };
    this.recoverableAudioSessions.set(session.id, session);
    void this.persistRecoveryAudio(session);
  }

  // The recorder delivers its container on dataavailable, which is a separate
  // event from stop. Recovery must key off the data: waiting for a stop that
  // may never arrive is what loses the audio entirely. There is no timeslice,
  // so that single data event carries the whole container — and persistence
  // proves it by decoding it, keeping the bytes for a later retry if it cannot.
  adoptLateRecorderAudio(session) {
    const recovery = session.audioRecovery;
    if (!recovery || recovery.saved || recovery.blob || this.isSessionCancelled(session) ||
      !session.chunks.length) {
      return Promise.resolve();
    }
    recovery.blob = new Blob(session.chunks, { type: session.mimeType });
    recovery.waitingRecorder = false;
    return this.persistRecoveryAudio(session);
  }

  async persistRecoveryAudio(session) {
    const recovery = session.audioRecovery;
    if (!recovery || recovery.waitingRecorder || recovery.saving || recovery.saved ||
      this.isSessionCancelled(session)) return;
    // The regular command rereads current settings. Without a native route
    // snapshot, late cloud audio must remain in memory: neither silently send
    // it to a changed provider nor persist it as local raw audio.
    if (session.provider !== "local") {
      if (!recovery.routeDeferred) this.reportLifecycle(session, "recovery", "fallback");
      recovery.routeDeferred = true;
      return;
    }
    recovery.saving = true;
    try {
      if (!recovery.wav) {
        if (!recovery.blob?.size) throw new Error("No complete audio available for recovery");
        recovery.wav = await this.waitForSessionStage(session, "recovery",
          () => window.TypeAloudVadGate.encodeFullWav(recovery.blob), AUDIO_STAGE_TIMEOUT_MS);
      }
      this.assertSessionActive(session);
      await this.waitForSessionStage(session, "recovery", () =>
        Promise.resolve(ipc.invoke("save-pending-transcription", recovery.wav, "audio/wav", recovery.id))
          .then((historyId) => {
            if (typeof historyId !== "string" || !historyId.trim()) {
              throw new Error("Missing audio recovery acknowledgment");
            }
            recovery.saved = true;
            if (session.audioRecovery === recovery) {
              recovery.blob = null;
              recovery.wav = null;
              session.chunks = [];
              this.recoverableAudioSessions.delete(session.id);
            }
            return historyId;
          }), HISTORY_STAGE_TIMEOUT_MS);
    } catch {
      // Each failed/timed-out stage is diagnosed by waitForSessionStage. Keep
      // the original Blob (and any completed WAV) until ACK or explicit cancel.
    } finally {
      recovery.saving = false;
    }
  }

  retryRecoveryPersistence() {
    for (const [sessionId, recovery] of this.recoverableTranscriptions || []) {
      void this.persistRecoveryText(sessionId, recovery);
    }
    for (const session of this.recoverableAudioSessions?.values() || []) {
      void this.persistRecoveryAudio(session);
    }
  }

  discardSessionRecovery(sessionId) {
    const recovery = this.recoverableTranscriptions?.get(sessionId);
    if (recovery) recovery.discarded = true;
    this.recoverableTranscriptions?.delete(sessionId);
    if (this.pendingRecoveryUi?.sessionId === sessionId) this.pendingRecoveryUi = null;
    this.cancelSessionAudioRecovery(sessionId);
  }

  cancelSessionAudioRecovery(sessionId) {
    const session = this.recoverableAudioSessions?.get(sessionId);
    if (session) {
      session.lifecycle.state = "cancelled";
      for (const cancelWaiter of session.lifecycle.cancelWaiters) cancelWaiter();
      session.chunks = [];
      session.audioRecovery = null;
      this.recoverableAudioSessions.delete(sessionId);
    }
  }

  showRecoveryIfIdle() {
    if (this.isRecording || this.starting || this.transcriptionInProgressCount > 0 ||
      this.pendingInsertionOrder.length || this.isFlushingInsertQueue ||
      !this.pendingRecoveryUi) return false;
    const { sessionId, recovery } = this.pendingRecoveryUi;
    if (sessionId !== this.recordingSessionId || recovery.discarded) return false;
    if (this.recoveryShownId !== sessionId) {
      this.setTranscriptionPreview(recovery.text);
      this.showInsertFailed(recovery.text);
      if (recovery.kind === "incomplete") {
        this.promptText.textContent = t("inputPrompt.transcriptionIncompleteTitle");
        this.statusText.textContent = t("inputPrompt.transcriptionIncompleteHint", this.shortcutValues());
      }
      if (recovery.persisted) {
        this.statusText.textContent = t("inputPrompt.recoverySavedHint", this.shortcutValues());
      }
      this.recoveryShownId = sessionId;
      this.scheduleHidePrompt(15000);
    }
    return true;
  }

  /// Shows `text` in the height-capped preview bubble, pinned to the tail so
  /// the newest (streamed) text is what's visible. `.scrolled` drives the
  /// top-edge fade mask — only when older lines are actually hidden above,
  /// so a short transcript renders at full strength.
  setTranscriptionPreview(text) {
    const inner = this.transcriptionTextInner;
    if (!inner) {
      return;
    }
    inner.textContent = text;
    this.transcriptionText.classList.add("visible");
    // Drives CSS to dim the prompt box so the streamed-text bubble reads as the
    // front-most layer (the prompt box keeps its .recording class throughout
    // transcription, so this body flag is what tells "bubble is up" apart from
    // "still just listening").
    document.body.classList.add("has-transcription");
    inner.scrollTop = inner.scrollHeight;
    inner.classList.toggle("scrolled", inner.scrollTop > 0);
  }

  clearTranscriptionPreview() {
    if (this.transcriptionTextInner) {
      this.transcriptionTextInner.textContent = "";
      this.transcriptionTextInner.classList.remove("scrolled");
    }
    this.transcriptionText.classList.remove("visible");
    document.body.classList.remove("has-transcription");
  }

  async flushPendingInsertions() {
    if (this.isFlushingInsertQueue || this.isRecording || this.starting) {
      return;
    }

    if (!this.pendingInsertionOrder.length) {
      this.showRecoveryIfIdle();
      return;
    }

    // Only explicit terminal states are disposable. A recorder still awaiting
    // its stop event is valid pending work, even before processing increments.
    while (this.pendingInsertionOrder.length) {
      const headId = this.pendingInsertionOrder[0];
      const state = this.recordingSessions?.get(headId)?.lifecycle?.state;
      if (!["cancelled", "failed", "completed"].includes(state)) break;
      this.removePendingInsertion(headId);
    }
    if (!this.pendingInsertionOrder.length) {
      this.showRecoveryIfIdle();
      return;
    }

    const nextId = this.pendingInsertionOrder[0];
    if (!this.pendingInsertionsById.has(nextId)) {
      return;
    }

    this.isFlushingInsertQueue = true;
    this.updateStatusText();
    let insertedAny = false;
    let allDirect = true;
    let cancelledAny = false;

    try {
      while (this.pendingInsertionOrder.length && !this.isRecording && !this.starting) {
        const nextId = this.pendingInsertionOrder[0];
        if (!this.pendingInsertionsById.has(nextId)) {
          // Result not yet available — wait for next flush trigger
          break;
        }
        const text = this.pendingInsertionsById.get(nextId);
        const session = this.recordingSessions?.get(nextId);
        this.pendingInsertionsById.delete(nextId);
        this.pendingInsertionOrder.shift();
        if (hasMeaningfulText(text)) {
          let result;
          const insertionStartedAt = Date.now();
          try {
            if (session) this.assertSessionActive(session);
            this.reportLifecycle(session, "insert", "start");
            // Native text insertion is irreversible once dispatched. Keep the
            // FIFO lock until its actual reply, even if the session is cancelled;
            // a JS deadline must not permit a second insertion to overtake it.
            result = await this.typeText(text, { suppressUi: true });
            this.reportLifecycle(session, "insert",
              session && this.isSessionCancelled(session) ? "late" :
                result?.ok || result?.noText ? "complete" : "error",
              Date.now() - insertionStartedAt);
          } catch (error) {
            result = { ok: false, message: errorMessage(error) };
            this.reportLifecycle(session, "insert",
              session && this.isSessionCancelled(session) ? "cancel" : "error",
              Date.now() - insertionStartedAt);
          }
          if (session && this.isSessionCancelled(session)) {
            cancelledAny = true;
            continue;
          }
          if (result?.ok) {
            insertedAny = true;
            if (!result.direct) allDirect = false;
          } else if (result && !result.noText) {
            allDirect = false;
            // Preserve every failed final, including when another recovery is
            // already visible or the history write failed. No clipboard write
            // occurs until the user explicitly copies each queued entry.
            this.preserveRecoveryText(nextId, text, "insert-failed");
          }
        }
        if (session && !this.isSessionCancelled(session)) this.completeRecordingSession(session);
      }
    } finally {
      this.isFlushingInsertQueue = false;
    }

    if (!this.isRecording && !this.starting && !this.pendingInsertionOrder.length) {
      if (this.pendingRecoveryUi?.sessionId === this.recordingSessionId) {
        this.showRecoveryIfIdle();
        return;
      }
      if (cancelledAny && !insertedAny) return;
      // Best path: text already appeared in the focused field — close silently.
      if (insertedAny && allDirect) {
        this.hidePrompt();
        return;
      }
      this.updateShortcutHint(this.recordShortcut);
      if (insertedAny) {
        // A batch mixed inserted + failed items — brief acknowledgement.
        this.statusText.textContent = t("inputPrompt.textInserted");
        this.statusText.style.color = "var(--status-success)";
        this.scheduleHidePrompt(1200);
      } else {
        this.statusText.textContent = t("inputPrompt.noSpeech");
        this.statusText.style.color = "var(--status-warning)";
        this.scheduleHidePrompt(1500);
      }
    } else if (!this.isRecording && !this.starting) {
      this.updateStatusText();
    }
  }

  clearPendingInsertions() {
    this.pendingInsertionOrder = [];
    this.pendingInsertionsById.clear();
  }

  async acquireLocalTranscriptionSlot(recordingSession) {
    const previous = this.localTranscriptionTail || Promise.resolve();
    let release = null;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    // A cancelled waiter releases its own slot, but its successor still waits
    // for earlier work. Skipping a waiter must not break FIFO serialization.
    this.localTranscriptionTail = previous.then(() => released);
    try {
      if (recordingSession) {
        await this.waitForSessionStage(recordingSession, "finalize", () => previous, null);
      } else {
        await previous;
      }
    } catch (error) {
      release();
      throw error;
    }
    return release;
  }

  async hasReadyEngine() {
    this.engineBlocker = "";
    this.engineBlockerModel = null;
    try {
      const settings = await ipc.invoke("get-settings");
      if (!settings) {
        return true;
      }
      // Readiness is independent of the selected engine: a local selection
      // can still be waiting for its model download. No API keys leave Rust.
      this.engineBlocker = settings.engineBlocker || "";
      this.engineBlockerModel = settings.model || null;
      return settings.engineReady !== false;
    } catch (error) {
      console.error("Failed to check engine readiness before recording:", error);
      // Don't block recording on a settings-read failure — the backend will
      // still return a clear error if the key really is missing.
      return true;
    }
  }

  showApiKeyRequired() {
    this.clearHidePromptTimer();
    this.clearActualHideTimer();
    this.stopWaveAnimation();
    this.promptElement.classList.add("visible");
    this.promptElement.classList.remove("recording");
    this.promptText.textContent = t("inputPrompt.noApiKeyTitle");
    this.statusText.textContent = t("inputPrompt.noApiKey");
    this.statusText.style.color = "var(--status-warning-strong)";
    this.scheduleHidePrompt(2800);
  }

  showLocalModelMissing(model = this.currentModel) {
    this.localModelSetupModel = model || QWEN_LOCAL_MODEL_ID;
    this.showApiKeyRequired();
    this.promptElement.classList.add("engine-blocked");
    this.promptText.textContent = t("inputPrompt.localModelMissingTitle");
    this.statusText.textContent = t("inputPrompt.localModelMissing");
    if (this.waveContainer) this.waveContainer.style.display = "none";
    if (this.localModelBtn) {
      this.localModelBtn.textContent = t("inputPrompt.openLocalModel");
      this.localModelBtn.hidden = false;
    }
    this.scheduleHidePrompt(15000);
  }

  shouldUseNemotronLive(recordingSession) {
    return (
      (recordingSession?.provider ?? this.currentProvider) === "local" &&
      (recordingSession?.captureModel ?? this.currentModel) === NEMOTRON_LOCAL_MODEL_ID
    );
  }

  async beginNemotronLive(recordingSession, sampleRate) {
    await ipc.invoke(
      "start-live-transcription",
      recordingSession.id,
      Math.round(sampleRate)
    );
    const live = {
      sessionId: recordingSession.id,
      node: null,
      mutedOutput: null,
      uploadTail: Promise.resolve(),
      uploadError: null,
      pendingPcm: [],
      pendingPcmBytes: 0,
      stopped: false,
    };
    recordingSession.live = live;
    return live;
  }

  async setupNemotronLive(recordingSession, source) {
    if (!this.shouldUseNemotronLive(recordingSession)) {
      return;
    }
    if (!this.audioContext?.audioWorklet) {
      throw new Error("AudioWorklet is required for Nemotron live transcription");
    }

    await this.audioContext.audioWorklet.addModule("live-pcm-worklet.js");
    const live = await this.beginNemotronLive(recordingSession, this.audioContext.sampleRate);

    const node = new AudioWorkletNode(this.audioContext, "typealoud-pcm16-capture");
    const mutedOutput = this.audioContext.createGain();
    mutedOutput.gain.value = 0;
    live.node = node;
    live.mutedOutput = mutedOutput;

    node.port.onmessage = (event) => {
      if (live.stopped || !(event.data instanceof ArrayBuffer)) {
        return;
      }
      live.pendingPcm.push(new Uint8Array(event.data));
      live.pendingPcmBytes += event.data.byteLength;
      if (live.pendingPcmBytes >= 4096) {
        this.flushNemotronPcm(live);
      }
    };
    source.connect(node);
    node.connect(mutedOutput);
    mutedOutput.connect(this.audioContext.destination);
  }

  stopNemotronCapture(recordingSession) {
    const live = recordingSession?.live;
    if (!live || live.stopped) {
      return;
    }
    this.flushNemotronPcm(live);
    live.stopped = true;
    if (live.node) {
      live.node.port.onmessage = null;
    }
    try {
      live.node?.disconnect();
      live.mutedOutput?.disconnect();
    } catch {
      // The AudioContext may already be closing.
    }
  }

  flushNemotronPcm(live) {
    if (!live?.pendingPcmBytes) {
      return;
    }
    const bytes = new Uint8Array(live.pendingPcmBytes);
    let offset = 0;
    for (const chunk of live.pendingPcm) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    live.pendingPcm = [];
    live.pendingPcmBytes = 0;
    live.uploadTail = live.uploadTail
      .then(() => live.cancelled ? undefined : ipc.invoke("push-live-audio", bytes, live.sessionId))
      .catch((error) => {
        live.uploadError = error;
      });
  }

  async finishNemotronLive(recordingSession) {
    const live = recordingSession?.live;
    if (!live) {
      throw new Error("Nemotron realtime session was not initialized");
    }
    await live.uploadTail;
    this.assertSessionActive(recordingSession);
    if (live.cancelled) throw new Error("TRANSCRIPTION_CANCELLED");
    if (live.uploadError) {
      throw live.uploadError;
    }
    return ipc.invoke("finish-live-transcription", live.sessionId,
      ...(recordingSession.captureIncomplete ? [true] : []));
  }

  cancelNemotronLive(recordingSession) {
    const sessionId = recordingSession?.live?.sessionId;
    if (sessionId == null) {
      return;
    }
    recordingSession.live.cancelled = true;
    recordingSession.live.pendingPcm = [];
    recordingSession.live.pendingPcmBytes = 0;
    void ipc.invoke("cancel-live-transcription", sessionId).catch(() => {});
  }


  // ---- Chunked local (Qwen) capture -------------------------------------
  //
  // Qwen3-ASR is encoder-decoder: a whole clip is encoded before token 1, so on
  // the unchunked path every second of decoding lands AFTER the user releases
  // the key (~7 s for a 5-minute dictation, ~27 s at 13 minutes, and outright
  // failure past that when audio tokens overflow the context cap). Cutting the
  // live audio at quiet points during recording moves all but the final chunk
  // off that tail, so the wait after release is one chunk regardless of how long
  // the user spoke.
  //
  // Fail-open by design: if live capture cannot be set up, `chunked` stays unset
  // and processRecording takes the original whole-clip path.

  shouldUseChunkedLocal(recordingSession) {
    return (
      (recordingSession?.provider ?? this.currentProvider) === "local" &&
      (recordingSession?.captureModel ?? this.currentModel) !== NEMOTRON_LOCAL_MODEL_ID &&
      !!window.TypeAloudChunk
    );
  }

  createChunkedSession(recordingSession, sampleRate) {
    const chunked = {
      sessionId: recordingSession.id,
      sampleRate,
      node: null,
      mutedOutput: null,
      blocks: [],
      blockSamples: 0,
      state: window.TypeAloudChunk.createChunkState(),
      previousLoudRef: 0,
      nextChunkIndex: 0,
      results: [],
      failedChunks: 0,
      queue: Promise.resolve(),
      livePartial: null,
      aborted: false,
      stopped: false,
      recordingSession,
      // All custody counters use the capture rate, before WAV resampling.
      accounting: {
        acceptedSamples: 0,
        queuedSamples: 0,
        submittedSamples: 0,
        completedSamples: 0,
        queuedChunks: 0,
        submittedChunks: 0,
        completedChunks: 0,
        startedAt: performance.now(),
        lastPcmAt: null,
        stopRequestedAt: null,
        sealedAt: null,
      },
    };
    recordingSession.chunked = chunked;
    return chunked;
  }

  consumeChunkedSamples(recordingSession, samples) {
    const chunked = recordingSession?.chunked;
    if (!chunked || chunked.stopped || chunked.aborted || !samples.length) {
      return;
    }
    pushOnsetBlock(recordingSession.onsetProbe, samples, recordingSession.audioContext);
    chunked.accounting.acceptedSamples += samples.length;
    chunked.accounting.lastPcmAt = performance.now();
    chunked.blocks.push(samples);
    chunked.blockSamples += samples.length;
    window.TypeAloudChunk.pushFrame(
      chunked.state,
      window.TypeAloudChunk.frameRms(samples),
      samples.length
    );
    const cut = window.TypeAloudChunk.decideCut(chunked.state, chunked.sampleRate);
    if (cut) {
      this.closeChunk(chunked, cut.cutAtSample, cut.reason);
    }
  }

  reportChunkProbe(chunked, event, reason, metadata = {}, slow = false) {
    // Numeric custody metadata only: never include PCM, text, or error messages.
    // Even formatting a diagnostic must not interrupt capture or decoding.
    try {
      const a = chunked.accounting;
      const session = chunked.recordingSession || { id: chunked.sessionId };
      const now = performance.now();
      const stopAt = a.stopRequestedAt ?? a.sealedAt ?? now;
      const gapAt = a.sealedAt ?? now;
      this.reportAudioProbe(session, "chunk", [
        `event=${event}`, `reason=${reason}`, `session=${chunked.sessionId}`,
        `chunk=${metadata.chunkIndex ?? -1}`, `rate=${chunked.sampleRate}`,
        `hold_ms=${Math.max(0, Math.round(stopAt - a.startedAt))}`,
        `last_pcm_gap_ms=${a.lastPcmAt === null ? -1 : Math.max(0, Math.round(gapAt - a.lastPcmAt))}`,
        `start=${metadata.start ?? -1}`, `end=${metadata.end ?? -1}`,
        `input_samples=${metadata.inputSamples ?? 0}`,
        `wav_bytes=${metadata.wavBytes ?? -1}`, `wav_frames=${metadata.wavFrames ?? -1}`,
        `chars=${metadata.chars ?? -1}`,
        `accepted=${a.acceptedSamples}`, `buffered=${chunked.blockSamples}`,
        `queued=${a.queuedSamples}`, `submitted=${a.submittedSamples}`,
        `completed=${a.completedSamples}`,
        `queued_chunks=${a.queuedChunks}`, `submitted_chunks=${a.submittedChunks}`,
        `completed_chunks=${a.completedChunks}`,
        `native_samples=${session.nativeCapture?.sampleCount ?? -1}`,
        `stopped=${Number(chunked.stopped)}`,
      ].join(" "), slow);
    } catch {
      // Diagnostics remain best effort even during teardown.
    }
  }

  async setupChunkedLocal(recordingSession, source) {
    if (!this.shouldUseChunkedLocal(recordingSession)) {
      return;
    }
    let chunked = null;
    try {
      if (!this.audioContext?.audioWorklet) {
        throw new Error("AudioWorklet is required for chunked local transcription");
      }
      await this.audioContext.audioWorklet.addModule("live-pcm-worklet.js");

      chunked = this.createChunkedSession(
        recordingSession,
        this.audioContext.sampleRate
      );

      // "f32" keeps the original float samples: each closed chunk is resampled
      // to 16 kHz through an OfflineAudioContext, so a round trip through Int16
      // here would quantize twice for nothing.
      const node = new AudioWorkletNode(this.audioContext, "typealoud-pcm16-capture", {
        processorOptions: { format: "f32" },
      });
      const mutedOutput = this.audioContext.createGain();
      mutedOutput.gain.value = 0;
      chunked.node = node;
      chunked.mutedOutput = mutedOutput;

      node.port.onmessage = (event) => {
        if (chunked.stopped || chunked.aborted || !(event.data instanceof ArrayBuffer)) {
          return;
        }
        this.consumeChunkedSamples(recordingSession, new Float32Array(event.data));
      };

      source.connect(node);
      node.connect(mutedOutput);
      mutedOutput.connect(this.audioContext.destination);
      if (recordingSession.onsetProbe) {
        recordingSession.onsetProbe.connectedAtMs =
          performance.now() - recordingSession.onsetProbe.originMs;
      }
      recordingSession.chunked = chunked;
    } catch (error) {
      // Never abort a recording over this: the whole-clip path still works, it
      // just pays the old tail latency.
      chunked?.node?.disconnect?.();
      chunked?.mutedOutput?.disconnect?.();
      if (recordingSession.chunked === chunked) {
        recordingSession.chunked = null;
      }
      console.warn("chunked local capture unavailable; using the whole-clip path:", error);
    }
  }

  // Split the buffered blocks at `cutAtSample`, hand the head off to decode, and
  // carry the tail over as the opening of the next chunk.
  closeChunk(chunked, requestedCut, reason = "manual") {
    if (chunked.blocks.reduce((total, block) => total + block.length, 0) !== chunked.blockSamples) {
      throw new Error("Local chunk audio buffer sample mismatch");
    }
    const cutAtSample = Math.min(requestedCut, chunked.blockSamples);
    const head = new Float32Array(cutAtSample);
    const tail = [];
    let offset = 0;
    for (const block of chunked.blocks) {
      const start = offset;
      offset += block.length;
      if (offset <= head.length) {
        head.set(block, start);
      } else if (start >= head.length) {
        tail.push(block);
      } else {
        const split = head.length - start;
        head.set(block.subarray(0, split), start);
        tail.push(block.slice(split));
      }
    }
    chunked.blocks = tail;
    chunked.blockSamples = tail.reduce((total, block) => total + block.length, 0);
    const quietRemainder = reason === "release" && chunked.previousLoudRef > 0 &&
      window.TypeAloudChunk.loudSamples(chunked.state, chunked.previousLoudRef) <
        REMAINDER_QUIET_LOUD_S * chunked.sampleRate;
    chunked.previousLoudRef = chunked.state.loudRef;
    chunked.state = window.TypeAloudChunk.stateAfterCut(chunked.state, cutAtSample);
    if (head.length) {
      this.enqueueChunkDecode(chunked, head, reason, quietRemainder);
    }
  }

  enqueueChunkDecode(chunked, pcm, reason = "manual", quietRemainder = false) {
    const recordingSession = chunked.recordingSession ||
      this.recordingSessions?.get(chunked.sessionId) || { id: chunked.sessionId, chunked };
    this.ensureRecordingSession(recordingSession);
    const chunkIndex = chunked.nextChunkIndex++;
    const accounting = chunked.accounting;
    const metadata = {
      chunkIndex,
      start: accounting.queuedSamples,
      end: accounting.queuedSamples + pcm.length,
      inputSamples: pcm.length,
    };
    accounting.queuedSamples += pcm.length;
    accounting.queuedChunks += 1;
    this.reportChunkProbe(chunked, "queued", reason, metadata);
    chunked.results[chunkIndex] = "";
    chunked.queue = chunked.queue.then(async () => {
      if (chunked.aborted) {
        return;
      }
      if (reason === "release" && chunkIndex > 0 &&
        (quietRemainder || pcm.length <= REMAINDER_VAD_MAX_S * chunked.sampleRate) &&
        await this.remainderIsSilent(pcm, chunked.sampleRate)) {
        if (chunked.aborted) return;
        accounting.submittedSamples += pcm.length;
        accounting.submittedChunks += 1;
        accounting.completedSamples += pcm.length;
        accounting.completedChunks += 1;
        this.reportChunkProbe(chunked, "request-result", "no-speech", { ...metadata, chars: 0 });
        return;
      }
      try {
        const wav = await this.waitForSessionStage(recordingSession, "resample",
          () => this.encodeChunkWav(pcm, chunked.sampleRate), AUDIO_STAGE_TIMEOUT_MS, chunkIndex);
        if (chunked.aborted) {
          return;
        }
        // encodeChunkWav emits a standard PCM16 mono WAV. Inspect only its
        // header for diagnostics; never equate resampled frames with input PCM.
        try {
          metadata.wavBytes = wav.byteLength;
          if (wav.byteLength >= 44) {
            const header = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
            const frameBytes = header.getUint16(32, true);
            if (frameBytes > 0 && header.getUint32(40, true) + 44 === wav.byteLength) {
              metadata.wavFrames = header.getUint32(40, true) / frameBytes;
            }
          }
        } catch {
          // Header diagnostics do not affect an otherwise valid request.
        }
        chunked.inFlightChunkIndex = chunkIndex;
        const text = await this.waitForSessionStage(recordingSession, "chunk-ipc", () => {
          const request = ipc.invoke("transcribe-audio", wav, "audio/wav",
            chunked.sessionId, chunkIndex, undefined, undefined, recordingSession.provider);
          accounting.submittedSamples += pcm.length;
          accounting.submittedChunks += 1;
          this.reportChunkProbe(chunked, "request-start", reason, metadata);
          return request;
        }, TRANSCRIPTION_STAGE_TIMEOUT_MS, chunkIndex);
        if (chunked.aborted || this.isSessionCancelled(recordingSession)) return;
        chunked.results[chunkIndex] = typeof text === "string" ? text : "";
        accounting.completedSamples += pcm.length;
        accounting.completedChunks += 1;
        let chars = 0;
        for (const _ of chunked.results[chunkIndex]) chars += 1;
        this.reportChunkProbe(chunked, "request-result", "complete", {
          ...metadata, chars,
        });
        // Keep this recording's worker due for its successor. Reset-safe
        // runtimes retain the same process; one-audio runtimes replace it. The
        // true final chunk has neither condition and leaves no unused process.
        this.prewarmQwenWorker(recordingSession, {
          successorQueued: chunked.nextChunkIndex > chunkIndex + 1,
        });
      } catch (error) {
        this.reportChunkProbe(chunked, "request-result",
          this.isSessionCancelled(recordingSession) || chunked.aborted ? "cancelled" : "error",
          metadata, true);
        if (this.isSessionCancelled(recordingSession) || chunked.aborted) return;
        // Never label or insert a join with a missing chunk as a complete final.
        // Preserve successful chunks for explicit Copy instead, and stop queued
        // work so a failed stage cannot hold later recordings behind this one.
        chunked.failedChunks += 1;
        chunked.failure = error;
        chunked.aborted = true;
        chunked.cancelSent = true;
        chunked.blocks = [];
        chunked.blockSamples = 0;
        void ipc.invoke("cancel-transcription", chunked.sessionId).catch(() => {});
        console.warn(`local chunk ${chunkIndex} failed to decode:`, error);
      } finally {
        if (chunked.inFlightChunkIndex === chunkIndex) chunked.inFlightChunkIndex = null;
      }
      if (chunked.livePartial?.index === chunkIndex) {
        chunked.livePartial = null;
      }
      this.renderChunkedPreview(chunked);
    });
  }

  // True only when the VAD positively finds no speech. Any failure, a missing
  // VAD or a slow verdict fails open to decoding, which is the old behavior.
  async remainderIsSilent(pcm, sampleRate) {
    const gate = window.TypeAloudVadGate;
    if (typeof gate?.hasSpeech !== "function") return false;
    let timer = null;
    try {
      const verdict = (async () => gate.hasSpeech(await this.resampleTo16k(pcm, sampleRate)))();
      verdict.catch(() => {}); // a rejection after the timeout won the race is moot
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(true), REMAINDER_VAD_TIMEOUT_MS);
      });
      return (await Promise.race([verdict, timeout])) === false;
    } catch (error) {
      console.warn("remainder VAD failed; decoding it anyway:", error);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // Chunks reach Qwen the same way whole clips already do: resampled to 16 kHz
  // mono by WebKit's own resampler (the OfflineAudioContext call vad-gate.js has
  // shipped all along) and written as PCM16 WAV. Reusing that path keeps chunk
  // audio identical in provenance to what the model is fed today.
  async encodeChunkWav(pcm, sampleRate) {
    const pcm16k = await this.resampleTo16k(pcm, sampleRate);
    return window.TypeAloudVad.encodeWavPcm16(pcm16k, 16000);
  }

  async resampleTo16k(pcm, sampleRate) {
    if (sampleRate === 16000) {
      return pcm;
    }
    const length = Math.max(1, Math.ceil((pcm.length * 16000) / sampleRate));
    const offline = new OfflineAudioContext(1, length, 16000);
    const buffer = offline.createBuffer(1, pcm.length, sampleRate);
    buffer.copyToChannel(pcm, 0);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  // Finalized chunks plus the in-flight chunk's streaming text. Preview only —
  // the assembled final from finishChunkedLocal is what gets inserted.
  renderChunkedPreview(chunked) {
    if (chunked.aborted || (this.recordingSessionId > 0 &&
      chunked.sessionId !== this.recordingSessionId)) {
      return;
    }
    const parts = chunked.results.slice();
    if (chunked.livePartial) {
      parts[chunked.livePartial.index] = chunked.livePartial.text;
    }
    const text = window.TypeAloudChunk.joinChunkTexts(parts);
    if (text) {
      this.setTranscriptionPreview(text);
    }
  }

  stopChunkedCapture(recordingSession, { flush = true } = {}) {
    const chunked = recordingSession?.chunked;
    if (!chunked || chunked.stopped) {
      return;
    }
    chunked.stopped = true;
    chunked.accounting.sealedAt = performance.now();
    if (chunked.node) {
      chunked.node.port.onmessage = null;
    }
    try {
      chunked.node?.disconnect();
      chunked.mutedOutput?.disconnect();
    } catch {
      // The AudioContext may already be closing.
    }
    // Everything since the last cut becomes the final chunk — unless the user
    // cancelled, in which case decoding it would only be killed moments later.
    if (flush && chunked.blockSamples > 0 && !chunked.aborted) {
      this.closeChunk(chunked, chunked.blockSamples, "release");
    }
    this.reportChunkProbe(chunked, "seal", flush ? "release" : "cancelled");
    this.reportAudioOnset(recordingSession);
  }

  async finishChunkedLocal(recordingSession) {
    const chunked = recordingSession?.chunked;
    if (!chunked) {
      throw new Error("chunked local session was not initialized");
    }
    await chunked.queue;
    if (this.isSessionCancelled(recordingSession)) {
      this.reportChunkProbe(chunked, "final", "cancelled");
    }
    this.assertSessionActive(recordingSession);
    const text = window.TypeAloudChunk.joinChunkTexts(chunked.results);
    // Silence is legitimate; a missing chunk is not a complete dictation.
    if (chunked.failedChunks > 0) {
      this.reportChunkProbe(chunked, "final", "decode-error", {}, true);
      throw chunked.failure || new Error("local chunked transcription incomplete");
    }
    if (!recordingSession.captureIncomplete) {
      const a = chunked.accounting;
      const capture = recordingSession.nativeCapture;
      const covered = a && chunked.stopped && !chunked.aborted &&
        chunked.blockSamples === 0 && chunked.blocks.length === 0 &&
        [a.acceptedSamples, a.queuedSamples, a.submittedSamples, a.completedSamples,
          a.queuedChunks, a.submittedChunks, a.completedChunks].every(Number.isSafeInteger) &&
        a.acceptedSamples === a.queuedSamples && a.queuedSamples === a.submittedSamples &&
        a.submittedSamples === a.completedSamples &&
        a.queuedChunks === chunked.nextChunkIndex && a.queuedChunks === a.submittedChunks &&
        a.submittedChunks === a.completedChunks &&
        (!capture || (capture.stopped && !capture.accepting && capture.sampleCount === a.acceptedSamples));
      if (!covered) {
        this.reportChunkProbe(chunked, "final", "coverage-mismatch", {}, true);
        throw new Error("Local chunk audio coverage incomplete");
      }
    }
    this.reportChunkProbe(chunked, "final", recordingSession.captureIncomplete ? "capture-incomplete" : "complete",
      {}, !!recordingSession.captureIncomplete);
    return text;
  }

  // Chunk decodes deliberately skip the history write, so the joined dictation
  // is recorded here as a single entry. Best-effort: a failed history write must
  // never cost the user their text, so fall back to the local join.
  async recordAssembledTranscription(text, recordingSession) {
    if (!text) {
      return text;
    }
    try {
      const recorded = recordingSession ? await this.waitForSessionStage(recordingSession, "history",
        () => ipc.invoke("record-assembled-transcription", text), HISTORY_STAGE_TIMEOUT_MS) :
        await ipc.invoke("record-assembled-transcription", text);
      return typeof recorded === "string" ? recorded : text;
    } catch (error) {
      if (recordingSession) {
        this.assertSessionActive(recordingSession);
        this.reportLifecycle(recordingSession, "history", "fallback");
      }
      console.warn("failed to record the assembled transcription in history:", error);
      return text;
    }
  }

  cancelChunkedLocal(recordingSession) {
    const chunked = recordingSession?.chunked;
    if (!chunked || chunked.cancelSent) {
      return;
    }
    chunked.cancelSent = true;
    chunked.aborted = true;
    chunked.blocks = [];
    chunked.blockSamples = 0;
    chunked.livePartial = null;
    void ipc.invoke("cancel-transcription", chunked.sessionId).catch(() => {});
  }

  shouldUseNativeCapture() {
    return this.osName === "macos";
  }

  async setupNativeConsumers(recordingSession) {
    if (this.shouldUseNemotronLive(recordingSession)) {
      await this.beginNemotronLive(recordingSession, 16000);
    }
    if (this.shouldUseChunkedLocal(recordingSession)) {
      this.createChunkedSession(recordingSession, 16000);
    }
  }

  createNativeCapture(recordingSession) {
    let resolveDone;
    const capture = {
      sessionId: recordingSession.id,
      sampleRate: 16000,
      pcmBlocks: [],
      sampleCount: 0,
      latestRms: 0,
      accepting: true,
      started: false,
      stopped: false,
      error: null,
      stats: null,
      stopPromise: null,
      done: new Promise((resolve) => {
        resolveDone = resolve;
      }),
      resolveDone: (stats) => {
        if (capture.stopped) return;
        capture.stopped = true;
        capture.stats = stats || null;
        resolveDone(stats || null);
      },
    };
    capture.channel = ipc.createChannel((message) => {
      this.consumeNativeCaptureMessage(recordingSession, message);
    });
    recordingSession.nativeCapture = capture;
    return capture;
  }

  consumeNativeCaptureMessage(recordingSession, message) {
    const capture = recordingSession?.nativeCapture;
    if (!capture) return;
    if (message instanceof ArrayBuffer || ArrayBuffer.isView(message)) {
      if (!capture.accepting) return;
      const source = message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      const length = source.byteLength - (source.byteLength % 2);
      if (!length) return;
      const bytes = source.slice(0, length);
      const samples = pcm16LeToFloat(bytes);
      capture.pcmBlocks.push(bytes);
      capture.sampleCount += samples.length;

      let sumSquares = 0;
      for (let index = 0; index < samples.length; index += 1) {
        sumSquares += samples[index] * samples[index];
      }
      capture.latestRms = Math.sqrt(sumSquares / samples.length);

      if (recordingSession.chunked) {
        this.consumeChunkedSamples(recordingSession, samples);
      } else {
        pushOnsetBlock(recordingSession.onsetProbe, samples, null);
      }
      const live = recordingSession.live;
      if (live && !live.stopped && !live.cancelled) {
        live.pendingPcm.push(bytes);
        live.pendingPcmBytes += bytes.byteLength;
        if (live.pendingPcmBytes >= 4096) {
          this.flushNemotronPcm(live);
        }
      }
      return;
    }

    if (!message || typeof message !== "object") return;
    if (message.event === "error") {
      capture.error = new Error(message.message || "Native microphone stream failed");
      if (this.isRecording && this.activeRecordingSession === recordingSession) {
        setTimeout(() => {
          if (this.isRecording && this.activeRecordingSession === recordingSession) {
            this.stopRequested = true;
            this.stopRecording();
          }
        }, 0);
      }
    } else if (message.event === "stopped") {
      capture.resolveDone(message.stats);
    }
  }

  async finishNativeCapture(recordingSession, { flush = true } = {}) {
    const capture = recordingSession?.nativeCapture;
    if (!capture) return;
    if (capture.stopPromise) return capture.stopPromise;
    capture.stopPromise = (async () => {
      let timeoutId;
      let commandStats = null;
      let integrityReason = "complete";
      try {
        // Bound both IPC completion and channel drainage. A missing IPC reply
        // must not prevent finalization or block every subsequent recording.
        const stopped = Promise.resolve()
          .then(() => ipc.invoke("stop-native-capture", capture.sessionId))
          .then(async (stats) => {
            commandStats = stats;
            capture.releaseConfirmed = true;
            await capture.done;
            return stats;
          });
        const stats = await Promise.race([
          stopped,
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(nativeCaptureError({
              code: "NATIVE_CAPTURE_STOP_TIMEOUT", message: "Native capture stop timed out",
            })),
              NATIVE_CAPTURE_STOP_TIMEOUT_MS);
          }),
        ]);
        if (stats?.channelSendFailures > 0 ||
          (Number.isFinite(stats?.outputSamples) && stats.outputSamples !== capture.sampleCount)) {
          integrityReason = stats?.channelSendFailures > 0 ? "channel-send-failure" : "sample-mismatch";
          capture.error ||= new Error("Native audio delivery was incomplete");
        }
      } catch (error) {
        capture.stopError = nativeCaptureError(error);
        capture.error ||= capture.stopError;
      } finally {
        clearTimeout(timeoutId);
      }
      // Closing acceptance before finalization also rejects PCM arriving after
      // a timeout. Do not label that local deadline as a native stopped ACK.
      recordingSession.captureIncomplete = !!capture.error;
      capture.accepting = false;
      const finalStats = commandStats || capture.stats;
      if (integrityReason === "complete" && capture.error) {
        integrityReason = capture.stopError ? "stop-failure" : "stream-error";
      }

      try {
        // A consumer teardown failure must not skip the other consumer or the
        // recovery WAV. Already queued decodes remain eligible for recovery.
        for (const finish of [
          () => this.stopNemotronCapture(recordingSession),
          () => this.stopChunkedCapture(recordingSession, { flush }),
        ]) {
          try { finish(); } catch (error) {
            recordingSession.finalizationError ||= error;
            recordingSession.captureIncomplete = true;
            integrityReason = "consumer-finalization-failure";
          }
        }

        try { this.reportAudioOnset(recordingSession); } catch (error) {
          console.warn("Native capture diagnostics failed:", error);
        }

        if (flush && capture.sampleCount > 0) {
          const wav = encodePcm16LeWav(
            capture.pcmBlocks,
            capture.sampleCount,
            capture.sampleRate
          );
          recordingSession.chunks.push(new Blob([wav], { type: "audio/wav" }));
          recordingSession.mimeType = "audio/wav";
          if (recordingSession.captureIncomplete && !this.isSessionCancelled(recordingSession)) {
            recordingSession.captureRecoveryWav = wav;
          }
        } else if (flush) {
          recordingSession.finalizationError = capture.error || new Error("No native audio captured");
          recordingSession.captureIncomplete = true;
          integrityReason = "no-audio";
        }
      } catch (error) {
        recordingSession.finalizationError ||= error;
        recordingSession.captureIncomplete = true;
        integrityReason = "wav-encoding-failure";
        throw error;
      } finally {
        capture.pcmBlocks = [];
        if (this.nativeCapture === capture) this.nativeCapture = null;
        // Report the final decision after consumer teardown and WAV encoding.
        // Diagnostics must never prevent resource release or result recovery.
        try {
          this.reportAudioProbe(recordingSession, "capture", [
            "path=native", `reason=${integrityReason}`,
            `incomplete=${!!recordingSession.captureIncomplete}`,
            `out_samples=${finalStats?.outputSamples ?? "unknown"}`,
            `recv_samples=${capture.sampleCount}`,
            `channel_failures=${finalStats?.channelSendFailures ?? "unknown"}`,
            `error_code=${capture.stopError?.code || "none"}`,
          ].join(" "), !!recordingSession.captureIncomplete);
          if (flush) this.reportLifecycle(recordingSession, "capture",
            recordingSession.captureIncomplete ? "error" : "complete");
        } catch (error) {
          console.warn("Native integrity diagnostics failed:", error);
        }
      }
    })();
    return capture.stopPromise;
  }

  async startNativeRecording(startupTiming, startupStartedAt, preflightReadyAt, captureEngine = {
    provider: this.currentProvider || "local",
    model: this.currentModel,
  }) {
    // Serialize normal release/start transitions. The preceding stop has a
    // bounded wait; Rust retains ownership if the device is still stopping.
    // Hotkey release only arms STOP_DEBOUNCE; the stop is dispatched about
    // 250 ms later. A re-press just beyond that deadline can overlap its stop,
    // so debounce alone does not serialize device release and the next start.
    const previous = this.nativeCapture;
    if (previous?.stopPromise) {
      try {
        await previous.stopPromise;
      } catch {
        // Its own path preserves audio and reports the failure. Rust will
        // reject the next start if device release is still outstanding.
      }
    }
    this.statusText.textContent = "";
    if (!this.pendingInsertionOrder.length && this.transcriptionInProgressCount === 0) {
      this.clearTranscriptionPreview();
    }
    const captureStartedAt = performance.now();
    const sessionId = ++this.recordingSessionId;
    const onsetProbe = createOnsetProbe(16000, captureStartedAt);
    const recordingSession = {
      id: sessionId,
      chunks: [],
      mimeType: "audio/wav",
      qwenSession: captureEngine.provider === "local" &&
        captureEngine.model !== NEMOTRON_LOCAL_MODEL_ID,
      cancelledShortPress: false,
      provider: captureEngine.provider,
      captureModel: captureEngine.model,
      mediaStream: null,
      audioContext: null,
      onsetProbe,
    };
    const capture = this.createNativeCapture(recordingSession);
    this.ensureRecordingSession(recordingSession);
    this.reportLifecycle(recordingSession, "capture", "start");
    this.activeRecordingSession = recordingSession;
    this.pendingInsertionOrder.push(sessionId);
    this.audioChunks = recordingSession.chunks;
    this.recordingMimeType = "audio/wav";

    try {
      await this.setupNativeConsumers(recordingSession);
      onsetProbe.connectedAtMs = performance.now() - onsetProbe.originMs;
      const info = await ipc.invoke(
        "start-native-capture",
        sessionId,
        this.currentMicrophone || "default",
        capture.channel
      );
      capture.started = true;
      capture.info = info;
      if (capture.error || capture.stopped) {
        throw capture.error || new Error("Native capture stopped during startup");
      }
    } catch (error) {
      // Native capture is macOS's better path, not its only one — the WebKit
      // path is still compiled in for Windows/Linux. A Mac where CoreAudio
      // cannot open (device busy, an unusual format, a permission edge) should
      // fall back and pay the 3.0 s attenuation on this one dictation rather
      // than lose it outright. This mirrors the chunked-local path, which
      // likewise refuses to abort a recording over its own optimization.
      this.cancelRecordingSession(recordingSession);
      // Resolve first: finishNativeCapture otherwise waits for a "stopped"
      // event that a stream which never started will never send. The stop
      // invoke below is issued regardless of capture.started, because a start
      // whose response was lost can still have left a live session in Rust,
      // and that would block every later recording.
      capture.resolveDone(null);
      try {
        await this.finishNativeCapture(recordingSession, { flush: false });
      } catch {
        // Teardown is best-effort; the fallback matters more than its tidiness.
      }
      // A timed-out native operation may still own CoreAudio. Do not open a
      // competing WebKit stream until release is known; the next native start
      // can reap the old handle once its thread actually exits.
      const startError = nativeCaptureError(error);
      const releaseKnown = capture.releaseConfirmed || capture.stopError?.deviceReleased === true ||
        capture.stopError?.code === "NATIVE_CAPTURE_NOT_ACTIVE";
      if (startError.code === "NATIVE_CAPTURE_START_TIMEOUT") throw startError;
      if (startError.code === "NATIVE_CAPTURE_BUSY" || !releaseKnown) {
        throw capture.stopError || startError;
      }
      this.reportAudioProbe(recordingSession, "capture", [
        "path=native",
        "outcome=failed",
        "fallback=webkit",
        `error=${String(error?.message || error).replace(/\s+/g, "_").slice(0, 120)}`,
      ].join(" "), true);
      return false;
    }
    const microphoneReadyAt = performance.now();

    if (this.stopRequested) {
      this.cancelRecordingSession(recordingSession);
      await this.finishNativeCapture(recordingSession, { flush: false });
      this.scheduleHidePrompt(300);
      return true;
    }

    const info = capture.info || {};
    this.reportAudioProbe(recordingSession, "capture", [
      `device=${String(info.device || "?").replace(/\s+/g, "_")}`,
      `rate=${info.inputRate}`,
      `channels=${info.channels}`,
      `format=${info.sampleFormat}`,
      `target_rate=${capture.sampleRate}`,
      `path=native`,
      `mic_ms=${Math.round(microphoneReadyAt - preflightReadyAt)}`,
    ].join(" "), false);
    this.nativeCapture = capture;

    this.promptElement.classList.add("visible", "recording");
    this.promptText.textContent = this.recordingPromptText();
    this.recordingStartedAt = Date.now();
    this.cancelledShortPress = false;
    this.isRecording = true;
    this.startWaveAnimation();
    this.startRecordingTimer();

    const setupReadyAt = performance.now();
    requestAnimationFrame((paintedAt) => {
      const nativeMs = nonNegativeMilliseconds(Number(startupTiming.nativeMs));
      const eventDeliveryMs = nonNegativeMilliseconds(Number(startupTiming.eventDeliveryMs));
      const frontendMs = nonNegativeMilliseconds(paintedAt - startupStartedAt);
      const endToEndMs = nativeMs + eventDeliveryMs + frontendMs;
      void ipc.invoke("report-recording-startup", {
        recordingNumber: sessionId,
        uptimeMs: nonNegativeMilliseconds(startupStartedAt - this.pageStartedAt),
        nativeMs,
        eventDeliveryMs,
        preflightMs: nonNegativeMilliseconds(preflightReadyAt - startupStartedAt),
        microphoneMs: nonNegativeMilliseconds(microphoneReadyAt - preflightReadyAt),
        setupMs: nonNegativeMilliseconds(setupReadyAt - microphoneReadyAt),
        renderMs: nonNegativeMilliseconds(paintedAt - setupReadyAt),
        frontendMs,
        endToEndMs,
      }).catch((error) => {
        if (isDev) console.warn("Failed to report recording startup timing:", error);
      });
      this.scheduleQwenPrewarm(recordingSession, endToEndMs);
    });

    if (this.stopRequested) this.stopRecording();
    return true;
  }

  async startRecording(startupTiming = {}) {
    if (this.isRecording || this.starting) return;

    // A prior Escape may have cancelled an older transcription without hiding
    // the prompt yet. A new recording is a fresh operation and must not inherit
    // that cancellation state when stopRecording decides whether to process it.
    this.cancelInProgress = false;
    this.cancelGateToken = null;
    const startupStartedAt = performance.now();
    this.clearHidePromptTimer();
    this.clearActualHideTimer();
    this.tapInsertCandidate = hasMeaningfulText(this._failedText) ? this._failedText : null;
    this.recordingLockId = null;
    this.lockTipShown = false;
    this.clearInsertFailedUi();
    this.retryRecoveryPersistence();
    this.starting = true;
    try {
      // Tell the user what is missing before opening the microphone.
      if (!(await this.hasReadyEngine())) {
        if (this.engineBlocker === "local-model-missing") this.showLocalModelMissing(this.engineBlockerModel);
        else this.showApiKeyRequired();
        return;
      }
      const preflightReadyAt = performance.now();

      if (this.settingsReady) {
        await this.settingsReady;
      }
      // Freeze the route before opening the microphone. Settings may change
      // while native startup, getUserMedia, or AudioContext.resume is pending.
      // The model snapshot selects capture consumers only; Rust still selects
      // the current model within this session's provider at transcription time.
      const captureEngine = {
        provider: this.currentProvider || "local",
        model: this.currentModel,
      };
      if (this.shouldUseNativeCapture()) {
        // false means native capture could not start; fall through to the
        // WebKit path below rather than failing the dictation.
        const handled = await this.startNativeRecording(
          startupTiming,
          startupStartedAt,
          preflightReadyAt,
          captureEngine
        );
        if (handled) return;
      }

      // Do NOT reveal the prompt during "starting": the window appearing is the
      // signal users act on, and if it shows before the mic is actually open
      // they start talking while getUserMedia is still spinning up and lose the
      // first words. We only prep state here; the prompt is revealed (straight
      // into the Listening state) after getUserMedia resolves below.
      this.statusText.textContent = "";
      if (!this.pendingInsertionOrder.length && this.transcriptionInProgressCount === 0) {
        this.clearTranscriptionPreview();
      }

      // Each dictation opens its own stream and cleanup() stops it on release,
      // so the OS microphone indicator and Bluetooth call mode last only while
      // the hotkey is held. macOS normally records natively (above) and reaches
      // this path only when native capture could not start.
      const stream = this.osName === "windows"
        ? await window.TypeAloudMicrophone.open(ipc, this.osName, AUDIO_CONSTRAINTS)
        : await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
      const microphoneReadyAt = performance.now();

      if (this.stopRequested) {
        // Cancelled while the microphone was opening: close it right away and
        // bail without clearing older work or hiding recoverable text.
        stream.getTracks().forEach((track) => track.stop());
        this.scheduleHidePrompt(300);
        return;
      }

      this.mediaStream = stream;

      // Setup audio context for visualization
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();
      // WebKit reports "suspended" here on every recording, because this window
      // is raised by the Rust event tap and no user gesture ever reaches the
      // webview. That state is NOT the cause of anything: measured with this
      // resume() removed, audio still arrives from ~8 ms and the envelope is
      // identical, so WebKit auto-starts a context fed by a live capture source
      // and the suspension is transient. Kept as belt-and-braces only — relying
      // on an undocumented auto-start would be fragile — not as a fix.
      const audioContextStateBefore = this.audioContext.state;
      let audioContextResumeMs = 0;
      if (this.audioContext.state === "suspended") {
        const resumeStartedAt = performance.now();
        try {
          await this.audioContext.resume();
        } catch (error) {
          if (isDev) console.warn("AudioContext resume failed:", error);
        }
        audioContextResumeMs = performance.now() - resumeStartedAt;
      }
      const audioTrack = this.mediaStream.getAudioTracks?.()[0];
      const trackSettings = audioTrack?.getSettings ? audioTrack.getSettings() : {};
      const onsetProbe = createOnsetProbe(this.audioContext.sampleRate, microphoneReadyAt);
      this.onsetProbe = onsetProbe;
      const source = this.audioContext.createMediaStreamSource(
        this.mediaStream
      );
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      // Time-domain samples (one per fftSize) — used to compute a per-frame
      // volume (RMS) for the scrolling waveform, not a frequency spectrum.
      this.dataArray = new Uint8Array(this.analyser.fftSize);

      // Setup media recorder
      // Try to use the best supported format, fallback to webm
      let mimeType = "audio/webm;codecs=opus"; // Default fallback
      if (MediaRecorder.isTypeSupported("audio/mp4")) {
        mimeType = "audio/mp4"; // Better compression than WebM, widely supported
      } else if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        mimeType = "audio/webm;codecs=opus"; // Good compression, modern browsers
      }
      
      if (isDev) console.log("Using audio format:", mimeType);
      // Keep per-recording state so overlapping recordings don't clobber each other.
      const sessionId = ++this.recordingSessionId;
      const recordingSession = {
        id: sessionId,
        chunks: [],
        mimeType: mimeType,
        qwenSession: captureEngine.provider === "local" &&
          captureEngine.model !== NEMOTRON_LOCAL_MODEL_ID,
        cancelledShortPress: false,
        provider: captureEngine.provider,
        captureModel: captureEngine.model,
        mediaStream: this.mediaStream,
        audioContext: this.audioContext,
        onsetProbe,
      };
      this.ensureRecordingSession(recordingSession);
      this.reportLifecycle(recordingSession, "capture", "start");
      this.reportAudioProbe(recordingSession, "capture", [
        `device=${String(audioTrack?.label || "?").replace(/\s+/g, "_")}`,
        `rate=${trackSettings.sampleRate}`,
        `channels=${trackSettings.channelCount}`,
        `ec=${trackSettings.echoCancellation}`,
        `ns=${trackSettings.noiseSuppression}`,
        `agc=${trackSettings.autoGainControl}`,
        `ctx_rate=${this.audioContext.sampleRate}`,
        `ctx_state_before=${audioContextStateBefore}`,
        `ctx_resume_ms=${Math.round(audioContextResumeMs)}`,
        `ctx_state_after=${this.audioContext.state}`,
        `mic_ms=${Math.round(microphoneReadyAt - preflightReadyAt)}`,
      ].join(" "), audioContextStateBefore !== "running");
      this.activeRecordingSession = recordingSession;
      this.pendingInsertionOrder.push(sessionId);
      this.audioChunks = recordingSession.chunks;
      this.recordingMimeType = mimeType; // Store for later use
      
      this.mediaRecorder = new MediaRecorder(this.mediaStream, {
        mimeType: mimeType,
      });
      recordingSession.mediaRecorder = this.mediaRecorder;

      this.mediaRecorder.ondataavailable = (event) => {
        const lifecycle = recordingSession.lifecycle;
        if (lifecycle.state === "cancelled") return;
        if (["completed", "failed"].includes(lifecycle.state) && !lifecycle.recoverLateRecorder) return;
        if (lifecycle.recoverLateRecorder && (recordingSession.audioRecovery?.blob || recordingSession.audioRecovery?.saved)) return;
        if (event.data.size > 0) {
          recordingSession.chunks.push(event.data);
          if (recordingSession.chunks.length === 1) this.reportLifecycle(recordingSession, "capture", "complete");
          if (lifecycle.recoverLateRecorder) {
            void this.adoptLateRecorderAudio(recordingSession);
          }
        }
      };

      this.mediaRecorder.onstop = () => {
        void this.finalizeRecordingSession(recordingSession);
      };
      this.mediaRecorder.onerror = () => {
        recordingSession.finalizationError = new Error("Audio recorder failed");
        this.reportLifecycle(recordingSession, "recorder-stop", "error");
        if (!this.isRecording || this.activeRecordingSession !== recordingSession) {
          void this.finalizeRecordingSession(recordingSession, "error");
        }
      };

      await this.setupNemotronLive(recordingSession, source);
      await this.setupChunkedLocal(recordingSession, source);

      // Reveal the prompt only after every selected engine is ready to receive
      // audio. The visible Listening state therefore never drops first words.
      this.promptElement.classList.add("visible", "recording");
      this.promptText.textContent = this.recordingPromptText();

      // No timeslice, and requestData() is never called: the recorder emits
      // exactly one dataavailable, carrying the complete container. Late-audio
      // recovery (adoptLateRecorderAudio) leans on that contract — introducing
      // a timeslice here would make a partial container look adoptable, and
      // decoding is a check, not a general proof of a finished recording.
      this.mediaRecorder.start();
      this.recordingStartedAt = Date.now();
      this.cancelledShortPress = false;
      this.isRecording = true;
      this.startWaveAnimation();
      this.startRecordingTimer();

      const setupReadyAt = performance.now();
      requestAnimationFrame((paintedAt) => {
        const nativeMs = nonNegativeMilliseconds(Number(startupTiming.nativeMs));
        const eventDeliveryMs = nonNegativeMilliseconds(Number(startupTiming.eventDeliveryMs));
        const frontendMs = nonNegativeMilliseconds(paintedAt - startupStartedAt);
        const endToEndMs = nativeMs + eventDeliveryMs + frontendMs;
        void ipc.invoke("report-recording-startup", {
          recordingNumber: sessionId,
          uptimeMs: nonNegativeMilliseconds(startupStartedAt - this.pageStartedAt),
          nativeMs,
          eventDeliveryMs,
          preflightMs: nonNegativeMilliseconds(preflightReadyAt - startupStartedAt),
          microphoneMs: nonNegativeMilliseconds(microphoneReadyAt - preflightReadyAt),
          setupMs: nonNegativeMilliseconds(setupReadyAt - microphoneReadyAt),
          renderMs: nonNegativeMilliseconds(paintedAt - setupReadyAt),
          frontendMs,
          endToEndMs,
        }).catch((error) => {
          if (isDev) console.warn("Failed to report recording startup timing:", error);
        });
        // First paint is complete, and probation discards accidental hotkeys
        // without allocating the model. The eventual request is fire-and-forget.
        this.scheduleQwenPrewarm(recordingSession, endToEndMs);
      });

      if (this.stopRequested) {
        this.stopRecording();
      }
    } catch (error) {
      console.error("Error starting recording:", error);
      if (this.activeRecordingSession) {
        this.cancelRecordingSession(this.activeRecordingSession);
      }
      await this.handleRecordingError(error);
    } finally {
      this.starting = false;
      if (!this.isRecording && this.recordingLockId != null) void this.releaseRecordingLock();
      if (this.stopRequested && !this.isRecording) {
        if (this.cancelInProgress) {
          // Keep cancellation latched until setup and stop have both finished;
          // releasing it while AudioWorklet setup awaits could submit the clip.
          this.deferCancelGateRelease(this.cancelGateToken, true);
        } else {
          void this.flushPendingInsertions();
        }
      }
    }
  }

  stopRecording() {
    if (!this.isRecording) {
      return;
    }

    this.isRecording = false;
    if (this.recordingLockId != null) void this.releaseRecordingLock();
    const recordingSession = this.activeRecordingSession;
    this.stopRecordingTimer();
    // Mis-trigger discarding now lives in the Rust hotkey layer, which measures
    // the real key-hold time (independent of mic cold-start). The frontend only
    // cancels when explicitly told to (Esc, or Rust's Cancel → cancelRecording).
    const shouldCancel = this.cancelledShortPress || this.cancelInProgress;
    this.cancelledShortPress = shouldCancel;
    let finalizeOnRelease = false;
    if (recordingSession) {
      recordingSession.cancelledShortPress = shouldCancel;
      const lifecycle = this.ensureRecordingSession(recordingSession);
      lifecycle.state = "waiting-stop";
      lifecycle.stopRequestedAt = Date.now();
      if (recordingSession.chunked) {
        recordingSession.chunked.accounting.stopRequestedAt = performance.now();
        this.reportChunkProbe(recordingSession.chunked, "stop", shouldCancel ? "cancelled" : "release");
      }
      this.reportLifecycle(
        recordingSession,
        recordingSession.nativeCapture ? "capture" : "recorder-stop",
        "start"
      );
      if (shouldCancel) {
        this.cancelRecordingSession(recordingSession);
      } else if (recordingSession.nativeCapture) {
        finalizeOnRelease = true;
      } else if (recordingSession.chunked || recordingSession.live) {
        // Chunked/live audio is captured through the AudioWorklet, and the
        // stop* calls below close the final segment — the whole set of segments
        // is known the moment the hotkey is released. The recorder's Blob is
        // not this session's audio, so its stop event adds nothing to wait for,
        // and waiting on it is exactly what wedged the prompt when WebKit
        // dropped that event. Finalize on release instead.
        finalizeOnRelease = true;
        // Purely diagnostic, and deliberately not cleared by the finalize
        // below: nothing waits on the recorder any more, but whether its stop
        // event ever arrives is still the open question from the original
        // stall. Only a real stop clears this.
        lifecycle.stopWatchTimer = setTimeout(() => {
          lifecycle.stopWatchTimer = null;
          this.reportLifecycle(recordingSession, "recorder-stop", "timeout",
            Date.now() - lifecycle.stopRequestedAt);
        }, RECORDER_STOP_TIMEOUT_MS);
      } else {
        // Whole-clip (cloud) dictation genuinely needs the recorder's
        // finished container, so it still waits: a warning at 2s, failure at 15s.
        lifecycle.stopTimer = setTimeout(() => {
          void this.finalizeRecordingSession(recordingSession, "timeout");
        }, RECORDER_STOP_TIMEOUT_MS);
        lifecycle.hardStopTimer = setTimeout(() => {
          void this.finalizeRecordingSession(recordingSession, "hard-timeout");
        }, BATCH_RECORDER_STOP_TIMEOUT_MS);
      }
    }

    if (shouldCancel) {
      this.promptText.textContent = t("inputPrompt.cancelled");
      this.statusText.textContent = "";
      this.clearTranscriptionPreview();
    } else {
      this.promptText.textContent = t(recordingSession?.nativeCapture?.error
        ? "inputPrompt.recordingInterrupted" : "inputPrompt.processing");
      this.statusText.textContent = t("inputPrompt.transcribing");
    }

    if (recordingSession?.nativeCapture) {
      this.cleanup({ preserveAudioChunks: true, recordingSession });
      this.stopWaveAnimation();
      void this.finishNativeCapture(recordingSession, { flush: !shouldCancel })
        .then(() => {
          if (!shouldCancel) {
            return this.finalizeRecordingSession(recordingSession, "release");
          }
        })
        .catch((error) => {
          recordingSession.finalizationError = error;
          if (!shouldCancel) {
            return this.finalizeRecordingSession(recordingSession, "error");
          }
        });
      this.flushPendingInsertions();
      if (shouldCancel) this.scheduleHidePrompt(300);
      return;
    }

    this.stopNemotronCapture(recordingSession);
    this.stopChunkedCapture(recordingSession, { flush: !shouldCancel });
    try {
      const recorder = recordingSession?.mediaRecorder || this.mediaRecorder;
      if (recorder?.state === "recording") recorder.stop();
    } catch {
      if (recordingSession) {
        recordingSession.finalizationError = new Error("Audio recorder failed to stop");
        void this.finalizeRecordingSession(recordingSession, "error");
      }
    }

    // Release the mic as soon as recording stops; we keep the recorded audio
    // chunks for transcription. The mic indicator only shows while recording.
    this.cleanup({ preserveAudioChunks: true, recordingSession });
    this.stopWaveAnimation();
    // The captures above have closed their final segment, so the queue this
    // joins is already complete. A late recorder stop finds processing under
    // way and returns the same promise instead of starting a second one.
    if (finalizeOnRelease) void this.finalizeRecordingSession(recordingSession, "release");
    this.flushPendingInsertions();
    if (shouldCancel) this.scheduleHidePrompt(300);
  }

  deferCancelGateRelease(token, flush = false) {
    void Promise.resolve().then(() => {
      if (this.cancelGateToken !== token) return;
      this.cancelGateToken = null;
      this.cancelInProgress = false;
      if (flush) return this.flushPendingInsertions();
    });
  }

  cancelRecording() {
    if (this.cancelInProgress) {
      return;
    }
    this.cancelInProgress = true;
    const cancelToken = {};
    const selectedRecoveryId = this.recoveryShownId;
    this.cancelGateToken = cancelToken;
    this.stopRequested = true;
    this.stopRecordingTimer();
    this.clearHidePromptTimer();
    this.clearActualHideTimer();
    // Dismiss the insert-failed affordance immediately so Esc shows a clean
    // "Cancelled", not the Copy button + amber glow lingering for ~300ms.
    this.clearInsertFailedUi();

    // A live recording is always the operation Escape refers to, even while an
    // older session is still transcribing. Cancelling the backend first would
    // leave the new MediaRecorder session unmarked and let its partial clip run
    // through transcription after the mic tracks stop.
    if (this.isRecording) {
      this.cancelledShortPress = true;
      if (this.activeRecordingSession) {
        this.activeRecordingSession.cancelledShortPress = true;
      }
      this.stopRecording();
      this.deferCancelGateRelease(cancelToken);
      return;
    }

    // getUserMedia may still be resolving. stopRequested makes startRecording
    // release the stream as soon as it arrives instead of creating a session.
    if (this.starting) {
      this.stopRequested = true;
      this.promptText.textContent = t("inputPrompt.cancelled");
      this.statusText.textContent = "";
      return;
    }

    const cancellableIds = new Set(this.activeTranscriptionSessionIds);
    for (const [id, session] of this.recordingSessions || []) {
      if (["waiting-stop", "processing", "ready"].includes(session.lifecycle.state)) cancellableIds.add(id);
    }
    if (cancellableIds.size || this.transcriptionInProgressCount > 0) {
      const sessionId = cancellableIds.size ? Math.max(...cancellableIds) : null;
      const session = this.recordingSessions?.get(sessionId);
      if (session) {
        this.cancelRecordingSession(session);
      } else if (sessionId !== null) {
        this.cancelledTranscriptionSessionIds.add(sessionId);
        this.removePendingInsertion(sessionId);
        void ipc.invoke("cancel-transcription", sessionId).catch(() => {});
      }
      this.promptText.textContent = t("inputPrompt.cancelled");
      this.statusText.textContent = "";
      if (session) this.cleanup({ recordingSession: session });
      this.stopWaveAnimation();
      this.scheduleHidePrompt(300);
      this.deferCancelGateRelease(cancelToken, true);
      return;
    }

    const selectedSessionId = selectedRecoveryId ?? this.recordingSessionId;
    // Idle Escape dismisses the card, not completed words awaiting a durable
    // ACK. It still cancels unfinished late-audio work for this session.
    this.cancelSessionAudioRecovery(selectedSessionId);
    this.removePendingInsertion(selectedSessionId);
    this.promptText.textContent = t("inputPrompt.cancelled");
    this.statusText.textContent = "";
    this.cleanup();
    this.stopWaveAnimation();
    this.scheduleHidePrompt(300);
  }

  cleanup(options = {}) {
    const { preserveAudioChunks = false, recordingSession } = options;
    const mediaStream = recordingSession ? recordingSession.mediaStream : this.mediaStream;
    const audioContext = recordingSession ? recordingSession.audioContext : this.audioContext;
    const mediaRecorder = recordingSession ? recordingSession.mediaRecorder : this.mediaRecorder;
    const ownsCurrentResources = !recordingSession || this.activeRecordingSession === recordingSession;
    logMicrophoneCleanup("Starting microphone cleanup...");

    // Stop this dictation's own stream. A newer recording holds a different
    // stream object, so it stays open.
    if (mediaStream) {
      logMicrophoneCleanup("Stopping media stream tracks...");
      mediaStream.getTracks().forEach((track) => {
        logMicrophoneCleanup(
          `Stopping track: ${track.kind}, state: ${track.readyState}`
        );
        track.stop();
        logMicrophoneCleanup(
          `Track stopped: ${track.kind}, new state: ${track.readyState}`
        );
      });
      if (this.mediaStream === mediaStream) this.mediaStream = null;
      if (recordingSession) recordingSession.mediaStream = null;
      logMicrophoneCleanup("Media stream cleared");
    }

    // Close audio context
    if (audioContext) {
      logMicrophoneCleanup(
        `Closing audio context, current state: ${audioContext.state}`
      );
      if (audioContext.state !== 'closed' && typeof audioContext.close === "function") {
        audioContext.close().then(() => {
          logMicrophoneCleanup("Audio context closed successfully");
        }).catch(err => {
          console.error('Error closing audio context:', err);
        });
      }
      if (this.audioContext === audioContext) this.audioContext = null;
      if (recordingSession) recordingSession.audioContext = null;
    }

    // Clean up media recorder
    if (mediaRecorder) {
      logMicrophoneCleanup("Cleaning up media recorder...");
      if (!preserveAudioChunks) {
        if (this.mediaRecorder === mediaRecorder) this.mediaRecorder = null;
      }
    }

    // Clean up analyser
    if (ownsCurrentResources && this.analyser) {
      logMicrophoneCleanup("Cleaning up analyser...");
      this.analyser = null;
    }
    
    if (ownsCurrentResources && this.dataArray) {
      this.dataArray = null;
    }

    // Reset audio chunks
    if (ownsCurrentResources && !preserveAudioChunks) {
      this.audioChunks = [];
    }
    
    logMicrophoneCleanup("Microphone cleanup completed");
  }

  // Runs the transcribe IPC with a single automatic retry on a transient
  // (hung / timed-out) failure. Across the retry the recording's session id
  // stays at the head of the insertion queue, so a later completed segment
  // waits its turn rather than jumping ahead — recording order is preserved.
  // Only after the retry also fails does the caller's catch give up (drop the
  // session, surface the failure). Deterministic errors rethrow immediately.
  async transcribeWithRetry(uploadBuffer, uploadMime, sessionId, provider) {
    const MAX_ATTEMPTS = 2; // original + one retry
    const session = this.recordingSessions?.get(sessionId);
    // Both attempts are the SAME recording, so they must share one History row.
    // The backend keys its failure row on this id; without it a retried upload
    // logs a second row and stores a second copy of the clip, and a retry that
    // finally succeeds leaves the first row behind as an orphan.
    const failureId = `failed-${Date.now()}-${sessionId}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const transcribe = () => ipc.invoke(
          "transcribe-audio",
          uploadBuffer,
          uploadMime,
          sessionId,
          undefined, // chunk-index: this is the whole-clip path
          session?.captureIncomplete ? true : undefined,
          failureId,
          provider // recording-start snapshot, even after the session map is cleared
        );
        return session ? await this.waitForSessionStage(session, "chunk-ipc",
          transcribe, TRANSCRIPTION_STAGE_TIMEOUT_MS) : await transcribe();
      } catch (error) {
        if (
          attempt >= MAX_ATTEMPTS ||
          error?.name === "TranscriptionStageTimeoutError" ||
          (session && this.isSessionCancelled(session)) ||
          !isRetryableTranscriptionError(errorMessage(error))
        ) {
          throw error;
        }
        if (isDev) {
          console.warn(
            `Transcription attempt ${attempt} failed (${errorMessage(error)}); auto-retrying once.`
          );
        }
      }
    }
  }

  async processRecordingOnce(recordingSession) {
    if (!recordingSession) {
      console.warn("Missing recording session; skipping transcription.");
      return;
    }

    const {
      id: sessionId,
      chunks = [],
      mimeType,
      cancelledShortPress,
    } = recordingSession;
    // Recomputed at every use, NOT captured once: transcriptions outlive this
    // stack frame, and a slow failure can land while the user is already
    // recording the next session. The old one-shot capture stayed stale-true
    // and let that failure repaint the prompt and schedule hidePrompt — which
    // tears down the live mic and clears the insertion queue mid-recording.
    const allowUi = () =>
      sessionId === this.recordingSessionId && !this.isRecording && !this.starting;

    // Hoisted so the catch (give-up path) can stash the exact uploaded bytes as
    // a re-transcribable pending entry — see the hang-recovery branch below.
    let uploadBuffer = null;
    let uploadMime = mimeType || "audio/webm";
    let releaseLocalTranscriptionSlot = null;
    let audioBlob = null;
    const useNemotronLive = !!recordingSession.live;
    const useChunkedLocal = !!recordingSession.chunked;
    let terminalState = "completed";

    this.transcriptionInProgressCount += 1;
    this.activeTranscriptionSessionIds.add(sessionId);
    this.updateStatusText();
    try {
      // A failed recovery WAV does not invalidate PCM already sent to a decoder.
      // Collect its final text, but keep it out of automatic insertion/history.
      if (recordingSession.nativeCapture && recordingSession.finalizationError) {
        recordingSession.captureIncomplete = true;
      }
      if (recordingSession.finalizationError && !useChunkedLocal && !useNemotronLive) {
        throw recordingSession.finalizationError;
      }
      if (
        cancelledShortPress ||
        this.cancelledTranscriptionSessionIds.has(sessionId)
      ) {
        terminalState = "cancelled";
        this.cancelNemotronLive(recordingSession);
        this.cancelChunkedLocal(recordingSession);
        this.removePendingInsertion(sessionId);
        if (allowUi()) {
          this.cancelledShortPress = false;
          this.recordingStartedAt = null;
          this.audioChunks = [];
          this.statusText.textContent = t("inputPrompt.cancelled");
          this.statusText.style.color = "var(--status-warning)";
          this.scheduleHidePrompt(300);
        }
        return;
      }
      if (!chunks.length && !useChunkedLocal && !useNemotronLive) {
        this.cancelNemotronLive(recordingSession);
        this.cancelChunkedLocal(recordingSession);
        console.warn("No audio chunks captured; skipping transcription request");
        this.removePendingInsertion(sessionId);
        if (allowUi()) {
          this.statusText.textContent = t("inputPrompt.noAudio");
          this.statusText.style.color = "var(--status-warning)";
          this.scheduleHidePrompt(1500);
        }
        return;
      }

      const useLocalWav =
        (recordingSession.provider || this.currentProvider) === "local" &&
        !useNemotronLive &&
        !useChunkedLocal;
      if (useLocalWav) {
        // Keep the full local pipeline single-flight, not just the stateful VAD
        // call. Waiting sessions retain only compressed MediaRecorder chunks;
        // they do not each hold decoded PCM, a WAV copy, and a queued native
        // request while llama.cpp is already using its model-sized memory.
        releaseLocalTranscriptionSlot = await this.acquireLocalTranscriptionSlot(recordingSession);
        if (this.cancelledTranscriptionSessionIds.has(sessionId)) {
          this.removePendingInsertion(sessionId);
          return;
        }
      }

      audioBlob = chunks.length ? new Blob(chunks, {
        type: mimeType || "audio/webm", // Use actual recording format
      }) : null;

      // Take the decoder's stable Blob before a recovery ACK can release the
      // session-owned chunks. Preserve the original WAV, not a VAD-trimmed copy.
      if (recordingSession.captureIncomplete && audioBlob) {
        this.preserveRecoveryAudio(recordingSession, {
          blob: audioBlob, wav: recordingSession.captureRecoveryWav || null,
        });
        recordingSession.captureRecoveryWav = null;
      }

      let transcription;
      if (useNemotronLive) {
        if (this.cancelledTranscriptionSessionIds.has(sessionId)) {
          this.cancelNemotronLive(recordingSession);
          this.removePendingInsertion(sessionId);
          return;
        }
        transcription = await this.waitForSessionStage(recordingSession, "finalize",
          () => this.finishNemotronLive(recordingSession), TRANSCRIPTION_STAGE_TIMEOUT_MS);
      } else if (useChunkedLocal) {
        // Every chunk but the last decoded while the user was still speaking;
        // only the flushed remainder is still in flight here.
        if (this.cancelledTranscriptionSessionIds.has(sessionId)) {
          this.cancelChunkedLocal(recordingSession);
          this.removePendingInsertion(sessionId);
          return;
        }
        transcription = await this.finishChunkedLocal(recordingSession);
        this.assertSessionActive(recordingSession);
        recordingSession.finalText = transcription;
        if (!recordingSession.captureIncomplete) {
          transcription = await this.recordAssembledTranscription(transcription, recordingSession);
        }
      } else {
        // Batch engines run the neural VAD after release. Nemotron has already
        // processed the live PCM stream and returns an empty final for silence.
        try {
          if (window.TypeAloudVadGate) {
            const verdict = await this.waitForSessionStage(recordingSession, "resample",
              () => window.TypeAloudVadGate.analyze(audioBlob, { forceWav: useLocalWav }), AUDIO_STAGE_TIMEOUT_MS);
            if (!verdict.speech) {
              this.removePendingInsertion(sessionId);
              if (allowUi()) {
                this.statusText.textContent = t("inputPrompt.noSpeech");
                this.scheduleHidePrompt(2000);
              }
              return;
            }
            if (verdict.wav) {
              uploadBuffer = verdict.wav;
              uploadMime = "audio/wav";
              if (verdict.trimmedMs > 0) {
                console.log(
                  `VAD trim: cut ${verdict.trimmedMs}ms of head/tail silence from a ${Math.round(verdict.durationMs)}ms clip`
                );
              }
            }
          }
        } catch (vadError) {
          this.assertSessionActive(recordingSession);
          if (vadError?.name === "TranscriptionStageTimeoutError") throw vadError;
          console.warn("VAD gate failed; proceeding to transcription:", vadError);
        }
        if (useLocalWav && !uploadBuffer) {
          try {
            uploadBuffer = await this.waitForSessionStage(recordingSession, "resample",
              () => window.TypeAloudVadGate.encodeFullWav(audioBlob), AUDIO_STAGE_TIMEOUT_MS);
            uploadMime = "audio/wav";
          } catch (wavError) {
            this.assertSessionActive(recordingSession);
            if (wavError?.name === "TranscriptionStageTimeoutError") throw wavError;
            console.warn("full-WAV fallback failed; sending original bytes:", wavError);
          }
        }

        if (this.cancelledTranscriptionSessionIds.has(sessionId)) {
          this.removePendingInsertion(sessionId);
          return;
        }

        if (!uploadBuffer) {
          uploadBuffer = new Uint8Array(await this.waitForSessionStage(recordingSession, "resample",
            () => audioBlob.arrayBuffer(), AUDIO_STAGE_TIMEOUT_MS));
        }

        transcription = await this.transcribeWithRetry(
          uploadBuffer,
          uploadMime,
          sessionId,
          recordingSession.provider
        );
      }

      this.assertSessionActive(recordingSession);
      if (transcription && transcription.trim()) {
        recordingSession.finalText = transcription;
        if (recordingSession.captureIncomplete) {
          terminalState = "failed";
          this.removePendingInsertion(sessionId);
          this.preserveRecoveryText(sessionId, transcription, "incomplete");
          return;
        }
        recordingSession.lifecycle.state = "ready";
        this.storeTranscriptionResult(sessionId, transcription);
        this.updateStatusText();
        await this.flushPendingInsertions();
      } else {
        this.removePendingInsertion(sessionId);
        if (allowUi()) {
          this.statusText.textContent = t("inputPrompt.noSpeech");
          this.scheduleHidePrompt(2000);
        }
      }
    } catch (error) {
      console.error("Transcription error:", error);
      this.cancelNemotronLive(recordingSession);
      this.cancelChunkedLocal(recordingSession);
      this.removePendingInsertion(sessionId);
      // Tauri rejects with the command's Err value, which is the raw string for
      // a Result<_, String>, so handle both string and Error shapes.
      const message = errorMessage(error);
      let isCancelled =
        this.isSessionCancelled(recordingSession) ||
        (error && error.name === "TranscriptionCancelledError") ||
        message.includes("TRANSCRIPTION_CANCELLED");
      terminalState = isCancelled ? "cancelled" : "failed";
      let recoveredText = !isCancelled && this.preserveCompletedChunks(recordingSession);

      // Finalizing on release runs before the recorder delivers its Blob, so
      // audioBlob was computed empty. `chunks` is the session's live array and
      // ondataavailable has since filled it, so re-read it here — a failed
      // chunked dictation keeps the same retry audio it had when finalization
      // waited for the recorder.
      if (!audioBlob && chunks.length) {
        audioBlob = new Blob(chunks, { type: mimeType || "audio/webm" });
      }

      // Audio/text recovery is background content custody, never pending FIFO
      // work. Keep source bytes until a real persistence ACK releases them.
      const wantsRecoveryAudio = !isCancelled && recordingSession.provider === "local" &&
        (useNemotronLive || useChunkedLocal || isRetryableTranscriptionError(message));
      if (wantsRecoveryAudio && (audioBlob || uploadBuffer)) {
        this.preserveRecoveryAudio(recordingSession, {
          blob: audioBlob,
          wav: uploadMime === "audio/wav" ? uploadBuffer : null,
        });
      } else if (wantsRecoveryAudio && !recordingSession.lifecycle.stopSeen) {
        // Failing before the recorder delivered anything at all — a chunk that
        // already errored mid-recording resolves the queue the instant the
        // hotkey is released. Register the session so the container that is
        // still on its way is saved for a manual retry.
        recordingSession.lifecycle.recoverLateRecorder = true;
        this.preserveRecoveryAudio(recordingSession, { waitingRecorder: true });
      }

      isCancelled ||= this.isSessionCancelled(recordingSession);
      if (isCancelled) {
        terminalState = "cancelled";
        this.recoverableTranscriptions?.delete(sessionId);
        recoveredText = false;
      }
      if (allowUi() && !recoveredText) {
        if (isCancelled) {
          this.statusText.textContent = t("inputPrompt.cancelled");
          this.statusText.style.color = "var(--status-warning)";
          this.scheduleHidePrompt(300);
        } else if (message.startsWith("LOCAL_MODEL_MISSING")) {
          this.showLocalModelMissing(this.currentProvider === "local"
            ? this.currentModel : recordingSession.captureModel);
        } else if (/api key not configured/i.test(message) || /no api key/i.test(message)) {
          this.statusText.textContent = t("inputPrompt.noApiKey");
          this.statusText.style.color = "var(--status-warning-strong)";
          this.scheduleHidePrompt(3500);
        } else if (/unauthorized/i.test(message) || /invalid api key/i.test(message) || /\b401\b/.test(message)) {
          this.statusText.textContent = t("inputPrompt.invalidApiKey");
          this.statusText.style.color = "var(--status-warning-strong)";
          this.scheduleHidePrompt(3500);
        } else {
          this.statusText.textContent = message
            ? t("inputPrompt.transcriptionFailedReason", { reason: message })
            : t("inputPrompt.transcriptionFailed");
          this.statusText.style.color = "var(--status-warning-strong)";
          this.scheduleHidePrompt(4000);
        }
      }
    } finally {
      await this.finishQwenWorkerSession(recordingSession);
      if (releaseLocalTranscriptionSlot) {
        releaseLocalTranscriptionSlot();
      }
      this.cancelledTranscriptionSessionIds.delete(sessionId);
      this.activeTranscriptionSessionIds.delete(sessionId);
      this.transcriptionInProgressCount = Math.max(0, this.transcriptionInProgressCount - 1);
      recordingSession.lifecycle.processingFinished = true;
      if ((recordingSession.lifecycle.state !== "ready" || terminalState !== "completed") &&
        !["completed", "cancelled", "failed"].includes(recordingSession.lifecycle.state)) {
        this.completeRecordingSession(recordingSession, terminalState);
      }
      this.reportLifecycle(recordingSession, "finalize", terminalState === "failed" ? "error" :
        terminalState === "cancelled" ? "cancel" : "complete");
      // Only refresh status when concurrent transcriptions are still running.
      // If count reached 0, the try/catch or flushPendingInsertions have already
      // set the terminal status ("Cancelled", "No speech", "Text inserted", etc.)
      // — calling updateStatusText() here would overwrite them with an empty string.
      if (this.transcriptionInProgressCount > 0) {
        this.updateStatusText();
      }
      await this.flushPendingInsertions();
    }
  }

  async handleRecordingError(error) {
    this.isRecording = false;
    this.stopRecordingTimer();

    // Force cleanup of resources
    this.cleanup();

    let errorMessageKey = "inputPrompt.recordingFailed";

    if (
      error.name === "NotAllowedError" ||
      error.name === "PermissionDeniedError"
    ) {
      errorMessageKey = "inputPrompt.permissionDenied";
    } else if (error.name === "NotFoundError") {
      errorMessageKey = "inputPrompt.noMicrophone";
    } else if (error?.code === "NATIVE_CAPTURE_START_TIMEOUT") {
      errorMessageKey = "inputPrompt.microphoneStartupTimeout";
    } else if (error.name === "NotReadableError" ||
      error?.code === "NATIVE_CAPTURE_BUSY" || error?.code === "NATIVE_CAPTURE_STOP_TIMEOUT") {
      errorMessageKey = "inputPrompt.microphoneBusy";
    } else if (error.name === "OverconstrainedError") {
      errorMessageKey = "inputPrompt.microphoneUnsupported";
    }

    // The prompt is no longer shown during "starting", so a getUserMedia
    // failure must reveal it here to surface the error.
    this.promptElement.classList.add("visible");
    this.promptText.textContent = t(errorMessageKey);
    this.statusText.textContent = t("inputPrompt.checkMicrophone");

    this.scheduleHidePrompt(3000);
  }

  async typeText(text, options = {}) {
    const { suppressUi = false } = options;
    if (!hasMeaningfulText(text)) {
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.noSpeech");
        this.statusText.style.color = "var(--status-warning)";
        this.scheduleHidePrompt(1500);
      }
      return { ok: false, noText: true };
    }

    // Send the transcribed text to the active application.
    try {
      const result = await ipc.invoke("type-text", text, textShape(text));

      // Any backend success means the text was injected directly (there is no
      // clipboard fallback). `method` differs per OS ("cgevent_unicode" on
      // macOS, "enigo_text" on Windows/Linux) and is kept only for diagnostics.
      if (result?.success) {
        if (!suppressUi) {
          this.statusText.textContent = t("inputPrompt.textInserted");
          this.statusText.style.color = "var(--status-success)";
          this.hidePrompt();
        }
        return { ok: true, method: result.method, direct: true };
      }

      if (result?.skippedNoText) {
        if (!suppressUi) {
          this.statusText.textContent = t("inputPrompt.noSpeech");
          this.statusText.style.color = "var(--status-warning)";
          this.scheduleHidePrompt(1500);
        }
        return { ok: false, noText: true };
      }

      // Insertion failed. By design there is NO clipboard fallback: the
      // transcription is already saved to history (and still shown on this
      // prompt), so we point the user there instead of touching their clipboard.
      console.warn("Text insertion failed in backend:", result);
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.insertFailed");
        this.statusText.style.color = "var(--status-warning-strong)";
        this.scheduleHidePrompt(2500);
      }
      return { ok: false, message: result?.message };
    } catch (error) {
      console.error("Failed to process text:", error);
      if (!suppressUi) {
        this.statusText.textContent = t("inputPrompt.insertFailed");
        this.statusText.style.color = "var(--status-warning-strong)";
        this.scheduleHidePrompt(2500);
      }
      return { ok: false, message: error?.message };
    }
  }

  startWaveAnimation() {
    // Scrolling volume history: x-axis is time. Each tick we measure the
    // current loudness (RMS) and push it in from the right; older samples
    // slide left and off the edge — like a real moving waveform, not a
    // static frequency spectrum.
    const bars = Array.from(this.waveContainer.querySelectorAll(".wave-bar"));
    const barCount = bars.length;
    const history = new Array(barCount).fill(0);

    const SAMPLE_INTERVAL_MS = 65; // ~1.5s of audio spread across the bars
    const MAX_HEIGHT = 25; // container is 28px tall
    const MIN_HEIGHT = 3;

    // Perceived loudness is logarithmic (dB), so the old LINEAR map (rms * 6)
    // made soft-but-clear speech barely lift off the floor — RMS ~0.02–0.05
    // gave only 3–7.5px of 25 — while it saturated by RMS ~0.17. The meter
    // looked dead when the mic was fine, so you couldn't tell it was hearing
    // you. Map RMS in dBFS across a window tuned for dictation instead: quiet
    // speech already fills a good chunk of the bar, and the whole usable range
    // is spread out rather than crammed into the loud end. Display-only — this
    // never touches the audio uploaded for transcription.
    const FLOOR_DB = -50; // ~RMS 0.003 (room tone) → empty
    const CEIL_DB = -12; //  ~RMS 0.25 (loud speech) → full
    const ACTIVE_AMPLITUDE = 0.3; // glow once mapped level clears this (~RMS 0.012)

    const rmsToAmplitude = (rms) => {
      if (rms <= 0) return 0;
      const db = 20 * Math.log10(rms);
      const span = CEIL_DB - FLOOR_DB;
      return Math.max(0, Math.min(1, (db - FLOOR_DB) / span));
    };

    const sampleVolume = () => {
      const native = this.activeRecordingSession?.nativeCapture;
      if (native) {
        const probe = this.activeRecordingSession?.onsetProbe;
        if (probe) {
          probe.analyserFrames += 1;
          const bucket = Math.floor((performance.now() - probe.originMs) / PROBE_BUCKET_MS);
          if (bucket >= 0 && bucket < PROBE_BUCKETS) probe.frameCounts[bucket] += 1;
          if (native.latestRms <= 0) probe.analyserSilentFrames += 1;
        }
        return native.latestRms;
      }
      if (!this.analyser || !this.dataArray) {
        return Math.random() * 0.15; // fallback so the wave still scrolls
      }
      this.analyser.getByteTimeDomainData(this.dataArray);
      let sumSquares = 0;
      for (let i = 0; i < this.dataArray.length; i++) {
        const v = (this.dataArray[i] - 128) / 128; // centered samples, -1..1
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / this.dataArray.length);
      const probe = this.activeRecordingSession?.onsetProbe;
      if (probe) {
        probe.analyserFrames += 1;
        const bucket = Math.floor((performance.now() - probe.originMs) / PROBE_BUCKET_MS);
        if (bucket >= 0 && bucket < PROBE_BUCKETS) probe.frameCounts[bucket] += 1;
        // 8-bit samples: room tone below ~-42 dBFS reads as an exact zero here,
        // which is why the float tap above is the one that decides the verdict.
        if (rms <= 0) probe.analyserSilentFrames += 1;
      }
      return rms;
    };

    const render = () => {
      for (let i = 0; i < barCount; i++) {
        const amplitude = rmsToAmplitude(history[i]);
        bars[i].style.height = `${Math.max(MIN_HEIGHT, amplitude * MAX_HEIGHT)}px`;
        bars[i].classList.toggle("active", amplitude > ACTIVE_AMPLITUDE);
      }
    };

    let lastSampleAt = 0;
    const animate = (now) => {
      if (!this.isRecording) return;

      const t = now || performance.now();
      if (t - lastSampleAt >= SAMPLE_INTERVAL_MS) {
        lastSampleAt = t;
        history.shift(); // drop the oldest (leftmost) sample
        history.push(sampleVolume()); // newest enters on the right
        render(); // CSS height transition smooths the leftward scroll
      }

      this.animationId = requestAnimationFrame(animate);
    };

    this.animationId = requestAnimationFrame(animate);
  }

  stopWaveAnimation() {
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }

    // Reset wave bars
    const bars = this.waveContainer.querySelectorAll(".wave-bar");
    bars.forEach((bar) => {
      bar.style.height = "3px";
      bar.classList.remove("active");
    });
  }

  hidePrompt() {
    this.cleanup();
    this.stopRecordingTimer();
    this.clearHidePromptTimer();
    this.clearActualHideTimer();
    this.clearPendingInsertions();
    this.isFlushingInsertQueue = false;
    
    this.promptElement.classList.remove("visible", "recording");
    this.clearTranscriptionPreview();
    this.updateShortcutHint(this.recordShortcut);
    this.statusText.textContent = "";
    this.statusText.style.color = "";

    // Reset recording state
    if (this.recordingLockId != null) void this.releaseRecordingLock();
    this.isRecording = false;
    this.stopRequested = false;
    this.starting = false;
    this.recordingStartedAt = null;
    this.cancelledShortPress = false;
    this.cancelInProgress = false;
    this.cancelGateToken = null;
    this.clearInsertFailedUi();
    this.updateModelBadge();

    this.actualHideTimerId = setTimeout(() => {
      this.actualHideTimerId = null;
      ipc.invoke("hide-input-prompt");
    }, 300);
  }
}

async function initializeInputPromptPage() {
  // This entry script is delivered twice — once via the <script> tag in
  // input-prompt.html and once via the on-page-load injection from the Rust
  // backend. Without a guard both run and construct two VoiceInputPrompt
  // instances, so every utterance is recorded, transcribed and inserted twice.
  // The flag lives on `window` so both script scopes share it.
  if (window.__typeAloudInputPromptStarted) {
    return;
  }
  window.__typeAloudInputPromptStarted = true;

  try {
    const settings = await ipc.invoke("get-settings");
    isDev = settings?.isDev ?? false;
    initI18n(settings?.uiLanguage);
    applyTheme(settings?.uiTheme);
  } catch (error) {
    console.error("Failed to load UI language settings:", error);
    initI18n("auto");
    applyTheme("elegant");
  }
  watchSystemTheme();
  // The native glass behind the box and the bubble follows them (macOS 26+ only).
  window.NativeGlass?.track([
    { id: "prompt", element: document.getElementById("inputPrompt") },
    { id: "transcription", element: document.getElementById("transcriptionText") },
  ]);
  new VoiceInputPrompt();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void initializeInputPromptPage();
  }, { once: true });
} else {
  void initializeInputPromptPage();
}

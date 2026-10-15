import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import * as chunkDecision from "./chunk-decision.mjs";
import { encodeWavPcm16 } from "./vad-decision.mjs";

const defaultSourcePath = fileURLToPath(new URL("./input-prompt.js", import.meta.url));

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadVoiceInputPrompt(options = {}) {
  const sourcePath = process.env.TYPEALOUD_INPUT_PROMPT_SOURCE || defaultSourcePath;
  const source = readFileSync(sourcePath, "utf8");
  const quietConsole = {
    log() {},
    warn() {},
    error() {},
  };
  const documentElement = {
    setAttribute() {},
  };
  const document = {
    documentElement,
    readyState: "complete",
    addEventListener() {},
    // setTranscriptionPreview/clearTranscriptionPreview toggle a class here to
    // drive the layering CSS; stub it so those paths don't NPE under the vm.
    body: { classList: { add() {}, remove() {}, toggle() {} } },
  };
  const window = {
    __typeAloudInputPromptStarted: true,
    __TYPEALOUD_IPC__: {
      invoke(command, ...args) {
        if (command === "report-transcription-lifecycle" && !options.captureLifecycle) {
          return Promise.resolve(null);
        }
        if (command === "report-audio-probe" && !options.captureAudioProbe) {
          return Promise.resolve(null);
        }
        return options.invoke ? options.invoke(command, ...args) : Promise.resolve(null);
      },
      on: options.on || (() => {}),
      createChannel: options.createChannel || ((handler) => ({ onmessage: handler })),
    },
    TypeAloudI18n: {
      initI18n() {},
      setLanguage() {},
      applyI18n() {},
      t(key, values) {
        return values?.reason ? `${key}: ${values.reason}` : key;
      },
    },
    TypeAloudVadGate: null,
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
      };
    },
    addEventListener() {},
  };
  Object.assign(window, options.window || {});
  const context = vm.createContext({
    ArrayBuffer,
    Blob,
    console: quietConsole,
    DataView,
    document,
    navigator: {},
    performance: options.performance || performance,
    requestAnimationFrame: options.requestAnimationFrame || (() => 1),
    cancelAnimationFrame: options.cancelAnimationFrame || (() => {}),
    setInterval: options.setInterval || setInterval,
    clearInterval: options.clearInterval || clearInterval,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    Float32Array,
    Uint8Array,
    window,
    ...(options.globals || {}),
  });

  vm.runInContext(
    `${source}\n;globalThis.__VoiceInputPrompt = VoiceInputPrompt;\n;globalThis.__normalizeRecordingStartPayload = typeof normalizeRecordingStartPayload === "function" ? normalizeRecordingStartPayload : null;`,
    context,
    { filename: sourcePath }
  );

  context.__VoiceInputPrompt.normalizeRecordingStartPayload =
    context.__normalizeRecordingStartPayload;
  return context.__VoiceInputPrompt;
}

function createBarePrompt(VoiceInputPrompt, overrides = {}) {
  return Object.assign(
    Object.create(VoiceInputPrompt.prototype),
    {
      isRecording: false,
      starting: false,
      isFlushingInsertQueue: false,
      pendingInsertionOrder: [],
      pendingInsertionsById: new Map(),
      activeTranscriptionSessionIds: new Set(),
      cancelledTranscriptionSessionIds: new Set(),
      localTranscriptionTail: Promise.resolve(),
      transcriptionInProgressCount: 0,
      recordingSessionId: 0,
      currentProvider: "openai",
      hidePromptTimerId: null,
      promptText: { textContent: "" },
      statusText: { textContent: "", style: {} },
      updateStatusText() {},
      updateShortcutHint() {},
      setTranscriptionPreview() {},
      flushPendingInsertions: VoiceInputPrompt.prototype.flushPendingInsertions,
      ...overrides,
    }
  );
}

test("a stale hide timer cannot hide an active or starting recording", () => {
  let scheduledCallback = null;
  let hideCalls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    setTimeout(callback) {
      scheduledCallback = callback;
      return 42;
    },
    clearTimeout() {},
  });

  for (const state of [
    { isRecording: true, starting: false },
    { isRecording: false, starting: true },
  ]) {
    const prompt = createBarePrompt(VoiceInputPrompt, {
      ...state,
      hidePrompt() {
        hideCalls += 1;
      },
    });

    prompt.scheduleHidePrompt(100);
    assert.equal(prompt.hidePromptTimerId, 42);
    scheduledCallback();
    assert.equal(prompt.hidePromptTimerId, null);
  }

  assert.equal(hideCalls, 0);
});

test("a hide timer still hides the prompt when the app remains idle", () => {
  let scheduledCallback = null;
  let hideCalls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    setTimeout(callback) {
      scheduledCallback = callback;
      return 42;
    },
    clearTimeout() {},
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    hidePrompt() {
      hideCalls += 1;
    },
  });

  prompt.scheduleHidePrompt(100);
  scheduledCallback();

  assert.equal(hideCalls, 1);
  assert.equal(prompt.hidePromptTimerId, null);
});

test("a hide timer waits while an older transcription is still pending", () => {
  let scheduledCallback = null;
  let hideCalls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    setTimeout(callback) {
      scheduledCallback = callback;
      return 42;
    },
    clearTimeout() {},
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    transcriptionInProgressCount: 1,
    pendingInsertionOrder: [1],
    hidePrompt() {
      hideCalls += 1;
    },
  });

  prompt.scheduleHidePrompt(100);
  scheduledCallback();

  assert.equal(hideCalls, 0);
  assert.deepEqual(prompt.pendingInsertionOrder, [1]);
  assert.equal(prompt.hidePromptTimerId, null);
});

test("Escape cancels the active recording before an older transcription", () => {
  const invoked = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      invoked.push([command, ...args]);
      return Promise.resolve(true);
    },
  });
  const activeRecordingSession = { id: 2, cancelledShortPress: false };
  let stopCalls = 0;
  const prompt = createBarePrompt(VoiceInputPrompt, {
    isRecording: true,
    transcriptionInProgressCount: 1,
    activeRecordingSession,
    cancelInProgress: false,
    stopRequested: false,
    pendingInsertionOrder: [1, 2],
    stopRecordingTimer() {},
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    stopWaveAnimation() {},
    stopRecording() {
      stopCalls += 1;
      this.isRecording = false;
    },
  });

  prompt.cancelRecording();

  assert.equal(stopCalls, 1);
  assert.equal(activeRecordingSession.cancelledShortPress, true);
  assert.deepEqual(prompt.pendingInsertionOrder, [1, 2]);
  assert.equal(invoked.some(([command]) => command === "cancel-transcription"), false);
});

test("Escape cancels only the latest transcription while preserving older work", () => {
  const invoked = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      invoked.push([command, ...args]);
      return Promise.resolve(true);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    transcriptionInProgressCount: 2,
    activeTranscriptionSessionIds: new Set([1, 2]),
    cancelInProgress: false,
    stopRequested: false,
    pendingInsertionOrder: [1, 2],
    pendingInsertionsById: new Map([[1, "older"]]),
    stopRecordingTimer() {},
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    cleanup() {},
    stopWaveAnimation() {},
    scheduleHidePrompt() {},
  });

  prompt.cancelRecording();

  assert.deepEqual(invoked, [["cancel-transcription", 2]]);
  assert.equal(prompt.cancelledTranscriptionSessionIds.has(2), true);
  assert.deepEqual(prompt.pendingInsertionOrder, [1]);
  assert.equal(prompt.pendingInsertionsById.get(1), "older");
});

test("local partial text is shown only for the latest non-recording session", () => {
  const handlers = new Map();
  const VoiceInputPrompt = loadVoiceInputPrompt({
    on(channel, handler) {
      handlers.set(channel, handler);
    },
  });
  const previews = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 2,
    transcriptionInProgressCount: 2,
    transcriptionText: {},
    setTranscriptionPreview(text) {
      previews.push(text);
    },
    updateModelBadge() {},
  });
  prompt.setupEventListeners();
  const onPartial = handlers.get("local-transcription-partial");

  prompt.isRecording = true;
  onPartial(null, { sessionId: 1, text: "old while recording" });
  prompt.isRecording = false;
  onPartial(null, { sessionId: 1, text: "old" });
  onPartial(null, { sessionId: 2, text: "latest" });

  assert.deepEqual(previews, ["latest"]);
});

test("Nemotron partials render during recording but not after the session is idle", () => {
  const handlers = new Map();
  const VoiceInputPrompt = loadVoiceInputPrompt({
    on(channel, handler) {
      handlers.set(channel, handler);
    },
  });
  const previews = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 4,
    transcriptionInProgressCount: 0,
    transcriptionText: {},
    activeRecordingSession: { live: { sessionId: 4 } },
    isRecording: true,
    setTranscriptionPreview(text) {
      previews.push(text);
    },
    updateModelBadge() {},
  });
  prompt.setupEventListeners();
  const onPartial = handlers.get("local-transcription-partial");

  onPartial(null, { sessionId: 4, text: "live" });
  prompt.isRecording = false;
  prompt.starting = false;
  onPartial(null, { sessionId: 4, text: "late" });

  assert.deepEqual(previews, ["live"]);
});

test("start event timing includes native work and renderer delivery delay", () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const normalize = VoiceInputPrompt.normalizeRecordingStartPayload;

  assert.equal(typeof normalize, "function");
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalize({
      dispatchedAtUnixMs: 1000,
      nativeMs: 80,
    }, 1300))),
    {
      nativeMs: 80,
      eventDeliveryMs: 300,
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalize(false, 1300))),
    {
      nativeMs: 0,
      eventDeliveryMs: 0,
    }
  );
});

test("recording startup reports native, delivery, microphone, and first-paint timing", async () => {
  const calls = [];
  const clock = [1000, 1010, 1160, 1170];
  const stream = {};
  class FakeAudioContext {
    createMediaStreamSource() {
      return { connect() {} };
    }

    createAnalyser() {
      return { fftSize: 0 };
    }
  }
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      this.state = "inactive";
    }

    start() {
      this.state = "recording";
    }
  }
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, payload) {
      calls.push([command, payload]);
      return Promise.resolve(null);
    },
    performance: { now: () => clock.shift() },
    requestAnimationFrame(callback) {
      callback(1550);
      return 1;
    },
    window: { AudioContext: FakeAudioContext },
    globals: {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { getUserMedia: async () => stream } },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    pageStartedAt: 0,
    cancelInProgress: true,
    stopRequested: false,
    activeRecordingSession: null,
    mediaStream: null,
    mediaRecorder: null,
    audioChunks: [],
    promptElement: { classList: { add() {} } },
    promptText: { textContent: "" },
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    clearTranscriptionPreview() {},
    updateModelBadge() {},
    hasReadyEngine: async () => true,
    startWaveAnimation() {},
    startRecordingTimer() {},
  });
  await prompt.startRecording({ nativeMs: 80, eventDeliveryMs: 300 });
  await Promise.resolve();

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[
    "report-recording-startup",
    {
      recordingNumber: 1,
      uptimeMs: 1000,
      nativeMs: 80,
      eventDeliveryMs: 300,
      preflightMs: 10,
      microphoneMs: 150,
      setupMs: 10,
      renderMs: 380,
      frontendMs: 550,
      endToEndMs: 930,
    },
  ]]);
  assert.equal(prompt.cancelInProgress, false);
});

test("macOS records through native PCM without opening WebKit capture", async () => {
  const calls = [];
  let channelHandler = null;
  let webkitOpens = 0;
  let finalized = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      calls.push([command, ...args]);
      if (command === "start-native-capture") {
        return Promise.resolve({
          device: "Built-in Microphone",
          inputRate: 48000,
          outputRate: 16000,
          channels: 1,
          sampleFormat: "f32",
        });
      }
      if (command === "stop-native-capture") {
        channelHandler({ event: "stopped", stats: { outputSamples: 4 } });
        return Promise.resolve({ outputSamples: 4 });
      }
      return Promise.resolve(null);
    },
    createChannel(handler) {
      channelHandler = handler;
      return { channel: true };
    },
    globals: {
      navigator: {
        mediaDevices: {
          async getUserMedia() {
            webkitOpens += 1;
            return {};
          },
        },
      },
    },
    requestAnimationFrame(callback) {
      callback(1200);
      return 1;
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    osName: "macos",
    currentMicrophone: "default",
    pageStartedAt: 0,
    stopRequested: false,
    cancelInProgress: false,
    activeRecordingSession: null,
    mediaStream: null,
    mediaRecorder: null,
    audioChunks: [],
    promptElement: { classList: { add() {} } },
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    clearTranscriptionPreview() {},
    updateModelBadge() {},
    hasReadyEngine: async () => true,
    startWaveAnimation() {},
    stopWaveAnimation() {},
    startRecordingTimer() {},
    stopRecordingTimer() {},
    cleanup() {},
    scheduleHidePrompt() {},
    finalizeRecordingSession() {
      finalized += 1;
      return Promise.resolve();
    },
  });

  await prompt.startRecording({ nativeMs: 0, eventDeliveryMs: 0 });
  assert.equal(prompt.isRecording, true);
  assert.equal(webkitOpens, 0);
  assert.equal(calls.some(([command]) => command === "start-native-capture"), true);

  channelHandler(new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x34, 0x12]).buffer);
  const session = prompt.activeRecordingSession;
  prompt.stopRecording();
  await session.nativeCapture.stopPromise;
  await Promise.resolve();

  assert.equal(finalized, 1);
  assert.equal(session.chunks.length, 1);
  assert.equal(session.mimeType, "audio/wav");
  const wav = new Uint8Array(await session.chunks[0].arrayBuffer());
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 16000);
  assert.deepEqual(Array.from(wav.subarray(44)), [0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x34, 0x12]);
});

test("a new native recording waits for the previous capture to release the device", async () => {
  // hotkey.rs only ARMS a stop deadline on release; the stop is dispatched
  // ~250 ms later, so a re-press just past the debounce races that stop. Rust
  // refuses a second stream while the first is shutting down, and on macOS the
  // WebKit fallback is cold, so losing this ordering costs 3.0 s of the new
  // dictation. Start must wait for the previous release, not rely on timing.
  const calls = [];
  let releasePrevious;
  const previousStop = new Promise((resolve) => {
    releasePrevious = resolve;
  });
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      calls.push(command);
      if (command === "start-native-capture") {
        return Promise.resolve({
          device: "Built-in Microphone",
          inputRate: 48000,
          outputRate: 16000,
          channels: 1,
          sampleFormat: "f32",
        });
      }
      return Promise.resolve(null);
    },
    createChannel() {
      return {};
    },
    requestAnimationFrame(callback) {
      callback(1200);
      return 1;
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    osName: "macos",
    currentMicrophone: "default",
    pageStartedAt: 0,
    stopRequested: false,
    cancelInProgress: false,
    activeRecordingSession: null,
    audioChunks: [],
    promptElement: { classList: { add() {}, remove() {} } },
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    clearTranscriptionPreview() {},
    updateModelBadge() {},
    hasReadyEngine: async () => true,
    startWaveAnimation() {},
    stopWaveAnimation() {},
    startRecordingTimer() {},
    stopRecordingTimer() {},
    cleanup() {},
    scheduleHidePrompt() {},
    finalizeRecordingSession: () => Promise.resolve(),
  });
  // A previous capture is still shutting down.
  prompt.nativeCapture = { stopPromise: previousStop };

  const starting = prompt.startRecording({ nativeMs: 0, eventDeliveryMs: 0 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    calls.includes("start-native-capture"),
    false,
    "claimed the device before the previous capture released it"
  );

  releasePrevious();
  await starting;
  assert.equal(calls.includes("start-native-capture"), true);
  assert.equal(prompt.isRecording, true);
});

test("a macOS native capture failure falls back to WebKit instead of losing the dictation", async () => {
  // Native capture is verified on exactly one Mac, but it is the path every Mac
  // takes. A machine where CoreAudio cannot open must still record — degraded by
  // the 3.0 s WKWebView attenuation, not dead.
  const calls = [];
  let webkitOpens = 0;
  const track = { readyState: "live", stop() {}, getSettings: () => ({}) };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.sampleRate = 48000;
      this.destination = {};
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    createAnalyser() {
      return { fftSize: 0 };
    }
    resume() {
      return Promise.resolve();
    }
  }
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }
    constructor() {
      this.state = "inactive";
    }
    start() {
      this.state = "recording";
    }
  }
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      calls.push([command, ...args]);
      if (command === "start-native-capture") {
        return Promise.reject(new Error("no default input device"));
      }
      return Promise.resolve(null);
    },
    createChannel() {
      return {};
    },
    requestAnimationFrame(callback) {
      callback(1200);
      return 1;
    },
    window: { AudioContext: FakeAudioContext },
    globals: {
      MediaRecorder: FakeMediaRecorder,
      navigator: {
        mediaDevices: {
          async getUserMedia() {
            webkitOpens += 1;
            return stream;
          },
        },
      },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    osName: "macos",
    currentMicrophone: "default",
    pageStartedAt: 0,
    stopRequested: false,
    cancelInProgress: false,
    activeRecordingSession: null,
    mediaStream: null,
    mediaRecorder: null,
    audioChunks: [],
    promptElement: { classList: { add() {}, remove() {} } },
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    clearTranscriptionPreview() {},
    updateModelBadge() {},
    hasReadyEngine: async () => true,
    startWaveAnimation() {},
    stopWaveAnimation() {},
    startRecordingTimer() {},
    stopRecordingTimer() {},
    cleanup() {},
    scheduleHidePrompt() {},
    finalizeRecordingSession: () => Promise.resolve(),
  });

  await prompt.startRecording({ nativeMs: 0, eventDeliveryMs: 0 });

  assert.equal(calls.some(([command]) => command === "start-native-capture"), true);
  // The dictation survives on the WebKit path.
  assert.equal(webkitOpens, 1);
  assert.equal(prompt.isRecording, true);
  assert.equal(prompt.activeRecordingSession.nativeCapture, undefined);
  // A start whose response was lost can still leave a live session in Rust, so
  // stop is issued even though the start reported failure.
  assert.equal(calls.some(([command]) => command === "stop-native-capture"), true);
});

test("native PCM drives Qwen chunking at 16 kHz and retains a recovery WAV", async () => {
  let channelHandler;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    window: { TypeAloudChunk: chunkDecision },
    createChannel(handler) {
      channelHandler = handler;
      return {};
    },
    invoke(command) {
      if (command === "stop-native-capture") {
        channelHandler({ event: "stopped" });
      }
      return Promise.resolve({});
    },
  });
  let closedChunk = null;
  const prompt = createBarePrompt(VoiceInputPrompt, {
    osName: "macos",
    currentProvider: "local",
    currentModel: "qwen3-asr-0.6b-q8_0",
    enqueueChunkDecode(_chunked, pcm) {
      closedChunk = pcm;
    },
  });
  const session = {
    id: 11,
    chunks: [],
    mimeType: "audio/wav",
    provider: "local",
    onsetProbe: null,
    audioContext: null,
  };
  prompt.createNativeCapture(session);
  await prompt.setupNativeConsumers(session);
  channelHandler(new Uint8Array([0x00, 0x40, 0x00, 0xc0]).buffer);
  await prompt.finishNativeCapture(session);

  assert.equal(session.chunked.sampleRate, 16000);
  assert.equal(closedChunk.length, 2);
  assert.ok(Math.abs(closedChunk[0] - 0.5) < 0.0001);
  assert.ok(Math.abs(closedChunk[1] + 0.5) < 0.0001);
  assert.equal(session.chunks.length, 1);
  assert.equal(session.chunks[0].type, "audio/wav");
});

test("native PCM feeds Nemotron's existing binary upload queue", async () => {
  let channelHandler;
  const calls = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    createChannel(handler) {
      channelHandler = handler;
      return {};
    },
    invoke(command, ...args) {
      calls.push([command, ...args]);
      if (command === "stop-native-capture") {
        channelHandler({ event: "stopped" });
      }
      return Promise.resolve(command === "finish-live-transcription" ? "done" : {});
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    osName: "macos",
    currentProvider: "local",
    currentModel: "nemotron-3.5-asr-streaming-0.6b-q8_0",
    currentLanguage: "auto",
  });
  const session = {
    id: 12,
    chunks: [],
    mimeType: "audio/wav",
    provider: "local",
    onsetProbe: null,
    audioContext: null,
  };
  prompt.createNativeCapture(session);
  await prompt.setupNativeConsumers(session);
  const pcm = new Uint8Array([1, 2, 3, 4]);
  channelHandler(pcm.buffer);
  await prompt.finishNativeCapture(session);
  await session.live.uploadTail;

  const started = calls.find(([command]) => command === "start-live-transcription");
  const pushed = calls.find(([command]) => command === "push-live-audio");
  assert.equal(started[2], 16000);
  assert.deepEqual(Array.from(pushed[1]), Array.from(pcm));
  assert.equal(pushed[2], 12);
});

test("Qwen prewarm eligibility requires an active recording", async () => {
  const calls = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      calls.push([command, args]);
      return Promise.resolve(true);
    },
  });
  const recordingSession = { id: 42, qwenSession: true };
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    currentModel: "qwen3-asr-0.6b-q8_0",
    activeRecordingSession: recordingSession,
  });

  prompt.prewarmQwenWorker(recordingSession);
  assert.deepEqual(calls, []);

  prompt.isRecording = true;
  prompt.prewarmQwenWorker(recordingSession);
  await Promise.resolve();
  assert.deepEqual(calls, [["prewarm-qwen-worker", [42]]]);

  recordingSession.qwenSession = false;
  prompt.prewarmQwenWorker(recordingSession);
  recordingSession.qwenSession = true;
  prompt.currentProvider = "groq";
  prompt.prewarmQwenWorker(recordingSession);
  assert.deepEqual(calls, [["prewarm-qwen-worker", [42]]]);
});

test("Qwen worker completion is session-scoped and idempotent", async () => {
  const calls = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      calls.push([command, args]);
      return Promise.resolve(true);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt);
  const qwen = { id: 73, qwenSession: true };

  await Promise.all([
    prompt.finishQwenWorkerSession(qwen),
    prompt.finishQwenWorkerSession(qwen),
  ]);
  await prompt.finishQwenWorkerSession({ id: 74, qwenSession: false });

  assert.deepEqual(calls, [["finish-qwen-worker-session", [73]]]);
});

test("a failed Qwen worker completion can retry during final cleanup", async () => {
  let attempts = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      assert.equal(command, "finish-qwen-worker-session");
      attempts += 1;
      return attempts === 1 ? Promise.reject(new Error("bridge unavailable")) : Promise.resolve(true);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt);
  const recordingSession = { id: 75, qwenSession: true };

  assert.equal(await prompt.finishQwenWorkerSession(recordingSession), false);
  assert.equal(await prompt.finishQwenWorkerSession(recordingSession), true);
  assert.equal(attempts, 2);
});

test("Qwen prewarm waits for probation after first paint and skips a cancelled recording", async () => {
  const events = [];
  let paintCallback = null;
  let scheduledPrewarm = null;
  const stream = {};
  class FakeAudioContext {
    createMediaStreamSource() {
      return { connect() {} };
    }

    createAnalyser() {
      return { fftSize: 0 };
    }
  }
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    start() {
      this.state = "recording";
      events.push("recorder-started");
    }
  }
  const clock = [1000, 1010, 1160, 1170];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      events.push(command);
      return Promise.resolve(true);
    },
    performance: { now: () => clock.shift() },
    requestAnimationFrame(callback) {
      paintCallback = callback;
      return 1;
    },
    setTimeout(callback, delay) {
      scheduledPrewarm = { callback, delay };
      return 42;
    },
    window: { AudioContext: FakeAudioContext },
    globals: {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { getUserMedia: async () => stream } },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    pageStartedAt: 0,
    currentProvider: "local",
    currentModel: "qwen3-asr-0.6b-q8_0",
    cancelInProgress: false,
    stopRequested: false,
    activeRecordingSession: null,
    mediaStream: null,
    mediaRecorder: null,
    audioChunks: [],
    promptElement: { classList: { add() {} } },
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    clearTranscriptionPreview() {},
    updateModelBadge() {},
    hasReadyEngine: async () => true,
    startWaveAnimation() {},
    startRecordingTimer() {},
  });

  await prompt.startRecording({ nativeMs: 0, eventDeliveryMs: 0 });
  assert.deepEqual(events, ["recorder-started"]);

  paintCallback(1200);
  await Promise.resolve();
  assert.deepEqual(events, [
    "recorder-started",
    "report-recording-startup",
  ]);
  assert.equal(scheduledPrewarm.delay, 300);

  prompt.isRecording = false;
  scheduledPrewarm.callback();
  await Promise.resolve();
  assert.deepEqual(events, [
    "recorder-started",
    "report-recording-startup",
  ]);

  prompt.isRecording = true;
  prompt.scheduleQwenPrewarm(prompt.activeRecordingSession, 500);
  await Promise.resolve();
  assert.deepEqual(events, [
    "recorder-started",
    "report-recording-startup",
    "prewarm-qwen-worker",
  ]);
});

test("the recording window does not open the microphone before a dictation", () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();

  // Windows/Linux used to warm one getUserMedia stream and keep it for the whole
  // process, which kept the OS microphone indicator lit and held Bluetooth
  // headsets in call mode. Each dictation now opens and closes its own stream.
  assert.equal(VoiceInputPrompt.prototype.primeMicrophone, undefined);
  assert.equal(VoiceInputPrompt.prototype.acquireCaptureStream, undefined);
});

test("releasing a dictation stops its microphone tracks", () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const stopped = [];
  const stream = {
    getTracks: () => [{ kind: "audio", readyState: "live", stop: () => stopped.push("track") }],
  };
  const session = { mediaStream: stream, audioContext: null, mediaRecorder: null };
  const prompt = createBarePrompt(VoiceInputPrompt, {
    activeRecordingSession: session,
    mediaStream: stream,
  });

  prompt.cleanup({ preserveAudioChunks: true, recordingSession: session });

  assert.deepEqual(stopped, ["track"]);
  assert.equal(session.mediaStream, null);
  assert.equal(prompt.mediaStream, null);
});

test("an older dictation's cleanup leaves a newer dictation's microphone open", () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const stopped = [];
  const streamNamed = (name) => ({
    getTracks: () => [{ kind: "audio", readyState: "live", stop: () => stopped.push(name) }],
  });
  const olderStream = streamNamed("older");
  const newerStream = streamNamed("newer");
  const older = { mediaStream: olderStream, audioContext: null, mediaRecorder: null };
  const newer = { mediaStream: newerStream, audioContext: null, mediaRecorder: null };
  const prompt = createBarePrompt(VoiceInputPrompt, {
    activeRecordingSession: newer,
    mediaStream: newerStream,
  });

  prompt.cleanup({ preserveAudioChunks: true, recordingSession: older });

  assert.deepEqual(stopped, ["older"]);
  assert.equal(prompt.mediaStream, newerStream);
});

test("a failed old transcription cannot repaint or hide a newer recording", async () => {
  const transcription = createDeferred();
  const invokeStarted = createDeferred();
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      assert.equal(command, "transcribe-audio");
      invokeStarted.resolve();
      return transcription.promise;
    },
  });
  const scheduledHides = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 1,
    pendingInsertionOrder: [1, 2],
    statusText: { textContent: "processing first", style: {} },
    scheduleHidePrompt(delayMs) {
      scheduledHides.push(delayMs);
    },
    async flushPendingInsertions() {},
  });

  const processing = prompt.processRecording({
    id: 1,
    chunks: [new Blob([new Uint8Array([1, 2, 3])])],
    mimeType: "audio/webm",
    cancelledShortPress: false,
  });
  await invokeStarted.promise;

  prompt.recordingSessionId = 2;
  prompt.isRecording = true;
  prompt.statusText.textContent = "recording second";
  transcription.reject(new Error("network timeout"));
  await processing;

  assert.equal(prompt.statusText.textContent, "recording second");
  assert.deepEqual(scheduledHides, []);
  assert.deepEqual(prompt.pendingInsertionOrder, [2]);
});

test("transcription IPC carries the recording session id", async () => {
  const calls = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      if (command === "transcribe-audio") {
        calls.push(args);
        return Promise.resolve("session text");
      }
      return Promise.resolve(null);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 7,
    pendingInsertionOrder: [7],
    async flushPendingInsertions() {},
  });

  await prompt.processRecording({
    id: 7,
    chunks: [new Blob([new Uint8Array([1, 2, 3])])],
    mimeType: "audio/webm",
    cancelledShortPress: false,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 7);
});

test("Nemotron final is inserted without running the Qwen batch path", async () => {
  const calls = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      calls.push([command, ...args]);
      if (command === "finish-live-transcription") {
        return Promise.resolve("live final");
      }
      return Promise.resolve(null);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    currentModel: "nemotron-3.5-asr-streaming-0.6b-q8_0",
    recordingSessionId: 9,
    pendingInsertionOrder: [9],
    async flushPendingInsertions() {},
  });

  await prompt.processRecording({
    id: 9,
    chunks: [new Blob([new Uint8Array([1, 2, 3])])],
    mimeType: "audio/webm",
    cancelledShortPress: false,
    live: {
      sessionId: 9,
      uploadTail: Promise.resolve(),
      uploadError: null,
    },
  });

  assert.deepEqual(calls, [["finish-live-transcription", 9]]);
  assert.equal(prompt.pendingInsertionsById.get(9), "live final");
});

test("local recording pipelines stay single-flight through transcription", async () => {
  const firstTranscription = createDeferred();
  const firstStarted = createDeferred();
  let transcriptionCalls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      if (command !== "transcribe-audio") {
        return Promise.resolve(null);
      }
      transcriptionCalls += 1;
      if (transcriptionCalls === 1) {
        firstStarted.resolve();
        return firstTranscription.promise;
      }
      return Promise.resolve("second text");
    },
    window: {
      TypeAloudVadGate: {
        async analyze() {
          return {
            speech: true,
            wav: new Uint8Array([1, 2, 3]),
            trimmedMs: 0,
            durationMs: 1000,
          };
        },
      },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    recordingSessionId: 2,
    pendingInsertionOrder: [1, 2],
    async flushPendingInsertions() {},
  });

  const first = processOneRecording(prompt, 1);
  await firstStarted.promise;
  const second = processOneRecording(prompt, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(transcriptionCalls, 1);
  firstTranscription.resolve("first text");
  await Promise.all([first, second]);
  assert.equal(transcriptionCalls, 2);
});

test("a queued local transcription can be cancelled before native IPC", async () => {
  const firstTranscription = createDeferred();
  const firstStarted = createDeferred();
  const invoked = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command, ...args) {
      invoked.push([command, ...args]);
      if (command === "transcribe-audio" && args[2] === 1) {
        firstStarted.resolve();
        return firstTranscription.promise;
      }
      if (command === "transcribe-audio") {
        return Promise.resolve("unexpected second text");
      }
      return Promise.resolve(true);
    },
    window: {
      TypeAloudVadGate: {
        async analyze() {
          return {
            speech: true,
            wav: new Uint8Array([1, 2, 3]),
            trimmedMs: 0,
            durationMs: 1000,
          };
        },
      },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    recordingSessionId: 2,
    pendingInsertionOrder: [1, 2],
    cancelInProgress: false,
    stopRequested: false,
    stopRecordingTimer() {},
    clearHidePromptTimer() {},
    clearActualHideTimer() {},
    clearInsertFailedUi() {},
    cleanup() {},
    stopWaveAnimation() {},
    scheduleHidePrompt() {},
    async flushPendingInsertions() {},
  });

  const first = processOneRecording(prompt, 1);
  await firstStarted.promise;
  const second = processOneRecording(prompt, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  prompt.cancelRecording();

  assert.equal(prompt.cancelledTranscriptionSessionIds.has(2), true);
  firstTranscription.resolve("first text");
  await Promise.all([first, second]);
  assert.equal(
    invoked.filter(([command]) => command === "transcribe-audio").length,
    1
  );
  assert.equal(
    invoked.some(
      ([command, sessionId]) =>
        command === "cancel-transcription" && sessionId === 2
    ),
    true
  );
});

test("the insertion queue waits for the earliest session result", async () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const inserted = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    pendingInsertionOrder: [1, 2],
    pendingInsertionsById: new Map([[2, "second"]]),
    async typeText(text) {
      inserted.push(text);
      return { ok: true, direct: true };
    },
  });

  await prompt.flushPendingInsertions();

  assert.deepEqual(inserted, []);
  assert.deepEqual(prompt.pendingInsertionOrder, [1, 2]);
  assert.equal(prompt.pendingInsertionsById.get(2), "second");
});

test("completed transcriptions are inserted in recording order", async () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const inserted = [];
  let hideCalls = 0;
  const prompt = createBarePrompt(VoiceInputPrompt, {
    pendingInsertionOrder: [1, 2, 3],
    pendingInsertionsById: new Map([
      [3, "third"],
      [1, "first"],
      [2, "second"],
    ]),
    async typeText(text, options) {
      assert.equal(options.suppressUi, true);
      inserted.push(text);
      return { ok: true, direct: true };
    },
    hidePrompt() {
      hideCalls += 1;
    },
  });

  await prompt.flushPendingInsertions();

  assert.deepEqual(inserted, ["first", "second", "third"]);
  assert.deepEqual(prompt.pendingInsertionOrder, []);
  assert.equal(prompt.pendingInsertionsById.size, 0);
  assert.equal(hideCalls, 1);
});

test("pending transcriptions are not inserted while recording", async () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const inserted = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    isRecording: true,
    pendingInsertionOrder: [1],
    pendingInsertionsById: new Map([[1, "first"]]),
    async typeText(text) {
      inserted.push(text);
      return { ok: true, direct: true };
    },
  });

  await prompt.flushPendingInsertions();

  assert.deepEqual(inserted, []);
  assert.deepEqual(prompt.pendingInsertionOrder, [1]);
  assert.equal(prompt.pendingInsertionsById.get(1), "first");
});

function hungError() {
  return new Error(
    "local ASR stalled mid-decode (no progress for 20s) — treating as hung"
  );
}

function processOneRecording(prompt, id = 1) {
  return prompt.processRecording({
    id,
    chunks: [new Blob([new Uint8Array([1, 2, 3])])],
    mimeType: "audio/webm",
    cancelledShortPress: false,
  });
}

test("a hung transcription is auto-retried once and then succeeds", async () => {
  let calls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      if (command !== "transcribe-audio") return null;
      calls += 1;
      return calls === 1
        ? Promise.reject(hungError())
        : Promise.resolve("recovered text");
    },
  });
  let flushes = 0;
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    async flushPendingInsertions() {
      flushes += 1;
    },
  });

  await processOneRecording(prompt);

  assert.equal(calls, 2, "should invoke twice: original + one retry");
  assert.equal(prompt.pendingInsertionsById.get(1), "recovered text");
  // Head stays queued through the retry (flush is mocked, so nothing drains it).
  assert.deepEqual(prompt.pendingInsertionOrder, [1]);
  assert.ok(flushes >= 1);
});

test("a transcription still hung after one retry gives up and unblocks the queue", async () => {
  let calls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      if (command !== "transcribe-audio") return null;
      calls += 1;
      return Promise.reject(hungError());
    },
  });
  const removed = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    scheduleHidePrompt() {},
    removePendingInsertion(id) {
      removed.push(id);
      VoiceInputPrompt.prototype.removePendingInsertion.call(this, id);
    },
    async flushPendingInsertions() {},
  });

  await processOneRecording(prompt);

  assert.equal(calls, 2, "one retry, then give up — never a third attempt");
  assert.deepEqual(removed, [1], "the hung session is dropped from the queue");
  assert.deepEqual(prompt.pendingInsertionOrder, []);
  assert.equal(prompt.statusText.style.color, "var(--status-warning-strong)");
});

test("a local hang surviving the retry is saved as a pending entry", async () => {
  const commands = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      commands.push(command);
      if (command === "transcribe-audio") return Promise.reject(hungError());
      if (command === "save-pending-transcription") return Promise.resolve("entry-1");
      return null;
    },
    window: { TypeAloudVadGate: { analyze: async () => ({ speech: true, wav: new Uint8Array([1, 2, 3]) }) } },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    scheduleHidePrompt() {},
    async flushPendingInsertions() {},
  });

  await processOneRecording(prompt);
  await settlePromises();

  assert.equal(commands.filter((c) => c === "transcribe-audio").length, 2);
  assert.ok(
    commands.includes("save-pending-transcription"),
    "the hung clip must be stashed for later re-transcription"
  );
});

test("a cloud hang is not saved as a pending entry", async () => {
  const commands = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      commands.push(command);
      if (command === "transcribe-audio") return Promise.reject(hungError());
      return null;
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "openai",
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    scheduleHidePrompt() {},
    async flushPendingInsertions() {},
  });

  await processOneRecording(prompt);

  assert.ok(
    !commands.includes("save-pending-transcription"),
    "cloud audio is not persisted for re-transcription"
  );
});

test("a non-retryable transcription error is not retried", async () => {
  let calls = 0;
  const VoiceInputPrompt = loadVoiceInputPrompt({
    invoke(command) {
      if (command !== "transcribe-audio") return null;
      calls += 1;
      return Promise.reject(new Error("api key not configured"));
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    scheduleHidePrompt() {},
    async flushPendingInsertions() {},
  });

  await processOneRecording(prompt);

  assert.equal(calls, 1, "deterministic errors must not be retried");
  assert.deepEqual(prompt.pendingInsertionOrder, []);
});

// ---- chunked local (Qwen) transcription --------------------------------

// A live chunk session as setupChunkedLocal builds it. 16 kHz means
// resampleTo16k is a no-op, so these tests exercise the real WAV encoding
// without needing an OfflineAudioContext.
function makeChunked(overrides = {}) {
  return {
    sessionId: 7,
    sampleRate: 16000,
    node: null,
    mutedOutput: null,
    blocks: [],
    blockSamples: 0,
    state: chunkDecision.createChunkState(),
    nextChunkIndex: 0,
    results: [],
    failedChunks: 0,
    queue: Promise.resolve(),
    livePartial: null,
    aborted: false,
    stopped: false,
    accounting: {
      acceptedSamples: 0, queuedSamples: 0, submittedSamples: 0, completedSamples: 0,
      queuedChunks: 0, submittedChunks: 0, completedChunks: 0,
      startedAt: 0, lastPcmAt: null, stopRequestedAt: null, sealedAt: null,
    },
    ...overrides,
  };
}

function loadForChunking(invoke) {
  return loadVoiceInputPrompt({
    invoke,
    window: {
      TypeAloudChunk: chunkDecision,
      TypeAloudVad: { encodeWavPcm16 },
    },
  });
}

test("closeChunk splits mid-block and carries the remainder into the next chunk", () => {
  const VoiceInputPrompt = loadForChunking(async () => null);
  const enqueued = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    enqueueChunkDecode(_chunked, pcm) {
      enqueued.push(Array.from(pcm));
    },
  });

  const chunked = makeChunked();
  const blocks = [
    Float32Array.from([0.1, 0.2, 0.3]),
    Float32Array.from([0.4, 0.5, 0.6]),
    Float32Array.from([0.7, 0.8, 0.9]),
  ];
  for (const block of blocks) {
    chunked.blocks.push(block);
    chunked.blockSamples += block.length;
    chunkDecision.pushFrame(chunked.state, chunkDecision.frameRms(block), block.length);
  }

  prompt.closeChunk(chunked, 4); // cut inside the second block

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].length, 4);
  enqueued[0].forEach((value, index) => {
    assert.ok(Math.abs(value - (index + 1) / 10) < 1e-6);
  });
  assert.equal(chunked.blockSamples, 5, "the tail carries over sample-exactly");
  assert.equal(chunked.state.samples, 5, "the cut state is re-based with the audio");
});

test("chunks decode in order, one at a time, each tagged with its chunk index", async () => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    if (channel !== "transcribe-audio") return null;
    calls.push(args);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return `chunk${args[3]}`;
  });

  const prompt = createBarePrompt(VoiceInputPrompt);
  const chunked = makeChunked();
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await chunked.queue;

  assert.deepEqual(chunked.results, ["chunk0", "chunk1", "chunk2"]);
  assert.equal(maxInFlight, 1, "decodes must stay serial — one llama worker");
  assert.equal(calls.length, 3);
  assert.equal(calls[0][1], "audio/wav");
  assert.equal(calls[0][2], 7, "the recording session id rides along");
  assert.deepEqual(calls.map((args) => args[3]), [0, 1, 2]);
  assert.ok(calls[0][0].length > 44, "a real WAV, header included, is uploaded");
});

test("a decoded chunk keeps the session worker ready, and the final chunk does not", async () => {
  const calls = [];
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    calls.push(channel);
    return channel === "transcribe-audio" ? `chunk${args[3]}` : true;
  });

  const recordingSession = { id: 7, qwenSession: true };
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    currentModel: "qwen3-asr-0.6b-q8_0",
    activeRecordingSession: recordingSession,
  });
  prompt.isRecording = true;
  const chunked = makeChunked({ recordingSession });

  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await chunked.queue;
  await Promise.resolve();
  assert.deepEqual(
    calls,
    ["transcribe-audio", "prewarm-qwen-worker"],
    "the session worker stays due for the next chunk while capture continues",
  );

  // Releasing the key. The last chunk has no successor, and a replacement here
  // would be a ~1.1 GiB process nobody ever uses.
  calls.length = 0;
  prompt.isRecording = false;
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await chunked.queue;
  await Promise.resolve();
  assert.deepEqual(calls, ["transcribe-audio"], "no replacement worker after the final chunk");

  // A provider switch mid-dictation must not start a Qwen worker either.
  calls.length = 0;
  prompt.isRecording = true;
  prompt.currentProvider = "groq";
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await chunked.queue;
  await Promise.resolve();
  assert.deepEqual(calls, ["transcribe-audio"], "no Qwen worker once the provider has changed");
});

test("releasing the key mid-decode still warms the worker the final chunk needs", async () => {
  const calls = [];
  let releaseFirstDecode;
  const firstDecode = new Promise((resolve) => {
    releaseFirstDecode = resolve;
  });
  let decodes = 0;
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    calls.push(channel);
    if (channel !== "transcribe-audio") return true;
    decodes += 1;
    if (decodes === 1) await firstDecode;
    return `chunk${args[3]}`;
  });

  const recordingSession = { id: 7, qwenSession: true };
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    currentModel: "qwen3-asr-0.6b-q8_0",
    activeRecordingSession: recordingSession,
  });
  prompt.isRecording = true;
  const chunked = makeChunked({ recordingSession });

  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await Promise.resolve();

  // stopRecording clears isRecording before stopChunkedCapture closes the
  // remainder, so the final chunk joins the queue with recording already off.
  prompt.isRecording = false;
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));

  releaseFirstDecode();
  await chunked.queue;
  await Promise.resolve();

  assert.deepEqual(
    calls,
    ["transcribe-audio", "prewarm-qwen-worker", "transcribe-audio"],
    "chunk 0 keeps the worker ready for the already-queued final chunk",
  );
});

test("one failed chunk stops queued work and refuses to return a gapped final", async () => {
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    if (channel !== "transcribe-audio") return null;
    if (args[3] === 1) throw new Error("chunk decode blew up");
    return `part${args[3]}`;
  });

  const prompt = createBarePrompt(VoiceInputPrompt);
  const chunked = makeChunked();
  for (let i = 0; i < 3; i++) prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await chunked.queue;

  assert.deepEqual(chunked.results, ["part0", "", ""]);
  assert.equal(chunked.failedChunks, 1);
  await assert.rejects(() => prompt.finishChunkedLocal({ chunked }), /chunk decode blew up/);
});

test("finishChunkedLocal reports failed chunks but accepts silence", async () => {
  const VoiceInputPrompt = loadForChunking(async () => {
    throw new Error("every chunk failed");
  });
  const prompt = createBarePrompt(VoiceInputPrompt);

  const allFailed = makeChunked();
  prompt.enqueueChunkDecode(allFailed, new Float32Array(160));
  await allFailed.queue;
  await assert.rejects(() => prompt.finishChunkedLocal({ chunked: allFailed }));

  // Silence decodes to empty text with no error — a legitimate "no speech".
  const silent = makeChunked({ results: ["", ""], failedChunks: 0, stopped: true });
  assert.equal(await prompt.finishChunkedLocal({ chunked: silent }), "");
});

function loadForRemainderVad(invoke, gate) {
  return loadVoiceInputPrompt({
    invoke,
    window: {
      TypeAloudChunk: chunkDecision,
      TypeAloudVad: { encodeWavPcm16 },
      TypeAloudVadGate: gate,
    },
  });
}

async function dictateWithRemainder(gate, { firstReason = "silence", remainderSamples = 8000 } = {}) {
  const decoded = [];
  const vadCalls = [];
  const VoiceInputPrompt = loadForRemainderVad(async (channel, ...args) => {
    if (channel !== "transcribe-audio") return null;
    decoded.push(args[3]);
    return `chunk${args[3]}`;
  }, gate && {
    hasSpeech: async (pcm) => {
      vadCalls.push(pcm.length);
      return gate(pcm);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt);
  const chunked = makeChunked();
  if (firstReason) prompt.enqueueChunkDecode(chunked, new Float32Array(16000), firstReason);
  prompt.enqueueChunkDecode(chunked, new Float32Array(remainderSamples), "release");
  await chunked.queue;
  chunked.stopped = true;
  chunked.accounting.acceptedSamples = chunked.accounting.queuedSamples;
  const text = await prompt.finishChunkedLocal({ chunked });
  return { decoded, vadCalls, text, chunked };
}

test("a silent remainder after the last cut is dropped instead of decoded", async () => {
  const { decoded, vadCalls, text, chunked } = await dictateWithRemainder(async () => false);
  assert.deepEqual(vadCalls, [8000], "only the final remainder is checked");
  assert.deepEqual(decoded, [0], "Qwen never sees the pause's tail");
  assert.equal(text, "chunk0", "nothing is appended for it");
  assert.equal(chunked.accounting.completedChunks, 2, "the skipped remainder still counts as covered");
});

test("a remainder with speech is decoded as before", async () => {
  const { decoded, text } = await dictateWithRemainder(async () => true);
  assert.deepEqual(decoded, [0, 1]);
  assert.equal(text, "chunk0 chunk1");
});

test("the VAD is not consulted for an uncut dictation or a long remainder", async () => {
  const uncut = await dictateWithRemainder(async () => false, { firstReason: null });
  assert.deepEqual(uncut.vadCalls, [], "a single-chunk dictation keeps the old path");
  assert.deepEqual(uncut.decoded, [0]);

  const long = await dictateWithRemainder(async () => false, { remainderSamples: 3 * 16000 + 1 });
  assert.deepEqual(long.vadCalls, [], "past 3 s the remainder is decoded unchecked");
  assert.deepEqual(long.decoded, [0, 1]);
});

test("a long remainder is VAD-checked only when it is quiet against the previous chunk", async () => {
  const run = async (remainderLevel) => {
    const vadCalls = [];
    const decoded = [];
    const VoiceInputPrompt = loadForRemainderVad(async (channel, ...args) => {
      if (channel !== "transcribe-audio") return null;
      decoded.push(args[3]);
      return `chunk${args[3]}`;
    }, { hasSpeech: async (pcm) => { vadCalls.push(pcm.length); return false; } });
    const prompt = createBarePrompt(VoiceInputPrompt);
    const chunked = makeChunked();
    const push = (seconds, level) => {
      for (let i = 0; i < seconds * 25; i++) {
        const block = new Float32Array(640).fill(level);
        chunked.blocks.push(block);
        chunked.blockSamples += block.length;
        chunkDecision.pushFrame(chunked.state, level, block.length);
      }
    };
    push(2, 0.2);
    prompt.closeChunk(chunked, chunked.blockSamples, "silence");
    push(9, remainderLevel);
    prompt.closeChunk(chunked, chunked.blockSamples, "release");
    await chunked.queue;
    return { vadCalls, decoded };
  };

  const quiet = await run(0.001);
  assert.deepEqual(quiet.vadCalls, [9 * 16000], "9 s of room noise goes to the VAD");
  assert.deepEqual(quiet.decoded, [0], "and is dropped on its no-speech verdict");

  const spoken = await run(0.2);
  assert.deepEqual(spoken.vadCalls, [], "9 s of speech is decoded unchecked, as before");
  assert.deepEqual(spoken.decoded, [0, 1]);
});

test("a failing or missing VAD fails open to decoding the remainder", async () => {
  const failing = await dictateWithRemainder(async () => { throw new Error("ort blew up"); });
  assert.deepEqual(failing.decoded, [0, 1]);

  const missing = await dictateWithRemainder(null);
  assert.deepEqual(missing.decoded, [0, 1]);
});

test("releasing the key flushes the buffered remainder as the final chunk", () => {
  const VoiceInputPrompt = loadForChunking(async () => null);
  const enqueued = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    enqueueChunkDecode(_chunked, pcm) {
      enqueued.push(pcm.length);
    },
  });

  const chunked = makeChunked();
  const block = new Float32Array(320);
  chunked.blocks.push(block);
  chunked.blockSamples = block.length;
  chunkDecision.pushFrame(chunked.state, 0.1, block.length);

  prompt.stopChunkedCapture({ chunked });

  assert.deepEqual(enqueued, [320], "the residual audio is not dropped on release");
  assert.equal(chunked.stopped, true);
});

test("cancelling stops dispatching chunks that have not started", async () => {
  const attempted = [];
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    if (channel === "transcribe-audio") attempted.push(args[3]);
    return "text";
  });

  const prompt = createBarePrompt(VoiceInputPrompt);
  const chunked = makeChunked();
  prompt.cancelChunkedLocal({ chunked });
  prompt.enqueueChunkDecode(chunked, new Float32Array(160));
  await chunked.queue;

  assert.deepEqual(attempted, [], "no audio is sent after a cancel");
  assert.equal(chunked.aborted, true);
  assert.equal(chunked.blockSamples, 0, "buffered audio is released on cancel");
});

test("a chunk's streaming text renders in its own slot, not over finalized chunks", () => {
  const VoiceInputPrompt = loadForChunking(async () => null);
  let preview = null;
  const prompt = createBarePrompt(VoiceInputPrompt, {
    setTranscriptionPreview(text) {
      preview = text;
    },
  });

  const chunked = makeChunked({
    results: ["the first chunk is done.", ""],
    livePartial: { index: 1, text: "the second chunk so far" },
  });
  prompt.renderChunkedPreview(chunked);
  assert.equal(preview, "the first chunk is done. the second chunk so far");

  chunked.aborted = true;
  preview = null;
  prompt.renderChunkedPreview(chunked);
  assert.equal(preview, null, "a cancelled session stops updating the preview");
});

test("the assembled dictation is recorded once, and history never costs the text", async () => {
  const calls = [];
  const VoiceInputPrompt = loadForChunking(async (channel, ...args) => {
    calls.push([channel, ...args]);
    if (channel === "record-assembled-transcription") return "scrubbed text";
    return null;
  });
  const prompt = createBarePrompt(VoiceInputPrompt);

  // The scrubbed text the backend returns is what gets inserted, so the insert
  // and the history row cannot drift apart.
  assert.equal(await prompt.recordAssembledTranscription("joined text"), "scrubbed text");
  assert.deepEqual(calls, [["record-assembled-transcription", "joined text"]]);

  // Empty means silence — nothing to record.
  calls.length = 0;
  assert.equal(await prompt.recordAssembledTranscription(""), "");
  assert.deepEqual(calls, []);

  const failing = loadForChunking(async () => {
    throw new Error("history write failed");
  });
  const failingPrompt = createBarePrompt(failing);
  assert.equal(
    await failingPrompt.recordAssembledTranscription("joined text"),
    "joined text",
    "a failed history write must not lose the dictation"
  );
});

test("an empty postprocessed final is not replaced with the unprocessed text", async () => {
  const VoiceInputPrompt = loadForChunking(async () => "");
  const prompt = createBarePrompt(VoiceInputPrompt);
  assert.equal(await prompt.recordAssembledTranscription("discarded boilerplate"), "");
});

test("cancelling on release does not decode a final chunk that is about to be killed", () => {
  const VoiceInputPrompt = loadForChunking(async () => null);
  const enqueued = [];
  const prompt = createBarePrompt(VoiceInputPrompt, {
    enqueueChunkDecode(_chunked, pcm) {
      enqueued.push(pcm.length);
    },
  });

  const chunked = makeChunked();
  chunked.blocks.push(new Float32Array(320));
  chunked.blockSamples = 320;
  chunkDecision.pushFrame(chunked.state, 0.1, 320);

  prompt.stopChunkedCapture({ chunked }, { flush: false });

  assert.deepEqual(enqueued, []);
  assert.equal(chunked.stopped, true, "capture still tears down on cancel");
});

// ---- Session lifecycle and recorder-event recovery ---------------------

function createFakeTimers() {
  const pending = new Map();
  let nextId = 0;
  return {
    pending,
    setTimeout(callback, delay) {
      const id = ++nextId;
      pending.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(delay) {
      const timer = [...pending.entries()].find(([, item]) => item.delay === delay);
      assert.ok(timer, `expected a pending ${delay}ms timer`);
      pending.delete(timer[0]);
      timer[1].callback();
    },
  };
}

async function settlePromises() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function createLifecycleHarness(options = {}) {
  const timers = createFakeTimers();
  const calls = [];
  const inserted = [];
  const recovered = [];
  const streams = [];
  let hides = 0;
  class FakeAudioContext {
    constructor() { this.sampleRate = 16000; this.state = "running"; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 0 }; }
    async close() { this.state = "closed"; }
  }
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  }
  const VoiceInputPrompt = loadVoiceInputPrompt({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    captureLifecycle: options.captureLifecycle,
    captureAudioProbe: options.captureAudioProbe,
    performance: options.performance,
    invoke(command, ...args) {
      calls.push([command, ...args]);
      if (options.invoke) return options.invoke(command, ...args);
      if (command === "transcribe-audio") return Promise.resolve(`final ${args[3]}`);
      if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
      return Promise.resolve(null);
    },
    window: {
      AudioContext: FakeAudioContext,
      TypeAloudChunk: chunkDecision,
      TypeAloudVad: { encodeWavPcm16 },
      TypeAloudVadGate: options.vadGate || null,
    },
    globals: {
      MediaRecorder: FakeMediaRecorder,
      navigator: { mediaDevices: { async getUserMedia() {
        const stream = { stops: 0, getTracks() { return [{ stop() { stream.stops++; } }]; } };
        streams.push(stream);
        return options.getUserMedia ? options.getUserMedia(stream, streams.length) : stream;
      } } },
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    currentProvider: "local",
    currentModel: options.model || "qwen3-asr-0.6b-q8_0",
    cancelInProgress: false,
    stopRequested: false,
    promptElement: { classList: { add() {}, remove() {} } },
    clearHidePromptTimer: VoiceInputPrompt.prototype.clearHidePromptTimer,
    clearActualHideTimer() {},
    clearInsertFailedUi: VoiceInputPrompt.prototype.clearInsertFailedUi,
    clearTranscriptionPreview() {},
    updateModelBadge() {},
    hasReadyEngine: async () => true,
    startWaveAnimation() {},
    stopWaveAnimation() {},
    startRecordingTimer() {},
    stopRecordingTimer() {},
    async setupNemotronLive() {},
    async setupChunkedLocal(session) {
      if (options.batch) return;
      this.createChunkedSession(session, options.sampleRate || 16000);
      const pcm = new Float32Array(320);
      this.consumeChunkedSamples(session, pcm);
    },
    async typeText(text) { inserted.push(text); return { ok: true, direct: true }; },
    showInsertFailed(text) { recovered.push(text); this._failedText = text; },
    hidePrompt() { hides++; },
  });
  await prompt.startRecording();
  return { prompt, session: prompt.activeRecordingSession, recorder: prompt.mediaRecorder,
    calls, inserted, recovered, streams, timers, get hides() { return hides; } };
}

test("letters spanning chunks reach final formatting once and insert its returned text", async () => {
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return Promise.resolve(args[3] === 0 ? "A P" : "I");
    if (command === "record-assembled-transcription") {
      assert.equal(args[0], "A P I");
      return Promise.resolve("API");
    }
    return Promise.resolve(null);
  } });
  h.prompt.closeChunk(h.session.chunked, 320, "test");
  await settlePromises();
  assert.deepEqual(Array.from(h.session.chunked.results), ["A P"]);
  h.prompt.consumeChunkedSamples(h.session, new Float32Array(320));
  h.prompt.stopRecording();
  await settlePromises();
  assert.deepEqual(h.inserted, ["API"]);
  assert.equal(h.session.finalText, "API");
  assert.equal(h.calls.filter(([command]) => command === "record-assembled-transcription").length, 1);
});

test("a chunked session finalizes on release, and late onstop events cannot repeat it", async () => {
  const h = await createLifecycleHarness();
  h.prompt.stopRecording();
  await settlePromises();
  // Chunked audio is captured through the worklet and its final segment is
  // closed by stopRecording, so the dictation is finished before the recorder
  // reports anything at all.
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.calls.filter(([command]) => command === "record-assembled-transcription").length, 1);
  h.recorder.onstop();
  h.recorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.calls.filter(([command]) => command === "record-assembled-transcription").length, 1);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  // A real stop clears the diagnostic watch, so it cannot log a false absence.
  assert.equal([...h.timers.pending.values()].some((timer) => timer.delay === 2000), false);
});

test("the chunked stop watch is diagnostic only and changes nothing when it fires", async () => {
  const h = await createLifecycleHarness({ captureLifecycle: true });
  h.prompt.stopRecording();
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0"]);
  h.timers.fire(2000);
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.calls.filter(([command]) => command === "record-assembled-transcription").length, 1);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  // It reports the missing stop event and nothing else.
  const reports = h.calls.filter(([command]) => command === "report-transcription-lifecycle");
  assert.equal(reports.some(([, report]) => report.phase === "recorder-stop" && report.event === "timeout"), true);
  assert.equal(reports.some(([, report]) => report.phase === "recorder-stop" && report.event === "complete"), false);
});

test("a failed chunked dictation still keeps retry audio the recorder delivers after release", async () => {
  const h = await createLifecycleHarness({
    vadGate: { encodeFullWav: async () => new Uint8Array([1, 2, 3]) },
    invoke(command) {
      if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
      if (command === "save-pending-transcription") return Promise.resolve("audio-history-id");
      return Promise.resolve(null);
    },
  });
  h.prompt.stopRecording();
  // Finalization now starts before the recorder hands over its Blob, so the
  // container arrives while the chunk decode is still in flight.
  h.recorder.ondataavailable({ data: new Blob(["late container"]) });
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.equal(h.calls.filter(([command]) => command === "save-pending-transcription").length, 1);
});

test("a chunked failure before any recorder data still saves the late container", async () => {
  const h = await createLifecycleHarness({
    vadGate: { encodeFullWav: async () => new Uint8Array([4, 5, 6]) },
    invoke(command) {
      if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
      if (command === "save-pending-transcription") return Promise.resolve("audio-history-id");
      return Promise.resolve(null);
    },
  });
  h.prompt.stopRecording();
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false);
  h.recorder.ondataavailable({ data: new Blob(["container after the failure"]) });
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.calls.filter(([command]) => command === "save-pending-transcription").length, 1);
  assert.deepEqual(h.inserted, []);
});

test("a chunked failure saves the late container even when onstop never arrives", async () => {
  const h = await createLifecycleHarness({
    vadGate: { encodeFullWav: async () => new Uint8Array([7, 8, 9]) },
    invoke(command) {
      if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
      if (command === "save-pending-transcription") return Promise.resolve("audio-history-id");
      return Promise.resolve(null);
    },
  });
  h.prompt.stopRecording();
  await settlePromises();
  // The container is delivered by its own dataavailable event; the stop event
  // that follows it is exactly the one WebKit is known to drop.
  h.recorder.ondataavailable({ data: new Blob(["container, no stop event"]) });
  await settlePromises();
  assert.equal(h.calls.filter(([command]) => command === "save-pending-transcription").length, 1);
});

test("a chunked final survives an empty MediaRecorder Blob", async () => {
  const h = await createLifecycleHarness();
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.session.chunks.length, 0);
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
});

test("a missing batch onstop never submits an unfinalized Blob", async () => {
  const h = await createLifecycleHarness({ batch: true });
  h.recorder.ondataavailable({ data: new Blob(["partial container"]) });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "transcribe-audio"), false);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
});

test("resampling timeout terminates the session and cannot repaint a newer recording", async () => {
  const resample = createDeferred();
  const h = await createLifecycleHarness({ sampleRate: 48000 });
  h.prompt.resampleTo16k = () => resample.promise;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.stopRequested = false;
  await h.prompt.startRecording();
  h.prompt.statusText.textContent = "new recording";
  h.timers.fire(30000);
  await settlePromises();
  assert.equal(h.prompt.pendingInsertionOrder.includes(h.session.id), false);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  assert.equal(h.streams[1].stops, 0);
  assert.equal(h.prompt.isRecording, true);
  assert.equal(h.prompt.statusText.textContent, "new recording");
  resample.resolve(new Float32Array(320));
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "transcribe-audio"), false);
  assert.deepEqual(h.inserted, []);
});

test("a chunk IPC timeout releases the queue and ignores a late final", async () => {
  const transcription = createDeferred();
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return transcription.promise;
    if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
    return Promise.resolve(null);
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.timers.fire(450000);
  await settlePromises();
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  transcription.resolve("too late");
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.equal(h.calls.some(([command]) => command === "record-assembled-transcription"), false);
});

test("history timeout preserves a complete final and late history never inserts twice", async () => {
  const history = createDeferred();
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.resolve("complete final");
    if (command === "record-assembled-transcription") return history.promise;
    return Promise.resolve(null);
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.timers.fire(5000);
  await settlePromises();
  assert.deepEqual(h.inserted, ["complete final"]);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  history.resolve("late scrubbed final");
  await settlePromises();
  assert.deepEqual(h.inserted, ["complete final"]);
});

test("Escape cancels a nonsettling chunk immediately and late results cannot reenter", async () => {
  const transcription = createDeferred();
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return transcription.promise;
    if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
    return Promise.resolve(null);
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  transcription.resolve("cancelled final");
  await settlePromises();
  assert.deepEqual(h.inserted, []);
});

test("Escape cancels a waiting recorder session without cancelling an earlier transcription", async () => {
  const h = await createLifecycleHarness();
  h.prompt.pendingInsertionOrder.unshift(0);
  h.prompt.activeTranscriptionSessionIds.add(0);
  h.prompt.transcriptionInProgressCount = 1;
  h.prompt.stopRecording();
  h.prompt.cancelRecording();
  await settlePromises();
  assert.deepEqual(Array.from(h.prompt.pendingInsertionOrder), [0]);
  assert.equal(h.session.chunked.aborted, true);
  assert.equal(h.calls.some(([command, id]) => command === "cancel-transcription" && id === 0), false);
  h.recorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, []);
});

test("an incomplete chunked dictation keeps completed text for Copy and never inserts a gap", async () => {
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.reject(new Error("chunk failure"));
    return Promise.resolve(null);
  } });
  h.session.chunked.results = ["preserved first chunk"];
  h.session.chunked.nextChunkIndex = 1;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(h.recovered, ["preserved first chunk"]);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
});

test("a completed newer session keeps FIFO order behind an older valid session", async () => {
  const first = createDeferred();
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return args[2] === 1 ? first.promise : Promise.resolve("second final");
    if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
    return Promise.resolve(null);
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.stopRequested = false;
  await h.prompt.startRecording();
  const secondRecorder = h.prompt.mediaRecorder;
  h.prompt.stopRecording();
  secondRecorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(Array.from(h.prompt.pendingInsertionOrder), [1, 2]);
  first.resolve("first final");
  await settlePromises();
  assert.deepEqual(h.inserted, ["first final", "second final"]);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
});

test("old incomplete text stays hidden after the newer successful recording finishes", async () => {
  const first = createDeferred();
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return args[2] === 1 ? first.promise : Promise.resolve("new final");
    if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
    return Promise.resolve(null);
  } });
  h.session.chunked.results = ["old recovered text"];
  h.session.chunked.nextChunkIndex = 1;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.stopRequested = false;
  await h.prompt.startRecording();
  const secondRecorder = h.prompt.mediaRecorder;
  first.reject(new Error("old chunk failed"));
  await settlePromises();
  assert.deepEqual(h.recovered, [], "an old failure must not cover the new recording");
  assert.equal(h.streams[1].stops, 0);
  h.prompt.stopRecording();
  secondRecorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, ["new final"]);
  assert.deepEqual(h.recovered, []);
  assert.equal(h.hides, 1, "old recovery custody must not block a later successful hide");
  assert.equal(h.prompt.recoverableTranscriptions.get(1).text, "old recovered text");
});

test("cancelling during history ignores a late result and does not revive recovery UI", async () => {
  const history = createDeferred();
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.resolve("final before cancel");
    if (command === "record-assembled-transcription") return history.promise;
    return Promise.resolve(null);
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  history.resolve("late history final");
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(h.recovered, []);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
});

test("an old cleanup cannot close the microphone owned by a newer session", async () => {
  const h = await createLifecycleHarness();
  h.prompt.stopRecording();
  h.prompt.stopRequested = false;
  await h.prompt.startRecording();
  h.prompt.cleanup({ recordingSession: h.session });
  assert.equal(h.streams[1].stops, 0);
  assert.equal(h.prompt.audioContext.state, "running");
  assert.equal(h.prompt.mediaStream, h.streams[1]);
});

test("late chunk partials cannot overwrite a final waiting on history", async () => {
  const handlers = new Map();
  const VoiceInputPrompt = loadVoiceInputPrompt({ on(channel, callback) { handlers.set(channel, callback); } });
  const previews = [];
  const chunked = makeChunked({ inFlightChunkIndex: null, results: ["final text"] });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 7,
    transcriptionInProgressCount: 1,
    transcriptionText: {},
    activeRecordingSession: { id: 7, lifecycle: { state: "processing" }, chunked },
    setTranscriptionPreview(text) { previews.push(text); },
  });
  prompt.setupEventListeners();
  handlers.get("local-transcription-partial")(null, { sessionId: 7, chunkIndex: 0, text: "late partial" });
  assert.deepEqual(previews, []);
});

test("lifecycle diagnostics contain phase metadata but never transcription content", async () => {
  const reports = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    captureLifecycle: true,
    invoke(command, ...args) {
      if (command === "report-transcription-lifecycle") reports.push(args[0]);
      if (command === "transcribe-audio") return Promise.resolve("private dictation content");
      return Promise.resolve(null);
    },
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 1,
    pendingInsertionOrder: [1],
    async flushPendingInsertions() {},
  });
  await processOneRecording(prompt);
  assert.ok(reports.some(({ phase, event }) => phase === "chunk-ipc" && event === "complete"));
  for (const report of reports) {
    assert.equal(report.sessionId, 1);
    assert.ok(Number.isInteger(report.elapsedMs) && report.elapsedMs >= 0);
    assert.ok(Object.keys(report).every((key) => ["sessionId", "phase", "event", "elapsedMs", "pendingCount", "chunkIndex"].includes(key)));
  }
  assert.equal(JSON.stringify(reports).includes("private"), false);
});

test("cancelling a queued local slot cannot let its successor overtake the holder", async () => {
  const VoiceInputPrompt = loadVoiceInputPrompt();
  const prompt = createBarePrompt(VoiceInputPrompt);
  const first = { id: 1 };
  const second = { id: 2 };
  const third = { id: 3 };
  const releaseFirst = await prompt.acquireLocalTranscriptionSlot(first);
  const secondSlot = prompt.acquireLocalTranscriptionSlot(second);
  await settlePromises();
  prompt.cancelRecordingSession(second);
  await assert.rejects(secondSlot, /TRANSCRIPTION_CANCELLED/);
  let thirdAcquired = false;
  const thirdSlot = prompt.acquireLocalTranscriptionSlot(third).then((release) => {
    thirdAcquired = true;
    return release;
  });
  await settlePromises();
  assert.equal(thirdAcquired, false);
  releaseFirst();
  const releaseThird = await thirdSlot;
  assert.equal(thirdAcquired, true);
  releaseThird();
});

function createInsertionHarness(options = {}) {
  const timers = createFakeTimers();
  const firstInsertion = createDeferred();
  const attempts = [];
  const uiEvents = [];
  const VoiceInputPrompt = loadVoiceInputPrompt({
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    invoke: async () => null,
  });
  const prompt = createBarePrompt(VoiceInputPrompt, {
    recordingSessionId: 2,
    pendingInsertionOrder: [1, 2],
    pendingInsertionsById: new Map([[1, "first"], [2, "second"]]),
    async typeText(text) {
      attempts.push(text);
      return text === "first" ? firstInsertion.promise : { ok: true, direct: true };
    },
    updateStatusText() { uiEvents.push("update"); },
    hidePrompt() { uiEvents.push("hide"); },
    showInsertFailed(text) { uiEvents.push(`copy:${text}`); },
    scheduleHidePrompt() { uiEvents.push("schedule-hide"); },
    ...options,
  });
  const firstSession = { id: 1 };
  const secondSession = { id: 2 };
  prompt.ensureRecordingSession(firstSession).state = "ready";
  prompt.ensureRecordingSession(secondSession).state = "ready";
  return { prompt, firstSession, firstInsertion, attempts, uiEvents, timers };
}

test("insertion holds FIFO until the actual native reply without a synthetic timeout", async () => {
  const h = createInsertionHarness();
  const flushing = h.prompt.flushPendingInsertions();
  await settlePromises();
  assert.deepEqual(h.attempts, ["first"]);
  assert.equal([...h.timers.pending.values()].some(({ delay }) => delay === 15000), false);
  assert.equal(h.prompt.isFlushingInsertQueue, true);
  h.firstInsertion.resolve({ ok: true, direct: true });
  await flushing;
  assert.deepEqual(h.attempts, ["first", "second"]);
});

test("cancelling an already dispatched insertion cannot release its FIFO lock", async () => {
  const h = createInsertionHarness();
  const flushing = h.prompt.flushPendingInsertions();
  await settlePromises();
  h.prompt.cancelRecordingSession(h.firstSession);
  await settlePromises();
  assert.deepEqual(h.attempts, ["first"], "the second native side effect must still wait");
  assert.equal(h.prompt.isFlushingInsertQueue, true);
  h.firstInsertion.resolve({ ok: true, direct: true });
  await flushing;
  assert.deepEqual(h.attempts, ["first", "second"]);
  assert.equal(h.uiEvents.some((event) => event.startsWith("copy:")), false);
});

test("a cancelled native insertion reply cannot update or hide a newer recording", async () => {
  const h = createInsertionHarness();
  const flushing = h.prompt.flushPendingInsertions();
  await settlePromises();
  h.prompt.cancelRecordingSession(h.firstSession);
  h.prompt.recordingSessionId = 3;
  h.prompt.isRecording = true;
  h.prompt.statusText.textContent = "new recording";
  h.uiEvents.length = 0;
  h.firstInsertion.resolve({ ok: false, message: "late native result" });
  await flushing;
  assert.deepEqual(h.attempts, ["first"]);
  assert.deepEqual(h.uiEvents, []);
  assert.equal(h.prompt.statusText.textContent, "new recording");
  assert.deepEqual(Array.from(h.prompt.pendingInsertionOrder), [2]);
});

test("Escape cancels the selected recording without discarding hidden older recovery", async () => {
  const h = await createLifecycleHarness();
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "older recoverable text" });
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.isRecording, false);
  assert.equal(h.prompt.cancelInProgress, false, "the recording-cancel gate must be released");
  assert.deepEqual(h.recovered, []);
  h.timers.fire(300);
  assert.equal(h.hides, 1, "hidden recovery is not a pending UI operation");
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.size, 1);
  h.timers.fire(300);
  assert.equal(h.hides, 2);
});

test("an old cancel callback cannot clear a newer startup cancellation gate", async () => {
  const h = await createLifecycleHarness();
  h.prompt.cancelRecording();
  const preflight = createDeferred();
  h.prompt.hasReadyEngine = () => preflight.promise;
  h.prompt.stopRequested = false;
  const starting = h.prompt.startRecording();
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.starting, true);
  assert.equal(h.prompt.cancelInProgress, true, "the new startup cancellation still owns the gate");
  preflight.resolve(true);
  await starting;
});

test("current failed final remains copyable without resurfacing older recovery", async () => {
  const copied = [];
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "transcribe-audio") return Promise.resolve("new complete final");
    if (command === "record-assembled-transcription") return Promise.reject(new Error("history unavailable"));
    if (command === "copy-to-clipboard") copied.push(args[0]);
    return Promise.resolve(null);
  } });
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "older recovered text" });
  const showInsertFailed = Object.getPrototypeOf(h.prompt).showInsertFailed;
  h.prompt.showInsertFailed = function(text) {
    h.recovered.push(text);
    showInsertFailed.call(this, text);
  };
  h.prompt.typeText = async () => ({ ok: false, message: "No editable text field" });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.size, 2);
  assert.equal(h.prompt.recoverableTranscriptions.get(0).kind, "incomplete");
  assert.equal(h.prompt.recoverableTranscriptions.get(h.session.id).kind, "insert-failed");
  assert.equal(h.prompt._failedText, "new complete final");
  assert.equal(h.prompt.promptText.textContent, "inputPrompt.insertFailedTitle");
  assert.deepEqual(h.recovered, ["new complete final"]);
  await h.prompt.copyFailedText();
  assert.equal(h.prompt.recoverableTranscriptions.size, 2, "Copy is not a persistence ACK");
  assert.deepEqual(copied, ["new complete final"]);
  h.timers.fire(1200);
  assert.equal(h.hides, 1);
});

test("startup cancellation keeps its gate through worklet setup and releases it after stop", async () => {
  const h = await createLifecycleHarness();
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "old recovery" });
  const setup = createDeferred();
  const originalSetup = h.prompt.setupChunkedLocal;
  h.prompt.setupChunkedLocal = async function(session, source) {
    await setup.promise;
    return originalSetup.call(this, session, source);
  };
  h.prompt.stopRequested = false;
  const starting = h.prompt.startRecording();
  await settlePromises();
  const cancelledSessionId = h.prompt.activeRecordingSession.id;
  assert.equal(cancelledSessionId, 2, "the session exists before AudioWorklet setup completes");
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.starting, true);
  assert.equal(h.prompt.cancelInProgress, true, "setup must still see the pending cancellation");
  setup.resolve();
  await starting;
  await settlePromises();
  assert.equal(h.prompt.cancelInProgress, false, "completed startup cancellation must release its gate");
  assert.equal(h.prompt.isRecording, false);
  assert.equal(h.calls.some(([command, ...args]) => command === "transcribe-audio" && args[2] === cancelledSessionId), false);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  assert.deepEqual(h.recovered, []);
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.size, 1);
});

test("cancelling pending microphone acquisition does not hide older recovery text", async () => {
  const microphone = createDeferred();
  const h = await createLifecycleHarness({ getUserMedia(stream, count) {
    return count === 2 ? microphone.promise.then(() => stream) : stream;
  } });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  const hidesBeforeStartup = h.hides;
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "old recovery" });
  h.prompt.stopRequested = false;
  const starting = h.prompt.startRecording();
  await settlePromises();
  h.prompt.cancelRecording();
  microphone.resolve();
  await starting;
  await settlePromises();
  assert.equal(h.streams[1].stops, 1, "a startup cancelled while the microphone was opening closes that stream");
  assert.equal(h.hides, hidesBeforeStartup, "older recovery must not disappear with the cancelled startup");
  assert.deepEqual(h.recovered, []);
  assert.equal(h.prompt.cancelInProgress, false);
});

function useRealRecoveryUi(h) {
  const show = Object.getPrototypeOf(h.prompt).showInsertFailed;
  h.prompt.showInsertFailed = function(text) { h.recovered.push(text); show.call(this, text); };
}

test("hidden old recovery neither resurfaces nor prevents a later successful dictation from hiding", async () => {
  const h = await createLifecycleHarness();
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "old unsaved text" });
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.hides, 1);
  assert.deepEqual(h.recovered, []);
  assert.equal(h.prompt.recoverableTranscriptions.get(0).text, "old unsaved text");
});

test("current recovery auto-hides after fifteen seconds without deleting unsaved content", async () => {
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
    if (command === "save-recovered-transcription") return Promise.reject(new Error("disk unavailable"));
    return Promise.resolve(null);
  } });
  useRealRecoveryUi(h);
  h.session.chunked.results = ["recover me"];
  h.session.chunked.nextChunkIndex = 1;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.deepEqual(h.recovered, ["recover me"]);
  h.timers.fire(15000);
  assert.equal(h.hides, 1);
  assert.equal(h.prompt.recoverableTranscriptions.get(1).text, "recover me");
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
});

test("recovery timeout retains content until its late durable acknowledgment arrives", async () => {
  const saved = createDeferred();
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "save-recovered-transcription") return saved.promise;
    return Promise.resolve(null);
  } });
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "durable text" });
  await settlePromises();
  const save = h.calls.find(([command]) => command === "save-recovered-transcription");
  assert.ok(save);
  assert.equal(save[1].text, "durable text");
  assert.equal(save[1].kind, "incomplete");
  assert.match(save[1].id, /^recovery-/);
  h.timers.fire(5000);
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.get(0).text, "durable text");
  saved.resolve("existing-history-id");
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.has(0), false);
  assert.deepEqual(h.recovered, []);
});

test("failed recovery persistence retries with its same id on the next recording result", async () => {
  let saves = 0;
  const h = await createLifecycleHarness({ invoke(command, ...args) {
    if (command === "save-recovered-transcription") {
      saves++;
      return saves === 1 ? Promise.reject(new Error("disk unavailable")) : Promise.resolve("history-id");
    }
    if (command === "transcribe-audio") return Promise.resolve("new text");
    if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
    return Promise.resolve(null);
  } });
  h.prompt.preserveCompletedChunks({ id: 0, finalText: "retry me" });
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.size, 1);
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  const ids = h.calls.filter(([command]) => command === "save-recovered-transcription").map(([, request]) => request.id);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(h.prompt.recoverableTranscriptions.size, 0);
  assert.deepEqual(h.inserted, ["new text"]);
  assert.equal(h.hides, 1);
});

test("batch onstop after its two-second warning still transcribes before the hard deadline", async () => {
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { analyze: async () => ({ speech: true, wav: new Uint8Array([1, 2, 3]) }) } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  await settlePromises();
  assert.deepEqual(Array.from(h.prompt.pendingInsertionOrder), [1]);
  assert.equal(h.calls.some(([command]) => command === "transcribe-audio"), false);
  h.recorder.ondataavailable({ data: new Blob(["complete container"]) });
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.inserted.length, 1);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
});

test("a batch hard timeout recovers a late final once without inserting or touching the new recording", async () => {
  const encoded = createDeferred();
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { encodeFullWav: () => encoded.promise },
    invoke(command) { return Promise.resolve(command === "save-pending-transcription" ? "audio-history-id" : null); } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  h.prompt.stopRequested = false;
  await h.prompt.startRecording();
  h.prompt.statusText.textContent = "new recording";
  h.recorder.ondataavailable({ data: new Blob(["complete late container"]) });
  h.recorder.onstop();
  h.recorder.onstop();
  await settlePromises();
  encoded.resolve(new Uint8Array([1, 2, 3]));
  await settlePromises();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.calls.filter(([command]) => command === "save-pending-transcription").length, 1);
  assert.equal(h.calls.some(([command]) => command === "transcribe-audio"), false);
  assert.deepEqual(h.inserted, []);
  assert.equal(h.prompt.statusText.textContent, "new recording");
  assert.equal(h.streams[1].stops, 0);
});

test("cancelling a hard-timed-out batch discards late recorder recovery", async () => {
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { encodeFullWav: async () => new Uint8Array([1, 2, 3]) } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  h.prompt.cancelRecording();
  h.recorder.ondataavailable({ data: new Blob(["cancelled container"]) });
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false);
  assert.deepEqual(h.inserted, []);
});

test("late batch recovery retains its original Blob when WAV encoding times out", async () => {
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { encodeFullWav: () => new Promise(() => {}) } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  h.recorder.ondataavailable({ data: new Blob(["complete late container"]) });
  h.recorder.onstop();
  await settlePromises();
  h.timers.fire(30000);
  await settlePromises();
  assert.ok(h.session.audioRecovery.blob.size > 0);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
});

test("a stale recovery ACK cannot delete replacement text for the same session", async () => {
  const first = createDeferred();
  const second = createDeferred();
  let saves = 0;
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "save-recovered-transcription") return ++saves === 1 ? first.promise : second.promise;
    return Promise.resolve(null);
  } });
  h.prompt.preserveRecoveryText(0, "old value", "incomplete");
  await settlePromises();
  const oldId = h.prompt.recoverableTranscriptions.get(0).id;
  h.prompt.preserveRecoveryText(0, "replacement value", "insert-failed");
  await settlePromises();
  const replacement = h.prompt.recoverableTranscriptions.get(0);
  assert.notEqual(replacement.id, oldId);
  first.resolve("first-history-row");
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.get(0), replacement);
  second.resolve("replacement-history-row");
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.size, 0);
});

test("idle Escape dismisses current recovery without discarding current or older text", async () => {
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
    return Promise.resolve(null);
  } });
  h.prompt.preserveRecoveryText(0, "hidden older text", "incomplete");
  h.session.chunked.results = ["current recovered text"];
  h.session.chunked.nextChunkIndex = 1;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.prompt.recoveryShownId, 1);
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.get(1).text, "current recovered text");
  assert.equal(h.prompt.recoverableTranscriptions.get(0).text, "hidden older text");
});

test("late batch persistence retries the same request id and keeps source audio until ACK", async () => {
  const firstSave = createDeferred();
  let saves = 0;
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { encodeFullWav: async () => new Uint8Array([1, 2, 3]) },
    invoke(command) {
      if (command === "save-pending-transcription") return ++saves === 1 ? firstSave.promise : Promise.resolve("pending-row");
      return Promise.resolve(null);
    } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  h.recorder.ondataavailable({ data: new Blob(["late complete container"]) });
  h.recorder.onstop();
  await settlePromises();
  h.timers.fire(5000);
  await settlePromises();
  assert.ok(h.session.audioRecovery.blob.size > 0);
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  h.prompt.retryRecoveryPersistence();
  await settlePromises();
  const requests = h.calls.filter(([command]) => command === "save-pending-transcription");
  assert.equal(requests.length, 2);
  assert.match(requests[0][3], /^pending-/);
  assert.equal(requests[0][3], requests[1][3]);
  assert.equal(h.session.audioRecovery.blob, null);
  firstSave.resolve("pending-row");
  await settlePromises();
  assert.equal(h.prompt.recoverableAudioSessions.size, 0);
});

test("late batch onstop before its final data still saves exactly once", async () => {
  const h = await createLifecycleHarness({ batch: true,
    vadGate: { encodeFullWav: async () => new Uint8Array([1, 2, 3]) },
    invoke(command) { return Promise.resolve(command === "save-pending-transcription" ? "pending-row" : null); } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false);
  h.recorder.ondataavailable({ data: new Blob(["late final container"]) });
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.calls.filter(([command]) => command === "save-pending-transcription").length, 1);
  assert.deepEqual(h.inserted, []);
});

test("cancelling late WAV encoding prevents a subsequent audio persistence request", async () => {
  const encoded = createDeferred();
  const h = await createLifecycleHarness({ batch: true, vadGate: { encodeFullWav: () => encoded.promise } });
  h.prompt.stopRecording();
  h.timers.fire(2000);
  h.timers.fire(15000);
  await settlePromises();
  h.recorder.ondataavailable({ data: new Blob(["late final container"]) });
  h.recorder.onstop();
  await settlePromises();
  h.prompt.cancelRecording();
  encoded.resolve(new Uint8Array([1, 2, 3]));
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false);
  assert.equal(h.prompt.recoverableAudioSessions.size, 0);
});

test("late cloud audio stays in memory without raw persistence or rerouting", async () => {
  for (const route of [{ provider: "openai" }, { provider: "groq" }]) {
    const h = await createLifecycleHarness({ batch: true,
      vadGate: { encodeFullWav: async () => { throw new Error("must not encode cloud recovery"); } } });
    Object.assign(h.session, route);
    h.prompt.stopRecording();
    h.timers.fire(2000);
    h.timers.fire(15000);
    await settlePromises();
    h.recorder.ondataavailable({ data: new Blob(["late private cloud audio"]) });
    h.recorder.onstop();
    await settlePromises();
    h.prompt.retryRecoveryPersistence();
    await settlePromises();
    assert.ok(h.session.audioRecovery.blob.size > 0);
    assert.equal(h.calls.some(([command]) => ["save-pending-transcription", "transcribe-audio"].includes(command)), false);
    assert.deepEqual(h.inserted, []);
  }
});

test("idle Escape keeps unsaved current text until its durable ACK without reviving the card", async () => {
  const saved = createDeferred();
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "transcribe-audio") return Promise.reject(new Error("decode failed"));
    if (command === "save-recovered-transcription") return saved.promise;
    return Promise.resolve(null);
  } });
  useRealRecoveryUi(h);
  h.session.chunked.results = ["completed words to preserve"];
  h.session.chunked.nextChunkIndex = 1;
  h.prompt.stopRecording();
  h.recorder.onstop();
  await settlePromises();
  assert.equal(h.prompt.transcriptionInProgressCount, 0);
  assert.equal(h.prompt.recoveryShownId, 1);
  const recovery = h.prompt.recoverableTranscriptions.get(1);
  h.prompt.cancelRecording();
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.get(1), recovery);
  assert.equal(recovery.discarded, undefined);
  assert.equal(h.prompt.pendingRecoveryUi, null);
  h.timers.fire(300);
  assert.equal(h.hides, 1);
  saved.resolve("durable-history-row");
  await settlePromises();
  assert.equal(h.prompt.recoverableTranscriptions.has(1), false);
  assert.equal(h.prompt.pendingRecoveryUi, null);
  assert.equal(h.prompt.statusText.textContent, "");
  assert.deepEqual(h.recovered, ["completed words to preserve"]);
});

test("native startup errors before the start response cannot enter Listening", async () => {
  let handler;
  const V = loadVoiceInputPrompt({
    createChannel(h) { handler = h; return {}; },
    invoke(command) {
      if (command === "start-native-capture") {
        handler({ event: "error", message: "device disconnected" });
        handler({ event: "stopped", stats: { outputSamples: 0 } });
        return Promise.resolve({ inputRate: 48000 });
      }
      return Promise.resolve(null);
    },
  });
  const prompt = createBarePrompt(V, {
    osName: "macos", stopRequested: false,
    promptElement: { classList: { add() {} } },
    clearTranscriptionPreview() {}, startWaveAnimation() {}, startRecordingTimer() {},
  });
  assert.equal(await prompt.startNativeRecording({}, 0, 0), false);
  assert.equal(prompt.isRecording, false);
  assert.equal(prompt.pendingInsertionOrder.length, 0);
});

test("native stop deadline covers an unresolved IPC and ignores late PCM", async () => {
  const timers = createFakeTimers();
  const stop = createDeferred();
  const V = loadVoiceInputPrompt({
    invoke(command) { return command === "stop-native-capture" ? stop.promise : Promise.resolve(null); },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const prompt = createBarePrompt(V);
  const session = { id: 1, chunks: [] };
  const capture = prompt.createNativeCapture(session);
  prompt.nativeCapture = capture;
  prompt.consumeNativeCaptureMessage(session, new Uint8Array([0, 64]).buffer);
  const finishing = prompt.finishNativeCapture(session);
  await settlePromises();
  timers.fire(8000);
  await finishing;
  assert.equal(prompt.nativeCapture, null);
  assert.equal(session.captureIncomplete, true);
  assert.equal(session.chunks.length, 1);
  prompt.consumeNativeCaptureMessage(session, new Uint8Array([1, 64]).buffer);
  assert.equal(capture.sampleCount, 1);
  stop.resolve({ outputSamples: 2 });
  await settlePromises();
  assert.equal(session.chunks.length, 1);
});

for (const mode of ["batch", "chunked", "live"]) {
  test(`interrupted native ${mode} audio is transcribed and recovered without insertion`, async () => {
    const h = await createLifecycleHarness({ batch: mode !== "chunked", invoke(command, ...args) {
      if (command === "transcribe-audio" || command === "finish-live-transcription") return Promise.resolve("kept words");
      if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
      return Promise.resolve(null);
    } });
    h.session.captureIncomplete = true;
    if (mode === "batch") h.session.provider = "openai";
    h.session.chunks.push(new Blob([new Uint8Array([1, 2])], { type: "audio/wav" }));
    if (mode === "live") {
      h.session.live = { sessionId: h.session.id, pendingPcm: [], pendingPcmBytes: 0, uploadTail: Promise.resolve() };
    }
    h.prompt.stopRecording();
    h.recorder.onstop();
    await h.session.lifecycle.processPromise;
    await settlePromises();
    assert.deepEqual(h.inserted, []);
    assert.deepEqual(h.recovered, ["kept words"]);
    assert.equal(h.calls.some(([command]) => command === "record-assembled-transcription"), false);
    const saved = h.calls.find(([command]) => command === "save-recovered-transcription");
    assert.equal(saved[1].kind, "incomplete");
    if (mode === "batch") assert.equal(h.calls.find(([command]) => command === "transcribe-audio")[5], true);
    if (mode === "live") assert.equal(h.calls.find(([command]) => command === "finish-live-transcription")[2], true);
    assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  });
}

test("native stop waits for channel drainage and detects missing samples", async () => {
  const timers = createFakeTimers();
  const V = loadVoiceInputPrompt({
    invoke: () => Promise.resolve({ outputSamples: 2, channelSendFailures: 1 }),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const prompt = createBarePrompt(V);
  const session = { id: 1, chunks: [] };
  const capture = prompt.createNativeCapture(session);
  prompt.consumeNativeCaptureMessage(session, new Uint8Array([0, 64]).buffer);
  let finished = false;
  const finishing = prompt.finishNativeCapture(session).then(() => { finished = true; });
  await settlePromises();
  assert.equal(finished, false);
  prompt.consumeNativeCaptureMessage(session, { event: "stopped" });
  await finishing;
  assert.equal(session.captureIncomplete, true);
  assert.equal(session.chunks.length, 1);
  assert.equal(timers.pending.size, 0);
  assert.equal(capture.accepting, false);
});

async function createChunkCoverageHarness(options = {}) {
  let h;
  let clockMs = 0;
  h = await createLifecycleHarness({
    batch: true,
    captureAudioProbe: true,
    performance: { now: () => clockMs },
    vadGate: { encodeFullWav: async (blob) => new Uint8Array(await blob.arrayBuffer()) },
    invoke(command, ...args) {
      if (command === "stop-native-capture") {
        const stats = { outputSamples: options.totalSamples ?? h.session.nativeCapture.sampleCount,
          channelSendFailures: 0 };
        if (!options.deferStopped) h.prompt.consumeNativeCaptureMessage(h.session, { event: "stopped", stats });
        return Promise.resolve(stats);
      }
      if (command === "transcribe-audio") {
        if (args[3] === 0 && options.firstDecode) return options.firstDecode.promise;
        if (options.decodeError) return Promise.reject(new Error("chunk decode failed"));
        return Promise.resolve(args[3] === 0 ? options.firstText ?? "first words" : options.emptyTail ? "" : "tail words");
      }
      if (command === "record-assembled-transcription") return Promise.resolve(args[0]);
      if (command === "report-audio-probe" && options.probeThrows) throw new Error("diagnostic unavailable");
      return Promise.resolve(null);
    },
  });
  h.session.audioContext = null;
  h.prompt.createNativeCapture(h.session);
  h.prompt.nativeCapture = h.session.nativeCapture;
  h.prompt.createChunkedSession(h.session, 16000);
  h.feed = (seconds, silence = false) => {
    for (let second = 0; second < seconds; second++) {
      const bytes = new Uint8Array(16000 * 2);
      if (!silence) for (let offset = 1; offset < bytes.length; offset += 2) bytes[offset] = 64;
      clockMs += 1000;
      h.prompt.consumeNativeCaptureMessage(h.session, bytes.buffer);
    }
  };
  h.advance = (ms) => { clockMs += ms; };
  h.probes = () => h.calls.filter(([command, report]) => command === "report-audio-probe" && report.stage === "chunk")
    .map(([, report]) => Object.fromEntries(report.detail.split(" ").map((part) => part.split("="))));
  h.finish = async () => {
    h.prompt.stopRecording();
    await h.session.nativeCapture.stopPromise;
    await settlePromises();
    await h.session.lifecycle.processPromise;
    await settlePromises();
  };
  return h;
}

for (const cut of ["silence", "forced"]) {
  test(`chunk sample coverage preserves every sample across a ${cut} cut and release`, async () => {
    const h = await createChunkCoverageHarness();
    if (cut === "silence") { h.feed(55); h.feed(1, true); h.feed(24); }
    else h.feed(100);
    const expectedSamples = (cut === "silence" ? 80 : 100) * 16000;
    await h.finish();
    assert.deepEqual(h.inserted, ["first words tail words"]);
    const accounting = h.session.chunked.accounting;
    for (const stage of ["acceptedSamples", "queuedSamples", "submittedSamples", "completedSamples"]) {
      assert.equal(accounting?.[stage], expectedSamples, stage);
    }
    assert.equal(h.session.nativeCapture.sampleCount, expectedSamples);
    assert.equal(h.session.chunked.blockSamples, 0);
    const submittedPcm = h.calls.filter(([command]) => command === "transcribe-audio")
      .map(([, wav]) => Buffer.from(wav).subarray(44));
    const capturedPcm = Buffer.from(await h.session.chunks[0].arrayBuffer()).subarray(44);
    const joinedPcm = Buffer.concat(submittedPcm);
    assert.equal(joinedPcm.length, capturedPcm.length);
    // The existing native positive-PCM normalization can round up by one LSB.
    for (let offset = 0; offset < joinedPcm.length; offset += 2) {
      assert.ok(Math.abs(joinedPcm.readInt16LE(offset) - capturedPcm.readInt16LE(offset)) <= 1,
        `captured sample ${offset / 2} remains at its original position`);
    }
    const queued = h.probes().filter((probe) => probe.event === "queued");
    assert.equal(queued.length, 2);
    assert.equal(queued[0].reason, cut);
    assert.equal(queued[0].start, "0");
    assert.equal(queued[0].end, queued[1].start);
    assert.equal(Number(queued[1].end), expectedSamples);
    assert.equal(queued[1].reason, "release");
    const started = h.probes().filter((probe) => probe.event === "request-start");
    assert.equal(started.length, 2);
    for (const probe of started) {
      assert.equal(Number(probe.wav_frames), Number(probe.input_samples));
      assert.equal(Number(probe.wav_bytes), 44 + Number(probe.wav_frames) * 2);
      assert.equal(probe.rate, "16000");
    }
    const summary = h.probes().find((probe) => probe.event === "final");
    assert.equal(summary.reason, "complete");
    assert.equal(summary.completed_chunks, "2");
    assert.equal(Number(summary.hold_ms), expectedSamples / 16);
    assert.equal(summary.last_pcm_gap_ms, "0");
    assert.equal(JSON.stringify(h.probes()).includes("first words"), false);
  });
}

test("chunk sample coverage waits for a 20 second tail delivered after stop IPC and a delayed first decode", async () => {
  const firstDecode = createDeferred();
  const h = await createChunkCoverageHarness({ firstDecode, deferStopped: true, totalSamples: 76 * 16000 });
  h.feed(55); h.feed(1, true);
  await settlePromises();
  h.prompt.stopRecording();
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "stop-native-capture"), true);
  h.feed(20);
  await settlePromises();
  assert.equal(h.session.chunked.stopped, false, "stop IPC is not channel drainage");
  assert.deepEqual(h.inserted, []);
  h.prompt.consumeNativeCaptureMessage(h.session, { event: "stopped" });
  await h.session.nativeCapture.stopPromise;
  await settlePromises();
  assert.equal(h.session.chunked.accounting?.queuedSamples, 76 * 16000);
  assert.equal(h.session.chunked.accounting.submittedSamples, 56 * 16000);
  assert.equal(h.session.chunked.accounting.completedSamples, 0);
  assert.deepEqual(h.inserted, [], "the first decode is still pending");
  firstDecode.resolve("first words");
  await settlePromises();
  await h.session.lifecycle.processPromise;
  assert.deepEqual(h.inserted, ["first words tail words"]);
  assert.equal(h.session.chunked.accounting.completedSamples, 76 * 16000);
});

for (const fault of ["cleared-tail", "dropped-consumer"]) {
  test(`chunk sample coverage rejects ${fault} instead of inserting the first chunk`, async () => {
    const h = await createChunkCoverageHarness();
    h.feed(55); h.feed(1, true);
    await settlePromises();
    if (fault === "dropped-consumer") h.prompt.consumeChunkedSamples = () => {};
    h.feed(20);
    if (fault === "cleared-tail") {
      h.session.chunked.blocks = [];
      h.session.chunked.blockSamples = 0;
      h.session.chunked.state = chunkDecision.createChunkState();
    }
    await h.finish();
    assert.deepEqual(h.inserted, [], "an uncovered tail must not be auto-inserted as complete");
    assert.deepEqual(h.recovered, ["first words"]);
    assert.equal(h.session.lifecycle.state, "failed");
    assert.equal(h.calls.some(([command]) => command === "record-assembled-transcription"), false);
    assert.equal(h.session.audioRecovery.blob.size, 44 + 76 * 16000 * 2);
    assert.equal(h.session.audioRecovery.wav.length, 44 + 76 * 16000 * 2);
    assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), true);
    assert.equal(h.probes().find((probe) => probe.event === "final").reason, "coverage-mismatch");
  });
}

test("chunk sample coverage accepts a 20 second silent tail returning empty text", async () => {
  const h = await createChunkCoverageHarness({ emptyTail: true });
  h.feed(55); h.feed(1, true); h.feed(20, true);
  await h.finish();
  assert.deepEqual(h.inserted, ["first words"]);
  assert.equal(h.session.chunked.accounting?.completedSamples, 76 * 16000);
  assert.equal(h.calls.filter(([command]) => command === "transcribe-audio").length, 2);
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false);
  const results = h.probes().filter((probe) => probe.event === "request-result");
  assert.equal(results[1].chars, "0");
  assert.equal(h.session.lifecycle.state, "completed");
});

test("chunk sample coverage diagnostics report stalled delivery without making wall time an invariant", async () => {
  const h = await createChunkCoverageHarness();
  h.feed(55); h.feed(1, true); h.advance(20000);
  await h.finish();
  assert.deepEqual(h.inserted, ["first words"]);
  const summary = h.probes().find((probe) => probe.event === "final");
  assert.equal(summary?.hold_ms, "76000");
  assert.equal(summary?.last_pcm_gap_ms, "20000");
  assert.equal(summary?.native_samples, String(56 * 16000));
});

test("chunk sample coverage diagnostics cannot fail a healthy recording", async () => {
  const h = await createChunkCoverageHarness({ probeThrows: true });
  h.feed(55); h.feed(1, true); h.feed(20);
  await h.finish();
  assert.deepEqual(h.inserted, ["first words tail words"]);
});

test("chunk sample coverage release diagnostics retain a stalled gap before a final tiny PCM packet", async () => {
  const h = await createChunkCoverageHarness({ deferStopped: true, totalSamples: 56 * 16000 + 1, emptyTail: true });
  h.feed(55); h.feed(1, true); h.advance(20000);
  h.prompt.stopRecording();
  await settlePromises();
  assert.equal(h.probes().find((probe) => probe.event === "stop").last_pcm_gap_ms, "20000");
  h.prompt.consumeNativeCaptureMessage(h.session, new Uint8Array([0, 0]).buffer);
  h.prompt.consumeNativeCaptureMessage(h.session, { event: "stopped" });
  await h.session.nativeCapture.stopPromise;
  await settlePromises();
  await h.session.lifecycle.processPromise;
  assert.equal(h.probes().find((probe) => probe.event === "seal").last_pcm_gap_ms, "0");
  assert.equal(h.probes().find((probe) => probe.event === "stop").last_pcm_gap_ms, "20000");
  assert.deepEqual(h.inserted, ["first words"]);
});

test("chunk sample coverage reports Unicode scalar counts matching Rust", async () => {
  const h = await createChunkCoverageHarness({ firstText: "A😀B" });
  h.feed(2);
  await h.finish();
  const result = h.probes().find((probe) => probe.event === "request-result");
  assert.equal(result.chars, "3");
  assert.deepEqual(h.inserted, ["A😀B"]);
});

test("chunk sample coverage logs fit the backend limit for day-long 192 kHz recordings", () => {
  const reports = [];
  const V = loadForChunking(async () => null);
  const prompt = createBarePrompt(V, { reportAudioProbe(_session, _stage, detail) { reports.push(detail); } });
  const session = { id: 9999999 };
  const chunked = prompt.createChunkedSession(session, 192000);
  const samples = 24 * 3600 * 192000;
  Object.assign(chunked.accounting, {
    acceptedSamples: samples, queuedSamples: samples, submittedSamples: samples, completedSamples: samples,
    queuedChunks: 2000, submittedChunks: 2000, completedChunks: 2000,
    startedAt: 0, stopRequestedAt: 86400000, sealedAt: 86400000, lastPcmAt: 86380000,
  });
  session.nativeCapture = { sampleCount: samples };
  chunked.blockSamples = 75 * 192000;
  for (const event of ["stop", "seal", "final", "request-result"]) {
    prompt.reportChunkProbe(chunked, event, "coverage-mismatch", {
      chunkIndex: 2000, start: samples - chunked.blockSamples, end: samples,
      inputSamples: chunked.blockSamples, wavBytes: 75 * 16000 * 2 + 44,
      wavFrames: 75 * 16000, chars: 50000,
    });
  }
  for (const detail of reports) {
    assert.ok(detail.length <= 512, `diagnostic was ${detail.length} characters`);
    assert.match(detail.slice(0, 512), /last_pcm_gap_ms=20000/);
  }
});

test("chunk sample coverage compares original 48 kHz samples rather than resampled WAV frames", async () => {
  const reports = [];
  const V = loadForChunking(async (command, ...args) => command === "transcribe-audio" ? `part${args[3]}` : null);
  const prompt = createBarePrompt(V, {
    reportAudioProbe(_session, _stage, detail) { reports.push(Object.fromEntries(detail.split(" ").map((part) => part.split("=")))); },
    async resampleTo16k(pcm, rate) { return new Float32Array(Math.ceil(pcm.length * 16000 / rate)); },
  });
  const session = { id: 7 };
  const chunked = prompt.createChunkedSession(session, 48000);
  for (let second = 0; second < 80; second++) {
    prompt.consumeChunkedSamples(session, new Float32Array(48000).fill(second === 55 ? 0 : 0.5));
  }
  prompt.stopChunkedCapture(session);
  assert.equal(await prompt.finishChunkedLocal(session), "part0 part1");
  assert.equal(chunked.accounting.completedSamples, 80 * 48000);
  const starts = reports.filter((report) => report.event === "request-start");
  assert.equal(starts.length, 2);
  for (const start of starts) {
    assert.equal(start.rate, "48000");
    assert.equal(Number(start.input_samples), Number(start.wav_frames) * 3);
  }
});

test("chunk sample coverage preserves existing decode-error and cancellation behavior", async () => {
  const failed = await createChunkCoverageHarness({ decodeError: true });
  failed.feed(55); failed.feed(1, true);
  await settlePromises();
  failed.feed(20);
  await failed.finish();
  assert.deepEqual(failed.inserted, []);
  assert.equal(failed.session.audioRecovery.blob.size, 44 + 76 * 16000 * 2);
  assert.equal(failed.probes().find((probe) => probe.event === "final").reason, "decode-error");

  const pending = createDeferred();
  const cancelled = await createChunkCoverageHarness({ firstDecode: pending });
  cancelled.feed(55); cancelled.feed(1, true);
  await settlePromises();
  cancelled.feed(20);
  cancelled.prompt.stopRecording();
  cancelled.prompt.cancelRecording();
  await cancelled.session.nativeCapture.stopPromise;
  pending.resolve("late first words");
  await settlePromises();
  assert.deepEqual(cancelled.inserted, []);
  assert.deepEqual(cancelled.recovered, []);
  assert.equal(cancelled.calls.some(([command]) => command === "save-pending-transcription"), false);
  assert.equal(cancelled.session.chunked.accounting.completedSamples, 0);
});

test("native stop timeout after Escape cannot recover or insert the cancelled clip", async () => {
  const h = await createLifecycleHarness({ invoke(command) {
    if (command === "stop-native-capture") return new Promise(() => {});
    return Promise.resolve(null);
  } });
  h.session.audioContext = null;
  h.prompt.createNativeCapture(h.session);
  h.prompt.nativeCapture = h.session.nativeCapture;
  h.prompt.consumeNativeCaptureMessage(h.session, new Uint8Array([0, 64]).buffer);
  h.prompt.stopRecording();
  h.prompt.cancelRecording();
  h.timers.fire(8000);
  await h.session.nativeCapture.stopPromise;
  await settlePromises();
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(h.recovered, []);
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false);
  assert.equal(h.calls.some(([command]) => command === "save-recovered-transcription"), false);
  assert.equal(h.prompt.pendingInsertionOrder.length, 0);
  assert.equal(h.prompt.nativeCapture, null);
});

test("native startup cannot fall back while the previous device is still owned", async () => {
  const V = loadVoiceInputPrompt({ invoke(command) {
    if (command === "start-native-capture") return Promise.reject({ code: "NATIVE_CAPTURE_BUSY", message: "A device is still reserved" });
    return Promise.resolve(null);
  } });
  const prompt = createBarePrompt(V, {
    osName: "macos", stopRequested: false,
    clearTranscriptionPreview() {},
  });
  await assert.rejects(prompt.startNativeRecording({}, 0, 0), /reserved/);
  assert.equal(prompt.isRecording, false);
  assert.equal(prompt.pendingInsertionOrder.length, 0);
});

test("fast native audio recovery ACK cannot erase a local batch before transcription", async () => {
  let h;
  h = await createLifecycleHarness({ batch: true, invoke(command, ...args) {
    if (command === "save-pending-transcription") return Promise.resolve("saved-audio");
    if (command === "stop-native-capture") {
      h.prompt.consumeNativeCaptureMessage(h.session, { event: "stopped" });
      return Promise.resolve({ outputSamples: 1 });
    }
    if (command === "transcribe-audio") return Promise.resolve("kept local words");
    return Promise.resolve(null);
  } });
  h.session.audioContext = null;
  h.prompt.createNativeCapture(h.session);
  h.prompt.nativeCapture = h.session.nativeCapture;
  h.prompt.consumeNativeCaptureMessage(h.session, new Uint8Array([0, 64]).buffer);
  h.session.nativeCapture.error = new Error("device disconnected");
  const finalize = h.prompt.finalizeRecordingSession.bind(h.prompt);
  const releaseFinalize = createDeferred();
  h.prompt.finalizeRecordingSession = (...args) => releaseFinalize.promise.then(() => finalize(...args));
  h.prompt.stopRecording();
  await h.session.nativeCapture.stopPromise;
  await settlePromises();
  assert.equal(h.calls.some(([command]) => command === "save-pending-transcription"), false,
    "defer custody transfer until the decoder has its own audio snapshot");
  releaseFinalize.resolve();
  await settlePromises();
  await h.session.lifecycle.processPromise;
  assert.deepEqual(h.inserted, []);
  assert.deepEqual(h.recovered, ["kept local words"]);
});

test("native stop deadline also covers a missing stopped channel event", async () => {
  const timers = createFakeTimers();
  const V = loadVoiceInputPrompt({
    invoke: () => Promise.resolve({ outputSamples: 1 }),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const prompt = createBarePrompt(V);
  const session = { id: 1, chunks: [] };
  prompt.createNativeCapture(session);
  prompt.consumeNativeCaptureMessage(session, new Uint8Array([0, 64]).buffer);
  const finishing = prompt.finishNativeCapture(session);
  await settlePromises();
  timers.fire(8000);
  await finishing;
  assert.equal(session.captureIncomplete, true);
  assert.equal(session.chunks.length, 1);
});

for (const [error, expected] of [
  [{ code: "NATIVE_CAPTURE_BUSY", message: "A device is still reserved" }, "microphoneBusy"],
  [{ code: "NATIVE_CAPTURE_BUSY", message: "Changed backend wording" }, "microphoneBusy"],
  [{ code: "NATIVE_CAPTURE_STOP_TIMEOUT", message: "Changed stop wording" }, "microphoneBusy"],
  [Object.assign(new Error("device busy"), { name: "NotReadableError" }), "microphoneBusy"],
  [{ code: "NATIVE_CAPTURE_START_TIMEOUT", message: "Changed startup wording" }, "microphoneStartupTimeout"],
  [new Error("native capture session 99 is still active"), "recordingFailed"],
  [new Error("failed to build native input stream"), "recordingFailed"],
]) {
  test(`recording error maps ${String(error)} to ${expected}`, async () => {
    const V = loadVoiceInputPrompt();
    const prompt = createBarePrompt(V, {
      stopRecordingTimer() {}, cleanup() {}, scheduleHidePrompt() {},
      promptElement: { classList: { add() {} } },
    });
    await prompt.handleRecordingError(error);
    assert.equal(prompt.promptText.textContent, `inputPrompt.${expected}`);
  });
}

for (const mode of ["chunked", "live"]) {
  test(`native WAV finalization failure still collects ${mode} final text`, async () => {
    const final = createDeferred();
    const h = await createLifecycleHarness({ batch: mode === "live", invoke(command) {
      if (command === "transcribe-audio" || command === "finish-live-transcription") return final.promise;
      return Promise.resolve(null);
    } });
    h.session.nativeCapture = {};
    h.session.finalizationError = new Error("WAV encoding failed");
    if (mode === "live") h.session.live = {
      sessionId: h.session.id, pendingPcm: [], pendingPcmBytes: 0, uploadTail: Promise.resolve(),
    };
    else h.prompt.stopChunkedCapture(h.session);
    h.prompt.isRecording = false;
    const processing = h.prompt.processRecording(h.session);
    await settlePromises();
    assert.equal(h.calls.some(([command]) => command === "cancel-live-transcription" || command === "cancel-transcription"), false);
    final.resolve("preserved final words");
    await processing;
    assert.deepEqual(h.inserted, []);
    assert.deepEqual(h.recovered, ["preserved final words"]);
  });
}

test("native integrity diagnostics contain both counts and the failure reason", async () => {
  const reports = [];
  const V = loadVoiceInputPrompt({ captureAudioProbe: true, invoke(command, report) {
    if (command === "report-audio-probe") reports.push(report);
    return Promise.resolve({ outputSamples: 2, channelSendFailures: 0 });
  } });
  const prompt = createBarePrompt(V);
  const session = { id: 71, chunks: [] };
  prompt.createNativeCapture(session);
  prompt.consumeNativeCaptureMessage(session, new Uint8Array([0, 64]).buffer);
  prompt.consumeNativeCaptureMessage(session, { event: "stopped" });
  await prompt.finishNativeCapture(session);
  assert.ok(reports.some((report) => report.sessionId === 71 &&
    /out_samples=2/.test(report.detail) && /recv_samples=1/.test(report.detail) &&
    /reason=sample-mismatch/.test(report.detail)));
});

for (const stopCode of ["NATIVE_CAPTURE_NOT_ACTIVE", "NATIVE_CAPTURE_STOP_TIMEOUT", "NATIVE_CAPTURE_FAILED"]) {
  test(`native startup fallback requires release confirmation: ${stopCode}`, async () => {
    const V = loadVoiceInputPrompt({ invoke(command) {
      if (command === "start-native-capture") return Promise.reject({ code: "NATIVE_CAPTURE_FAILED", message: "Cannot open device" });
      if (command === "stop-native-capture") return Promise.reject({ code: stopCode, message: "Diagnostics can change" });
      return Promise.resolve(null);
    } });
    const prompt = createBarePrompt(V, { clearTranscriptionPreview() {} });
    if (stopCode === "NATIVE_CAPTURE_NOT_ACTIVE") {
      assert.equal(await prompt.startNativeRecording({}, 0, 0), false);
    } else {
      await assert.rejects(prompt.startNativeRecording({}, 0, 0), (error) => error.code === stopCode);
    }
  });
}

test("startup timeout retains its specific error after successful device cleanup", async () => {
  const V = loadVoiceInputPrompt({ invoke(command) {
    if (command === "start-native-capture") return Promise.reject({ code: "NATIVE_CAPTURE_START_TIMEOUT", message: "Diagnostic text" });
    return Promise.resolve(null);
  } });
  const prompt = createBarePrompt(V, { clearTranscriptionPreview() {} });
  await assert.rejects(prompt.startNativeRecording({}, 0, 0), (error) => error.code === "NATIVE_CAPTURE_START_TIMEOUT");
});

test("chunk consumer teardown failure does not skip the recovery WAV or queued final", async () => {
  const V = loadVoiceInputPrompt({ invoke: () => Promise.resolve({ outputSamples: 1 }) });
  const prompt = createBarePrompt(V, { stopChunkedCapture() { throw new Error("tail flush failed"); } });
  const session = { id: 1, chunks: [] };
  prompt.createNativeCapture(session);
  prompt.consumeNativeCaptureMessage(session, new Uint8Array([0, 64]).buffer);
  prompt.consumeNativeCaptureMessage(session, { event: "stopped" });
  await prompt.finishNativeCapture(session);
  assert.equal(session.chunks.length, 1);
  assert.equal(session.captureIncomplete, true);
  assert.equal(session.finalizationError.message, "tail flush failed");
});

test("failed native setup can fall back after the backend confirms device release", async () => {
  const V = loadVoiceInputPrompt({ invoke(command) {
    if (command === "start-native-capture" || command === "stop-native-capture") {
      return Promise.reject({ code: "NATIVE_CAPTURE_FAILED", message: "Configured device unavailable",
        deviceReleased: command === "stop-native-capture" });
    }
    return Promise.resolve(null);
  } });
  const prompt = createBarePrompt(V, { clearTranscriptionPreview() {} });
  assert.equal(await prompt.startNativeRecording({}, 0, 0), false);
});

for (const failure of ["consumer", "wav"]) {
  test(`native integrity probe reports final ${failure} failure`, async () => {
    const reports = [];
    const V = loadVoiceInputPrompt({ captureAudioProbe: true, invoke(command, report) {
      if (command === "report-audio-probe") reports.push(report);
      return Promise.resolve({ outputSamples: 1 });
    }, ...(failure === "wav" ? { globals: { Blob: class {
      constructor() { throw new Error("WAV allocation failed"); }
    } } } : {}) });
    const prompt = createBarePrompt(V, failure === "consumer" ? {
      stopChunkedCapture() { throw new Error("Consumer teardown failed"); },
    } : {});
    const session = { id: 72, chunks: [] };
    prompt.nativeCapture = prompt.createNativeCapture(session);
    prompt.consumeNativeCaptureMessage(session, new Uint8Array([0, 64]).buffer);
    prompt.consumeNativeCaptureMessage(session, { event: "stopped" });
    const finishing = prompt.finishNativeCapture(session);
    if (failure === "wav") await assert.rejects(finishing, /WAV allocation failed/);
    else await finishing;
    assert.equal(session.captureIncomplete, true);
    assert.equal(prompt.nativeCapture, null);
    assert.ok(reports.some((report) => report.sessionId === 72 &&
      report.detail.includes(`reason=${failure === "wav" ? "wav-encoding-failure" : "consumer-finalization-failure"}`) &&
      report.detail.includes("incomplete=true")));
  });
}

test("large Qwen retains its badge and chunked worker lifecycle", async () => {
  const h = await createLifecycleHarness({ model: "qwen3-asr-1.7b-q8_0" });
  assert.equal(h.prompt.resolveActiveModel(), "Qwen3 1.7B · Local");
  assert.equal(h.session.qwenSession, true);
  assert.ok(h.session.chunked);
  h.prompt.stopRecording();
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.calls.filter(([command]) => command === "record-assembled-transcription").length, 1);
  assert.equal(h.calls.filter(([command]) => command === "finish-qwen-worker-session").length, 1);
});

async function startSecondRecording(h, failedText) {
  h.prompt.stopRecording();
  await settlePromises();
  h.prompt._failedText = failedText;
  h.prompt.stopRequested = false;
  h.prompt.startRecordingPromise = h.prompt.startRecording();
  await h.prompt.startRecordingPromise;
  assert.equal(h.prompt.isRecording, true);
  return h.prompt.activeRecordingSession.id;
}

test("a hotkey tap on a failure card inserts its text and never transcribes the tap", async () => {
  const h = await createLifecycleHarness();
  const tapSessionId = await startSecondRecording(h, "words that missed the field");
  assert.equal(h.prompt._failedText, "", "the card is cleared as the tap starts recording");
  const hidesBefore = h.hides;
  await h.prompt.handleHotkeyTap();
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0", "words that missed the field"]);
  assert.equal(h.hides, hidesBefore + 1, "a successful re-insertion closes the prompt");
  assert.equal(h.prompt.isRecording, false);
  assert.equal(h.calls.some(([command, ...args]) =>
    command === "transcribe-audio" && args[2] === tapSessionId), false);
  assert.equal(h.prompt.tapInsertCandidate, null);
});

test("a tap whose insertion fails again brings the same card back", async () => {
  const h = await createLifecycleHarness();
  await startSecondRecording(h, "still no field");
  h.prompt.typeText = async (text) => {
    h.inserted.push(text);
    return { ok: false, message: "No editable text field" };
  };
  await h.prompt.handleHotkeyTap();
  await settlePromises();
  assert.deepEqual(h.recovered, ["still no field"]);
  assert.equal(h.prompt._failedText, "still no field", "the next tap can try again");
  assert.equal(h.prompt.isFlushingInsertQueue, false);
});

test("a tap without a failure card is the plain mis-trigger cancel", async () => {
  const h = await createLifecycleHarness();
  await startSecondRecording(h, "");
  await h.prompt.handleHotkeyTap();
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0"]);
  assert.equal(h.prompt.isRecording, false);
});

test("holding the hotkey on a failure card dictates normally and drops the old card text", async () => {
  const h = await createLifecycleHarness();
  await startSecondRecording(h, "old card text");
  h.prompt.tapInsertCandidate = null; // what the stop-recording event does
  h.prompt.stopRecording();
  await settlePromises();
  assert.deepEqual(h.inserted, ["final 0", "final 0"], "the new dictation is inserted, not the card");
});

test("a locked recording shows its hint and releases the lock when it ends", async () => {
  const h = await createLifecycleHarness();
  h.prompt.handleRecordingLock(5);
  assert.equal(h.prompt.recordingLockId, 5);
  assert.equal(h.prompt.promptText.textContent, "inputPrompt.lockedHint");
  h.prompt.stopRecording();
  await settlePromises();
  assert.deepEqual(h.calls.filter(([command]) => command === "release-recording-lock"),
    [["release-recording-lock", 5]]);
  assert.equal(h.prompt.recordingLockId, null);
});

test("a lock that arrives after the recording already failed is released at once", async () => {
  const h = await createLifecycleHarness();
  h.prompt.stopRecording();
  await settlePromises();
  const preflight = createDeferred();
  h.prompt.hasReadyEngine = () => preflight.promise;
  h.prompt.showApiKeyRequired = () => {};
  h.prompt.stopRequested = false;
  const starting = h.prompt.startRecording();
  h.prompt.handleRecordingLock(8);
  assert.equal(h.prompt.recordingLockId, 8, "a lock during startup belongs to that recording");
  preflight.resolve(false);
  await starting;
  h.prompt.handleRecordingLock(9);
  await settlePromises();
  assert.deepEqual(h.calls.filter(([command]) => command === "release-recording-lock"),
    [["release-recording-lock", 8], ["release-recording-lock", 9]]);
});

test("the double-tap tip shows after thirty seconds of holding, a few times at most", () => {
  const storage = new Map();
  const VoiceInputPrompt = loadVoiceInputPrompt({ window: { localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } } });
  const recordingFor = (ms, overrides = {}) => createBarePrompt(VoiceInputPrompt, {
    isRecording: true, recordingStartedAt: Date.now() - ms, recordingLockId: null,
    lockTipShown: false, recordShortcut: "Ctrl+Shift", ...overrides,
  });

  const early = recordingFor(29000);
  early.maybeShowLockTip();
  assert.equal(early.promptText.textContent, "");
  for (let shown = 1; shown <= 4; shown++) {
    const prompt = recordingFor(31000);
    prompt.maybeShowLockTip();
    prompt.promptText.textContent = prompt.promptText.textContent || "none";
    assert.equal(prompt.promptText.textContent, shown <= 3 ? "inputPrompt.lockTip" : "none");
  }
  storage.clear();
  recordingFor(1000).rememberLockUsed();
  const afterLock = recordingFor(31000);
  afterLock.maybeShowLockTip();
  assert.equal(afterLock.promptText.textContent, "", "never again once the user has locked");
  const locked = recordingFor(31000, { recordingLockId: 2 });
  storage.clear();
  locked.maybeShowLockTip();
  assert.equal(locked.promptText.textContent, "");
});

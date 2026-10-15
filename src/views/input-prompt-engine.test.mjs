import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as chunkDecision from "./chunk-decision.mjs";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function harness(options = {}) {
  const calls = [];
  const listeners = new Map();
  const element = () => ({
    hidden: true, textContent: "", style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, handler) { this[name] = handler; },
    querySelectorAll: () => [],
  });
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  class FakeAudioContext {
    constructor() { this.sampleRate = 16000; this.state = options.resume ? "suspended" : "running"; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 0 }; }
    resume() { return options.resume(); }
  }
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    start() { this.state = "recording"; }
  }
  let microphones = 0;
  const stream = { getTracks: () => [], getAudioTracks: () => [] };
  const context = vm.createContext({
    window: {
      __typeAloudInputPromptStarted: true,
      __TYPEALOUD_IPC__: {
        async invoke(command, ...args) {
          calls.push([command, ...args]);
          return options.invoke ? options.invoke(command, ...args) : null;
        },
        on(name, handler) { listeners.set(name, handler); },
        createChannel: (handler) => ({ onmessage: handler }),
      },
      TypeAloudI18n: { t: (key) => key, initI18n() {}, setLanguage() {}, applyI18n() {} },
      TypeAloudChunk: chunkDecision,
      AudioContext: FakeAudioContext,
      addEventListener() {},
    },
    document: {
      readyState: "loading", addEventListener() {}, getElementById: getElement,
      documentElement: { setAttribute() {} }, body: element(),
    },
    navigator: { mediaDevices: { getUserMedia() {
      microphones++;
      return options.getUserMedia ? options.getUserMedia(stream) : Promise.resolve(stream);
    } } },
    console: { log() {}, warn() {}, error() {} },
    Blob, ArrayBuffer, DataView, Uint8Array, Float32Array,
    MediaRecorder: FakeMediaRecorder, performance,
    requestAnimationFrame() {}, setTimeout() { return 1; }, clearTimeout() {},
  });
  vm.runInContext(`${read("./input-prompt.js")}\n;globalThis.Prompt = VoiceInputPrompt;`, context);
  const prompt = Object.assign(Object.create(context.Prompt.prototype), {
    isRecording: false, starting: false, stopRequested: false,
    recordingSessionId: 0, currentProvider: "local", currentModel: "qwen3-asr-0.6b-q8_0",
    recordingSessions: new Map(), cancelledTranscriptionSessionIds: new Set(),
    activeTranscriptionSessionIds: new Set(), pendingInsertionOrder: [], pendingInsertionsById: new Map(),
    transcriptionInProgressCount: 0, localTranscriptionTail: Promise.resolve(),
    promptElement: getElement("inputPrompt"), promptText: getElement("promptText"),
    statusText: getElement("statusText"), waveContainer: getElement("waveContainer"),
    localModelBtn: getElement("localModelBtn"), copyBtn: getElement("copyBtn"),
    clearActualHideTimer() {}, retryRecoveryPersistence() {}, clearTranscriptionPreview() {},
    updateStatusText() {}, updateShortcutHint() {}, updateModelBadge() {},
    startWaveAnimation() {}, stopWaveAnimation() {}, startRecordingTimer() {},
    scheduleHidePrompt() {}, async flushPendingInsertions() {},
  });
  return { prompt, calls, listeners, context, get microphones() { return microphones; } };
}

test("settings without provider default to local", async () => {
  const h = harness({ invoke: async () => ({}) });
  await h.prompt.syncShortcutFromSettings();
  assert.equal(h.prompt.currentProvider, "local");
});

test("web capture keeps the provider selected before getUserMedia resolves", async () => {
  const microphone = deferred();
  const h = harness({ getUserMedia: async (stream) => { await microphone.promise; return stream; } });
  const start = h.prompt.startRecording();
  await settle();
  assert.equal(h.microphones, 1);
  h.prompt.setupEventListeners();
  h.listeners.get("shortcut-updated")(null, { provider: "openai", model: "gpt-transcribe" });
  microphone.resolve();
  await start;
  assert.equal(h.prompt.isRecording, true);
  assert.equal(h.prompt.activeRecordingSession.provider, "local");
  assert.equal(h.prompt.activeRecordingSession.qwenSession, true);
});

test("web capture keeps its provider across AudioContext resume", async () => {
  const resume = deferred();
  const h = harness({ resume: () => resume.promise });
  const start = h.prompt.startRecording();
  await settle();
  h.prompt.currentProvider = "groq";
  resume.resolve();
  await start;
  assert.equal(h.prompt.isRecording, true);
  assert.equal(h.prompt.activeRecordingSession.provider, "local");
});

test("native consumers use the session provider after settings change", async () => {
  const h = harness();
  h.prompt.currentProvider = "openai";
  const session = { id: 1, provider: "local", captureModel: "qwen3-asr-0.6b-q8_0" };
  await h.prompt.setupNativeConsumers(session);
  assert.ok(session.chunked, "the local recording must retain its local capture consumer");
});

test("native capture keeps its provider while the start IPC is pending", async () => {
  const nativeStart = deferred();
  const h = harness({ invoke: async (command) => command === "start-native-capture" ? nativeStart.promise : null });
  h.prompt.osName = "macos";
  const start = h.prompt.startRecording();
  await settle();
  assert.equal(h.prompt.activeRecordingSession.provider, "local");
  h.prompt.currentProvider = "openai";
  nativeStart.resolve({});
  await start;
  assert.equal(h.prompt.isRecording, true);
  assert.equal(h.prompt.activeRecordingSession.provider, "local");
});

test("chunk requests carry the recording provider even after settings change", async () => {
  const h = harness();
  h.prompt.currentProvider = "openai";
  h.prompt.encodeChunkWav = async () => new Uint8Array([1]);
  const session = { id: 1, provider: "local" };
  const chunked = h.prompt.createChunkedSession(session, 16000);
  h.prompt.enqueueChunkDecode(chunked, new Float32Array(320));
  await chunked.queue;
  const request = h.calls.find(([name]) => name === "transcribe-audio");
  assert.equal(request?.[7], "local");
  assert.equal(request?.[4], 0);
});

test("automatic retries use the explicit provider when the session map no longer has the recording", async () => {
  let attempts = 0;
  const h = harness({ invoke: async (command) => {
    if (command === "transcribe-audio" && ++attempts === 1) throw new Error("timed out");
    return "words";
  } });
  h.prompt.currentProvider = "openai";
  assert.equal(await h.prompt.transcribeWithRetry(new Uint8Array([1]), "audio/wav", 1, "local"), "words");
  const requests = h.calls.filter(([name]) => name === "transcribe-audio");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((call) => call[7]), ["local", "local"]);
  assert.equal(requests[0][6], requests[1][6]);
});

test("batch finalization passes the session provider explicitly to automatic retry", async () => {
  const h = harness();
  const received = [];
  h.prompt.currentProvider = "openai";
  h.prompt.transcribeWithRetry = async (...args) => { received.push(args); return ""; };
  await h.prompt.processRecording({
    id: 1, provider: "local", mimeType: "audio/wav",
    chunks: [new Blob([new Uint8Array([1])])],
  });
  assert.equal(received[0]?.[3], "local");
});

test("missing local model blocks capture with a model-settings action", async () => {
  const h = harness({ invoke: async () => ({ engineReady: false, engineBlocker: "local-model-missing" }) });
  h.prompt.setupEventListeners();
  await h.prompt.startRecording();
  assert.equal(h.microphones, 0);
  assert.equal(h.prompt.promptText.textContent, "inputPrompt.localModelMissingTitle");
  assert.equal(h.prompt.statusText.textContent, "inputPrompt.localModelMissing");
  assert.equal(h.prompt.localModelBtn.hidden, false);
  assert.equal(h.prompt.localModelBtn.textContent, "inputPrompt.openLocalModel");
  await h.prompt.localModelBtn.click();
  assert.ok(h.calls.some(([name]) => name === "open-local-model-panel"));
  h.prompt.clearInsertFailedUi();
  assert.equal(h.prompt.localModelBtn.hidden, true);
});

test("missing Nemotron opens its own model panel instead of the Qwen default", async () => {
  const model = "nemotron-3.5-asr-streaming-0.6b-q8_0";
  const h = harness({ invoke: async (command) => command === "get-settings"
    ? { engineReady: false, engineBlocker: "local-model-missing", model } : null });
  h.prompt.setupEventListeners();
  await h.prompt.startRecording();
  await h.prompt.localModelBtn.click();
  assert.equal(h.calls.find(([name]) => name === "open-local-model-panel")?.[1], model);
});

test("missing cloud key keeps the API-key preflight message", async () => {
  const h = harness({ invoke: async () => ({ engineReady: false, engineBlocker: "api-key-missing" }) });
  await h.prompt.startRecording();
  assert.equal(h.microphones, 0);
  assert.equal(h.prompt.statusText.textContent, "inputPrompt.noApiKey");
  assert.equal(h.prompt.localModelBtn.hidden, true);
});

test("settings-read failure does not block capture", async () => {
  const h = harness({ invoke: async (command) => {
    if (command === "get-settings") throw new Error("settings read failed");
    return null;
  } });
  await h.prompt.startRecording();
  assert.equal(h.microphones, 1);
  assert.equal(h.prompt.isRecording, true);
});

test("LOCAL_MODEL_MISSING transcription errors reuse the local-model preflight message", async () => {
  const h = harness({ invoke: async (command) => {
    if (command === "transcribe-audio") throw "LOCAL_MODEL_MISSING: missing files";
    return null;
  } });
  h.prompt.recordingSessionId = 1;
  await h.prompt.processRecording({
    id: 1, provider: "local", mimeType: "audio/wav",
    chunks: [new Blob([new Uint8Array([1])])],
  });
  assert.equal(h.prompt.statusText.textContent, "inputPrompt.localModelMissing");
  assert.equal(h.prompt.localModelBtn.hidden, false);
});

test("raw-audio IPC uses session-provider at argument six", async () => {
  const calls = [];
  const context = vm.createContext({
    window: { __TAURI__: { core: { invoke: async (...args) => calls.push(args) }, event: { listen() {} } } },
    document: { documentElement: { setAttribute() {} } },
    Headers, Uint8Array, ArrayBuffer,
  });
  vm.runInContext(read("./ipc-bridge.js"), context);
  await context.window.__TYPEALOUD_IPC__.invoke("transcribe-audio", new Uint8Array([1]), "audio/wav", 1, 0, undefined, undefined, "local");
  const headers = calls[0][2].headers;
  const header = (key) => headers instanceof Headers ? headers.get(key) : headers[key];
  assert.equal(header("session-provider"), "local");
  assert.ok(!header("recovery-provider"));
});


test("local-model action layout is scoped and cleared before a new recording", () => {
  const h = harness();
  const classes = new Set();
  h.prompt.promptElement.classList = {
    add(...names) { names.forEach((name) => classes.add(name)); },
    remove(...names) { names.forEach((name) => classes.delete(name)); },
  };
  h.prompt.showLocalModelMissing();
  assert.ok(classes.has("engine-blocked"));
  h.prompt.clearInsertFailedUi();
  assert.ok(!classes.has("engine-blocked"));
  assert.equal(h.prompt.localModelBtn.hidden, true);
  assert.equal(h.prompt.waveContainer.style.display, "");
  const css = read("./input-prompt.css");
  assert.match(css, /\.input-prompt\.engine-blocked\s*\{[^}]*gap:\s*12px/);
  assert.match(css, /\.engine-blocked \.left-section\s*\{[^}]*flex:\s*1[^}]*min-width:\s*0/);
  assert.match(css, /\.engine-blocked \.status-text\s*\{[^}]*white-space:\s*normal/);
});

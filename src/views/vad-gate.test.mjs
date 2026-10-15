import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadVadGate({ segments = [{ start: 0, end: 500 }] } = {}) {
  let activeRuns = 0;
  let maxConcurrentRuns = 0;
  const sharedVad = {
    async *run() {
      activeRuns += 1;
      maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns);
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield* segments;
      activeRuns -= 1;
    },
  };

  class FakeAudioContext {
    async decodeAudioData() {
      return { length: 1600, sampleRate: 16000 };
    }

    close() {}
  }

  class FakeOfflineAudioContext {
    constructor() {
      this.destination = {};
    }

    createBufferSource() {
      return { buffer: null, connect() {}, start() {} };
    }

    async startRendering() {
      return { getChannelData: () => new Float32Array(1600) };
    }
  }

  const window = {
    ort: { env: { wasm: {} } },
    vad: { NonRealTimeVAD: { new: async () => sharedVad } },
    TypeAloudVad: {
      decideSpeech: () => ({ speech: true, totalSpeechMs: 500 }),
      trimRangeMs: () => ({ startMs: 0, endMs: 100 }),
      shouldTrim: () => false,
      encodeWavPcm16: () => new Uint8Array(44),
    },
  };
  const context = vm.createContext({
    AudioContext: FakeAudioContext,
    Blob,
    console,
    document: {
      baseURI: "file:///audit/",
      createElement() {},
      head: { appendChild() {} },
    },
    Float32Array,
    OfflineAudioContext: FakeOfflineAudioContext,
    Promise,
    setTimeout,
    URL,
    window,
  });
  const source = readFileSync(
    new URL("./vad-gate.js", import.meta.url),
    "utf8"
  );
  vm.runInContext(source, context);

  return {
    gate: window.TypeAloudVadGate,
    maxConcurrentRuns: () => maxConcurrentRuns,
  };
}

test("VAD analyses sharing one model run serially", async () => {
  const { gate, maxConcurrentRuns } = loadVadGate();
  const blob = new Blob([new Uint8Array([1])], { type: "audio/webm" });

  await Promise.all([gate.analyze(blob), gate.analyze(blob)]);

  assert.equal(maxConcurrentRuns(), 1);
});

test("hasSpeech reports whether any segment was found", async () => {
  const pcm = new Float32Array(1600);
  assert.equal(await loadVadGate().gate.hasSpeech(pcm), true);
  assert.equal(await loadVadGate({ segments: [] }).gate.hasSpeech(pcm), false);
});

test("hasSpeech shares the model with analyze and never overlaps it", async () => {
  const { gate, maxConcurrentRuns } = loadVadGate();
  const blob = new Blob([new Uint8Array([1])], { type: "audio/webm" });

  await Promise.all([gate.analyze(blob), gate.hasSpeech(new Float32Array(1600))]);

  assert.equal(maxConcurrentRuns(), 1);
});

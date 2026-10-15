import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./live-pcm-worklet.js", import.meta.url), "utf8");

test("audio worklet converts float samples to little-endian PCM16", () => {
  let Processor = null;
  class AudioWorkletProcessor {
    constructor(options) {
      this.options = options;
      this.port = {
        postMessage(buffer) {
          this.buffer = buffer;
        },
      };
    }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    registerProcessor(name, implementation) {
      assert.equal(name, "typealoud-pcm16-capture");
      Processor = implementation;
    },
    Int16Array,
    Math,
  });

  const processor = new Processor();
  const keepAlive = processor.process([[
    new Float32Array([-1, -0.5, 0, 0.5, 1]),
  ]]);

  assert.equal(keepAlive, true);
  assert.deepEqual(
    Array.from(new Int16Array(processor.port.buffer)),
    [-32768, -16384, 0, 16384, 32767]
  );
});

test("audio worklet passes float samples through untouched when asked for f32", () => {
  let Processor = null;
  class AudioWorkletProcessor {
    constructor(options) {
      this.options = options;
      this.port = {
        postMessage(buffer) {
          this.buffer = buffer;
        },
      };
    }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    registerProcessor(name, implementation) {
      Processor = implementation;
    },
    Int16Array,
    Float32Array,
    Math,
  });

  const processor = new Processor({ processorOptions: { format: "f32" } });
  const input = new Float32Array([-1, -0.5, 0, 0.25, 1]);
  const keepAlive = processor.process([[input]]);

  assert.equal(keepAlive, true);
  assert.deepEqual(
    Array.from(new Float32Array(processor.port.buffer)),
    [-1, -0.5, 0, 0.25, 1]
  );
});

test("the f32 copy is detached from the graph's reused input buffer", () => {
  let Processor = null;
  class AudioWorkletProcessor {
    constructor(options) {
      this.options = options;
      this.port = {
        postMessage(buffer) {
          this.buffer = buffer;
        },
      };
    }
  }
  vm.runInNewContext(source, {
    AudioWorkletProcessor,
    registerProcessor(name, implementation) {
      Processor = implementation;
    },
    Int16Array,
    Float32Array,
    Math,
  });

  const processor = new Processor({ processorOptions: { format: "f32" } });
  const input = new Float32Array([0.5, 0.5]);
  processor.process([[input]]);
  input.fill(0); // the audio graph overwrites its input block for the next render

  assert.deepEqual(Array.from(new Float32Array(processor.port.buffer)), [0.5, 0.5]);
});

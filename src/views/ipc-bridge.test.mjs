import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./ipc-bridge.js", import.meta.url), "utf8");

function loadBridge() {
  const calls = [];
  const channels = [];
  class Channel {
    constructor(handler) {
      this.onmessage = handler;
      channels.push(this);
    }
  }
  const window = {
    __TAURI__: {
      core: { Channel, invoke: async (...args) => { calls.push(args); return "saved-id"; } },
      event: { listen: async () => () => {} },
    },
  };
  vm.runInNewContext(source, { window });
  return { bridge: window.__TYPEALOUD_IPC__, calls, channels };
}

test("recovered text uses the strict recovery payload command", async () => {
  const { bridge, calls } = loadBridge();
  const recovery = { id: "recovery-100-1", text: "kept words", kind: "incomplete" };
  assert.equal(await bridge.invoke("save-recovered-transcription", recovery), "saved-id");
  assert.equal(calls[0][0], "save_recovered_transcription");
  assert.equal(calls[0][1].recovery, recovery);
  assert.deepEqual(Object.keys(calls[0][1]), ["recovery"]);
});

test("pending audio carries an optional stable recovery id without changing the raw body", async () => {
  const { bridge, calls } = loadBridge();
  const audio = new Uint8Array([1, 2, 3]);
  await bridge.invoke("save-pending-transcription", audio, "audio/wav", "pending-100-1");
  assert.equal(calls[0][0], "save_pending_transcription");
  assert.equal(calls[0][1], audio);
  assert.equal(calls[0][2].headers["mime-type"], "audio/wav");
  assert.equal(calls[0][2].headers["recovery-id"], "pending-100-1");
});

test("legacy two-argument pending audio does not send a recovery id header", async () => {
  const { bridge, calls } = loadBridge();
  const audio = new Uint8Array([1]);
  await bridge.invoke("save-pending-transcription", audio, "audio/mp4");
  assert.equal(calls[0][1], audio);
  assert.equal(calls[0][2].headers["mime-type"], "audio/mp4");
  assert.equal(Object.hasOwn(calls[0][2].headers, "recovery-id"), false);
});

test("native capture passes a Tauri binary channel and session-scoped stop", async () => {
  const { bridge, calls, channels } = loadBridge();
  const received = [];
  const channel = bridge.createChannel((message) => received.push(message));
  await bridge.invoke("start-native-capture", 7, "Built-in Microphone", channel);
  await bridge.invoke("stop-native-capture", 7);

  assert.equal(channels.length, 1);
  channel.onmessage("pcm");
  assert.deepEqual(received, ["pcm"]);
  assert.equal(calls[0][0], "start_native_capture");
  assert.equal(calls[0][1].sessionId, 7);
  assert.equal(calls[0][1].session_id, 7);
  assert.equal(calls[0][1].microphone, "Built-in Microphone");
  assert.equal(calls[0][1].onAudio, channel);
  assert.equal(calls[0][1].on_audio, channel);
  assert.equal(calls[1][0], "stop_native_capture");
  assert.equal(calls[1][1].sessionId, 7);
});

test("live completion carries the optional capture integrity flag", async () => {
  const { bridge, calls } = loadBridge();
  await bridge.invoke("finish-live-transcription", 42, true);
  await bridge.invoke("finish-live-transcription", 43);
  assert.equal(calls[0][0], "finish_live_transcription");
  assert.equal(calls[0][1].sessionId, 42);
  assert.equal(calls[0][1].captureIncomplete, true);
  assert.equal(calls[0][1].capture_incomplete, true);
  assert.equal(calls[1][1].captureIncomplete, undefined);
});

test("whole-clip transcription sends capture integrity independently of chunk index", async () => {
  const { bridge, calls } = loadBridge();
  const audio = new Uint8Array([1, 2]);
  await bridge.invoke("transcribe-audio", audio, "audio/wav", 42, undefined, true);
  await bridge.invoke("transcribe-audio", audio, "audio/wav", 43);
  await bridge.invoke("transcribe-audio", audio, "audio/wav", 44, 0, false);
  assert.equal(calls[0][1], audio);
  assert.equal(calls[0][2].headers["capture-incomplete"], "true");
  assert.equal(Object.hasOwn(calls[0][2].headers, "chunk-index"), false);
  assert.equal(Object.hasOwn(calls[1][2].headers, "capture-incomplete"), false);
  assert.equal(calls[2][2].headers["chunk-index"], "0");
  assert.equal(calls[2][2].headers["capture-incomplete"], "false");
});

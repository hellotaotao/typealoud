import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("retry codes render in both languages without translating successful dictation", () => {
  const context = vm.createContext({
    window: {}, navigator: { language: "en" },
    document: { documentElement: { setAttribute() {} } },
  });
  vm.runInContext(read("../src/views/i18n.js"), context);
  const { localizeRetryError } = context.window.TypeAloudI18n;
  const main = read("../src/views/main.js");
  // Read only the dedicated production code registry, never test literals.
  const backend = read("../src-tauri/src/retry_error.rs");
  const codes = new Set([...backend.matchAll(/Self::\w+ => "(RETRY_[A-Z_]+)"/g)].map((match) => match[1]));
  assert.ok(codes.size > 0, "production retry code registry must not be empty");
  // Append-only compatibility fixture: these codes have shipped in History.
  const legacyCodes = [
    "RETRY_HISTORY_READ", "RETRY_ENTRY_MISSING", "RETRY_NOT_PENDING",
    "RETRY_AUDIO_MISSING", "RETRY_AUDIO_READ", "RETRY_SETTINGS_READ",
    "RETRY_RESULT_SAVE", "RETRY_AUDIO_FORMAT", "RETRY_NO_SPEECH",
  ];
  for (const code of legacyCodes) codes.add(code);
  for (const code of codes) {
    context.window.TypeAloudI18n.setLanguage("en");
    const english = localizeRetryError(code);
    context.window.TypeAloudI18n.setLanguage("zh");
    const chinese = localizeRetryError(code);
    assert.notEqual(english, code);
    assert.notEqual(chinese, english);
    assert.match(chinese, /[\u4e00-\u9fff]/);
  }
  assert.equal(localizeRetryError("provider failure detail"), "provider failure detail");
  assert.match(main, /activity.success === false \? localizeRetryError\(savedText\) : savedText/);
});

test("automatic retry sends the recording provider snapshot through the real IPC bridge", async () => {
  const calls = [];
  const context = vm.createContext({
    window: { __TAURI__: {
      core: { invoke: async (...args) => {
        calls.push(args);
        if (calls.length % 2 === 1) throw "timed out";
        return "words";
      } },
      event: { listen() {} },
    } },
    Headers, Uint8Array, ArrayBuffer, setTimeout,
    document: {
      readyState: "loading", addEventListener() {},
      documentElement: { setAttribute() {} },
    },
    navigator: { language: "en" },
  });
  vm.runInContext(read("../src/views/ipc-bridge.js"), context);
  vm.runInContext(read("../src/views/i18n.js"), context);
  // Load the full production class; leave DOMContentLoaded pending so capture
  // does not start, then invoke its real method without running the constructor.
  vm.runInContext(read("../src/views/input-prompt.js"), context);
  const receiver = vm.runInContext("Object.create(VoiceInputPrompt.prototype)", context);
  receiver.waitForSessionStage = (_session, _stage, work) => work();
  receiver.isSessionCancelled = () => false;
  for (const provider of ["local", "groq"]) {
    receiver.currentProvider = provider === "local" ? "groq" : "local";
    receiver.recordingSessions = new Map([[1, { provider, captureIncomplete: true }]]);
    assert.equal(await receiver.transcribeWithRetry(new Uint8Array([1]), "audio/wav", 1, provider), "words");
    const first = calls.at(-2)[2].headers;
    const second = calls.at(-1)[2].headers;
    const header = (headers, name) => headers instanceof Headers ? headers.get(name) : headers[name];
    assert.equal(header(first, "session-provider"), provider);
    assert.equal(header(second, "session-provider"), provider);
    assert.equal(header(first, "failure-id"), header(second, "failure-id"));
    assert.equal(header(first, "capture-incomplete"), "true");
  }
});


test("History searches the displayed translation and preserves literal successful text", () => {
  const container = { replaceChildren(node) { this.emptyText = node.textContent; } };
  const context = vm.createContext({
    window: {}, navigator: { language: "en" },
    document: {
      readyState: "loading", addEventListener() {},
      documentElement: { setAttribute() {} },
      getElementById(id) {
        return id === "history-container" ? container : { classList: { contains: () => true } };
      },
      createElement() { return {}; },
    },
  });
  vm.runInContext(read("../src/views/i18n.js"), context);
  vm.runInContext(read("../src/views/main.js"), context);
  vm.runInContext(`
    cachedActivities = [
      { id: "failed", success: false, text: "RETRY_NO_SPEECH" },
      { id: "literal", success: true, text: "RETRY_NO_SPEECH" },
    ];
    renderGroupedList = (_container, rows) => { window.matches = rows.map(row => row.id); };
  `, context);
  for (const [language, query] of [["en", "no speech"], ["zh", "未检测到语音"]]) {
    context.window.TypeAloudI18n.setLanguage(language);
    context.query = query;
    vm.runInContext("window.matches = []; historyQuery = query; renderHistory();", context);
    assert.deepEqual(Array.from(context.window.matches), ["failed"]);
  }
  vm.runInContext('window.matches = []; historyQuery = "retry_"; renderHistory();', context);
  assert.deepEqual(Array.from(context.window.matches), ["literal"]);
});

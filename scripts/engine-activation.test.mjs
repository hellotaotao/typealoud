import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8");
const small = "qwen3-asr-0.6b-q8_0";
const large = "qwen3-asr-1.7b-q8_0";
const activationSource = source.slice(source.indexOf("let engineSwitchPending"), source.indexOf("async function initializeSettingsPage()"));
function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function harness(options = {}) {
  const saved = [], calls = [];
  const fields = {
    providerSelect: { value: "local-qwen-large", options: ["local-qwen", "local-qwen-large", "openrouter", "openai"].map(value => ({ value })) },
    modelSelect: { value: "microsoft/mai-transcribe-2", options: [{ value: "microsoft/mai-transcribe-2" }, { value: "qwen/qwen3-asr-1.7b" }, { value: "gpt-transcribe" }] },
    themeSelect: { value: "midnight" },
    apiKeyOpenRouter: { value: "openrouter-key" }, apiKeyOpenAI: { value: "openai-key" },
  };
  const context = vm.createContext({
    console: { error() {} },
    currentSettings: { provider: "local", model: small, localCapable: true },
    initializeDependencies: async () => {}, document: { getElementById: id => fields[id] },
    normalizeThemePref: value => value, translate: key => key,
    showSaveStatus() {}, renderEngineCards() {},
    localModelForProvider: choice => choice === "local-qwen-large" ? large : choice === "local-qwen" ? small : "",
    providerForSettings: settings => settings.provider === "local" ? settings.model === large ? "local-qwen-large" : "local-qwen" : settings.provider,
    modelOptions: { openrouter: [{ value: "microsoft/mai-transcribe-2" }, { value: "qwen/qwen3-asr-1.7b" }], openai: [{ value: "gpt-transcribe" }] },
    ipc: { invoke: async (command, payload) => {
      calls.push([command, payload]);
      if (command === "get-local-model-status") return options.status ? options.status(payload) : { state: "ready" };
      if (command === "save-settings") {
        if (options.fail) throw new Error("write failed");
        if (options.beforeSave) await options.beforeSave(payload);
        saved.push(payload); return options.saveResult ?? true;
      }
    } },
    engineCloudDrafts: new Map(),
    setSelectValue: (element, value) => { element.value = value; },
    inspectedLocalModel: null, expandedEngineProvider: null,
    ENGINE_CARDS: ["local-qwen", "local-qwen-large", "openrouter", "openai"].map(value => ({ value, local: value.startsWith("local") })),
    engineStatus: entry => options.notReady?.includes(entry.value) ? { key: "needs", tone: "warn" } : { key: "ready", tone: "ok" },
    camelKey: value => value,
    isQwenChoice: value => value === "local-qwen" || value === "local-qwen-large",
    engineRowFor: value => value === "local-qwen-large" ? "local-qwen" : value,
    toggleProviderFields() {}, updateModelOptions() {}, renderSettingChoices() {}, refreshLocalModelStatus: async () => {},
  });
  vm.runInContext(activationSource + "\n" + section("function inspectEngine", "function handleThemeChange"), context);
  return { context, fields, saved, calls };
}
test("inspecting cloud and editing its key or theme never changes active engine", async () => {
  const h = harness();
  h.context.inspectEngine("openrouter");
  h.fields.apiKeyOpenRouter.value = "edited-key";
  await h.context.saveSettings();
  assert.equal(h.saved[0].provider, "local");
  assert.equal(h.saved[0].model, small);
  assert.equal(h.saved[0].apiKeyOpenRouter, "edited-key");
  assert.equal(h.saved[0].uiTheme, "midnight");
  assert.equal(h.context.currentSettings.localCapable, true);
  assert.equal(h.calls.some(([command]) => command === "get-local-model-status"), false);
});
test("explicit cloud activation captures provider and model before queue runs", async () => {
  const h = harness();
  h.context.inspectEngine("openrouter");
  const switching = h.context.activateEngine(h.context.inspectedEngineTarget());
  h.fields.providerSelect.value = "openai";
  h.fields.modelSelect.value = "gpt-transcribe";
  const ordinary = h.context.saveSettings();
  assert.equal(await switching, true);
  await ordinary;
  assert.equal(h.saved.length, 2);
  for (const settings of h.saved) {
    assert.equal(settings.provider, "openrouter");
    assert.equal(settings.model, "microsoft/mai-transcribe-2");
  }
});
test("failed activation leaves persisted engine unchanged and reports failure", async () => {
  for (const options of [{ fail: true }, { saveResult: false }]) {
    const h = harness(options);
    assert.equal(await h.context.activateEngine(h.context.inspectedEngineTarget()), false);
    assert.equal(h.context.currentSettings.model, small);
    assert.notEqual(vm.runInContext("engineActivationMessage", h.context), "");
    assert.equal(vm.runInContext("engineSwitchPending", h.context), false);
  }
});
test("cloud activation requires a key but key editing alone never activates", async () => {
  const h = harness();
  h.context.inspectEngine("openrouter"); h.fields.apiKeyOpenRouter.value = "";
  assert.equal(await h.context.activateEngine(h.context.inspectedEngineTarget()), false);
  assert.equal(h.saved.length, 0);
  assert.equal(h.context.currentSettings.model, small);
});
for (const state of ["absent", "partial", "downloading", "ready"]) {
  test(`explicit local selection persists intent when model is ${state}`, async () => {
    const h = harness({ status: () => ({ state }) });
    assert.equal(await h.context.activateEngine(h.context.inspectedEngineTarget()), true);
    assert.equal(h.context.currentSettings.model, large);
    assert.equal(h.saved[0].provider, "local");
    assert.equal(h.saved[0].model, large);
    assert.equal(h.calls.some(([command]) => command === "get-local-model-status"), false);
    assert.equal(await h.context.activateEngine({ provider: "local", model: small }), true);
    assert.equal(h.context.currentSettings.model, small);
    assert.equal(vm.runInContext("engineActivationMessage", h.context), "");
  });
}
test("download completion updates availability without activation or a confirmation", () => {
  const h = harness(); let listener;
  Object.assign(h.context, {
    localModelSyncBound: false, localModelStatusRequests: new Map(), localModelStatuses: new Map(),
    localModelDownloadStartedHere: large, selectedLocalModel: () => large,
  });
  h.context.ipc.on = (_event, callback) => { listener = callback; };
  vm.runInContext(section("function setupLocalModelSync", "// --- GPU acceleration panel"), h.context);
  h.context.setupLocalModelSync(); listener(null, { model: large, state: "ready" });
  assert.equal(h.saved.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.context.currentSettings.model, small);
});
test("ordinary queued write after pending activation preserves successful active model", async () => {
  let resolveSave;
  let first = true;
  const h = harness({ beforeSave: () => {
    if (!first) return;
    first = false;
    return new Promise(resolve => { resolveSave = resolve; });
  } });
  const activate = h.context.activateEngine(h.context.inspectedEngineTarget());
  for (let i = 0; i < 30 && !resolveSave; i++) await Promise.resolve();
  assert.ok(resolveSave);
  h.context.inspectEngine("openrouter");
  const save = h.context.saveSettings();
  assert.equal(vm.runInContext("engineSwitchPending", h.context), true);
  assert.equal(await h.context.activateEngine(h.context.inspectedEngineTarget()), false);
  resolveSave();
  await activate; await save;
  assert.equal(h.saved.length, 2);
  assert.ok(h.saved.every(settings => settings.model === large && settings.provider === "local"));
});


test("the active cloud engine's drawer shows its real model; an inactive one keeps its candidate", () => {
  const h = harness();
  h.context.currentSettings = { provider: "openrouter", model: "microsoft/mai-transcribe-2" };
  h.context.updateModelOptions = () => { h.fields.modelSelect.value = "qwen/qwen3-asr-1.7b"; };
  h.context.inspectEngine("openrouter");
  assert.equal(h.fields.modelSelect.value, "microsoft/mai-transcribe-2");
  h.fields.modelSelect.value = "qwen/qwen3-asr-1.7b";
  h.context.inspectEngine("local-qwen-large");
  h.context.inspectEngine("openrouter");
  assert.equal(h.fields.modelSelect.value, "microsoft/mai-transcribe-2", "a pick that never saved is not shown as in use");

  h.context.currentSettings = { provider: "local", model: small };
  h.context.inspectEngine("openrouter");
  h.fields.modelSelect.value = "microsoft/mai-transcribe-2";
  h.context.inspectEngine("local-qwen-large");
  h.context.inspectEngine("openrouter");
  assert.equal(h.fields.modelSelect.value, "microsoft/mai-transcribe-2");
  assert.equal(h.saved.length, 0);
});

test("local drawers show the activation panel only for a failure; cloud drawers keep the upload notice", () => {
  const h = harness();
  for (const id of ["engineActivation", "engineActivationStatus", "engineCloudNotice"]) h.fields[id] = {};
  for (const choice of ["local-qwen", "local-qwen-large"]) {
    h.fields.providerSelect.value = choice;
    h.context.renderEngineActivation();
    assert.equal(h.fields.engineActivation.hidden, true, choice);
  }
  vm.runInContext('engineActivationMessage = "Failed to switch"', h.context);
  h.context.renderEngineActivation();
  assert.equal(h.fields.engineActivation.hidden, false);
  assert.equal(h.fields.engineActivationStatus.textContent, "Failed to switch");
  vm.runInContext('engineActivationMessage = ""', h.context);
  h.fields.providerSelect.value = "openrouter";
  h.context.renderEngineActivation();
  assert.equal(h.fields.engineActivation.hidden, false);
  assert.equal(h.fields.engineCloudNotice.hidden, false);
  assert.doesNotMatch(source, /engineUseBtn|activateInspectedEngine/);
  assert.doesNotMatch(source, /engineUndoTarget|engineUndoBtn|settings\.engine\.activated/);
});

test("a model picked in the active cloud engine applies at once; an inactive engine's model waits for its check", async () => {
  const h = harness();
  h.context.currentSettings = { provider: "openrouter", model: "microsoft/mai-transcribe-2" };
  h.context.inspectEngine("openrouter");
  h.fields.modelSelect.value = "qwen/qwen3-asr-1.7b";
  h.context.handleModelChange();
  await h.context.saveSettings();
  assert.equal(h.saved[0].provider, "openrouter");
  assert.equal(h.saved[0].model, "qwen/qwen3-asr-1.7b");
  assert.equal(h.context.currentSettings.model, "qwen/qwen3-asr-1.7b");

  const idle = harness();
  idle.context.inspectEngine("openai");
  idle.fields.modelSelect.value = "gpt-transcribe";
  idle.context.handleModelChange();
  await idle.context.saveSettings();
  assert.equal(idle.saved.length, 1);
  assert.equal(idle.saved[0].provider, "local");
  assert.equal(idle.saved[0].model, small);
});

test("a failure message stays with its engine instead of following the next drawer opened", () => {
  const h = harness();
  vm.runInContext('engineActivationMessage = "Failed to switch"', h.context);
  h.context.inspectEngine("openrouter");
  assert.equal(vm.runInContext("engineActivationMessage", h.context), "");
});

test("an opened engine that is not usable yet says it is not in use and what the next click needs", () => {
  const h = harness({ notReady: ["openai", "local-qwen-large"] });
  for (const id of ["engineActivation", "engineActivationStatus", "engineCloudNotice"]) h.fields[id] = {};
  h.fields.providerSelect.value = "openai";
  h.context.renderEngineActivation();
  assert.equal(h.fields.engineActivationStatus.textContent, "settings.engine.notReadyKey");
  h.fields.providerSelect.value = "local-qwen-large";
  h.context.renderEngineActivation();
  assert.equal(h.fields.engineActivation.hidden, true, "with Qwen in use, its size picker says what 1.7B needs");
  h.fields.providerSelect.value = "local-qwen";
  h.context.renderEngineActivation();
  assert.equal(h.fields.engineActivation.hidden, true, "the engine in use needs no hint");
  h.context.currentSettings = { provider: "openrouter", model: "qwen/qwen3-asr-1.7b" };
  h.fields.providerSelect.value = "local-qwen-large";
  h.context.renderEngineActivation();
  assert.equal(h.fields.engineActivation.hidden, false);
  assert.equal(h.fields.engineActivationStatus.textContent, "settings.engine.notReadyDownload");
});

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

test("rapid model picks in the active cloud engine save the last one, even mid-save", async () => {
  let release;
  let first = true;
  const h = harness({ beforeSave: () => {
    if (!first) return;
    first = false;
    return new Promise(resolve => { release = resolve; });
  } });
  h.context.currentSettings = { provider: "openrouter", model: "qwen/qwen3-asr-1.7b" };
  h.context.inspectEngine("openrouter");
  h.fields.modelSelect.value = "microsoft/mai-transcribe-2";
  h.context.handleModelChange();
  await settle();
  assert.ok(release, "the first save is still in flight");
  h.fields.modelSelect.value = "qwen/qwen3-asr-1.7b";
  h.context.handleModelChange();
  release();
  await settle();
  assert.deepEqual(h.saved.map(settings => settings.model), ["microsoft/mai-transcribe-2", "qwen/qwen3-asr-1.7b"]);
  assert.equal(h.context.currentSettings.model, "qwen/qwen3-asr-1.7b");
  assert.equal(h.fields.modelSelect.value, "qwen/qwen3-asr-1.7b");
});

test("a failed model save puts the choice back on the model still in use", async () => {
  const h = harness({ fail: true });
  h.context.currentSettings = { provider: "openrouter", model: "qwen/qwen3-asr-1.7b" };
  h.context.inspectEngine("openrouter");
  h.fields.modelSelect.value = "microsoft/mai-transcribe-2";
  h.context.handleModelChange();
  await settle();
  assert.equal(h.context.currentSettings.model, "qwen/qwen3-asr-1.7b");
  assert.equal(h.fields.modelSelect.value, "qwen/qwen3-asr-1.7b");
  assert.notEqual(vm.runInContext("engineActivationMessage", h.context), "");
});

test("a queued model pick survives opening another engine's drawer before the save ends", async () => {
  let release;
  let first = true;
  const h = harness({ beforeSave: () => {
    if (!first) return;
    first = false;
    return new Promise(resolve => { release = resolve; });
  } });
  h.context.currentSettings = { provider: "openrouter", model: "qwen/qwen3-asr-1.7b" };
  h.context.inspectEngine("openrouter");
  h.fields.modelSelect.value = "microsoft/mai-transcribe-2";
  h.context.handleModelChange();
  await settle();
  h.fields.modelSelect.value = "qwen/qwen3-asr-1.7b";
  h.context.handleModelChange();
  h.context.inspectEngine("openai");
  release();
  await settle();
  assert.deepEqual(h.saved.map(settings => settings.model), ["microsoft/mai-transcribe-2", "qwen/qwen3-asr-1.7b"]);
  assert.equal(h.context.currentSettings.model, "qwen/qwen3-asr-1.7b");
  h.context.inspectEngine("openrouter");
  assert.equal(h.fields.modelSelect.value, "qwen/qwen3-asr-1.7b");
});

test("reopening the active engine mid-save shows the pick being saved, so picking back undoes it", async () => {
  let release;
  let first = true;
  const h = harness({ beforeSave: () => {
    if (!first) return;
    first = false;
    return new Promise(resolve => { release = resolve; });
  } });
  h.context.currentSettings = { provider: "openrouter", model: "qwen/qwen3-asr-1.7b" };
  h.context.inspectEngine("openrouter");
  h.fields.modelSelect.value = "microsoft/mai-transcribe-2";
  h.context.handleModelChange();
  await settle();
  h.context.inspectEngine("openai");
  h.context.inspectEngine("openrouter");
  assert.equal(h.fields.modelSelect.value, "microsoft/mai-transcribe-2", "the drawer shows the pick being saved");
  h.fields.modelSelect.value = "qwen/qwen3-asr-1.7b";
  h.context.handleModelChange();
  release();
  await settle();
  assert.deepEqual(h.saved.map(settings => settings.model), ["microsoft/mai-transcribe-2", "qwen/qwen3-asr-1.7b"]);
  assert.equal(h.context.currentSettings.model, "qwen/qwen3-asr-1.7b");
  assert.equal(h.fields.modelSelect.value, "qwen/qwen3-asr-1.7b");
});

test("a model picked while switching to that engine is applied once the switch lands", async () => {
  let release;
  let first = true;
  const h = harness({ beforeSave: () => {
    if (!first) return;
    first = false;
    return new Promise(resolve => { release = resolve; });
  } });
  h.context.inspectEngine("openrouter");
  h.fields.modelSelect.value = "qwen/qwen3-asr-1.7b";
  void h.context.activateEngine(h.context.inspectedEngineTarget());
  await settle();
  h.fields.modelSelect.value = "microsoft/mai-transcribe-2";
  h.context.handleModelChange();
  release();
  await settle();
  assert.deepEqual(h.saved.map(settings => `${settings.provider}/${settings.model}`), ["openrouter/qwen/qwen3-asr-1.7b", "openrouter/microsoft/mai-transcribe-2"]);
  assert.equal(h.context.currentSettings.model, "microsoft/mai-transcribe-2");
  assert.equal(h.fields.modelSelect.value, "microsoft/mai-transcribe-2");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const entrypoint = source.slice(source.includes("let engineSwitchPending") ? source.indexOf("let engineSwitchPending") : source.indexOf("async function selectEngine("), source.indexOf("// The in-card Accessibility onboarding panel"));
function harness(fail = false) {
  const calls = [], pages = [], notices = [];
  const context = vm.createContext({
    selectedEngineValue: () => "local-qwen-large",
    NEMOTRON_LOCAL_MODEL: "nemotron", nemotronOffered: () => false,
    window: { TypeAloudSettings: { runEngineChange: async change => change({ provider: "local", model: "qwen3-asr-1.7b-q8_0" }) } },
    ENGINE_OPTIONS: [{ value: "local-qwen", model: "qwen3-asr-0.6b-q8_0" }, { value: "local-qwen-large", model: "qwen3-asr-1.7b-q8_0" }, { value: "openai" }],
    showPage: async (...args) => pages.push(args),
    refreshReadiness: async () => calls.push(["refresh"]),
    renderEngineCard() {},
    showNotification: (...args) => notices.push(args),
    console,
    ipc: { invoke: async (...args) => { calls.push(args); if(args[0] === "get-api-keys") return {apiKeyOpenAI:"test", apiKeyGroq:"test"}; if(args[0] === "get-local-model-status") return { state: fail ? "absent" : "ready" }; return true; } },
  });
  vm.runInContext(entrypoint, context);
  return { context, calls, pages, notices };
}
test("home switches a ready local engine directly without navigating", async () => {
  const h = harness(); await h.context.selectEngine("local-qwen");
  assert.deepEqual(h.calls, [["set-local-model", "qwen3-asr-0.6b-q8_0"], ["get-local-model-status", "qwen3-asr-0.6b-q8_0"], ["refresh"]]);
  assert.equal(h.pages.length, 0);
});
test("home switches a cloud provider directly without navigating", async () => {
  const h = harness(); await h.context.selectEngine("openai");
  assert.deepEqual(h.calls, [["set-provider", "openai"], ["get-api-keys"], ["refresh"]]);
  assert.equal(h.pages.length, 0);
});
test("home current ready engine click does not mutate settings", async () => {
  const h = harness(); await h.context.selectEngine("local-qwen-large");
  assert.deepEqual(h.calls, [["get-local-model-status", "qwen3-asr-1.7b-q8_0"], ["refresh"]]); assert.equal(h.pages.length, 0);
});
test("unavailable home engine opens its setup details", async () => {
  const h = harness(true); await h.context.selectEngine("local-qwen");
  assert.equal(h.pages[0][1].settingsTarget, "local-model:qwen3-asr-0.6b-q8_0");
});

test("home keeps switching locked until readiness refresh finishes", async () => {
  const h = harness();
  let finish;
  h.context.refreshReadiness = () => new Promise((resolve) => { finish = resolve; });
  const switching = h.context.selectEngine("local-qwen");
  await new Promise((resolve) => setImmediate(resolve));
  void h.context.selectEngine("openai");
  assert.equal(h.calls.length, 2);
  finish(); await switching;
});

test("home persists an unconfigured cloud provider before opening setup", async () => {
 const h = harness();
 h.context.ipc.invoke = async (...args) => { h.calls.push(args); return args[0] === "get-api-keys" ? {} : true; };
 await h.context.selectEngine("openai");
 assert.equal(h.pages[0][1].settingsTarget, "engine:openai");
 assert.deepEqual(h.calls.slice(0,2), [["set-provider","openai"],["get-api-keys"]]);
});

test("missing local assets still save selection before showing setup", async () => {
 const h = harness(true); await h.context.selectEngine("local-qwen");
 assert.deepEqual(h.calls, [["set-local-model", "qwen3-asr-0.6b-q8_0"], ["get-local-model-status", "qwen3-asr-0.6b-q8_0"], ["refresh"]]);
});

const availabilitySource = source.slice(source.indexOf("const engineAvailability ="), source.indexOf("function renderEngineCard()"));
function availabilityHarness() {
 const options = [{value:"local-qwen",model:"small"},{value:"local-qwen-large",model:"large"},{value:"openai"},{value:"groq"}];
 const context = vm.createContext({
  ENGINE_OPTIONS: options, availableEngineOptions: () => options,
  renderEngineCard() {}, t: (key, params) => params ? `${key}:${params.percent}` : key,
  ipc: {invoke: async (command) => command === "get-api-keys" ? {apiKeyOpenAI:" secret ",apiKeyGroq:" "} : {state:"ready"}},
 });
 vm.runInContext(availabilitySource,context);
 return {context,options, get: value => vm.runInContext(`engineAvailability.get("${value}")`, context)};
}
test("availability labels distinguish ready local, cloud, setup, download, progress and unknown", async () => {
 const h=availabilityHarness();
 assert.equal(h.context.engineReadinessLabel(h.options[0]),"home.engineChecking");
 await h.context.refreshEngineAvailability();
 assert.equal(h.context.engineReadinessLabel(h.options[0]),"home.engineReadyLocal");
 assert.equal(h.context.engineReadinessLabel(h.options[2]),"home.engineReadyCloud");
 assert.equal(h.context.engineReadinessLabel(h.options[3]),"home.engineNeedsSetup");
 h.context.applyEngineDownloadProgress({model:"small",state:"absent"});
 assert.equal(h.context.engineReadinessLabel(h.options[0]),"home.engineNeedsDownload");
 h.context.applyEngineDownloadProgress({model:"small",state:"downloading",downloadedBytes:35,totalBytes:100});
 assert.equal(h.context.engineReadinessLabel(h.options[0]),"home.engineDownloadProgress:35");
 assert.equal(JSON.stringify(h.get("openai")).includes("secret"),false);
});
test("late availability refresh cannot overwrite a newer download event", async () => {
 const h=availabilityHarness(); let finish;
 h.context.ipc.invoke=async(command,model)=> command === "get-api-keys" ? {} : model === "small" ? await new Promise(resolve=>{finish=resolve;}) : {state:"ready"};
 const refresh=h.context.refreshEngineAvailability();
 h.context.applyEngineDownloadProgress({model:"small",state:"downloading",downloadedBytes:80,totalBytes:100});
 finish({state:"absent"}); await refresh;
 assert.equal(h.get("local-qwen").state,"downloading");
 assert.equal(h.get("local-qwen").downloadedBytes,80);
});
test("latest refresh wins and readiness completion does not switch engines", async () => {
 const h=availabilityHarness(); let finish;
 const calls=[];
 h.context.ipc.invoke=async(command,model)=> {calls.push(command); return command === "get-api-keys" ? {} : model === "small" ? await new Promise(resolve=>{finish=resolve;}) : {state:"ready"};};
 const old=h.context.refreshEngineAvailability();
 h.context.ipc.invoke=async(command)=> {calls.push(command); return command === "get-api-keys" ? {apiKeyGroq:"key"} : {state:"ready"};};
 await h.context.refreshEngineAvailability();
 finish({state:"absent"}); await old;
 assert.equal(h.get("local-qwen").state,"ready");
 assert.equal(h.get("groq").state,"ready");
 assert.equal(calls.some(command=>command.startsWith("set-")),false);
});

test("current engine with missing assets can open setup", async () => {
 const h=harness(true); await h.context.selectEngine("local-qwen-large");
 assert.equal(h.pages[0][1].settingsTarget,"local-model:qwen3-asr-1.7b-q8_0");
 assert.equal(h.calls.some(([command])=>command.startsWith("set-")),false);
});


test("home mutations are dispatched through the Settings shared save queue", async () => {
  const h = harness(); let dispatched = false;
  h.context.window.TypeAloudSettings.runEngineChange = async change => {
    dispatched = true;
    assert.equal(h.calls.length, 0);
    return change({ provider: "local", model: "qwen3-asr-1.7b-q8_0" });
  };
  await h.context.selectEngine("local-qwen");
  assert.equal(dispatched, true);
  assert.equal(h.pages.length, 0);
});

test("home shows Qwen as one engine at its current or last size, OpenAI, the engine in use, and More", () => {
  const home = source.slice(source.indexOf("const QWEN_SIZE_LABELS"), source.indexOf("function renderEngineCard()"));
  const options = [
    { value: "local-qwen", model: "small" }, { value: "local-qwen-large", model: "large" },
    { value: "openai", label: "OpenAI" }, { value: "groq", label: "Groq" }, { value: "local-nemotron", labelKey: "nemo", model: "nemo" },
  ];
  const run = (selected, qwenModel) => {
    const context = vm.createContext({
      QWEN_LARGE_LOCAL_MODEL: "large", t: key => key,
      cachedSettings: { qwenModel }, selectedEngineValue: () => selected, availableEngineOptions: () => options,
    });
    vm.runInContext(home, context);
    return JSON.parse(JSON.stringify({
      shown: context.homeEngineOptions().map(option => option.value),
      more: context.homeMoreOptions().map(option => option.value),
      label: context.homeEngineLabel(options[1]),
    }));
  };
  assert.deepEqual(run("local-qwen", ""), { shown: ["local-qwen", "openai"], more: ["groq", "local-nemotron"], label: "home.engineLocalQwen 1.7B" });
  assert.deepEqual(run("local-qwen-large", "large").shown, ["local-qwen-large", "openai"]);
  assert.deepEqual(run("openai", "large").shown, ["local-qwen-large", "openai"], "returning to Qwen goes back to the size used last");
  assert.deepEqual(run("groq", ""), { shown: ["local-qwen", "openai", "groq"], more: ["local-nemotron"], label: "home.engineLocalQwen 1.7B" });
});

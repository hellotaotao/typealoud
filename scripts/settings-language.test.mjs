import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function harness(model, provider = "local") {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { appendChild(child) { child.parentElement = this; }, value: id === "languageSelect" ? "en" : "", classList: {
        toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
        remove(name) { classes.delete(name); }, contains: name => classes.has(name),
      } });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: node }, currentSettings: { provider, model },
    inspectedLocalModel: null, gpuRuntimeSupported: false,
    translate: key => key, syncEngineDrawer() {},
  });
  vm.runInContext(section('const QWEN_LOCAL_MODEL', 'let currentThemePref') + '\n'
    + section('function localModelForProvider', '// Nemotron is wired') + '\n'
    + section('function toggleProviderFields', '// --- Local model panel'), context);
  return { context, node };
}

for (const [choice, model, provider, disabled] of [
  ["local-qwen", "qwen3-asr-0.6b-q8_0", "local", true],
  ["local-qwen-large", "qwen3-asr-1.7b-q8_0", "local", true],
  ["local-nemotron", "nemotron-3.5-asr-streaming-0.6b-q8_0", "local", false],
  ["openrouter", "qwen/qwen3-asr-1.7b", "openrouter", false],
  ["openai", "gpt-transcribe", "openai", false],
]) {
  test(`${choice}: Qwen alone reduces the language row to one plain note without clearing the saved value`, () => {
    const h = harness(model, provider);
    h.context.toggleProviderFields(choice);
    assert.equal(h.node("languageSelect").disabled, disabled);
    assert.equal(h.node("dictationOptions").classList.contains("hidden"), false);
    assert.equal(h.node("languageLocalNote").classList.contains("hidden"), !disabled);
    assert.equal(h.node("languageDescription").classList.contains("hidden"), disabled);
    assert.equal(h.node("languageControl").classList.contains("hidden"), disabled);
    // Replacement rules apply to every engine, so the dictionary entry stays.
    assert.equal(h.node("dictionarySettingItem").classList.contains("hidden"), false);
    assert.equal(h.node("languageSelect").value, "en");
  });
}

test("inspecting another engine does not change the active engine's language control", () => {
  const h = harness("nemotron-3.5-asr-streaming-0.6b-q8_0");
  h.context.inspectedLocalModel = "qwen3-asr-0.6b-q8_0";
  h.context.toggleProviderFields("local-qwen");
  assert.equal(h.node("languageSelect").disabled, false);
  h.context.currentSettings.model = "qwen3-asr-0.6b-q8_0";
  h.context.toggleProviderFields("local-qwen");
  assert.equal(h.node("languageSelect").disabled, true);
  assert.equal(h.node("languageSelect").value, "en");
});

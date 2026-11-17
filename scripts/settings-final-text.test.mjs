import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/views/main.html", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

// Final-text toggles: each is a default-on checkbox saved under its own key.
const toggles = [
  { key: "mergeSpelledLetters", id: "mergeSpelledLettersCheck", title: "mergeSpelledLettersTitle",
    description: "mergeSpelledLettersDescription" },
  { key: "removeFillerWords", id: "removeFillerWordsCheck", title: "removeFillerWordsTitle",
    description: "removeFillerWordsDescription" },
];

function harness(toggle, enabled) {
  let stored = { provider: "local", model: "qwen3-asr-0.6b-q8_0", [toggle.key]: enabled };
  const saved = [];
  const checkbox = { checked: false };
  const context = vm.createContext({
    console,
    document: { getElementById: id => id === toggle.id ? checkbox : null },
    initializeDependencies: async () => {},
    ipc: { invoke: async (command, payload) => {
      if (command === "get-settings") return { ...stored };
      if (command === "get-api-keys") return {};
      if (command === "save-settings") {
        saved.push(payload);
        stored = { ...stored, ...payload };
        return true;
      }
      throw new Error(`Unexpected command: ${command}`);
    } },
    initI18n() {}, applyTheme() {}, setSelectValue() {}, applyNemotronAvailability() {},
    toggleProviderFields() {}, renderSettingChoices() {}, renderEngineCards() {}, showSaveStatus() {},
    renderShortcutPicker() {},
    refreshLocalModelStatus: async () => {}, refreshGpuRuntimeStatus: async () => {},
    checkMicrophonePermissionStatus: async () => {}, checkAccessibilityStatus: async () => {},
    normalizeThemePref: value => value || "elegant", translate: key => key,
    providerForSettings: () => "local-qwen", engineCloudDrafts: new Map(),
    currentSettings: {}, inspectedLocalModel: null, expandedEngineProvider: null,
    gpuRuntimeSupported: false,
  });
  vm.runInContext(section("async function loadSettings()", "let engineSwitchPending") + "\n"
    + section("async function saveSettings()", "async function initializeSettingsPage()"), context);
  return { context, checkbox, saved };
}

for (const toggle of toggles) {
  for (const enabled of [undefined, true, false]) {
    test(`${toggle.key} loads ${enabled === undefined ? "legacy default" : enabled}`, async () => {
      const h = harness(toggle, enabled);
      await h.context.loadSettings();
      assert.equal(h.checkbox.checked, enabled !== false);
    });
  }

  test(`${toggle.key} saves both toggle states and restores them on reopening`, async () => {
    const h = harness(toggle, true);
    await h.context.loadSettings();
    for (const enabled of [false, true]) {
      h.checkbox.checked = enabled;
      assert.equal(await h.context.saveSettings(), true);
      assert.equal(h.saved.at(-1)[toggle.key], enabled);
      h.checkbox.checked = !enabled;
      await h.context.loadSettings();
      assert.equal(h.checkbox.checked, enabled);
    }
  });

  test(`${toggle.key} uses the common dictation section and existing checkbox autosave`, () => {
    const options = html.slice(html.indexOf('id="dictationOptions"'), html.indexOf('id="engineAdvanced"'));
    assert.match(options, new RegExp(`type="checkbox"[^>]*id="${toggle.id}"`));
    assert.match(options, new RegExp(`aria-labelledby="${toggle.title}"`));
    assert.match(options, new RegExp(`aria-describedby="${toggle.description}"`));
    assert.match(source, /settingsPage\?\.addEventListener\("change", commitNow\)/);
  });
}

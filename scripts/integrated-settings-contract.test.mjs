import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8");

const mainHtml = read("src/views/main.html");
const mainJs = read("src/views/main.js");
const settingsJs = read("src/views/settings.js");
const settingsCss = read("src/views/settings.css");
const i18nJs = read("src/views/i18n.js");
const commandsRs = read("src-tauri/src/commands.rs");
const libRs = read("src-tauri/src/lib.rs");
const trayRs = read("src-tauri/src/tray.rs");
const settingsRs = read("src-tauri/src/settings.rs");
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));

function sectionSource(id) {
  const start = mainHtml.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `${id} is missing`);
  const next = mainHtml.indexOf('<section id="settings-panel-', start + id.length);
  return mainHtml.slice(start, next === -1 ? mainHtml.length : next);
}

test("Tauri config has no standalone settings window", () => {
  const labels = tauriConfig.app.windows.map((window) => window.label);
  assert.ok(labels.includes("main"));
  assert.ok(!labels.includes("settings"));
  assert.equal(existsSync(path.join(repoRoot, "src/views/settings.html")), false);
});

test("main sidebar treats Settings as a normal page", () => {
  assert.match(mainHtml, /class="nav-item"[^>]*data-page="settings"/);
  assert.match(mainHtml, /id="settings-page"\s+class="page"/);
  assert.match(mainJs, /showPage\("settings"/);
});

test("Settings uses two horizontal accessible tabs", () => {
  assert.match(mainHtml, /class="settings-tabs"[^>]*role="tablist"/);
  for (const tab of ["dictation", "app"]) {
    assert.match(mainHtml, new RegExp(`data-settings-tab="${tab}"`));
    assert.match(mainHtml, new RegExp(`id="settings-panel-${tab}"`));
  }
  assert.doesNotMatch(mainHtml, /class="sidebar-item"/);
  assert.match(settingsCss, /\.settings-tabs/);
  assert.match(settingsJs, /event\.key === "ArrowRight"/);
  assert.match(settingsJs, /event\.key === "ArrowLeft"/);
});

test("settings are grouped by what the user came to do", () => {
  const dictation = sectionSource("settings-panel-dictation");
  for (const id of ["shortcutSelect", "languageSelect", "openDictionaryBtn"]) {
    assert.match(dictation, new RegExp(`id="${id}"`));
  }
  assert.match(dictation, /id="providerSelect"/);
  const engines = sectionSource("settings-panel-dictation");
  for (const id of ["providerSelect", "apiKeyGroq", "apiKeyOpenAI", "modelSelect", "nemotronLatencySelect", "localModelItem"]) {
    assert.match(engines, new RegExp(`id="${id}"`));
  }

  // App is how the app itself looks and starts.
  const app = sectionSource("settings-panel-app");
  for (const id of [
    "uiLanguageSelect",
    "themeSelect",
    "autoLaunchCheck",
    "startMinimizedCheck",
    "checkUpdatesBtn",
  ]) {
    assert.match(app, new RegExp(`id="${id}"`));
  }

  // System is set-up-once state: permissions, logs, build. Not day-to-day.
  const system = sectionSource("settings-panel-app");
  for (const id of [
    "permissionSummary",
    "permissionStatus",
    "accessibilityStatus",
    "diagnosticLogPanel",
    "settingsBuildLine",
  ]) {
    assert.match(system, new RegExp(`id="${id}"`));
  }
  // Permissions collapse to one row when nothing needs doing.
  assert.match(settingsJs, /function renderPermissionSummary/);
  assert.match(settingsJs, /permissionState\.accessibility = ok/);
});

test("local engines are provider choices while cloud providers retain model selection", () => {
  const transcription = sectionSource("settings-panel-dictation");
  assert.match(transcription, /option value="local-nemotron"/);
  assert.match(transcription, /option value="local-qwen"/);
  assert.doesNotMatch(transcription, /option value="local"/);
  assert.match(transcription, /id="modelItem"/);
  assert.match(settingsJs, /localModelForProvider/);
  assert.match(settingsJs, /modelItem\?\.classList\.toggle\("hidden", isLocal\)/);
  assert.match(settingsJs, /provider: localModel \? "local" : choice/);
  assert.match(settingsJs, /const target = intent \|\| previous/);
});

test("the engine is chosen from cards that show what a label cannot", () => {
  // A dropdown row reads "Local · Qwen3-ASR · ★ Recommended" and truncates.
  // The cards carry where the audio goes and whether the choice is usable yet.
  assert.match(mainHtml, /id="engineCards"[^>]*role="group"/);
  assert.match(settingsJs, /const ENGINE_CARDS = \[/);
  assert.match(settingsJs, /function renderEngineCards/);
  assert.match(settingsJs, /function engineStatus/);
  // The select survives as the value holder and the keyboard path, so every
  // existing listener keeps working — cards drive it rather than replace it.
  assert.match(mainHtml, /id="providerSelect"/);
  assert.match(settingsJs, /card\.addEventListener\("click", \(\) => void chooseSettingsEngine\(rowChoice\(entry\)\)\)/);
  assert.match(settingsJs, /disclosure\.addEventListener\("click", \(\) => inspectEngine\(rowChoice\(entry\), \{ toggle: true \}\)\)/);
  assert.match(settingsCss, /\.setting-control-fallback/);
  assert.doesNotMatch(settingsCss, /\.setting-control-fallback\s*\{[^}]*display:\s*none/);
  for (const key of ["needsKey", "keySet", "needsDownload"]) {
    assert.ok(i18nJs.includes(`${key}:`), `engine status copy ${key} is missing`);
  }
});

test("a local engine states what it cannot use instead of hiding it", () => {
  // Qwen ignores language; Nemotron and cloud requests carry it.
  // Neither local engine uses the dictionary.
  assert.match(mainHtml, /class="setting-description hidden" id="languageLocalNote"/);
  assert.match(mainHtml, /class="setting-control" id="languageControl"/);
  assert.match(mainHtml, /id="dictionaryLocalNote"/);
  assert.match(settingsJs, /languageSelect\.disabled = isQwen/);
  assert.match(settingsJs, /getElementById\("languageLocalNote"\)\?\.classList\.toggle\("hidden", !isQwen\)/);
  assert.match(mainJs, /getElementById\("dictionaryLocalNote"\)/);
  for (const locale of ["settings", "dictionary"]) {
    assert.ok(i18nJs.includes("localNote"), `${locale} localNote copy is missing`);
  }
});

test("translate mode is gone end to end", () => {
  // A local engine needs no key, so the key field hides instead of moving into
  // a translation panel.
  assert.match(settingsJs, /apiKeyItem\?\.classList\.toggle\("hidden", isLocal\)/);
  for (const source of [mainHtml, settingsJs, mainJs, i18nJs, settingsRs, commandsRs]) {
    assert.doesNotMatch(source, /translateProvider|translate_provider|translateConsent|translate_consent|translateShortcut|translate_shortcut/);
  }
  assert.doesNotMatch(commandsRs, /audio\/translations|TRANSLATE_NEEDS_CONSENT/);
});

test("onboarding, Home, and tray expose Qwen and Nemotron as separate local engines", () => {
  // Onboarding cards are built from the hardware/support policy, not static HTML.
  assert.match(mainHtml, /id="obEngineMain"/);
  assert.match(mainHtml, /id="obEngineMore"/);
  assert.match(mainJs, /"local-nemotron": "obLocalNemotronCard"/);
  assert.match(mainJs, /"local-qwen": "obLocalQwenCard"/);
  assert.match(mainJs, /card\.setAttribute\("data-local-model", option\.model\)/);
  assert.match(mainJs, /value: "local-nemotron"/);
  assert.match(mainJs, /value: "local-qwen"/);
  assert.match(mainJs, /settingsTarget: `engine:\$\{providerChoice\}`/);
  assert.match(trayRs, /engine-local-nemotron/);
  assert.match(trayRs, /engine-local-qwen/);
});

test("Nemotron is hidden wherever no wired runtime exists", () => {
  assert.ok(settingsRs.includes("pub nemotron_supported: bool"));
  assert.ok(settingsRs.includes("nemotron_supported: crate::nemotron_asr::supported()"));
  assert.ok(settingsJs.includes("function applyNemotronAvailability"));
  assert.ok(settingsJs.includes("currentSettings.nemotronSupported"));
  assert.ok(settingsJs.includes('#providerSelect option[value="${LOCAL_NEMOTRON_PROVIDER}"]'));
  assert.ok(mainJs.includes("cachedSettings?.nemotronSupported"));
  assert.ok(mainJs.includes("const available = availableEngineOptions();"));
  assert.ok(mainJs.includes("return availableEngineOptions().filter("));
  assert.ok(trayRs.includes("fn available_engines()"));
  assert.ok(trayRs.includes("for (id, label, provider, model) in available_engines()"));
  assert.ok(trayRs.includes("crate::nemotron_asr::supported()"));
});

test("main page owns the Settings controller", () => {
  assert.match(mainHtml, /<script src="main\.js"><\/script>\s*<script src="settings\.js"><\/script>/);
  assert.match(settingsJs, /window\.TypeAloudSettings\s*=/);
  assert.match(settingsJs, /#settings-page/);
  assert.doesNotMatch(settingsJs, /invoke\("close-settings"\)/);
  assert.match(mainJs, /ipc\.on\("open-settings-page"/);
});

test("settings commit on change — no draft, no Save button", () => {
  // Home's engine switcher always wrote through immediately (set_provider),
  // while this page held a draft behind Save: one setting, two meanings of
  // "changed". Both write through now.
  assert.doesNotMatch(mainHtml, /id="saveSettingsButton"/);
  assert.doesNotMatch(mainHtml, /id="discardSettingsButton"/);
  assert.doesNotMatch(mainHtml, /id="unsavedHint"/);
  assert.doesNotMatch(settingsJs, /settingsDirty/);
  assert.doesNotMatch(settingsJs, /function markDirty/);
  assert.doesNotMatch(settingsJs, /confirmLeave/);
  assert.doesNotMatch(mainJs, /confirmLeave/);
  assert.match(settingsJs, /settingsPage\?\.addEventListener\("change", commitNow\)/);
  // Free text debounces then commits on blur; a failed write has to be visible
  // because there is no longer a button whose state could imply "unsaved".
  assert.match(settingsJs, /function commitSoon/);
  assert.match(settingsJs, /showSaveStatus\("error"/);
  assert.match(mainHtml, /id="saveStatus"/);
  assert.doesNotMatch(settingsJs, /alert\(translate\("settings\.saveError"\)\)/);
});

test("backend routes every Settings entry into the main window", () => {
  assert.match(commandsRs, /window\.label\(\) != "main"/);
  assert.match(commandsRs, /get_webview_window\("main"\)/);
  assert.match(commandsRs, /emit_to\("main",\s*"open-settings-page"/);
  assert.doesNotMatch(commandsRs, /get_webview_window\("settings"\)/);
  assert.doesNotMatch(libRs, /SETTINGS_ENTRY_SCRIPT/);
  assert.doesNotMatch(libRs, /label == "main" \|\| label == "settings"/);
  assert.match(trayRs, /commands::open_settings/);
  assert.doesNotMatch(trayRs, /get_webview_window\("settings"\)/);
});

test("Qwen is the recommended local engine and Nemotron exposes both latency profiles", () => {
  const transcription = sectionSource("settings-panel-dictation");
  assert.match(transcription, /option value="local-qwen"[^>]*>Local · Qwen3-ASR · ★ Recommended<\/option>/);
  assert.match(transcription, /id="nemotronLatencyItem"/);
  assert.match(transcription, /id="nemotronLatencySelect"/);
  assert.match(transcription, /option value="560"/);
  assert.match(transcription, /option value="1120"/);
  assert.match(settingsJs, /configurationProvider !== LOCAL_NEMOTRON_PROVIDER/);
  assert.match(settingsJs, /nemotronLatencyMs: Number/);
  assert.match(mainJs, /value: "local-qwen",[\s\S]*?recommended: true/);
  assert.match(commandsRs, /LOCAL_PROVIDER => crate::local_asr::QWEN_MODEL_ID/);
});

test("new Settings page labels exist in both locales", () => {
  for (const value of [
    'pageTitle: "Settings"',
    'dictation: "Dictation Settings"',
    'app: "App Settings"',
    'pageTitle: "设置"',
    'dictation: "听写设置"',
    'app: "应用设置"',
  ]) {
    assert.ok(i18nJs.includes(value), `missing i18n entry: ${value}`);
  }
});

test("software update is reachable without the tray or three clicks", () => {
  // The tray entry is invisible once the menu-bar icon overflows, which left
  // Settings -> App -> scroll as the only route to a downloaded build.
  assert.match(mainHtml, /id="sidebarVersion"/);
  assert.match(mainHtml, /id="update-card"/);
  assert.match(mainJs, /ipc\.on\("update-status"/);
  assert.match(mainJs, /invoke\("install-update-and-restart"\)/);
  assert.match(mainJs, /function renderUpdateCard/);
  // The card is an announcement, not a status row: it exists only when a build
  // is actually waiting.
  assert.match(mainJs, /card\.classList\.toggle\("hidden", !updateReady\(\)\)/);
  // Tray keeps its entry — this adds routes, it does not move one.
  assert.ok(trayRs.includes("install-update"));
  for (const key of ["restartShort", "cardTitle", "checkShort"]) {
    assert.ok(i18nJs.includes(`${key}:`), `update.${key} copy is missing`);
  }
});

test("System settings contains a collapsed diagnostic log viewer with refresh and copy", () => {
  const system = sectionSource("settings-panel-app");
  const app = system;
  const details = system.match(/<details\b[^>]*id="diagnosticLogPanel"[^>]*>/)?.[0] || "";

  assert.ok(details, "diagnostic log details is missing");
  assert.doesNotMatch(details, /\sopen(?:\s|=|>)/, "diagnostic log details must start collapsed");
  assert.match(app, /id="diagnosticLogContent"[^>]*readonly/);
  assert.match(app, /id="refreshDiagnosticLogBtn"/);
  assert.match(app, /id="copyDiagnosticLogBtn"/);
  assert.match(settingsJs, /diagnosticLogPanel.*addEventListener\("toggle"/s);
  assert.match(settingsJs, /invoke\("get-diagnostic-log"\)/);
  assert.match(settingsJs, /invoke\("copy-to-clipboard",\s*content/s);
  assert.match(settingsCss, /\.diagnostic-log-content/);

  for (const value of [
    'title: "Diagnostic logs"',
    'copy: "Copy all"',
    'title: "\\u8bca\\u65ad\\u65e5\\u5fd7"',
    'copy: "\\u590d\\u5236\\u5168\\u90e8"',
  ]) {
    assert.ok(i18nJs.includes(value), `missing diagnostics i18n entry: ${value}`);
  }

  assert.match(commandsRs, /pub fn get_diagnostic_log/);
  assert.match(commandsRs, /window\.label\(\) != "main"/);
  assert.match(commandsRs, /join\("TypeAloud\.log"\)/);
});

test("unrequested microphone permission is not reported as granted", () => {
  assert.doesNotMatch(
    mainJs,
    /result\.status === "granted"\s*\|\|\s*result\.status === "not-determined"/
  );
  assert.doesNotMatch(
    settingsJs,
    /status === "granted"\s*\|\|\s*status === "not-determined"/
  );
  assert.match(
    settingsJs,
    /requestMicrophonePermission[\s\S]*navigator\.mediaDevices\.getUserMedia/
  );
  assert.match(
    settingsJs,
    /requestMicrophonePermission[\s\S]*open-microphone-settings/
  );
});

test("sidebar version and update action stack without horizontal crowding", () => {
  const css = read("src/views/main.css");
  const row = css.match(/\.sidebar-version\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(row, /flex-direction:\s*column/);
  assert.match(row, /align-items:\s*flex-start/);
});

test("settings markup contains no literal escaped newlines", () => {
  assert.ok(!mainHtml.includes("\\n"));
});

test("engine cards offer both Qwen sizes then OpenAI then Groq then Nemotron", () => {
  const cards = settingsJs.match(/const ENGINE_CARDS = \[([\s\S]*?)\];/)?.[1] || "";
  const values = [...cards.matchAll(/value: ([^,]+)/g)].map((match) => match[1]);
  assert.deepEqual(values, ["LOCAL_QWEN_PROVIDER", "LOCAL_QWEN_LARGE_PROVIDER", '"openai"', '"groq"', "LOCAL_NEMOTRON_PROVIDER"]);
});

test("settings groups keep their spacing", () => {
  assert.match(settingsCss, /#settings-page \.setting-group\s*\{[^}]*margin-bottom:\s*14px/);
});

test("model setup opens Dictation while update checks still open App", () => {
  assert.match(settingsJs, /target\.startsWith\("local-model"\)[\s\S]*?activateSettingsTab\("dictation"\)/);
  assert.match(mainJs, /settingsTarget: "app"/);
  assert.match(settingsJs, /const SETTINGS_TABS = \["dictation", "app"\]/);
});


test("default settings prioritizes engines and collapses local maintenance", () => {
  const panel = sectionSource("settings-panel-dictation");
  assert.ok(panel.indexOf('id="engineCards"') < panel.indexOf('id="shortcutSelect"'));
  assert.match(panel, /<details[^>]*id="engineAdvanced"/);
  assert.match(panel, /id="dictationOptions"/);
  assert.doesNotMatch(mainHtml, /data-settings-tab="engines"/);
});

test("engine configuration lives in a stable inline accordion drawer", () => {
  assert.match(settingsJs, /function syncEngineDrawer/);
  assert.match(settingsJs, /aria-expanded/);
  const render = settingsJs.slice(settingsJs.indexOf('function renderEngineCards'), settingsJs.indexOf('function camelKey'));
  assert.doesNotMatch(render, /host\.replaceChildren/);
  assert.match(settingsCss, /\.engine-drawer/);
});

test("reference-style settings controls retain select-backed values", () => {
  for (const id of ['uiLanguageSelect','themeSelect','modelSelect']) {
    assert.match(settingsJs, new RegExp(`"${id}"`));
  }
  assert.match(settingsJs, /function renderSettingChoices/);
  assert.match(settingsCss, /\.theme-swatch/);
  assert.match(settingsCss, /\.segmented-choices/);
});

test("cloud models explain cost and tradeoffs without a single-choice button", () => {
  assert.match(settingsJs, /function renderModelChoices/);
  assert.match(settingsJs, /options\.length === 1/);
  assert.match(i18nJs, /\$0\.04/);
  assert.match(i18nJs, /\$0\.111/);
  assert.match(i18nJs, /modelTurboDetail/);
  assert.match(settingsCss, /#engineAdvanced\s*\{[^}]*background:\s*transparent/);
});

test("the Settings accessibility row offers the Finder route while the grant is missing", () => {
  // A TypeAloud row that never appears in the Accessibility list can only be fixed
  // by dragging the app in. Home already offered the Finder reveal and the drag
  // cloud; the Settings route to the same pane now offers both too.
  assert.match(mainHtml, /id="accessibilityRevealRow"/);
  assert.match(mainHtml, /id="revealAppForAccessibility"[^>]*data-i18n="readiness\.axGuide\.revealApp"/);
  assert.match(settingsJs, /getElementById\("accessibilityRevealRow"\)\?\.classList\.toggle\("hidden", ok\)/);
  assert.match(settingsJs, /getElementById\("revealAppForAccessibility"\)/);
  assert.match(settingsJs, /async function handleAccessibilityPermission[\s\S]*?invoke\("show-ax-cloud"\)/);
});

test("the Home update card links to the release notes for the waiting version", () => {
  // The card only said "downloaded, restart when you like". What changed lives
  // on the GitHub release page, so the card opens that page for its version.
  assert.match(mainJs, /t\("update\.whatsNew"\)/);
  assert.match(mainJs, /card\.replaceChildren\(icon, titles, notes, restart\)/);
  assert.match(mainJs, /invoke\("open-release-page", updateStatus\.version\)/);
  // The URL is built and validated in Rust from the version alone.
  assert.match(commandsRs, /pub fn open_release_page\(version: String\)/);
  assert.match(commandsRs, /updater::release_page_url\(&version\)/);
  assert.ok(i18nJs.includes('whatsNew: "看看改了什么"'));
  assert.ok(i18nJs.includes(`whatsNew: "What's new"`));
});

test("engines switch from their row with no separate Use button; Qwen's sizes and their costs sit in its drawer", () => {
  assert.doesNotMatch(mainHtml, /engineUseBtn/);
  assert.match(settingsJs, /value: LOCAL_QWEN_LARGE_PROVIDER, local: true, icon: "memory", group: "size"/);
  assert.match(settingsJs, /picker\.id = "qwenSizePicker"/);
  assert.match(settingsJs, /\[LOCAL_QWEN_LARGE_PROVIDER\]: \{ label: "1\.7B", noteKey: "settings\.engine\.qwenSize\.largeNote", download: "~2\.5 GB", memory: "~2\.9 GB" \}/);
  assert.match(settingsCss, /\.engine-card-row\.experimental:not\(\.active\) \{\s*opacity: 0\.75;/);
  assert.doesNotMatch(settingsCss, /\.engine-card-row\.experimental \{[^}]*opacity/);
  const check = settingsCss.match(/\.engine-check::before \{([^}]+)\}/)[1];
  assert.match(check, /border-radius: 50%/);
});

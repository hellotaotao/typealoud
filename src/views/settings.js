(function () {
let ipc = null;
let initI18n = () => "en";
let setLanguage = () => "en";
let applyI18n = () => {};
let t = (key) => key;

if (typeof document !== "undefined" && document.documentElement) {
  document.documentElement.setAttribute("data-settings-js-ran", "1");
}

const READY_TIMEOUT_MS = 3000;
const READY_POLL_MS = 25;
const THEME_PREFS = new Set(["auto", "midnight", "elegant"]);
const QWEN_LOCAL_MODEL = "qwen3-asr-0.6b-q8_0";
const QWEN_LARGE_LOCAL_MODEL = "qwen3-asr-1.7b-q8_0";
const NEMOTRON_LOCAL_MODEL = "nemotron-3.5-asr-streaming-0.6b-q8_0";
const LOCAL_QWEN_PROVIDER = "local-qwen";
const LOCAL_QWEN_LARGE_PROVIDER = "local-qwen-large";
const LOCAL_NEMOTRON_PROVIDER = "local-nemotron";
let currentThemePref = "elegant";

// First entry per provider is the effective default when switching provider
// (the rebuilt <select> lands on it) — keep it in sync with the backend
// default (settings.rs default_model / save_onboarding_api_key /
// perform_transcription_request's empty-model fallback). `recommended` adds a
// localized "★ 推荐" tag to the label. Turbo over lv3 is evidence-backed: the
// 2026-07-03 punctuation sweep (docs/cloud-transcription.md) showed lv3 collapse to zero
// punctuation on run-on Chinese speech while turbo+seed punctuates.
//
// OpenAI is deliberately ONE row. `gpt-transcribe` ($0.0045/min, 2026-07-28)
// dominates the three models dropped on 2026-09-06:
//   - gpt-4o-transcribe ($0.006/min) — dearer, and measured WORST of the family
//     on Chinese punctuation (0/1/0 marks vs mini's 6/8/7, 2026-07-07).
//   - whisper-1 ($0.006/min) — dearer, oldest, collapses the same way, worst
//     prompt-leak offender.
//   - gpt-4o-mini-transcribe ($0.003/min) — the only real trade-off, and it
//     lost on quality: measured head-to-head 2026-09-07 (same 20 s run-on zh
//     clip, 3 reps each, both deterministic, both 92/92 words correct), it
//     emits HALF-WIDTH ASCII commas into Chinese text and runs the whole
//     utterance together as one sentence, where gpt-transcribe emits proper
//     full-width ，。 and segments it into two. scrub.rs does no width
//     normalization, so that lands in the user's document verbatim. The 33%
//     saving is ~$0.68/month at 15 min/day of real audio — not worth it.
const modelOptions = {
  groq: [
    { value: "whisper-large-v3-turbo", labelKey: "settings.model.options.whisperLargeV3Turbo", recommended: true },
    { value: "whisper-large-v3", labelKey: "settings.model.options.whisperLargeV3" },
  ],
  openai: [
    { value: "gpt-transcribe", labelKey: "settings.model.options.gptTranscribe", recommended: true },
  ],
};

let currentSettings = {};
const engineCloudDrafts = new Map();
let expandedEngineProvider = null;
let pageEventsBound = false;
let shortcutSyncBound = false;
let themeSyncBound = false;
let pendingAccessibilityRecheck = false;
let accessibilityRecheckTimer = null;
let settingsInitialized = false;
let activeSettingsTab = "dictation";

// Keep primary dictation controls together; low-frequency setup is collapsible.
const SETTINGS_TABS = ["dictation", "app"];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function translate(key, vars) {
  try {
    return typeof t === "function" ? t(key, vars) : key;
  } catch {
    return key;
  }
}

function normalizeThemePref(value) {
  return THEME_PREFS.has(value) ? value : "elegant";
}

function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

function concreteTheme(pref) {
  const normalized = normalizeThemePref(pref);
  return normalized === "auto" ? (systemPrefersDark() ? "midnight" : "elegant") : normalized;
}

function applyTheme(value) {
  currentThemePref = normalizeThemePref(value);
  document.documentElement.setAttribute("data-theme", concreteTheme(currentThemePref));
}

function watchSystemTheme() {
  if (!window.matchMedia) {
    return;
  }
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (currentThemePref === "auto") {
      document.documentElement.setAttribute("data-theme", concreteTheme(currentThemePref));
    }
  });
}

function getDependencies() {
  const bridge = window.__SAYTYPE_IPC__;
  const i18nApi = window.SayTypeI18n;

  if (
    bridge &&
    typeof bridge.invoke === "function" &&
    typeof bridge.on === "function" &&
    i18nApi &&
    typeof i18nApi.initI18n === "function" &&
    typeof i18nApi.setLanguage === "function" &&
    typeof i18nApi.applyI18n === "function" &&
    typeof i18nApi.t === "function"
  ) {
    return { bridge, i18nApi };
  }

  return null;
}

async function waitForDependencies() {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const dependencies = getDependencies();
    if (dependencies) {
      return dependencies;
    }
    await delay(READY_POLL_MS);
  }

  return getDependencies();
}

async function initializeDependencies() {
  if (ipc) {
    return;
  }

  const dependencies = getDependencies() || (await waitForDependencies());
  if (!dependencies) {
    throw new Error("settings runtime dependencies unavailable");
  }

  ipc = dependencies.bridge;
  ({ initI18n, setLanguage, applyI18n, t } = dependencies.i18nApi);
}

// Keep the original selects as value holders; buttons use the same change path.
function renderSettingChoices() {
  for (const id of ["uiLanguageSelect", "themeSelect", "modelSelect"]) {
    const select = document.getElementById(id);
    if (!select) continue;
    let group = document.getElementById(`${id}Choices`);
    if (!group) {
      group = document.createElement("div");
      group.id = `${id}Choices`;
      group.className = id === "themeSelect" ? "theme-choices" : "segmented-choices";
      group.setAttribute("role", "group");
      select.after(group);
      select.hidden = true;
      select.addEventListener("change", renderSettingChoices);
    }
    group.setAttribute("aria-label", select.title);
    const order = id === "themeSelect" ? ["auto", "elegant", "midnight"]
      : id === "uiLanguageSelect" ? ["auto", "zh", "en"] : null;
    const options = Array.from(select.options);
    if (order) options.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
    if (id === "modelSelect") {
      renderModelChoices(select, group, options);
      continue;
    }
    const signature = options.map(option => option.value).join("|");
    if (group.dataset.options !== signature) {
      group.replaceChildren();
      group.dataset.options = signature;
      for (const option of options) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.value = option.value;
        button.className = "setting-choice";
        if (id === "themeSelect") {
          const swatch = document.createElement("span");
          swatch.className = `theme-swatch theme-swatch-${option.value}`;
          swatch.setAttribute("aria-hidden", "true");
          button.appendChild(swatch);
        }
        const label = document.createElement("span");
        label.className = "choice-label";
        button.appendChild(label);
        button.addEventListener("click", () => {
          if (select.value === button.dataset.value) return;
          select.value = button.dataset.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        group.appendChild(button);
      }
    }
    for (const button of group.children) {
      const option = options.find(option => option.value === button.dataset.value);
      const modelLabels = {
        "whisper-large-v3-turbo": "Large V3 Turbo",
        "whisper-large-v3": "Large V3",
        "gpt-transcribe": "GPT Transcribe",
      };
      button.querySelector(".choice-label").textContent = id === "modelSelect"
        ? modelLabels[option.value] || option.textContent : option.textContent;
      button.title = option.textContent;
      button.setAttribute("aria-pressed", String(button.dataset.value === select.value));
      button.disabled = select.disabled;
    }
  }
}

// Rates and tradeoffs verified against OpenAI/Groq model documentation.
// https://developers.openai.com/api/docs/models/gpt-transcribe
// https://console.groq.com/docs/speech-to-text
function renderModelChoices(select, group, options) {
  const single = options.length === 1;
  const hint = select.closest(".setting-item")?.querySelector(".setting-description");
  if (hint) {
    const key = single ? "settings.modelSingleHint" : "settings.modelMultipleHint";
    hint.setAttribute("data-i18n", key);
    hint.textContent = translate(key);
  }
  const signature = options.map(option => option.value).join("|");
  group.className = single ? "model-info" : "segmented-choices model-choices";
  if (group.dataset.options !== signature) {
    group.replaceChildren();
    group.dataset.options = signature;
    for (const option of options) {
      const item = document.createElement(single ? "div" : "button");
      item.dataset.value = option.value;
      item.className = single ? "model-summary" : "setting-choice model-choice";
      if (!single) {
        item.type = "button";
        item.addEventListener("click", () => {
          if (select.value === item.dataset.value) return;
          select.value = item.dataset.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
      for (const className of ["model-name", "model-recommended", "model-price", "model-detail"]) {
        const span = document.createElement("span");
        span.className = className;
        item.appendChild(span);
      }
      group.appendChild(item);
    }
  }
  const metadata = {
    "gpt-transcribe": ["GPT Transcribe", "modelOpenaiPrice", "modelOpenaiDetail"],
    "whisper-large-v3-turbo": ["Large V3 Turbo", "modelTurboPrice", "modelTurboDetail"],
    "whisper-large-v3": ["Large V3", "modelV3Price", "modelV3Detail"],
  };
  for (const item of group.children) {
    const value = item.dataset.value;
    const data = metadata[value] || [value, "", ""];
    item.querySelector(".model-name").textContent = data[0];
    item.querySelector(".model-price").textContent = data[1] ? translate(`settings.${data[1]}`) : "";
    item.querySelector(".model-detail").textContent = data[2] ? translate(`settings.${data[2]}`) : "";
    const recommended = item.querySelector(".model-recommended");
    recommended.hidden = value !== "whisper-large-v3-turbo";
    recommended.textContent = translate("settings.engine.recommended");
    if (!single) {
      item.setAttribute("aria-pressed", String(value === select.value));
      item.disabled = select.disabled;
    }
  }
}

function updateModelOptions(provider) {
  const select = document.getElementById("modelSelect");
  if (!select) {
    return;
  }

  select.innerHTML = "";
  (modelOptions[provider] || []).forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt.value;
    const label = opt.labelKey ? translate(opt.labelKey) : opt.label || opt.value;
    option.textContent = opt.recommended
      ? `${label} · ${translate("settings.model.recommendedTag")}`
      : label;
    select.appendChild(option);
  });
  renderSettingChoices();
}

// The engine list, in the order it is offered. Cloud rows carry the key state,
// local rows the download state — the two things that decide whether a choice
// is usable at all, which a bare dropdown could not show.
// Qwen is one row whose two sizes are picked inside its drawer, so the 1.7B
// entry has no row of its own ("size"). Groq and Nemotron sit behind "More
// engines" unless one of them is in use.
const ENGINE_CARDS = [
  { value: LOCAL_QWEN_PROVIDER, local: true, icon: "memory", recommended: true, group: "main" },
  { value: LOCAL_QWEN_LARGE_PROVIDER, local: true, icon: "memory", group: "size" },
  { value: "openai", local: false, icon: "cloud", group: "main" },
  { value: "groq", local: false, icon: "cloud", group: "more" },
  { value: LOCAL_NEMOTRON_PROVIDER, local: true, icon: "memory", experimental: true, group: "more" },
];
const QWEN_CHOICES = [LOCAL_QWEN_PROVIDER, LOCAL_QWEN_LARGE_PROVIDER];
const QWEN_SIZE_SPECS = {
  [LOCAL_QWEN_PROVIDER]: { label: "0.6B", noteKey: "settings.engine.qwenSize.smallNote", download: "~1.0 GB", memory: "~1.4 GB" },
  [LOCAL_QWEN_LARGE_PROVIDER]: { label: "1.7B", noteKey: "settings.engine.qwenSize.largeNote", download: "~2.5 GB", memory: "~2.9 GB" },
};
// The 1.7B suggestion is based on how fast 0.6B actually runs here, not on
// the chip name. 1.7B decodes about 2.2x slower than 0.6B (M4 measurements
// in docs/local-asr.md). The wait is quoted for one 15-second sentence.
const QWEN_LARGE_SLOWDOWN = 2.2;
const QWEN_SENTENCE_SECONDS = 15;
const QWEN_SUGGEST_MAX_WAIT_SECONDS = 1.5;
const QWEN_SLOW_WAIT_SECONDS = 3;
const QWEN_MIN_SMALL_SAMPLES = 10;
const QWEN_MIN_LARGE_SAMPLES = 5;
let engineMoreExpanded = false;
// Measured decode speed per model: { [model]: { samples, medianRtf } }.
let qwenSpeed = {};

function isQwenChoice(choice) {
  return QWEN_CHOICES.includes(choice);
}

// The row (and drawer) an engine choice lives in.
function engineRowFor(choice) {
  return isQwenChoice(choice) ? LOCAL_QWEN_PROVIDER : choice;
}

// The Qwen size the Qwen row stands for right now: the one open in its
// drawer, else the one in use, else the one used last.
function qwenChoice() {
  if (isQwenChoice(expandedEngineProvider)) return expandedEngineProvider;
  const active = providerForSettings(currentSettings);
  if (isQwenChoice(active)) return active;
  return currentSettings.qwenModel === QWEN_LARGE_LOCAL_MODEL ? LOCAL_QWEN_LARGE_PROVIDER : LOCAL_QWEN_PROVIDER;
}

function rowChoice(entry) {
  return entry.value === LOCAL_QWEN_PROVIDER ? qwenChoice() : entry.value;
}

// Seconds to wait after releasing the key for one 15-second sentence, from
// this machine's own dictations. A size with too few samples of its own is
// estimated from the other one; null until there is enough to go on.
function qwenWaitEstimate(speed, model) {
  const small = speed?.[QWEN_LOCAL_MODEL];
  const large = speed?.[QWEN_LARGE_LOCAL_MODEL];
  const enough = (entry, minimum) => entry && entry.samples >= minimum && Number.isFinite(entry.medianRtf);
  let rtf = null;
  if (model === QWEN_LARGE_LOCAL_MODEL) {
    if (enough(large, QWEN_MIN_LARGE_SAMPLES)) rtf = large.medianRtf;
    else if (enough(small, QWEN_MIN_SMALL_SAMPLES)) rtf = small.medianRtf * QWEN_LARGE_SLOWDOWN;
  } else if (enough(small, QWEN_MIN_SMALL_SAMPLES)) {
    rtf = small.medianRtf;
  } else if (enough(large, QWEN_MIN_LARGE_SAMPLES)) {
    rtf = large.medianRtf / QWEN_LARGE_SLOWDOWN;
  }
  return rtf === null ? null : rtf * QWEN_SENTENCE_SECONDS;
}

// "suggest": 0.6B is in use, 1.7B is not downloaded, and 1.7B would still
// answer quickly here. "slow": 1.7B is in use and keeps people waiting.
function qwenSizeAdvice(speed, activeModel, largeState) {
  if (activeModel === QWEN_LOCAL_MODEL && !["ready", "downloading"].includes(largeState)) {
    const small = speed?.[QWEN_LOCAL_MODEL];
    const wait = small?.samples >= QWEN_MIN_SMALL_SAMPLES ? qwenWaitEstimate(speed, QWEN_LARGE_LOCAL_MODEL) : null;
    if (wait !== null && wait <= QWEN_SUGGEST_MAX_WAIT_SECONDS) return "suggest";
  }
  if (activeModel === QWEN_LARGE_LOCAL_MODEL) {
    const large = speed?.[QWEN_LARGE_LOCAL_MODEL];
    if (large?.samples >= QWEN_MIN_LARGE_SAMPLES && large.medianRtf * QWEN_SENTENCE_SECONDS > QWEN_SLOW_WAIT_SECONDS) {
      return "slow";
    }
  }
  return "";
}

function engineStatus(entry) {
  if (entry.local) {
    const status = localModelStatuses.get(localModelForProvider(entry.value));
    if (!status) return { key: "settings.permission.checking", tone: "busy" };
    if (status.state === "unknown") return { key: "settings.permission.error", tone: "warn" };
    if (status.state === "ready") return { key: "settings.engine.status.ready", tone: "ok" };
    if (status.state === "downloading") return { key: "settings.engine.status.downloading", tone: "busy" };
    return { key: "settings.engine.status.needsDownload", tone: "warn" };
  }
  const field = entry.value === "groq" ? "apiKeyGroq" : "apiKeyOpenAI";
  const hasKey = !!document.getElementById(field)?.value.trim();
  return hasKey
    ? { key: "settings.engine.status.keySet", tone: "ok" }
    : { key: "settings.engine.status.needsKey", tone: "warn" };
}

function updateEngineChoice(button, active) {
  button.setAttribute("aria-pressed", String(active));
  button.disabled = engineSwitchPending;
}

// Rows behave like a Wi-Fi list. Clicking a usable engine switches to it and
// opens its details; one that still needs a key or a download only opens, to
// show what is missing, and switches on a later click once it is usable. The
// active engine's row just opens or closes, and so does the chevron on any row.
async function chooseSettingsEngine(choice) {
  if (engineSwitchPending) return;
  const entry = ENGINE_CARDS.find((card) => card.value === choice);
  const active = choice === providerForSettings(currentSettings);
  if (active || !entry || engineStatus(entry).tone !== "ok") {
    inspectEngine(choice, { toggle: true });
    return;
  }
  inspectEngine(choice);
  await activateEngine(inspectedEngineTarget());
}

// The copy key for a row: the Qwen row names the engine, not one size.
function rowCopyKey(entry) {
  return entry.value === LOCAL_QWEN_PROVIDER ? "qwen" : camelKey(entry.value);
}

function renderEngineCards() {
  renderSettingChoices();
  const host = document.getElementById("engineCards");
  const select = document.getElementById("providerSelect");
  if (!host || !select) {
    return;
  }
  const offered = new Set(Array.from(select.options).map((option) => option.value));
  const selected = providerForSettings(currentSettings);
  const rows = ENGINE_CARDS.filter((entry) => entry.group !== "size" && offered.has(entry.value));

  rows.forEach((entry) => {
      const active = engineRowFor(selected) === entry.value;
      const statusEntry = { ...entry, value: rowChoice(entry) };
      const existing = document.getElementById(`engine-choice-${entry.value}`);
      if (existing) {
        existing.parentElement.classList.toggle("active", active);
        updateEngineChoice(existing, active);
        document.getElementById(`engine-disclosure-${entry.value}`)?.setAttribute(
          "aria-label", translate("settings.engine.details", { model: translate(`settings.engine.${rowCopyKey(entry)}.name`) }));
        existing.querySelector(".engine-card-name > span").textContent = translate(`settings.engine.${rowCopyKey(entry)}.name`);
        existing.querySelector(".engine-card-desc").textContent = translate(`settings.engine.${rowCopyKey(entry)}.description`);
        const status = engineStatus(statusEntry);
        const badge = existing.querySelector(".engine-card-status");
        badge.textContent = active ? translate("settings.engine.activeModel", { model: engineTargetLabel(currentSettings) }) : translate(status.key);
        badge.className = `engine-card-status engine-status-${status.tone}`;
        return;
      }
      const card = document.createElement("button");
      card.type = "button";
      const row = document.createElement("div");
      row.className = `engine-card-row${active ? " active" : ""}${
        entry.experimental ? " experimental" : ""
      }`;
      card.className = "engine-choice";
      card.id = `engine-choice-${entry.value}`;
      updateEngineChoice(card, active);

      // Shows which engine is in use; the whole row is the control.
      const check = document.createElement("span");
      check.className = "engine-check";
      check.setAttribute("aria-hidden", "true");
      const tick = document.createElement("span");
      tick.className = "material-icons";
      tick.textContent = "check";
      check.appendChild(tick);

      const icon = document.createElement("span");
      icon.className = "engine-card-icon material-icons";
      icon.textContent = entry.icon;

      const body = document.createElement("div");
      body.className = "engine-card-body";
      const nameRow = document.createElement("div");
      nameRow.className = "engine-card-name";
      const name = document.createElement("span");
      name.textContent = translate(`settings.engine.${rowCopyKey(entry)}.name`);
      nameRow.appendChild(name);
      if (entry.recommended) {
        const tag = document.createElement("span");
        tag.className = "engine-tag-ok";
        tag.textContent = translate("settings.engine.recommended");
        nameRow.appendChild(tag);
      }
      if (entry.experimental) {
        const tag = document.createElement("span");
        tag.className = "engine-tag-muted";
        tag.textContent = translate("settings.engine.experimental");
        nameRow.appendChild(tag);
      }
      const desc = document.createElement("div");
      desc.className = "engine-card-desc";
      desc.textContent = translate(`settings.engine.${rowCopyKey(entry)}.description`);
      body.appendChild(nameRow);
      body.appendChild(desc);

      const status = engineStatus(statusEntry);
      const statusEl = document.createElement("span");
      statusEl.className = `engine-card-status${status.tone ? ` engine-status-${status.tone}` : ""}`;
      statusEl.textContent = active ? translate("settings.engine.activeModel", { model: engineTargetLabel(currentSettings) }) : translate(status.key);

      card.append(check, icon, body, statusEl);
      card.addEventListener("click", () => void chooseSettingsEngine(rowChoice(entry)));

      const chevron = document.createElement("span");
      chevron.className = "engine-card-chevron material-icons";
      chevron.textContent = "expand_more";
      chevron.setAttribute("aria-hidden", "true");
      const disclosure = document.createElement("button");
      disclosure.type = "button";
      disclosure.className = "engine-disclosure";
      disclosure.id = `engine-disclosure-${entry.value}`;
      disclosure.setAttribute("aria-controls", `engine-drawer-${entry.value}`);
      disclosure.setAttribute("aria-label", translate("settings.engine.details", { model: name.textContent }));
      disclosure.appendChild(chevron);
      disclosure.addEventListener("click", () => inspectEngine(rowChoice(entry), { toggle: true }));
      // The row's own padding counts as the row, not as a dead strip.
      row.addEventListener("click", (event) => {
        if (event.target === row) void chooseSettingsEngine(rowChoice(entry));
      });
      const drawer = document.createElement("div");
      drawer.id = `engine-drawer-${entry.value}`;
      drawer.className = "engine-drawer";
      drawer.hidden = true;
      drawer.setAttribute("role", "region");
      drawer.setAttribute("aria-labelledby", card.id);
      if (entry.value === LOCAL_QWEN_PROVIDER) {
        const picker = document.createElement("div");
        picker.id = "qwenSizePicker";
        picker.className = "qwen-size-picker";
        drawer.appendChild(picker);
      }
      row.append(card, disclosure);
      host.append(row, drawer);
    });
  arrangeEngineRows(host, rows, selected);
  renderQwenSizePicker();
  syncEngineDrawer();
  renderEngineActivation();
}

// Main rows first, then "More engines" and the rows behind it. An engine in
// use from the more group is shown with the main rows, so it is never hidden.
function arrangeEngineRows(host, rows, selected) {
  const inUse = engineRowFor(selected);
  const main = rows.filter((entry) => entry.group === "main" || entry.value === inUse);
  const more = rows.filter((entry) => !main.includes(entry));
  let toggle = document.getElementById("engineMoreToggle");
  if (!toggle) {
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.id = "engineMoreToggle";
    toggle.className = "engine-more-toggle";
    toggle.addEventListener("click", () => {
      engineMoreExpanded = !engineMoreExpanded;
      if (!engineMoreExpanded && ENGINE_CARDS.find((card) => card.value === engineRowFor(expandedEngineProvider))?.group === "more") {
        expandedEngineProvider = null;
      }
      renderEngineCards();
    });
  }
  const desired = [];
  const place = (entry, hidden) => {
    const row = document.getElementById(`engine-choice-${entry.value}`)?.parentElement;
    const drawer = document.getElementById(`engine-drawer-${entry.value}`);
    if (!row || !drawer) return;
    row.hidden = hidden;
    if (hidden) drawer.hidden = true;
    desired.push(row, drawer);
  };
  main.forEach((entry) => place(entry, false));
  toggle.hidden = more.length === 0;
  toggle.setAttribute("aria-expanded", String(engineMoreExpanded));
  const caret = document.createElement("span");
  caret.className = "material-icons";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "chevron_right";
  const label = document.createElement("span");
  label.className = "engine-more-label";
  label.textContent = translate("settings.engine.more");
  const names = document.createElement("span");
  names.className = "engine-more-names";
  names.textContent = more.map((entry) => translate(`settings.engine.${rowCopyKey(entry)}.name`)).join(" · ");
  toggle.replaceChildren(caret, label, names);
  desired.push(toggle);
  more.forEach((entry) => place(entry, !engineMoreExpanded));
  // Move only what is out of place: re-inserting a drawer that holds the
  // focused key field would blur it mid-typing.
  desired.forEach((node, index) => {
    if (host.children[index] !== node) host.insertBefore(node, host.children[index] || null);
  });
}

function qwenSizeBadge(choice) {
  const status = localModelStatuses.get(localModelForProvider(choice));
  if (choice === providerForSettings(currentSettings)) return translate("settings.engine.qwenSize.inUse");
  if (status?.state === "ready") return translate("settings.engine.qwenSize.ready");
  if (status?.state === "downloading") {
    const percent = status.totalBytes ? Math.floor(100 * (status.downloadedBytes || 0) / status.totalBytes) : 0;
    return translate("settings.engine.qwenSize.downloading", { percent });
  }
  return translate("settings.engine.qwenSize.absent");
}

function formatWait(seconds) {
  return seconds === null
    ? translate("settings.engine.qwenSize.waitUnknown")
    : translate("settings.engine.qwenSize.waitValue", { seconds: seconds < 10 ? seconds.toFixed(1) : Math.round(seconds) });
}

// The two Qwen sizes inside the Qwen drawer, with what each costs here and,
// when this machine is fast enough, a nudge towards 1.7B.
function renderQwenSizePicker() {
  const picker = document.getElementById("qwenSizePicker");
  if (!picker) return;
  const active = providerForSettings(currentSettings);
  const inspected = qwenChoice();
  const label = document.createElement("div");
  label.className = "qwen-size-label";
  label.textContent = translate("settings.engine.qwenSize.label");
  const options = document.createElement("div");
  options.className = "qwen-size-options";
  QWEN_CHOICES.forEach((choice) => {
    const spec = QWEN_SIZE_SPECS[choice];
    const button = document.createElement("button");
    button.type = "button";
    button.id = `qwen-size-${choice}`;
    button.className = `qwen-size-option${choice === active ? " in-use" : ""}`;
    button.setAttribute("aria-pressed", String(choice === inspected));
    button.disabled = engineSwitchPending;
    const head = document.createElement("span");
    head.className = "qwen-size-head";
    const name = document.createElement("strong");
    name.textContent = spec.label;
    const note = document.createElement("span");
    note.className = "qwen-size-note";
    note.textContent = translate(spec.noteKey);
    const badge = document.createElement("span");
    badge.className = "qwen-size-badge";
    badge.textContent = qwenSizeBadge(choice);
    head.append(name, note, badge);
    const specs = document.createElement("dl");
    specs.className = "qwen-size-specs";
    [
      ["settings.engine.qwenSize.download", spec.download],
      ["settings.engine.qwenSize.memory", spec.memory],
      ["settings.engine.qwenSize.wait", formatWait(qwenWaitEstimate(qwenSpeed, localModelForProvider(choice)))],
    ].forEach(([key, value]) => {
      const term = document.createElement("dt");
      term.textContent = translate(key);
      const detail = document.createElement("dd");
      detail.textContent = value;
      specs.append(term, detail);
    });
    button.append(head, specs);
    button.addEventListener("click", () => void chooseQwenSize(choice));
    options.appendChild(button);
  });
  const children = [label, options];
  const activeModel = isQwenChoice(active) ? localModelForProvider(active) : "";
  const advice = qwenSizeAdvice(qwenSpeed, activeModel, localModelStatuses.get(QWEN_LARGE_LOCAL_MODEL)?.state);
  if (advice) {
    const hint = document.createElement("div");
    hint.className = `qwen-size-hint${advice === "slow" ? " slow" : ""}`;
    const text = document.createElement("p");
    text.textContent = advice === "slow"
      ? translate("settings.engine.qwenSize.slow", { seconds: formatSeconds(qwenWaitEstimate(qwenSpeed, QWEN_LARGE_LOCAL_MODEL)) })
      : translate("settings.engine.qwenSize.suggest");
    const action = document.createElement("button");
    action.type = "button";
    action.id = "qwenSizeHintAction";
    action.className = "btn";
    action.disabled = engineSwitchPending;
    action.textContent = translate(advice === "slow" ? "settings.engine.qwenSize.slowAction" : "settings.engine.qwenSize.suggestAction");
    action.addEventListener("click", () => void chooseQwenSize(advice === "slow" ? LOCAL_QWEN_PROVIDER : LOCAL_QWEN_LARGE_PROVIDER));
    hint.append(text, action);
    children.push(hint);
  }
  picker.replaceChildren(...children);
}

function formatSeconds(seconds) {
  return seconds === null ? "?" : seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
}

// Picking a size. A downloaded size switches at once while Qwen is in use,
// like a cloud engine's model pick; otherwise it waits for the row click. A
// missing size starts downloading and, when Qwen is in use, takes over once
// the download finishes (unless another engine was chosen meanwhile).
async function chooseQwenSize(choice) {
  if (engineSwitchPending) return;
  const model = localModelForProvider(choice);
  const state = localModelStatuses.get(model)?.state;
  const active = providerForSettings(currentSettings);
  const qwenInUse = isQwenChoice(active);
  inspectEngine(choice);
  if (state === "ready") {
    if (qwenInUse && choice !== active) await activateEngine({ provider: "local", model });
    return;
  }
  if (state === "absent" || state === "partial") {
    await handleLocalModelAction({ switchWhenReady: qwenInUse });
  }
}

function syncEngineDrawer() {
  const expanded = expandedEngineProvider;
  // Both Qwen sizes open the Qwen row's drawer.
  const expandedRow = engineRowFor(expanded);
  for (const entry of ENGINE_CARDS) {
    const panel = document.getElementById(`engine-drawer-${entry.value}`);
    if (panel) panel.hidden = entry.value !== expandedRow;
    document.getElementById(`engine-disclosure-${entry.value}`)
      ?.setAttribute("aria-expanded", String(entry.value === expandedRow));
  }
  const local = !!localModelForProvider(expanded);
  const drawer = document.getElementById(`engine-drawer-${expandedRow}`);
  if (!drawer) return;
  // These nodes are shared by every drawer and follow whichever one is open.
  // Each goes in before a later one already here, so their order never depends
  // on which drawers were opened before. Nodes already here stay put: moving
  // the focused key field would blur it mid-typing.
  const place = (ids) => ids.forEach((id, index) => {
    const node = document.getElementById(id);
    if (!node || node.parentElement === drawer) return;
    const next = ids.slice(index + 1)
      .map((later) => document.getElementById(later))
      .find((later) => later?.parentElement === drawer);
    drawer.insertBefore(node, next || null);
  });
  if (local) {
    place(["engineAdvanced", "engineActivation"]);
    const advanced = document.getElementById("engineAdvanced");
    if (advanced) advanced.open = true;
  } else {
    place(["apiKeyItem", "modelItem", "engineActivation"]);
  }
}

function camelKey(providerValue) {
  return providerValue.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function localModelForProvider(provider) {
  if (provider === LOCAL_QWEN_LARGE_PROVIDER) return QWEN_LARGE_LOCAL_MODEL;
  if (provider === LOCAL_NEMOTRON_PROVIDER) {
    return NEMOTRON_LOCAL_MODEL;
  }
  if (provider === LOCAL_QWEN_PROVIDER) {
    return QWEN_LOCAL_MODEL;
  }
  return "";
}

function providerForSettings(settings) {
  if (settings?.provider !== "local") {
    return settings?.provider || "groq";
  }
  if (settings.model === QWEN_LARGE_LOCAL_MODEL) return LOCAL_QWEN_LARGE_PROVIDER;
  return settings.model === NEMOTRON_LOCAL_MODEL
    ? LOCAL_NEMOTRON_PROVIDER
    : LOCAL_QWEN_PROVIDER;
}

// Nemotron is wired for Apple Silicon and Windows x64. On other build targets it
// is not merely "not downloaded yet" — it cannot run. Drop the option instead
// of letting it be picked. This is a compile-time constant per build
// (`nemotronSupported`), so removing the node once is enough.
function applyNemotronAvailability() {
  if (currentSettings.nemotronSupported) {
    return;
  }
  document
    .querySelector(`#providerSelect option[value="${LOCAL_NEMOTRON_PROVIDER}"]`)
    ?.remove();
  document.getElementById("nemotronLatencyItem")?.classList.add("hidden");
}

// Reuse the same key inputs so switching modes never loses an unsaved key.
function toggleProviderFields(providerChoice) {
  const provider = localModelForProvider(providerChoice) ? "local" : providerChoice;
  const isLocal = provider === "local";
  const advanced = document.getElementById("engineAdvanced");
  advanced?.classList.toggle("hidden", !isLocal && !inspectedLocalModel);

  const apiKeyItem = document.getElementById("apiKeyItem");
  const modelItem = document.getElementById("modelItem");
  const nemotronLatencyItem = document.getElementById("nemotronLatencyItem");
  const fieldGroq = document.getElementById("apiKeyFieldGroq");
  const fieldOpenAI = document.getElementById("apiKeyFieldOpenAI");
  if (!fieldGroq || !fieldOpenAI) {
    return;
  }

  const title = document.getElementById("apiKeyTitle");
  const description = document.getElementById("apiKeyDescription");
  if (title) title.textContent = translate("settings.apiKey.title");
  if (description) description.textContent = translate("settings.apiKey.description");

  // Language is a shared setting for the active engine, not the inspected card.
  // Qwen ignores it; Nemotron and cloud requests carry the saved value.
  const activeProvider = providerForSettings(currentSettings);
  const isQwen = [LOCAL_QWEN_PROVIDER, LOCAL_QWEN_LARGE_PROVIDER].includes(activeProvider);
  const languageSelect = document.getElementById("languageSelect");
  if (languageSelect) {
    languageSelect.disabled = isQwen;
  }
  // Qwen has nothing to choose here, so the whole row goes rather than sitting
  // there with a note and no control.
  document.getElementById("languageSettingItem")?.classList.toggle("hidden", isQwen);
  document.getElementById("languageLocalNote")?.classList.toggle("hidden", !isQwen);
  document.getElementById("languageDescription")?.classList.toggle("hidden", isQwen);
  document.getElementById("languageControl")?.classList.toggle("hidden", isQwen);

  // A local engine needs no key.
  apiKeyItem?.classList.toggle("hidden", isLocal);
  modelItem?.classList.toggle("hidden", isLocal);
  const configurationProvider = inspectedLocalModel
    ? providerForSettings({ provider: "local", model: inspectedLocalModel })
    : providerChoice;
  nemotronLatencyItem?.classList.toggle("hidden", configurationProvider !== LOCAL_NEMOTRON_PROVIDER);
  // GPU acceleration applies to the Qwen engine only: Nemotron runs on its
  // own runtime, and platforms without a GPU pack have nothing to switch.
  document
    .getElementById("localComputeItem")
    ?.classList.toggle(
      "hidden",
      !gpuRuntimeSupported || ![LOCAL_QWEN_PROVIDER, LOCAL_QWEN_LARGE_PROVIDER].includes(configurationProvider)
    );
  fieldGroq.classList.toggle("hidden", provider !== "groq");
  fieldOpenAI.classList.toggle("hidden", provider !== "openai");
  syncEngineDrawer();
}

// --- Local model panel (provider "local") ---
const localModelStatuses = new Map();
const localModelStatusRequests = new Map();
// Size of the selected local model, for the delete confirmation.
let localModelTotalBytes = 0;
let localModelState = "absent"; // absent | partial | downloading | ready
// Whether the running download was started from this Settings page. Gates the
// "switch to local?" prompt on ready: a download driven by the onboarding
// onboarding wizard auto-switches there, so Settings must not show a second,
// competing dialog.
let localModelDownloadStartedHere = "";
let inspectedLocalModel = null;
let localModelSyncBound = false;
let updatesPanelBound = false;
let currentAppVersion = "";
let diagnosticLogPanelBound = false;
let diagnosticLogLoaded = false;
let diagnosticLogLoading = false;
let currentDiagnosticLog = null;

function formatGB(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function selectedLocalModel() {
  const provider = document.getElementById("providerSelect")?.value;
  return inspectedLocalModel || localModelForProvider(provider) || QWEN_LOCAL_MODEL;
}

function renderLocalModelPanel(status) {
  // The Qwen card reports the same state, so re-render it whenever this does.
  window.setTimeout(renderEngineCards, 0);
  const item = document.getElementById("localModelItem");
  const statusEl = document.getElementById("localModelStatus");
  const actionBtn = document.getElementById("localModelActionBtn");
  const deleteBtn = document.getElementById("localModelDeleteBtn");
  const progressEl = document.getElementById("localModelProgress");
  if (!item || !statusEl || !actionBtn || !deleteBtn || !progressEl) {
    return;
  }
  localModelState = status.state;
  localModelTotalBytes = status.totalBytes || 0;
  const provider = document.getElementById("providerSelect")?.value;
  item.classList.toggle("hidden", !inspectedLocalModel && !localModelForProvider(provider));
  const advanced = document.getElementById("engineAdvanced");
  if (advanced) {
    const visible = !!inspectedLocalModel || !!localModelForProvider(provider);
    advanced.classList.toggle("hidden", !visible);
    if (visible && status.state !== "ready") advanced.open = true;
  }


  const pct = status.totalBytes ? status.downloadedBytes / status.totalBytes : 0;
  progressEl.value = Math.round(pct * 1000);
  progressEl.classList.toggle("hidden", status.state !== "downloading");
  // Also offered in the "partial" state: an interrupted download leaves up to
  // ~1 GB of .part files behind, and resuming is not the only way out of it.
  const isPartial = status.state === "partial";
  deleteBtn.classList.toggle("hidden", status.state !== "ready" && !isPartial);
  deleteBtn.textContent = translate(
    isPartial ? "settings.localModel.deletePartial" : "settings.localModel.delete"
  );

  if (status.state === "unsupported") {
    statusEl.textContent = translate("settings.localModel.statusUnsupported");
    actionBtn.classList.add("hidden");
    deleteBtn.classList.add("hidden");
  } else if (status.state === "ready") {
    statusEl.textContent = translate("settings.localModel.statusReady", {
      size: formatGB(status.totalBytes),
    });
    actionBtn.classList.add("hidden");
  } else if (status.state === "downloading") {
    statusEl.textContent = translate("settings.localModel.statusDownloading", {
      done: formatGB(status.downloadedBytes),
      total: formatGB(status.totalBytes),
    });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate("settings.localModel.cancel");
  } else {
    statusEl.textContent =
      status.state === "partial"
        ? translate("settings.localModel.statusPartial")
        : translate("settings.localModel.statusAbsent", { total: formatGB(status.totalBytes) });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate(
      status.state === "partial" ? "settings.localModel.resume" : "settings.localModel.download"
    );
  }
}

async function refreshLocalModelStatus() {
  if (!ipc) return;
  void ipc.invoke("get-local-speed").then((speed) => {
    qwenSpeed = speed || {};
    renderQwenSizePicker();
  }).catch(() => {});
  const models = new Set([selectedLocalModel()]);
  for (const option of document.getElementById("providerSelect")?.options || []) {
    const model = localModelForProvider(option.value);
    if (model) models.add(model);
  }
  await Promise.all([...models].map(async (model) => {
    const request = (localModelStatusRequests.get(model) || 0) + 1;
    localModelStatusRequests.set(model, request);
    try {
      const status = await ipc.invoke("get-local-model-status", model);
      if (localModelStatusRequests.get(model) !== request) return;
      localModelStatuses.set(model, status);
      if (model === selectedLocalModel()) renderLocalModelPanel(status);
    } catch (error) {
      if (localModelStatusRequests.get(model) !== request) return;
      localModelStatuses.set(model, { state: "unknown" });
      console.error("Failed to fetch local model status:", model, error);
    }
  }));
  renderEngineCards();
}

async function handleLocalModelAction({ switchWhenReady = false } = {}) {
  try {
    if (localModelState === "downloading") {
      localModelDownloadStartedHere = "";
      await ipc.invoke("cancel-local-model-download");
      return; // terminal event repaints the panel
    }
    // Optimistic repaint, then kick the (long-running) download; progress
    // events keep the panel live. Errors surface via the "error" event too.
    const model = selectedLocalModel();
    localModelDownloadStartedHere = model;
    renderLocalModelPanel({ state: "downloading", downloadedBytes: 0, totalBytes: 1 });
    void refreshLocalModelStatus();
    await ipc.invoke("download-local-model", model, switchWhenReady);
  } catch (error) {
    console.error("Local model download failed:", error);
  }
}

async function handleLocalModelDelete() {
  const confirmKey =
    localModelState === "partial"
      ? "settings.localModel.deletePartialConfirm"
      : "settings.localModel.deleteConfirm";
  if (!confirm(translate(confirmKey, { size: formatGB(localModelTotalBytes) }))) {
    return;
  }
  try {
    await ipc.invoke("delete-local-model", selectedLocalModel());
    await refreshLocalModelStatus();
  } catch (error) {
    console.error("Failed to delete local model:", error);
  }
}

function setupLocalModelSync() {
  if (localModelSyncBound || !ipc) {
    return;
  }
  localModelSyncBound = true;
  ipc.on("local-model-download-progress", (_event, payload) => {
    if (!payload) {
      return;
    }
    const model = payload.model || selectedLocalModel();
    localModelStatusRequests.set(model, (localModelStatusRequests.get(model) || 0) + 1);
    if (payload.state === "downloading") {
      localModelStatuses.set(model, payload);
      renderEngineCards();
    } else {
      void refreshLocalModelStatus();
    }
    if (payload.state === "ready") {
      // A download requested with "use it when ready" has switched the engine
      // in the backend just before this event; show the engine now in use.
      void queueSettingsOperation(refreshSettingsSnapshot).then(renderEngineCards, () => {});
    }
    if (payload.model && payload.model !== selectedLocalModel()) {
      return;
    }
    if (payload.state === "error") {
      alert(translate("settings.localModel.downloadFailed", { reason: payload.message || "" }));
    }
    if (payload.state === "downloading") {
      renderLocalModelPanel({
        state: "downloading",
        downloadedBytes: payload.downloadedBytes || 0,
        totalBytes: payload.totalBytes || 0,
      });
    } else {
      // ready/cancelled/error: re-derive the real on-disk state.
      void refreshLocalModelStatus();
    }
    if (payload.state === "ready" && localModelDownloadStartedHere === selectedLocalModel()) {
      localModelDownloadStartedHere = "";
      renderEngineActivation();
    }
  });

}

// --- GPU acceleration panel (local Qwen engine) ---
// The GPU runtime is an optional ~33 MB pack fetched on demand: the required
// runtime is CPU-only, and which backend runs is decided by which pack the
// process is started from, not by a flag. Qwen only — Nemotron ships its own
// runtime and is unaffected by this setting.
let gpuRuntimeSupported = false;
let gpuRuntimeState = "absent"; // absent | downloading | ready
let gpuRuntimeStatus = null;
let gpuRuntimeSyncBound = false;

function formatMB(bytes) {
  return `${Math.round((bytes || 0) / 1024 / 1024)} MB`;
}

function renderLocalComputePanel(status) {
  const statusEl = document.getElementById("localComputeStatus");
  const select = document.getElementById("localComputeSelect");
  const actionBtn = document.getElementById("localComputeActionBtn");
  const deleteBtn = document.getElementById("localComputeDeleteBtn");
  const progressEl = document.getElementById("localComputeProgress");
  if (!statusEl || !select || !actionBtn || !deleteBtn || !progressEl) {
    return;
  }
  gpuRuntimeState = status.state;

  const pct = status.totalBytes ? status.downloadedBytes / status.totalBytes : 0;
  progressEl.value = Math.round(pct * 1000);
  progressEl.classList.toggle("hidden", status.state !== "downloading");
  deleteBtn.classList.toggle("hidden", status.state !== "ready");
  deleteBtn.textContent = translate("settings.localCompute.delete");
  actionBtn.classList.add("hidden");

  if (status.state === "downloading") {
    statusEl.textContent = translate("settings.localCompute.statusDownloading", {
      done: formatMB(status.downloadedBytes),
      total: formatMB(status.totalBytes),
    });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate("settings.localCompute.cancel");
    return;
  }
  // The copy follows the control the user is looking at, not the saved value:
  // the select can be ahead of the config until Save.
  if (select.value !== "gpu") {
    statusEl.textContent = translate("settings.localCompute.statusCpu");
    return;
  }
  if (status.state !== "ready") {
    statusEl.textContent = translate("settings.localCompute.statusAbsent", {
      total: formatMB(status.totalBytes),
    });
    actionBtn.classList.remove("hidden");
    actionBtn.textContent = translate(
      status.downloadedBytes > 0
        ? "settings.localCompute.retry"
        : "settings.localCompute.download"
    );
    return;
  }
  if (status.fellBack) {
    statusEl.textContent = translate("settings.localCompute.statusFellBack");
    return;
  }
  // An installed pack that lists no device is the "no driver / unusable GPU"
  // case — say so, because the transcription silently runs on the CPU.
  statusEl.textContent = status.devices?.length
    ? translate("settings.localCompute.statusReady", { device: status.devices[0] })
    : translate("settings.localCompute.statusNoDevice");
}

async function refreshGpuRuntimeStatus() {
  if (!ipc || !gpuRuntimeSupported) {
    return;
  }
  try {
    const status = await ipc.invoke("get-gpu-runtime-status");
    // The status reports the pack size as sizeBytes; progress events use
    // totalBytes. Normalize here so the panel has one shape to render.
    gpuRuntimeStatus = { ...status, totalBytes: status.sizeBytes };
    renderLocalComputePanel(gpuRuntimeStatus);
  } catch (error) {
    console.error("Failed to fetch GPU runtime status:", error);
  }
}

async function handleGpuRuntimeAction() {
  try {
    if (gpuRuntimeState === "downloading") {
      await ipc.invoke("cancel-gpu-runtime-download");
      return; // the terminal event repaints the panel
    }
    renderLocalComputePanel({
      ...(gpuRuntimeStatus || {}),
      state: "downloading",
      downloadedBytes: 0,
      totalBytes: gpuRuntimeStatus?.totalBytes || 1,
    });
    await ipc.invoke("download-gpu-runtime");
  } catch (error) {
    console.error("GPU runtime download failed:", error);
  }
}

async function handleGpuRuntimeDelete() {
  if (!confirm(translate("settings.localCompute.deleteConfirm"))) {
    return;
  }
  try {
    await ipc.invoke("delete-gpu-runtime");
    // The backend also rewrites a saved "gpu" back to "auto"; mirror it here so
    // the form cannot save the removed backend straight back in.
    const select = document.getElementById("localComputeSelect");
    if (select?.value === "gpu") {
      select.value = "auto";
    }
    currentSettings.localCompute = "auto";
    await refreshGpuRuntimeStatus();
    void renderBuildLine();
    renderEngineCards();
  } catch (error) {
    console.error("Failed to remove the GPU runtime:", error);
  }
}

// Picking the GPU with nothing installed is a request to install it — the
// setting on its own would save and then quietly keep running on the CPU.
function handleLocalComputeChange() {
  const select = document.getElementById("localComputeSelect");
  if (select?.value === "gpu" && gpuRuntimeState === "absent") {
    void handleGpuRuntimeAction();
    return;
  }
  renderLocalComputePanel(
    gpuRuntimeStatus || { state: gpuRuntimeState, downloadedBytes: 0, totalBytes: 0, devices: [] }
  );
}

function setupGpuRuntimeSync() {
  if (gpuRuntimeSyncBound || !ipc) {
    return;
  }
  gpuRuntimeSyncBound = true;
  ipc.on("local-gpu-runtime-progress", (_event, payload) => {
    if (!payload) {
      return;
    }
    if (payload.state === "error") {
      alert(translate("settings.localCompute.downloadFailed", { reason: payload.message || "" }));
    }
    if (payload.state === "downloading") {
      renderLocalComputePanel({
        state: "downloading",
        downloadedBytes: payload.downloadedBytes || 0,
        totalBytes: payload.totalBytes || 0,
        devices: [],
      });
    } else {
      // ready/cancelled/error/absent: re-derive the real on-disk state.
      void refreshGpuRuntimeStatus();
    }
  });
}

function revealLocalModelPanel(model = QWEN_LOCAL_MODEL) {
  // Inspect/download without selecting an engine that is not yet usable.
  inspectEngine(providerForSettings({ provider: "local", model }));
  const advanced = document.getElementById("engineAdvanced");
  if (advanced) advanced.open = true;
  void refreshLocalModelStatus();
  window.setTimeout(() => {
    document.getElementById("localModelItem")?.scrollIntoView({ block: "center" });
  }, 0);
}

function renderUpdateStatus(status) {
  const statusEl = document.getElementById("updateStatus");
  const checkBtn = document.getElementById("checkUpdatesBtn");
  const installBtn = document.getElementById("installUpdateBtn");
  if (!statusEl || !checkBtn || !installBtn) {
    return;
  }

  const state = status?.state || "idle";
  const version = status?.version || "";
  statusEl.title = "";
  checkBtn.disabled = state === "checking" || state === "downloading";
  checkBtn.classList.toggle("hidden", state === "ready" || state === "storeManaged");
  installBtn.classList.toggle("hidden", state !== "ready");

  if (state === "checking") {
    statusEl.textContent = translate("settings.updates.checking");
  } else if (state === "downloading") {
    statusEl.textContent = translate("settings.updates.downloading", { version });
  } else if (state === "ready") {
    statusEl.textContent = translate("settings.updates.ready", { version });
  } else if (state === "error") {
    // The updater's own message is technical and can run to a paragraph; it
    // stays in the tooltip and the log.
    statusEl.textContent = translate("settings.updates.error");
    statusEl.title = status?.message || "";
  } else if (state === "upToDate") {
    statusEl.textContent = translate("settings.updates.upToDate", { version: currentAppVersion });
  } else if (state === "storeManaged") {
    // The Microsoft Store build: the Store installs new versions itself.
    statusEl.textContent = translate("settings.updates.storeManaged", { version: currentAppVersion });
  } else {
    statusEl.textContent = currentAppVersion ? `v${currentAppVersion}` : "";
  }
}

async function refreshUpdateStatus() {
  try {
    renderUpdateStatus(await ipc.invoke("get-update-status"));
  } catch {
    renderUpdateStatus({ state: "idle" });
  }
}

async function setupUpdatesPanel() {
  if (updatesPanelBound || !ipc) {
    return;
  }
  updatesPanelBound = true;

  ipc.on("update-status", (_event, payload) => {
    if (payload) {
      renderUpdateStatus(payload);
    }
  });

  document.getElementById("checkUpdatesBtn")?.addEventListener("click", async () => {
    try {
      renderUpdateStatus(await ipc.invoke("check-for-updates"));
    } catch (error) {
      renderUpdateStatus({ state: "error", message: String(error) });
    }
  });

  document.getElementById("installUpdateBtn")?.addEventListener("click", async () => {
    try {
      await ipc.invoke("install-update-and-restart");
    } catch (error) {
      renderUpdateStatus({ state: "error", message: String(error) });
    }
  });

  try {
    // Dev-channel builds show the local build counter alongside the version;
    // official CI builds stay a clean "1.6.1". Remote versions in the
    // downloading/ready strings are untouched.
    const info = await ipc.invoke("get-build-info");
    currentAppVersion =
      info.channel === "official" ? info.version : `${info.version} · dev.${info.buildNumber}`;
  } catch {
    currentAppVersion = "";
  }
  await refreshUpdateStatus();
}

function formatDiagnosticLogSize(bytes) {
  const size = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function renderDiagnosticLog(result) {
  const contentElement = document.getElementById("diagnosticLogContent");
  const statusElement = document.getElementById("diagnosticLogStatus");
  const copyButton = document.getElementById("copyDiagnosticLogBtn");
  if (!contentElement || !statusElement || !copyButton) {
    return;
  }

  currentDiagnosticLog = result;
  const content = typeof result?.content === "string" ? result.content : "";
  contentElement.value = content;
  copyButton.disabled = !content;
  if (!content) {
    statusElement.textContent = translate("settings.diagnostics.empty");
    return;
  }

  const language = currentSettings?.uiLanguage;
  const locale = language === "zh" ? "zh-CN" : language === "en" ? "en-US" : undefined;
  const modifiedAt = Number(result.modifiedAtUnixMs);
  const time = modifiedAt > 0 ? new Date(modifiedAt).toLocaleString(locale) : "—";
  statusElement.textContent = translate(
    result.truncated ? "settings.diagnostics.truncated" : "settings.diagnostics.loaded",
    {
      size: formatDiagnosticLogSize(Number(result.sizeBytes)),
      time,
    }
  );
}

async function refreshDiagnosticLog() {
  if (!ipc || diagnosticLogLoading) {
    return;
  }

  const statusElement = document.getElementById("diagnosticLogStatus");
  const refreshButton = document.getElementById("refreshDiagnosticLogBtn");
  const copyButton = document.getElementById("copyDiagnosticLogBtn");
  diagnosticLogLoading = true;
  if (statusElement) {
    statusElement.textContent = translate("settings.diagnostics.loading");
  }
  if (refreshButton) {
    refreshButton.disabled = true;
  }
  if (copyButton) {
    copyButton.disabled = true;
  }

  try {
    const result = await ipc.invoke("get-diagnostic-log");
    diagnosticLogLoaded = true;
    renderDiagnosticLog(result);
  } catch (error) {
    if (statusElement) {
      statusElement.textContent = translate("settings.diagnostics.loadError", {
        message: String(error),
      });
    }
  } finally {
    diagnosticLogLoading = false;
    if (refreshButton) {
      refreshButton.disabled = false;
    }
    if (copyButton) {
      copyButton.disabled = !document.getElementById("diagnosticLogContent")?.value;
    }
  }
}

async function copyDiagnosticLog() {
  const content = document.getElementById("diagnosticLogContent")?.value || "";
  const statusElement = document.getElementById("diagnosticLogStatus");
  if (!content || !statusElement) {
    return;
  }

  try {
    await ipc.invoke("copy-to-clipboard", content, null);
    statusElement.textContent = translate("settings.diagnostics.copied");
  } catch (error) {
    statusElement.textContent = translate("settings.diagnostics.copyError", {
      message: String(error),
    });
  }
}

async function refreshUsagePreview() {
  const contentElement = document.getElementById("usagePreviewContent");
  const statusElement = document.getElementById("usagePreviewStatus");
  if (!ipc || !contentElement || !statusElement) {
    return;
  }
  try {
    const preview = await ipc.invoke("get-usage-preview");
    const batch = Array.isArray(preview?.batch) ? preview.batch : [];
    if (!preview?.enabled) {
      contentElement.value = "";
      statusElement.textContent = translate("settings.usageStats.previewOff");
      return;
    }
    if (!batch.length) {
      contentElement.value = "";
      statusElement.textContent = translate("settings.usageStats.previewEmpty");
      return;
    }
    const text = JSON.stringify({ endpoint: preview.endpoint, batch }, null, 2);
    contentElement.value = text;
    statusElement.textContent = translate("settings.usageStats.previewLoaded", {
      count: batch.length,
      size: formatDiagnosticLogSize(new TextEncoder().encode(JSON.stringify(batch)).length),
    });
  } catch (error) {
    statusElement.textContent = translate("settings.diagnostics.loadError", {
      message: String(error),
    });
  }
}

function setupUsagePreviewPanel() {
  const panel = document.getElementById("usagePreviewPanel");
  if (!panel || panel.dataset.bound) {
    return;
  }
  panel.dataset.bound = "1";
  panel.addEventListener("toggle", () => {
    if (panel.open) void refreshUsagePreview();
  });
  document.getElementById("refreshUsagePreviewBtn")?.addEventListener("click", () => {
    void refreshUsagePreview();
  });
  // Turning statistics off deletes the local counts; show that right away.
  // The page-level change handler queues the save after this listener runs.
  document.getElementById("usageStatsCheck")?.addEventListener("change", () => {
    if (!panel.open) return;
    window.setTimeout(() => {
      void Promise.resolve(saveSettings.pending).then(refreshUsagePreview);
    }, 0);
  });
}

function setupDiagnosticLogPanel() {
  if (diagnosticLogPanelBound) {
    return;
  }
  const panel = document.getElementById("diagnosticLogPanel");
  if (!panel) {
    return;
  }

  panel.addEventListener("toggle", () => {
    if (panel.open && !diagnosticLogLoaded) {
      void refreshDiagnosticLog();
    }
  });
  document.getElementById("refreshDiagnosticLogBtn")?.addEventListener("click", () => {
    void refreshDiagnosticLog();
  });
  document.getElementById("copyDiagnosticLogBtn")?.addEventListener("click", () => {
    void copyDiagnosticLog();
  });
  diagnosticLogPanelBound = true;

  if (panel.open) {
    void refreshDiagnosticLog();
  }
}

function toggleKeyReveal(button) {
  const input = document.getElementById(button.getAttribute("data-target"));
  if (!input) {
    return;
  }
  const reveal = input.type === "password";
  input.type = reveal ? "text" : "password";
  button.textContent = reveal ? "visibility_off" : "visibility";
  const label = translate(reveal ? "settings.apiKey.hide" : "settings.apiKey.reveal");
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

// Settings commit as they are changed — there is no draft to keep. The Home
// engine switcher always wrote through immediately (set_provider), so the page
// and the switcher used to disagree about what "changed" meant; now they don't.
let saveStatusTimer = null;

function showSaveStatus(state, message) {
  const element = document.getElementById("saveStatus");
  if (!element) {
    return;
  }
  window.clearTimeout(saveStatusTimer);
  element.textContent = message;
  element.classList.toggle("save-status-error", state === "error");
  element.classList.toggle("save-status-ok", state === "ok");
  if (state === "ok") {
    // A confirmation only has to be caught out of the corner of the eye; a
    // failure stays until the next attempt says otherwise.
    saveStatusTimer = window.setTimeout(() => {
      element.textContent = "";
      element.classList.remove("save-status-ok");
    }, 1600);
  }
}

// Text inputs commit on blur, but a key pasted and left alone should not sit
// unsaved either — hence a debounce on top.
let commitTimer = null;

function commitSoon(delayMs = 700) {
  window.clearTimeout(commitTimer);
  commitTimer = window.setTimeout(() => {
    commitTimer = null;
    void saveSettings();
  }, delayMs);
}

function commitNow() {
  window.clearTimeout(commitTimer);
  commitTimer = null;
  void saveSettings();
}

function setSelectValue(element, value, fallback) {
  if (!element) {
    return;
  }

  const hasOption = Array.from(element.options).some((option) => option.value === value);
  element.value = hasOption ? value : fallback;
}

function inspectEngine(providerChoice, { toggle = false } = {}) {
  const select = document.getElementById("providerSelect");
  if (!select || !Array.from(select.options).some((option) => option.value === providerChoice)) return;
  if (toggle && expandedEngineProvider === providerChoice) {
    expandedEngineProvider = null;
    syncEngineDrawer();
    return;
  }
  if (expandedEngineProvider !== providerChoice) engineActivationMessage = "";
  expandedEngineProvider = providerChoice;
  if (ENGINE_CARDS.find((card) => card.value === providerChoice)?.group === "more") engineMoreExpanded = true;
  const previousChoice = select.value;
  const modelSelect = document.getElementById("modelSelect");
  if (modelOptions[previousChoice]?.some((option) => option.value === modelSelect?.value)) {
    engineCloudDrafts.set(previousChoice, modelSelect.value);
  }
  select.value = providerChoice;
  inspectedLocalModel = localModelForProvider(providerChoice) || null;
  if (!inspectedLocalModel) {
    // The engine in use shows its real model; drafts are for the others.
    const candidate = currentSettings.provider === providerChoice
      ? activeModelChoice()
      : engineCloudDrafts.get(providerChoice) || "";
    updateModelOptions(providerChoice);
    if (candidate) setSelectValue(modelSelect, candidate, modelSelect?.options[0]?.value || "");
  }
  toggleProviderFields(providerChoice);
  renderEngineCards();
  void refreshLocalModelStatus();
}

function handleProviderChange(event) {
  inspectEngine(event.target.value || "groq");
}

function handleThemeChange(event) {
  applyTheme(event.target.value);
}

function handleUiLanguageChange(event) {
  setLanguage(event.target.value);
  applyI18n(document);
  if (currentDiagnosticLog) {
    renderDiagnosticLog(currentDiagnosticLog);
  }
  void checkMicrophonePermissionStatus();
  void checkAccessibilityStatus();
  void refreshUpdateStatus();
}

function activateSettingsTab(tabName, focus = false) {
  const target = SETTINGS_TABS.includes(tabName) ? tabName : "dictation";
  activeSettingsTab = target;

  document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
    const active = tab.getAttribute("data-settings-tab") === target;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) {
      tab.focus();
    }
  });

  document.querySelectorAll(".settings-panel").forEach((panel) => {
    const active = panel.id === `settings-panel-${target}`;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function handleSettingsTabClick(event) {
  activateSettingsTab(event.currentTarget.getAttribute("data-settings-tab"));
}

function handleSettingsTabKeydown(event) {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") {
    return;
  }
  event.preventDefault();
  const current = SETTINGS_TABS.indexOf(activeSettingsTab);
  let next = current;
  if (event.key === "ArrowRight") {
    next = (current + 1) % SETTINGS_TABS.length;
  } else if (event.key === "ArrowLeft") {
    next = (current - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
  } else if (event.key === "Home") {
    next = 0;
  } else if (event.key === "End") {
    next = SETTINGS_TABS.length - 1;
  }
  activateSettingsTab(SETTINGS_TABS[next], true);
}

function bindEventHandlers() {
  if (pageEventsBound) {
    return;
  }

  watchSystemTheme();

  const providerSelect = document.getElementById("providerSelect");
  const checkPermissionButton = document.getElementById("checkPermission");
  const checkAccessibilityButton = document.getElementById("checkAccessibility");
  const uiLanguageSelect = document.getElementById("uiLanguageSelect");
  const themeSelect = document.getElementById("themeSelect");

  providerSelect?.addEventListener("change", handleProviderChange);
  document.getElementById("modelSelect")?.addEventListener("change", handleModelChange);
  checkPermissionButton?.addEventListener("click", () => {
    void requestMicrophonePermission();
  });
  document.getElementById("recheckPermissions")?.addEventListener("click", () => {
    void recheckPermissions();
  });
  document.getElementById("openDictionaryBtn")?.addEventListener("click", () => {
    // Dictation is where you configure a dictation; the dictionary is part of
    // that, even though its editor is its own page.
    window.showPage?.("dictionary");
  });
  document.getElementById("revealAppForAccessibility")?.addEventListener("click", () => {
    void ipc.invoke("reveal-app-in-finder").catch((error) => {
      console.error("Failed to reveal the app:", error);
    });
  });
  document.getElementById("revealAppBtn")?.addEventListener("click", () => {
    void ipc.invoke("reveal-app-in-finder").catch((error) => {
      console.error("Failed to reveal the app:", error);
    });
  });
  checkAccessibilityButton?.addEventListener("click", () => {
    void handleAccessibilityPermission();
  });
  uiLanguageSelect?.addEventListener("change", handleUiLanguageChange);
  themeSelect?.addEventListener("change", handleThemeChange);

  document.querySelectorAll(".reveal-btn").forEach((button) => {
    button.addEventListener("click", () => toggleKeyReveal(button));
  });

  document.getElementById("localModelActionBtn")?.addEventListener("click", () => {
    void handleLocalModelAction();
  });
  document.getElementById("localComputeActionBtn")?.addEventListener("click", () => {
    void handleGpuRuntimeAction();
  });
  document.getElementById("localComputeDeleteBtn")?.addEventListener("click", () => {
    void handleGpuRuntimeDelete();
  });
  document
    .getElementById("localComputeSelect")
    ?.addEventListener("change", handleLocalComputeChange);
  document.getElementById("localModelDeleteBtn")?.addEventListener("click", () => {
    void handleLocalModelDelete();
  });

  // Only edits inside Settings commit. History search and the dictionary live
  // in the same main window and must not trigger a settings write.
  const settingsPage = document.querySelector("#settings-page");
  settingsPage?.addEventListener("change", commitNow);
  for (const id of ["apiKeyGroq", "apiKeyOpenAI"]) {
    document.getElementById(id)?.addEventListener("input", () => renderEngineCards());
  }
  settingsPage?.addEventListener("input", (event) => {
    // Selects and checkboxes already fired `change`; only free text needs the
    // debounce, and re-committing on every keystroke would rewrite the config
    // file per character.
    if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
      commitSoon();
    }
  });
  settingsPage?.addEventListener(
    "blur",
    (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") {
        commitNow();
      }
    },
    true
  );

  // Permission state can change while another main-window page is active or
  // while System Settings is in front. Refresh quietly whenever the app comes
  // back; the debounced gated recheck stays for the guided flow, where the TCC
  // grant can land a beat after refocus.
  window.addEventListener("focus", () => {
    void refreshAccessibilityQuietly();
    scheduleAccessibilityRecheck();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refreshAccessibilityQuietly();
      scheduleAccessibilityRecheck();
    }
  });

  // The backend broadcasts every real Accessibility state change (wizard
  // grant, main-window rechecks), so re-render without waiting for the next
  // visit to Settings.
  ipc.on("microphone-status-changed", () => {
    void checkMicrophonePermissionStatus();
  });
  document.getElementById("openWindowsMicrophoneSettings")?.addEventListener("click", async () => {
    try { await ipc.invoke("open-microphone-settings"); await checkMicrophonePermissionStatus(); }
    catch {
      document.getElementById("permissionStatus").textContent = translate("microphoneAccess.settingsFailed");
    }
  });

  ipc.on("accessibility-permission-changed", () => {
    void refreshAccessibilityQuietly();
  });

  document.querySelectorAll("[data-settings-tab]").forEach((tab) => {
    tab.addEventListener("click", handleSettingsTabClick);
    tab.addEventListener("keydown", handleSettingsTabKeydown);
  });

  pageEventsBound = true;
}

// Permissions are install-time state, not a setting anyone returns to. When
// both are granted the two rows collapse into one line; the moment one is
// missing they expand again, with the button that fixes it.
const permissionState = { microphone: null, accessibility: null };
let microphoneProbeBusy = false;
let microphoneRefreshVersion = 0;

function renderPermissionSummary() {
  const allGranted =
    permissionState.microphone === true && permissionState.accessibility === true;
  document.getElementById("permissionSummary")?.classList.toggle("hidden", !allGranted);
  for (const id of ["permissionStatus", "accessibilityStatus"]) {
    document
      .getElementById(id)
      ?.closest(".setting-item")
      ?.classList.toggle("hidden", allGranted);
  }
}

function renderAccessibilityStatus(result) {
  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return;
  }

  let ok = false;
  if (!result) {
    statusElement.textContent = translate("settings.permission.error");
    statusElement.className = "permission-status denied";
  } else if (result.granted) {
    statusElement.textContent = translate("settings.accessibility.granted");
    statusElement.className = "permission-status granted";
    ok = true;
  } else if (result.status === "not_required") {
    statusElement.textContent = translate("settings.accessibility.notRequired");
    statusElement.className = "permission-status granted";
    ok = true;
  } else {
    statusElement.textContent = translate("settings.accessibility.denied");
    statusElement.className = "permission-status denied";
  }

  // Once granted there's nothing to act on, so hide the check button.
  document.getElementById("checkAccessibility")?.classList.toggle("hidden", ok);
  // The Finder route matters only while the grant is missing: a TypeAloud row
  // that never appears in the Accessibility list is fixed by dragging the app in.
  document.getElementById("accessibilityRevealRow")?.classList.toggle("hidden", ok);
  permissionState.accessibility = ok;
  renderPermissionSummary();
}

function scheduleAccessibilityRecheck() {
  if (!pendingAccessibilityRecheck) {
    return;
  }

  if (accessibilityRecheckTimer) {
    window.clearTimeout(accessibilityRecheckTimer);
  }

  accessibilityRecheckTimer = window.setTimeout(() => {
    accessibilityRecheckTimer = null;
    pendingAccessibilityRecheck = false;
    void recheckAccessibilityPermission();
  }, 400);
}

async function requestAccessibilityPermission() {
  if (!ipc) {
    return null;
  }

  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return null;
  }

  try {
    statusElement.textContent = translate("settings.accessibility.rechecking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("request-accessibility-permission");
    renderAccessibilityStatus(result);
    return result;
  } catch (error) {
    console.error("Failed to request accessibility permission:", error);
    renderAccessibilityStatus(null);
    return null;
  }
}

async function handleAccessibilityPermission() {
  const result = await requestAccessibilityPermission();
  if (!result || result.granted || result.status === "not_required") {
    return;
  }

  try {
    pendingAccessibilityRecheck = true;
    await ipc.invoke("show-permission-dialog");
  } catch (error) {
    pendingAccessibilityRecheck = false;
    console.error("Failed to open accessibility settings:", error);
  }

  // Same as the Home guide: the drag cloud appears with the deep-link, not
  // later, because a missing row in the list is exactly when it is needed. A dev
  // bare binary has no .app bundle, so the backend declines and returns false.
  ipc.invoke("show-ax-cloud").catch((error) => {
    console.error("Failed to show the drag cloud:", error);
  });
}

function setupShortcutSync() {
  if (shortcutSyncBound || !ipc) {
    return;
  }

  shortcutSyncBound = true;
  ipc.on("shortcut-updated", (_event, payload) => {
    if (!payload || !payload.recordShortcut) {
      return;
    }

    const shortcutSelect = document.getElementById("shortcutSelect");
    setSelectValue(shortcutSelect, payload.recordShortcut, "Ctrl+Shift");
  });
}

function setupThemeSync() {
  if (themeSyncBound || !ipc) {
    return;
  }

  themeSyncBound = true;
  ipc.on("ui-theme-updated", (_event, payload) => {
    if (!payload) {
      return;
    }

    applyTheme(payload.theme);
    setSelectValue(document.getElementById("themeSelect"), normalizeThemePref(payload.theme), "elegant");
  });
}

async function recheckPermissions() {
  const button = document.getElementById("recheckPermissions");
  const feedback = document.getElementById("permissionRecheckFeedback");
  if (!button || !feedback || button.disabled) return;
  button.disabled = true;
  button.textContent = translate("settings.permission.checking");
  feedback.textContent = translate("settings.permission.checking");
  feedback.setAttribute("aria-busy", "true");
  try {
    const [microphone, accessibility] = await Promise.all([
      currentSettings?.os === "windows" ? requestMicrophonePermission() : checkMicrophonePermissionStatus(), checkAccessibilityStatus(),
    ]);
    const failed = microphone == null || accessibility == null;
    const granted = microphone && (accessibility?.granted || accessibility?.status === "not_required");
    feedback.textContent = translate(`settings.permissions.${
      failed ? "checkFailed" : granted ? "checked" : "needsAttention"
    }`);
  } catch {
    feedback.textContent = translate("settings.permissions.checkFailed");
  } finally {
    button.disabled = false;
    button.textContent = translate("settings.permissions.recheck");
    feedback.setAttribute("aria-busy", "false");
  }
}

async function checkMicrophonePermissionStatus() {
  const version = ++microphoneRefreshVersion;
  if (!ipc) {
    return;
  }

  const statusElement = document.getElementById("permissionStatus");
  if (!statusElement) {
    return;
  }

  const micButton = document.getElementById("checkPermission");
  try {
    statusElement.textContent = translate("settings.permission.checking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("check-microphone-permission");
    if (version !== microphoneRefreshVersion) return permissionState.microphone;
    const status = result.status;
    let ok = false;

    if (currentSettings?.os === "windows") {
      const value = ["granted", "denied", "unavailable", "error"].includes(status) ? status : "unknown";
      ok = value === "granted";
      statusElement.textContent = translate(`microphoneAccess.${value}`);
      statusElement.className = `permission-status ${ok ? "granted" : value === "unknown" ? "unknown" : "denied"}`;
      if (micButton) {
        micButton.textContent = translate(microphoneProbeBusy ? "microphoneAccess.checking" : "microphoneAccess.check");
        micButton.disabled = microphoneProbeBusy;
      }
      const settingsButton = document.getElementById("openWindowsMicrophoneSettings");
      if (settingsButton) settingsButton.hidden = value !== "denied";
    } else if (status === "granted") {
      statusElement.textContent = translate("settings.permission.granted");
      statusElement.className = "permission-status granted";
      ok = true;
    } else if (status === "not-determined") {
      statusElement.textContent = translate("settings.permission.notDetermined");
      statusElement.className = "permission-status";
    } else if (status === "restricted") {
      statusElement.textContent = translate("settings.permission.restricted");
      statusElement.className = "permission-status denied";
    } else {
      statusElement.textContent = translate("settings.permission.denied");
      statusElement.className = "permission-status denied";
    }
    micButton?.classList.toggle("hidden", ok);
    permissionState.microphone = ok;
    renderPermissionSummary();
    return ok;
  } catch (error) {
    if (version !== microphoneRefreshVersion) return permissionState.microphone;
    console.error("Failed to check microphone permission:", error);
    statusElement.textContent = translate("settings.permission.error");
    statusElement.className = "permission-status denied";
    micButton?.classList.remove("hidden");
    permissionState.microphone = false;
    renderPermissionSummary();
    return null;
  }
}

async function requestMicrophonePermission() {
  if (microphoneProbeBusy) return;
  microphoneProbeBusy = true;
  const button = document.getElementById("checkPermission");
  if (button) button.disabled = true;
  try {
    if (currentSettings?.os === "windows") {
      await window.SayTypeMicrophone.probe(ipc, "windows");
    } else {
      const current = await ipc.invoke("check-microphone-permission");
      if (current?.status === "denied" || current?.status === "restricted") {
        await ipc.invoke("open-microphone-settings");
      } else if (
        current?.status !== "granted" &&
        navigator.mediaDevices?.getUserMedia
      ) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
      }
    }
  } catch (error) {
    console.warn("Microphone permission action failed:", error);
  } finally {
    microphoneProbeBusy = false;
    if (button) button.disabled = false;
  }
  return await checkMicrophonePermissionStatus();
}

async function checkAccessibilityStatus() {
  if (!ipc) {
    return null;
  }

  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return null;
  }

  try {
    statusElement.textContent = translate("settings.permission.checking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("check-accessibility-permission");
    renderAccessibilityStatus(result);
    return result;
  } catch (error) {
    console.error("Failed to check accessibility permission:", error);
    renderAccessibilityStatus(null);
    return null;
  }
}

// Same full recheck (backend state sync + hotkey restart on grant), but
// without the "rechecking…" placeholder write — safe to run on every focus /
// broadcast without making the status line flicker. Errors keep whatever is
// currently shown rather than degrading it to the error state.
async function refreshAccessibilityQuietly() {
  if (!ipc) {
    return;
  }
  try {
    renderAccessibilityStatus(await ipc.invoke("recheck-accessibility-permission"));
  } catch (error) {
    console.error("Failed to refresh accessibility permission:", error);
  }
}

async function recheckAccessibilityPermission() {
  if (!ipc) {
    return null;
  }

  const statusElement = document.getElementById("accessibilityStatus");
  if (!statusElement) {
    return null;
  }

  try {
    statusElement.textContent = translate("settings.accessibility.rechecking");
    statusElement.className = "permission-status";

    const result = await ipc.invoke("recheck-accessibility-permission");
    renderAccessibilityStatus(result);
    return result;
  } catch (error) {
    console.error("Failed to recheck accessibility permission:", error);
    renderAccessibilityStatus(null);
    return null;
  }
}

// The About row mirrors the sidebar's build string; dev builds carry the
// counter and provenance, official builds are a bare version.
async function renderBuildLine() {
  const element = document.getElementById("settingsBuildLine");
  if (!element) {
    return;
  }
  try {
    const info = await ipc.invoke("get-build-info");
    if (!info) {
      return;
    }
    const parts = [`TypeAloud ${info.version}`];
    if (info.channel !== "official") {
      parts.push(`dev.${info.buildNumber}`);
      parts.push(`${info.gitHash}${info.gitDirty ? " (dirty)" : ""}`);
    }
    element.textContent = parts.join(" · ");
  } catch (error) {
    console.error("Failed to read build info:", error);
  }
}

async function loadSettings() {
  await initializeDependencies();

  try {
    inspectedLocalModel = null;
    currentSettings = await ipc.invoke("get-settings");
    // Raw API keys come from a dedicated command — get_settings never ships
    // them to general readers. The main window fetches them only because it now
    // owns the Settings editor; input-prompt and other windows stay blocked.
    // Shares fate with the get-settings call above: if the config is readable
    // for one it is for the other, so this won't leave the key fields blank
    // (which a subsequent Save would persist as cleared keys).
    const apiKeys = await ipc.invoke("get-api-keys");
    initI18n(currentSettings.uiLanguage);
    applyTheme(currentSettings.uiTheme);

    const provider = currentSettings.provider || "groq";
    const providerChoice = providerForSettings(currentSettings);
    const providerSelect = document.getElementById("providerSelect");
    const shortcutSelect = document.getElementById("shortcutSelect");
    const uiLanguageSelect = document.getElementById("uiLanguageSelect");
    const themeSelect = document.getElementById("themeSelect");
    const languageSelect = document.getElementById("languageSelect");
    const modelSelect = document.getElementById("modelSelect");
    const nemotronLatencySelect = document.getElementById("nemotronLatencySelect");
    const autoLaunchCheck = document.getElementById("autoLaunchCheck");
    const startMinimizedCheck = document.getElementById("startMinimizedCheck");
    const mergeSpelledLettersCheck = document.getElementById("mergeSpelledLettersCheck");
    const removeFillerWordsCheck = document.getElementById("removeFillerWordsCheck");
    const apiKeyGroq = document.getElementById("apiKeyGroq");
    const apiKeyOpenAI = document.getElementById("apiKeyOpenAI");

    // Captured out of the payload: saveSettings replaces currentSettings with
    // the form values, which carry no backend-reported capability flags.
    gpuRuntimeSupported = !!currentSettings.gpuRuntimeSupported;
    setSelectValue(
      document.getElementById("localComputeSelect"),
      currentSettings.localCompute || "auto",
      "auto"
    );
    applyNemotronAvailability();
    inspectedLocalModel = null;
    engineCloudDrafts.clear();
    setSelectValue(providerSelect, providerChoice, "groq");
    expandedEngineProvider = providerSelect?.value || providerChoice;
    if (provider !== "local") {
      updateModelOptions(provider);
    }
    // Read back from the select: a stored choice this build can't offer (e.g. a
    // Nemotron config carried to an unsupported build) landed on the
    // fallback, and the dependent fields must follow what is on screen.
    toggleProviderFields(providerSelect?.value || providerChoice);

    if (apiKeyGroq) {
      apiKeyGroq.value = apiKeys.apiKeyGroq || apiKeys.apiKey || "";
    }
    if (apiKeyOpenAI) {
      apiKeyOpenAI.value = apiKeys.apiKeyOpenAI || "";
    }

    setSelectValue(shortcutSelect, currentSettings.shortcut || "Ctrl+Shift", "Ctrl+Shift");
    setSelectValue(uiLanguageSelect, currentSettings.uiLanguage || "auto", "auto");
    setSelectValue(themeSelect, normalizeThemePref(currentSettings.uiTheme), "elegant");
    setSelectValue(languageSelect, currentSettings.language || "auto", "auto");
    setSelectValue(
      nemotronLatencySelect,
      String(currentSettings.nemotronLatencyMs || 560),
      "560"
    );
    if (provider !== "local") {
      setSelectValue(modelSelect, currentSettings.model, modelSelect?.options[0]?.value || "");
    }

    if (autoLaunchCheck) {
      autoLaunchCheck.checked = !!currentSettings.autoLaunch;
    }
    if (startMinimizedCheck) {
      startMinimizedCheck.checked = !!currentSettings.startMinimized;
    }
    if (mergeSpelledLettersCheck) {
      mergeSpelledLettersCheck.checked = currentSettings.mergeSpelledLetters !== false;
    }
    if (removeFillerWordsCheck) {
      removeFillerWordsCheck.checked = currentSettings.removeFillerWords !== false;
    }
    const usageStatsCheck = document.getElementById("usageStatsCheck");
    if (usageStatsCheck) {
      usageStatsCheck.checked = currentSettings.usageStats !== false;
    }

    renderSettingChoices();
    await refreshLocalModelStatus();
    await refreshGpuRuntimeStatus();
    await Promise.all([
      checkMicrophonePermissionStatus(),
      checkAccessibilityStatus(),
    ]);

  } catch (error) {
    console.error("Failed to load settings:", error);
    initI18n("auto");
    applyTheme("elegant");
  }
}

let engineSwitchPending = false;
// The { provider, model } the running save is applying, while it runs.
let engineSwitchTarget = null;
let engineActivationMessage = "";
// A model picked in the active cloud engine while a save was running, kept as
// the exact { provider, model } so opening another drawer cannot change it.
let queuedModelChoice = null;

function inspectedEngineTarget() {
  const choice = document.getElementById("providerSelect")?.value || providerForSettings(currentSettings);
  const localModel = localModelForProvider(choice);
  return {
    provider: localModel ? "local" : choice,
    model: localModel || document.getElementById("modelSelect")?.value || "",
  };
}

function engineTargetLabel(target) {
  if (target.provider !== "local") {
    const labels = {
      "whisper-large-v3": "settings.engine.whisperLarge",
      "whisper-large-v3-turbo": "settings.engine.whisperTurbo",
      "gpt-transcribe": "settings.engine.gptTranscribe",
    };
    return labels[target.model] ? translate(labels[target.model]) : target.model;
  }
  const key = providerForSettings(target).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  return translate(`settings.engine.${key}.name`);
}

// The drawer's activation panel carries what switching means (cloud upload),
// why the last attempt failed, and what an unusable engine still needs.
function renderEngineActivation() {
  const panel = document.getElementById("engineActivation");
  if (!panel) return;
  const target = inspectedEngineTarget();
  const notice = document.getElementById("engineCloudNotice");
  if (notice) notice.hidden = target.provider === "local";
  const message = document.getElementById("engineActivationStatus");
  const text = engineActivationMessage || engineReadinessHint();
  if (message) message.textContent = text;
  panel.hidden = target.provider === "local" && !text;
}

// An opened engine that is not usable yet is not in use either. Say so, and
// what the next click needs, so an open drawer is not mistaken for a choice.
function engineReadinessHint() {
  const choice = document.getElementById("providerSelect")?.value;
  if (!choice || choice === providerForSettings(currentSettings)) return "";
  // With Qwen in use, the size picker already shows what the other size needs.
  if (isQwenChoice(choice) && isQwenChoice(providerForSettings(currentSettings))) return "";
  const entry = ENGINE_CARDS.find((card) => card.value === choice);
  if (!entry) return "";
  const status = engineStatus(entry);
  if (status.tone === "ok" || status.key === "settings.permission.checking") return "";
  const model = translate(`settings.engine.${camelKey(choice)}.name`);
  return translate(entry.local ? "settings.engine.notReadyDownload" : "settings.engine.notReadyKey", { model });
}

// A model picked inside the active cloud engine's drawer applies at once, like
// every other setting. For an inactive engine it stays a candidate until that
// row is chosen. The last pick wins: one made while a save is still running is
// queued and applied when that save ends.
function handleModelChange() {
  const target = inspectedEngineTarget();
  // The engine in use, or the one a running save is switching to.
  const activeProvider = target.provider !== "local"
    && (target.provider === currentSettings.provider || target.provider === engineSwitchTarget?.provider);
  if (activeProvider && engineSwitchPending) {
    queuedModelChoice = target;
    return;
  }
  if (activeProvider && target.model !== currentSettings.model) {
    void activateEngine(target);
    return;
  }
  renderEngineActivation();
}

// The model the active engine's drawer should show: the latest pick waiting to
// be saved, then the pick being saved, then the model in use. Showing an older
// model would swallow a click on it, since picking the selected choice is a
// no-op.
function activeModelChoice() {
  const provider = currentSettings.provider;
  if (queuedModelChoice?.provider === provider) return queuedModelChoice.model;
  if (engineSwitchTarget?.provider === provider) return engineSwitchTarget.model;
  return currentSettings.model;
}

// After a save, the open drawer of the engine in use shows what was actually
// saved, including after a failure that left the engine unchanged.
function syncActiveModelChoice() {
  const select = document.getElementById("modelSelect");
  const choice = document.getElementById("providerSelect")?.value;
  if (!select || choice !== currentSettings.provider) return;
  const model = activeModelChoice();
  if (select.value === model) return;
  setSelectValue(select, model, select.options[0]?.value || "");
  renderSettingChoices();
}

async function activateEngine(target) {
  if (engineSwitchPending) return false;
  const intent = { provider: target.provider, model: target.model };
  engineSwitchPending = true;
  engineSwitchTarget = intent;
  engineActivationMessage = "";
  renderEngineActivation();
  try {
    return await queueSettingsSave(intent);
  } finally {
    engineSwitchPending = false;
    engineSwitchTarget = null;
    // Replay a pick queued during this save only while its engine is still the
    // one in use; the pick carries its own target, whichever drawer is open.
    const queued = queuedModelChoice;
    queuedModelChoice = null;
    const replay = queued && queued.provider === currentSettings.provider && queued.model !== currentSettings.model;
    if (!replay) syncActiveModelChoice();
    renderEngineCards();
    if (replay) void activateEngine(queued);
  }
}

async function saveSettings() {
  return queueSettingsSave(null);
}

function queueSettingsSave(intent) {
  // Ordinary saves read the latest active engine only when their turn runs.
  // Explicit activation carries an immutable intent rather than reading the UI later.
  return queueSettingsOperation(() => persistSettings(intent));
}

function queueSettingsOperation(operation) {
  const pending = (saveSettings.pending || Promise.resolve()).then(operation);
  // A failed external mutation must reject its caller without poisoning the queue.
  saveSettings.pending = pending.catch(() => {});
  return pending;
}

async function refreshSettingsSnapshot() {
  const snapshot = await ipc.invoke("get-settings");
  if (!snapshot || typeof snapshot.provider !== "string" || typeof snapshot.model !== "string") {
    throw new Error("Could not refresh active engine settings");
  }
  currentSettings = { ...currentSettings, ...snapshot };
  saveSettings.snapshotNeedsRefresh = false;
}

function runEngineChange(change) {
  // Enqueue the debounced edit before the external mutation, never after it.
  let flushed = null;
  if (commitTimer !== null) {
    window.clearTimeout(commitTimer);
    commitTimer = null;
    if (settingsInitialized) flushed = queueSettingsSave(null);
  }
  return queueSettingsOperation(async () => {
    if (flushed && await flushed === false) throw new Error("Could not save pending settings");
    await initializeDependencies();
    await refreshSettingsSnapshot();
    // If the mutation succeeds but its refresh fails, a later save must retry
    // the read instead of restoring the engine from a stale Settings snapshot.
    saveSettings.snapshotNeedsRefresh = true;
    try {
      return await change({ ...currentSettings });
    } finally {
      await refreshSettingsSnapshot();
      engineActivationMessage = "";
      if (settingsInitialized) renderEngineCards();
    }
  });
}

async function persistSettings(intent = null) {
  try {
    await initializeDependencies();
    if (saveSettings.snapshotNeedsRefresh) await refreshSettingsSnapshot();
    const previous = { provider: currentSettings.provider, model: currentSettings.model };
    const target = intent || previous;
    if (intent) {
      // Selection records intent; model availability is checked before dictation.
      if (target.provider !== "local") {
        const options = modelOptions[target.provider];
        if (!options?.some((option) => option.value === target.model)) throw new Error(translate("settings.engine.invalidModel"));
        const keyId = target.provider === "openai" ? "apiKeyOpenAI" : "apiKeyGroq";
        if (!document.getElementById(keyId)?.value.trim()) throw new Error(translate("settings.engine.keyRequired"));
      }
    }
    const themeSelect = document.getElementById("themeSelect");
    const settings = {
      apiKeyGroq: document.getElementById("apiKeyGroq")?.value || "",
      apiKeyOpenAI: document.getElementById("apiKeyOpenAI")?.value || "",
      shortcut: document.getElementById("shortcutSelect")?.value || "Ctrl+Shift",
      language: document.getElementById("languageSelect")?.value || "auto",
      uiLanguage: document.getElementById("uiLanguageSelect")?.value || "auto",
      uiTheme: normalizeThemePref(themeSelect ? themeSelect.value : "elegant"),
      model: target.model,
      microphone: currentSettings.microphone,
      autoLaunch: !!document.getElementById("autoLaunchCheck")?.checked,
      startMinimized: !!document.getElementById("startMinimizedCheck")?.checked,
      mergeSpelledLetters: document.getElementById("mergeSpelledLettersCheck")?.checked
        ?? currentSettings.mergeSpelledLetters !== false,
      removeFillerWords: document.getElementById("removeFillerWordsCheck")?.checked
        ?? currentSettings.removeFillerWords !== false,
      usageStats: document.getElementById("usageStatsCheck")?.checked
        ?? currentSettings.usageStats !== false,
      provider: target.provider,
      localCompute: document.getElementById("localComputeSelect")?.value || "auto",
      nemotronLatencyMs: Number(
        document.getElementById("nemotronLatencySelect")?.value || 560
      ),
    };

    const saved = await ipc.invoke("save-settings", settings);
    if (saved === false) throw new Error(translate("settings.saveError"));
    currentSettings = { ...currentSettings, ...settings };
    toggleProviderFields(document.getElementById("providerSelect")?.value || providerForSettings(currentSettings));
    if (intent) {
      engineActivationMessage = "";
    }
    showSaveStatus("ok", translate("settings.saved"));
    renderEngineCards();
    return true;
  } catch (error) {
    console.error("Failed to save settings:", error);
    if (intent) engineActivationMessage = `${translate("settings.engine.switchFailed")} ${error.message || error}`;
    showSaveStatus("error", translate("settings.saveError"));
    renderEngineActivation();
    return false;
  }
}

async function initializeSettingsPage() {
  if (settingsInitialized) {
    return;
  }

  await initializeDependencies();
  bindEventHandlers();
  setupShortcutSync();
  setupThemeSync();
  setupLocalModelSync();
  setupGpuRuntimeSync();
  setupDiagnosticLogPanel();
  setupUsagePreviewPanel();
  void setupUpdatesPanel();
  await loadSettings();
  activateSettingsTab(activeSettingsTab);
  settingsInitialized = true;
  document.documentElement.setAttribute("data-settings-bootstrap-complete", "1");
}

async function showSettings(target = null) {
  const wasInitialized = settingsInitialized;
  try {
    await initializeSettingsPage();
    if (wasInitialized) {
      await saveSettings.pending;
      await loadSettings();
    }

    if (typeof target === "string" && target.startsWith("engine:")) {
      activateSettingsTab("dictation");
      inspectEngine(target.slice("engine:".length));
      return;
    }

    if (target === "engines-more") {
      activateSettingsTab("dictation");
      engineMoreExpanded = true;
      renderEngineCards();
      document.getElementById("engineMoreToggle")?.scrollIntoView({ block: "center" });
      return;
    }

    if (typeof target === "string" && target.startsWith("local-model")) {
      activateSettingsTab("dictation");
      const model = target.split(":", 2)[1] || QWEN_LOCAL_MODEL;
      revealLocalModelPanel(model);
      return;
    }

    const resolvedTarget = target === "system" ? "app" : target === "engines" ? "dictation" : target;
    activateSettingsTab(SETTINGS_TABS.includes(resolvedTarget) ? resolvedTarget : activeSettingsTab);
  } catch (error) {
    console.error("Failed to initialize settings page:", error);
    document.documentElement.setAttribute(
      "data-settings-bootstrap-error",
      String(error?.message || error)
    );
  }
}

window.SayTypeSettings = {
  show: showSettings,
  inspectEngine,
  runEngineChange,
  save: saveSettings,
};

document.documentElement.setAttribute("data-settings-handlers-exposed", "1");
})();

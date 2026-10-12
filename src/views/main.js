document.documentElement.setAttribute("data-main-js-ran", "1");

const ipc = window.__SAYTYPE_IPC__;
const { initI18n, setLanguage, applyI18n, t, getLocale, localizeRetryError } = window.SayTypeI18n;

const THEME_PREFS = new Set(["auto", "midnight", "elegant"]);
const RECENT_LIMIT = 12;
let currentThemePref = "elegant";

let onboardingPolicy;
let cachedSettings = null;
let cachedActivities = [];
let historyQuery = "";
let clearConfirming = false;
let clearConfirmTimer = null;

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

// Render each modifier as an OS-appropriate keycap: Apple glyphs on macOS,
// plain words (Ctrl/Shift/Alt/Win|Super) on Windows/Linux. Driven by the backend
// `os` field (get-settings), with a navigator fallback before settings load.
function shortcutKeycaps(shortcut) {
  const os = (cachedSettings?.os || "").toLowerCase();
  const isMac = os ? os === "macos" : /Mac/i.test(navigator.platform || "");
  const metaWord = os === "linux" ? "Super" : "Win";
  const macGlyphs = { ctrl: "⌃", control: "⌃", shift: "⇧", alt: "⌥", option: "⌥", cmd: "⌘", command: "⌘", meta: "⌘", super: "⌘", win: "⌘", windows: "⌘" };
  const textWords = { ctrl: "Ctrl", control: "Ctrl", shift: "Shift", alt: "Alt", option: "Alt", cmd: metaWord, command: metaWord, meta: metaWord, super: metaWord, win: metaWord, windows: metaWord };
  const map = isMac ? macGlyphs : textWords;
  return String(shortcut || "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => map[part.toLowerCase()] || part);
}

function engineReady(settings) {
  // The backend computes this (get_settings no longer ships the raw keys here).
  return !!settings?.engineReady;
}

async function initializeMainPage() {
  // The entry script runs twice (the <script> tag plus the Rust on-page-load
  // injection); guard so listeners and data loads are only wired up once.
  if (window.__sayTypeMainStarted) {
    return;
  }
  window.__sayTypeMainStarted = true;
  onboardingPolicy = await import("./onboarding-layout.mjs");

  try {
    cachedSettings = await ipc.invoke("get-settings");
  } catch (error) {
    console.error("Failed to load settings for i18n:", error);
  }

  initI18n(cachedSettings?.uiLanguage);
  applyTheme(cachedSettings?.uiTheme);

  await loadActivities();
  await loadDictionary();
  await refreshReadiness();

  try {
    const info = await ipc.invoke("get-build-info");
    const element = document.getElementById("appVersion");
    if (element && info) {
      if (info.channel === "official") {
        element.textContent = `v${info.version}`;
      } else {
        // Local build: append the dev counter, provenance in the tooltip.
        element.textContent = `v${info.version} · dev.${info.buildNumber}`;
        const parts = [`${info.gitHash}${info.gitDirty ? " (dirty)" : ""}`];
        if (info.buildTime) {
          parts.push(new Date(info.buildTime * 1000).toLocaleString());
        }
        if (info.debug) {
          parts.push("debug");
        }
        element.title = parts.join(" · ");
      }
    }
  } catch (error) {
    console.error("Failed to load app version", error);
  }

  setupUpdateAffordances();

  bindEvents();

  // First launch (or the flag was never set): take over with the onboarding
  // wizard. Strictly `=== false` so a settings-load error doesn't flash it.
  if (cachedSettings?.onboardingCompleted === false) {
    showOnboarding();
  }
}

function bindEvents() {
  watchSystemTheme();

  // Cmd+, (macOS standard "Preferences" shortcut) opens the Settings page.
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === ",") {
      event.preventDefault();
      openSettings();
    }
  });

  document.getElementById("helpButton")?.addEventListener("click", showHelp);
  document.getElementById("clearHistoryBtn")?.addEventListener("click", handleClearHistory);
  document.getElementById("historySearch")?.addEventListener("input", (event) => {
    historyQuery = event.target.value.trim().toLowerCase();
    renderHistory();
  });

  // Re-check readiness when the window regains focus — the user may have just
  // granted a permission in System Settings or added a key in Settings.
  window.addEventListener("focus", () => {
    void refreshReadiness();
    if (onboardingVisible()) {
      void obRefreshMicState();
    }
  });

  document.getElementById("obNextBtn")?.addEventListener("click", () => obMove(1));
  document.getElementById("obBackBtn")?.addEventListener("click", () => obMove(-1));
  document.getElementById("obStepSkipBtn")?.addEventListener("click", () => obMove(1));
  document.getElementById("obSkipBtn")?.addEventListener("click", () => {
    void finishOnboarding();
  });
  document.getElementById("obKeySaveBtn")?.addEventListener("click", () => {
    void obSaveKey();
  });
  document.getElementById("obKeyInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      void obSaveKey();
    }
  });
  document.getElementById("obMoreToggle")?.addEventListener("click", () => {
    obMoreExpanded = !obMoreExpanded;
    renderObLocal();
  });
  document.getElementById("obUsageStatsCheck")?.addEventListener("change", (event) => {
    void obSetUsageStats(event.target);
  });
  document.getElementById("obResumeBtn")?.addEventListener("click", resumeOnboarding);
  document.getElementById("obTryInput")?.addEventListener("input", renderObPracticeFeedback);
  document.getElementById("obHistoryHint")?.addEventListener("click", () => {
    pauseOnboarding();
    void showPage("history");
  });

  // Download completion updates readiness only; user intent was saved on click.
  ipc.on("local-model-download-progress", (_event, payload) => {
    if (!payload) return;
    const model = normalizeLocalModel(payload.model);
    obLocalVersions[model] = (obLocalVersions[model] || 0) + 1;
    applyEngineDownloadProgress(payload);
    obLocalStatuses[model] = {
      state: payload.state === "cancelled" ? "partial" : payload.state,
      downloadedBytes: payload.downloadedBytes || 0,
      totalBytes: payload.totalBytes || 0,
    };
    obLocalErrors[model] = payload.state === "error" ? (payload.message || t("onboarding.key.downloadFailed")) : "";
    renderHomeLocalReadiness();
    renderObLocal();
    renderObFooter();
    renderObFinal();
    if (payload.state !== "downloading") {
      void refreshReadiness();
      void obRefreshLocalStatus();
    }
  });

  ipc.on("microphone-status-changed", () => {
    void refreshReadiness();
    if (onboardingVisible()) void obRefreshMicState();
  });

  ipc.on("activity-updated", async () => {
    if (onboardingVisible() && obCurrent === "practice") {
      obPracticeActivity = true;
      renderObPracticeFeedback();
    }
    await loadActivities();
  });

  document.addEventListener("click", closeEngineMenu, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeEngineMenu();
  });
  ipc.on("accessibility-permission-changed", (_event, data) => {
    showNotification(data.message, data.granted ? "success" : "warning");
    void refreshReadiness();
  });

  ipc.on("ax-cloud-dismissed", () => {
    // The user closed the drag helper before granting. Leave the "waiting"
    // state so the guide button returns — clicking it re-opens the cloud and
    // System Settings. A late grant is still caught on window refocus.
    stopAxPolling();
    axGuideTimedOut = false;
    void refreshReadiness();
  });

  ipc.on("shortcut-updated", () => {
    void refreshReadiness();
  });

  ipc.on("ui-language-updated", async (_event, payload) => {
    if (!payload) {
      return;
    }
    setLanguage(payload.language);
    applyI18n(document);
    // applyI18n resets the clear button's text via its data-i18n attribute, so
    // drop any in-progress two-step confirm to keep its state consistent.
    resetClearButton();
    await refreshReadiness();
    renderRecent();
    renderHistory();
    renderDictionary();
    if (onboardingVisible()) {
      renderOnboarding();
    }
  });

  ipc.on("ui-theme-updated", (_event, payload) => {
    if (!payload) {
      return;
    }
    applyTheme(payload.theme);
  });

  ipc.on("open-settings-page", (_event, target) => {
    openSettings(typeof target === "string" ? target : null);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void initializeMainPage();
  }, { once: true });
} else {
  void initializeMainPage();
}

/* ---------- Readiness card ---------- */

// Accessibility onboarding: after the user clicks through to System Settings we
// actively poll `recheck` (which restarts the hotkey listener on grant) so the
// flow continues by itself — bounded, so a user who walks away doesn't leave a
// poller running forever. State lives at module level because renderReadiness
// rebuilds the whole card (replaceChildren) on every refresh.
const AX_POLL_INTERVAL_MS = 1000;
const AX_POLL_MAX_MS = 90_000;
let axGuideWaiting = false;
let axGuideTimedOut = false;
let axPollTimer = null;
let axPollDeadline = 0;

let readinessRefreshVersion = 0;
async function refreshReadiness() {
  const version = ++readinessRefreshVersion;
  try {
    const settings = await ipc.invoke("get-settings");
    if (version !== readinessRefreshVersion) return;
    cachedSettings = settings;
  } catch (error) {
    console.error("Failed to load settings:", error);
  }

  const [micOk, axOk] = await Promise.all([checkMicOk(), checkAxOk(), refreshEngineAvailability()]);
  if (version !== readinessRefreshVersion) return;
  if (axOk) {
    stopAxPolling();
    axGuideTimedOut = false;
    // Also covers "granted after the 90s poll stopped": the refocus recheck
    // funnels here. Otherwise the cloud would stay on screen (the poll timeout
    // deliberately leaves it up).
    ipc.invoke("hide-ax-cloud").catch(() => {});
  }
  // Keep the onboarding wizard's Accessibility page in sync — every AX state
  // change (button flow, polling, focus recheck) funnels through here.
  const axWasGranted = obAxGranted;
  obAxGranted = axOk;
  if (!axWasGranted && axOk) {
    obScheduleAdvance("accessibility");
  }
  if (onboardingVisible()) {
    renderObAx();
    renderObLocal();
    renderObFooter();
    renderObFinal();
  }
  renderReadiness({
    hasKey: engineReady(cachedSettings),
    micOk,
    axOk,
    recordShortcut: cachedSettings?.shortcut || "Ctrl+Shift",
  });
}

let homeMicState = "unknown";
let homeMicRefreshVersion = 0;
async function checkMicOk() {
  const version = ++homeMicRefreshVersion;
  try {
    const result = await ipc.invoke("check-microphone-permission");
    if (version === homeMicRefreshVersion) homeMicState = ["granted", "denied", "unavailable", "error"].includes(result.status) ? result.status : "unknown";
    return result.status === "granted";
  } catch (error) {
    console.error("Failed to check microphone permission:", error);
    if (version === homeMicRefreshVersion) homeMicState = "error";
    return false;
  }
}

async function checkAxOk() {
  try {
    // recheck (not the read-only check): it also syncs backend state, so a
    // grant made while this window was away restarts the hotkey listener the
    // moment we refocus. It only emits accessibility-permission-changed on a
    // real change, so the event handler re-entering here can't loop.
    const result = await ipc.invoke("recheck-accessibility-permission");
    return !!result.granted || result.status === "not_required";
  } catch (error) {
    console.error("Failed to check accessibility permission:", error);
    return false;
  }
}

async function startAccessibilityFlow() {
  if (axGuideWaiting) {
    return;
  }
  axGuideTimedOut = false;

  // Prompt first (prompt:true): the one-time system dialog is what pre-adds
  // TypeAloud to the Accessibility list — deep-linking without it lands a
  // first-run user on a list with nothing to toggle.
  try {
    const result = await ipc.invoke("request-accessibility-permission");
    if (result?.granted || result?.status === "not_required") {
      await refreshReadiness();
      return;
    }
  } catch (error) {
    console.error("Failed to request accessibility permission:", error);
  }

  // Then deep-link straight to the Accessibility pane.
  try {
    await ipc.invoke("show-permission-dialog");
  } catch (error) {
    console.error("Failed to open accessibility settings:", error);
  }

  // Appears alongside the deep-link, not on a timeout: a stuck user needs this
  // drag entry point in the first second. A dev bare binary has no .app bundle,
  // so the backend refuses to show it and returns false.
  ipc.invoke("show-ax-cloud").catch((error) => {
    console.error("Failed to show the drag cloud:", error);
  });

  beginAxPolling();
}

function beginAxPolling() {
  stopAxPolling();
  axGuideWaiting = true;
  axPollDeadline = Date.now() + AX_POLL_MAX_MS;
  void refreshReadiness();
  scheduleAxPoll();
}

function scheduleAxPoll() {
  axPollTimer = window.setTimeout(async () => {
    axPollTimer = null;
    let granted = false;
    try {
      const result = await ipc.invoke("recheck-accessibility-permission");
      granted = !!result.granted || result.status === "not_required";
    } catch (error) {
      console.error("Failed to recheck accessibility permission:", error);
    }
    if (!axGuideWaiting) {
      return; // stopped while the recheck was in flight (e.g. a focus refresh saw the grant)
    }
    if (granted) {
      stopAxPolling();
      await refreshReadiness();
      return;
    }
    if (Date.now() >= axPollDeadline) {
      stopAxPolling();
      axGuideTimedOut = true;
      await refreshReadiness();
      return;
    }
    scheduleAxPoll();
  }, AX_POLL_INTERVAL_MS);
}

function stopAxPolling() {
  axGuideWaiting = false;
  if (axPollTimer) {
    window.clearTimeout(axPollTimer);
    axPollTimer = null;
  }
}

// Shown as soon as the user is sent to System Settings (waiting state) and
// kept in the timed-out state, in both the readiness-card guide and the
// wizard's Accessibility page. Covers the one case the prompt+deep-link flow
// can't fix: the user once removed TypeAloud from the Accessibility list, and
// TCC won't reliably re-add the row — dragging the app in from Finder (same
// as clicking "+") always works. Whoever needs this discovers it the moment
// they see a list without TypeAloud in it, so it must not hide behind a delay.
function buildAxRevealRow() {
  const row = document.createElement("div");
  row.className = "ax-reveal-row";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-btn";
  button.textContent = t("readiness.axGuide.revealApp");
  button.addEventListener("click", () => {
    ipc.invoke("reveal-app-in-finder").catch((error) => {
      console.error("Failed to reveal app in Finder:", error);
    });
  });
  row.appendChild(button);
  const hint = document.createElement("span");
  hint.className = "ax-reveal-hint";
  hint.textContent = t("readiness.axGuide.revealHint");
  row.appendChild(hint);
  return row;
}

function makeIcon(name) {
  const icon = document.createElement("span");
  icon.className = "material-icons";
  icon.textContent = name;
  return icon;
}

function keycapRow(shortcut) {
  const group = document.createDocumentFragment();
  shortcutKeycaps(shortcut).forEach((symbol) => {
    const cap = document.createElement("span");
    cap.className = "kbd";
    cap.textContent = symbol;
    group.appendChild(cap);
  });
  return group;
}

function buildPill({ label, ok, onFix, alwaysAction = false, labelId = null }) {
  const pill = document.createElement(ok && !alwaysAction ? "span" : "button");
  pill.className = `pill ${ok ? "ok" : "warn"}`;
  if (!ok || alwaysAction) {
    pill.type = "button";
    if (onFix) {
      pill.addEventListener("click", onFix);
    }
  }
  pill.appendChild(makeIcon(ok ? "check" : "priority_high"));
  const text = document.createElement("span");
  text.textContent = label;
  if (labelId) text.id = labelId;
  pill.appendChild(text);
  return pill;
}

function renderHomeLocalReadiness() {
  const label = document.getElementById("homeLocalModelStatus");
  if (!label || cachedSettings?.provider !== "local") return;
  label.textContent = `${t("readiness.localModel")} · ${obDownloadLabel(cachedSettings.model, engineAvailability.get(selectedEngineValue()))}`;
}

function renderReadiness({ hasKey, micOk, axOk, recordShortcut }) {
  const card = document.getElementById("readiness-card");
  if (!card) {
    return;
  }
  const allReady = hasKey && micOk && axOk;
  card.replaceChildren();
  // With nothing to fix, the card is one line: the full layout said "ready" five
  // ways and pushed Recent halfway down the window.
  card.classList.toggle("compact", allReady);

  const head = document.createElement("div");
  head.className = "readiness-head";

  const iconWrap = document.createElement("div");
  iconWrap.className = "readiness-icon";
  iconWrap.appendChild(makeIcon("mic"));

  const titles = document.createElement("div");
  titles.className = "readiness-titles";
  const title = document.createElement("div");
  title.className = "readiness-title";
  title.textContent = allReady ? t("home.ready") : t("home.setupNeeded");
  const sub = document.createElement("div");
  sub.className = "readiness-sub";
  sub.textContent = allReady ? t("home.readyHint") : t("home.setupHint");
  titles.appendChild(title);
  if (!allReady) titles.appendChild(sub);

  const badge = document.createElement("div");
  badge.className = `readiness-badge ${allReady ? "ok" : "warn"}`;
  badge.appendChild(makeIcon(allReady ? "check" : "priority_high"));
  const badgeText = document.createElement("span");
  badgeText.textContent = allReady ? t("home.readyBadge") : t("home.setupBadge");
  badge.appendChild(badgeText);

  head.appendChild(iconWrap);
  head.appendChild(titles);
  card.appendChild(head);

  const shortcuts = document.createElement("div");
  shortcuts.className = "readiness-shortcuts";
  [
    { label: t("home.dictate"), shortcut: recordShortcut },
  ].forEach(({ label, shortcut }) => {
    const group = document.createElement("span");
    group.className = "shortcut-group";
    const text = document.createElement("span");
    text.textContent = label;
    group.appendChild(text);
    group.appendChild(keycapRow(shortcut));
    shortcuts.appendChild(group);
  });
  if (allReady) {
    head.appendChild(shortcuts);
    head.appendChild(badge);
    renderEngineCard();
    return;
  }
  head.appendChild(badge);
  card.appendChild(shortcuts);

  const divider = document.createElement("div");
  divider.className = "readiness-divider";
  card.appendChild(divider);

  const pills = document.createElement("div");
  pills.className = "readiness-pills";
  const isLocal = cachedSettings?.provider === "local";
  pills.appendChild(
    buildPill({
      label: isLocal
        ? `${t("readiness.localModel")} · ${obDownloadLabel(cachedSettings.model, engineAvailability.get(selectedEngineValue()))}`
        : hasKey
          ? t("readiness.apiKey")
          : t("readiness.addApiKey"),
      ok: hasKey,
      alwaysAction: isLocal,
      labelId: isLocal ? "homeLocalModelStatus" : null,
      onFix: () => openSettings(isLocal ? `local-model:${cachedSettings.model}` : `engine:${cachedSettings?.provider}`),
    })
  );
  pills.appendChild(buildPill({
    label: cachedSettings?.os === "windows" ? t(`microphoneAccess.${homeMicState}`) : t("readiness.microphone"),
    ok: micOk, onFix: () => openSettings("app"),
  }));
  pills.appendChild(
    buildPill({
      label: t("readiness.accessibility"),
      ok: axOk,
      onFix: () => {
        void startAccessibilityFlow();
      },
    })
  );
  card.appendChild(pills);

  if (!axOk) {
    card.appendChild(buildAxGuide());
  }

  renderEngineCard();
}

// Home switches ready engines directly; unavailable engines open setup without mutation.
const QWEN_LOCAL_MODEL = "qwen3-asr-0.6b-q8_0";
const QWEN_LARGE_LOCAL_MODEL = "qwen3-asr-1.7b-q8_0";
const NEMOTRON_LOCAL_MODEL = "nemotron-3.5-asr-streaming-0.6b-q8_0";

// Same order as the Settings engine cards — one list of engines shown in two
// places should not read differently in each.
const ENGINE_OPTIONS = [
  {
    value: "local-qwen",
    labelKey: "home.engineLocalQwen",
    model: QWEN_LOCAL_MODEL,
    recommended: true,
  },
  { value: "local-qwen-large", labelKey: "home.engineLocalQwenLarge", model: QWEN_LARGE_LOCAL_MODEL },
  { value: "openai", label: "OpenAI" },
  { value: "groq", label: "Groq" },
  {
    value: "local-nemotron",
    labelKey: "home.engineLocalNemotron",
    model: NEMOTRON_LOCAL_MODEL,
  },
];

const ENGINE_CAPTION_KEY = {
  groq: "home.engineCaptionGroq",
  openai: "home.engineCaptionOpenai",
  "local-qwen": "home.engineCaptionLocalQwen",
  "local-qwen-large": "home.engineCaptionLocalQwenLarge",
  "local-nemotron": "home.engineCaptionLocalNemotron",
};

// Nemotron is wired for Apple Silicon and Windows x64. Elsewhere the engine is
// not offered at all — a switcher button whose only outcome is an "unsupported"
// download panel is worse than no button. The backend answers for the running
// slice (`nemotronSupported`); renders only happen after settings load.
function nemotronOffered() {
  return !!cachedSettings?.nemotronSupported;
}

function availableEngineOptions() {
  return ENGINE_OPTIONS.filter(
    (option) => option.model !== NEMOTRON_LOCAL_MODEL || nemotronOffered()
  );
}

function normalizeLocalModel(model) {
  if (model === QWEN_LARGE_LOCAL_MODEL) return QWEN_LARGE_LOCAL_MODEL;
  return model === NEMOTRON_LOCAL_MODEL ? NEMOTRON_LOCAL_MODEL : QWEN_LOCAL_MODEL;
}

function localEngineSelected(model) {
  return cachedSettings?.provider === "local" && normalizeLocalModel(cachedSettings.model) === model;
}

function selectedEngineValue() {
  if (cachedSettings?.provider !== "local") {
    return cachedSettings?.provider || "groq";
  }
  if (cachedSettings.model === QWEN_LARGE_LOCAL_MODEL) return "local-qwen-large";
  return normalizeLocalModel(cachedSettings.model) === NEMOTRON_LOCAL_MODEL
    ? "local-nemotron"
    : "local-qwen";
}

// --- Software update: two entry points outside Settings -------------------
// The updater already broadcasts `update-status` (idle | checking | downloading
// | ready | upToDate | error); until now only the Settings page listened, so a
// downloaded build announced itself in the tray — invisible when the icon is in
// the menu-bar overflow — and nowhere else.
let updateStatus = { state: "idle", version: "" };

function updateReady() {
  return updateStatus.state === "ready" && !!updateStatus.version;
}

function renderSidebarVersion() {
  const row = document.getElementById("sidebarVersion");
  const action = document.getElementById("sidebarVersionAction");
  if (!row || !action) {
    return;
  }
  row.classList.toggle("update-ready", updateReady());
  if (updateReady()) {
    action.textContent = t("update.restartShort");
    row.title = t("update.readyTitle", { version: updateStatus.version });
  } else if (updateStatus.state === "downloading") {
    action.textContent = t("update.downloadingShort", { version: updateStatus.version });
    row.title = "";
  } else if (updateStatus.state === "checking") {
    action.textContent = t("update.checkingShort");
    row.title = "";
  } else if (updateStatus.state === "storeManaged") {
    // Microsoft Store build: nothing to check from here.
    action.textContent = "";
    row.title = "";
  } else {
    action.textContent = t("update.checkShort");
    row.title = "";
  }
}

function renderUpdateCard() {
  const card = document.getElementById("update-card");
  if (!card) {
    return;
  }
  // Nothing to restart into means no card at all — this row is not a place to
  // report "you are up to date".
  card.classList.toggle("hidden", !updateReady());
  if (!updateReady()) {
    card.replaceChildren();
    return;
  }

  const icon = document.createElement("div");
  icon.className = "readiness-icon update-card-icon";
  icon.appendChild(makeIcon("system_update_alt"));

  const titles = document.createElement("div");
  titles.className = "update-card-titles";
  const title = document.createElement("div");
  title.className = "update-card-title";
  title.textContent = t("update.cardTitle", { version: updateStatus.version });
  const sub = document.createElement("div");
  sub.className = "update-card-sub";
  sub.textContent = t("update.cardHint");
  titles.appendChild(title);
  titles.appendChild(sub);

  const restart = document.createElement("button");
  restart.type = "button";
  restart.className = "btn update-card-btn";
  restart.textContent = t("update.restart");
  restart.addEventListener("click", () => void installUpdate());

  const notes = document.createElement("button");
  notes.type = "button";
  notes.className = "link-btn update-card-notes";
  notes.textContent = t("update.whatsNew");
  notes.addEventListener("click", () => void openReleasePage());

  card.replaceChildren(icon, titles, notes, restart);
}

// The release page is where the notes live (the release workflow writes them
// there after the build), so link to it rather than render a copy in the app.
async function openReleasePage() {
  try {
    await ipc.invoke("open-release-page", updateStatus.version);
  } catch (error) {
    console.error("Failed to open the release page:", error);
    showNotification(String(error?.message || error), "warning");
  }
}

async function installUpdate() {
  try {
    await ipc.invoke("install-update-and-restart");
  } catch (error) {
    console.error("Failed to install update:", error);
    showNotification(String(error?.message || error), "warning");
  }
}

function applyUpdateStatus(status) {
  updateStatus = {
    state: status?.state || "idle",
    version: status?.version || "",
  };
  renderSidebarVersion();
  renderUpdateCard();
}

function setupUpdateAffordances() {
  renderSidebarVersion();
  // The row is useful even if the updater channel never answers (dev builds
  // skip update checks entirely) — it still routes to Settings. So a failure
  // here must not take the rest of init down with it.
  try {
    ipc.on("update-status", (_event, payload) => applyUpdateStatus(payload));
    ipc.invoke("get-update-status").then(applyUpdateStatus).catch(() => {});
  } catch (error) {
    console.warn("Update status unavailable:", error);
  }

  document.getElementById("sidebarVersion")?.addEventListener("click", () => {
    // Ready: restart straight from here. Otherwise this is the one-click route
    // to the update row that used to take three.
    if (updateReady()) {
      void installUpdate();
      return;
    }
    void showPage("settings", { settingsTarget: "app" });
    void ipc.invoke("check-for-updates").catch(() => {});
  });
}

const engineAvailability = new Map();
const engineAvailabilityVersions = new Map();

function nextEngineAvailabilityVersion(value) {
  const version = (engineAvailabilityVersions.get(value) || 0) + 1;
  engineAvailabilityVersions.set(value, version);
  return version;
}

async function refreshEngineAvailability() {
  const options = availableEngineOptions();
  const versions = new Map(options.map(({ value }) => [value, nextEngineAvailabilityVersion(value)]));
  // Retain booleans only, never credentials, in the Home availability cache.
  const cloud = ipc.invoke("get-api-keys").then(keys => ({
    openai: !!String(keys?.apiKeyOpenAI || "").trim(),
    groq: !!String(keys?.apiKeyGroq || "").trim(),
  })).catch(() => null);
  await Promise.all(options.map(async option => {
    let status;
    try {
      if (option.model) {
        status = await ipc.invoke("get-local-model-status", option.model);
      } else {
        const keys = await cloud;
        status = { state: keys ? (keys[option.value] ? "ready" : "setup") : "checking" };
      }
    } catch (_) {
      status = { state: "checking" };
    }
    if (engineAvailabilityVersions.get(option.value) === versions.get(option.value)) {
      engineAvailability.set(option.value, status || { state: "checking" });
    }
  }));
  renderEngineCard();
}

function applyEngineDownloadProgress(payload) {
  const option = ENGINE_OPTIONS.find(entry => entry.model === payload.model);
  if (!option) return;
  nextEngineAvailabilityVersion(option.value);
  engineAvailability.set(option.value, {
    state: payload.state === "error" ? "absent" : payload.state,
    downloadedBytes: payload.downloadedBytes || 0,
    totalBytes: payload.totalBytes || 0,
  });
  renderEngineCard();
}

function engineReadinessLabel(option) {
  const status = engineAvailability.get(option.value);
  if (!status || status.state === "checking") return t("home.engineChecking");
  if (status.state === "ready") return t(option.model ? "home.engineReadyLocal" : "home.engineReadyCloud");
  if (status.state === "downloading") {
    const percent = status.totalBytes > 0
      ? Math.min(100, Math.max(0, Math.floor(100 * status.downloadedBytes / status.totalBytes))) : null;
    return percent === null ? t("home.engineDownloading") : t("home.engineDownloadProgress", { percent });
  }
  return t(option.model ? "home.engineNeedsDownload" : "home.engineNeedsSetup");
}

const QWEN_SIZE_LABELS = { "local-qwen": "0.6B", "local-qwen-large": "1.7B" };

// Home shows Qwen as one engine, labelled with its size: the one in use, else
// the one used last, which is also where clicking it returns to.
function homeQwenValue() {
  const selected = selectedEngineValue();
  if (QWEN_SIZE_LABELS[selected]) return selected;
  return cachedSettings?.qwenModel === QWEN_LARGE_LOCAL_MODEL ? "local-qwen-large" : "local-qwen";
}

// Qwen and OpenAI, plus the engine in use when it lives under "More".
function homeEngineOptions() {
  const selected = selectedEngineValue();
  const values = [homeQwenValue(), "openai"];
  if (!values.includes(selected)) values.push(selected);
  const available = availableEngineOptions();
  return values.map((value) => available.find((option) => option.value === value)).filter(Boolean);
}

function homeMoreOptions() {
  const shown = new Set(homeEngineOptions().map((option) => option.value));
  return availableEngineOptions().filter((option) => !shown.has(option.value) && !QWEN_SIZE_LABELS[option.value]);
}

function homeEngineLabel(option) {
  if (QWEN_SIZE_LABELS[option.value]) return `${t("home.engineLocalQwen")} ${QWEN_SIZE_LABELS[option.value]}`;
  return option.labelKey ? t(option.labelKey) : option.label;
}

// Only a state that needs attention is shown on a button; "ready" is the norm.
function engineAttentionLabel(option) {
  const state = engineAvailability.get(option.value)?.state;
  return state && !["ready", "checking"].includes(state) ? engineReadinessLabel(option) : "";
}

let engineMenuOpen = false;

function closeEngineMenu(event) {
  if (event && document.getElementById("engine-card")?.querySelector(".engine-more")?.contains(event.target)) return;
  if (!engineMenuOpen) return;
  engineMenuOpen = false;
  renderEngineCard();
}

function renderEngineCard() {
  const card = document.getElementById("engine-card");
  if (!card) {
    return;
  }

  const focusedValue = card.contains(document.activeElement)
    ? document.activeElement?.getAttribute("data-engine") : null;
  const selectedEngine = selectedEngineValue();
  const row = document.createElement("div");
  row.className = "engine-row";
  const header = document.createElement("div");
  header.className = "engine-header";
  header.appendChild(makeIcon("memory"));
  const title = document.createElement("div");
  title.className = "engine-title";
  title.textContent = t("home.engineLabel");
  header.appendChild(title);
  const pills = document.createElement("div");
  pills.className = "engine-pills";
  pills.setAttribute("role", "group");
  pills.setAttribute("aria-label", t("home.engineLabel"));

  // Local engines show a computer, cloud ones a cloud, as on the onboarding cards.
  const kindIcon = (option) => {
    const icon = makeIcon(option.model ? "computer" : "cloud");
    icon.classList.add("engine-kind-icon");
    icon.setAttribute("aria-hidden", "true");
    return icon;
  };
  const pillButton = (value, text, extraClass = "") => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `engine-pill-btn${extraClass}`;
    btn.setAttribute("data-engine", value);
    btn.setAttribute("aria-disabled", String(engineSwitchPending));
    btn.textContent = text;
    return btn;
  };
  const attention = (option) => {
    const label = engineAttentionLabel(option);
    if (!label) return null;
    const note = document.createElement("span");
    note.className = "engine-pill-note";
    note.textContent = label;
    return note;
  };

  homeEngineOptions().forEach((option) => {
    const pill = document.createElement("div");
    const qwen = !!QWEN_SIZE_LABELS[option.value];
    const active = qwen ? !!QWEN_SIZE_LABELS[selectedEngine] : selectedEngine === option.value;
    pill.className = `engine-pill${active ? " active" : ""}`;
    const main = pillButton(option.value, qwen ? t("home.engineLocalQwen") : homeEngineLabel(option));
    main.prepend(kindIcon(option));
    main.setAttribute("aria-pressed", String(active));
    main.addEventListener("click", () => void selectEngine(option.value));
    pill.appendChild(main);
    if (qwen) {
      // The size lives inside the Qwen pill: a switch once both are downloaded,
      // otherwise just the size in use.
      const sizes = ["local-qwen", "local-qwen-large"];
      const both = sizes.every((value) => engineAvailability.get(value)?.state === "ready");
      const sizeGroup = document.createElement("span");
      sizeGroup.className = "engine-size";
      if (both) {
        sizeGroup.setAttribute("role", "group");
        sizeGroup.setAttribute("aria-label", t("home.engineQwenSize"));
        sizes.forEach((value) => {
          const current = QWEN_SIZE_LABELS[selectedEngine] ? selectedEngine === value : option.value === value;
          const size = pillButton(`size-${value}`, QWEN_SIZE_LABELS[value], ` engine-size-btn${current ? " current" : ""}`);
          size.setAttribute("aria-pressed", String(current));
          size.addEventListener("click", () => void selectEngine(value));
          sizeGroup.appendChild(size);
        });
      } else {
        sizeGroup.textContent = QWEN_SIZE_LABELS[option.value];
      }
      pill.appendChild(sizeGroup);
    }
    const note = attention(option);
    if (note) pill.appendChild(note);
    pills.appendChild(pill);
  });

  const moreOptions = homeMoreOptions();
  if (moreOptions.length) {
    const more = document.createElement("div");
    more.className = "engine-more";
    const toggle = pillButton("more", "", " engine-more-btn");
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", String(engineMenuOpen));
    const label = document.createElement("span");
    label.textContent = t("home.engineMore");
    toggle.append(label, makeIcon("expand_more"));
    toggle.addEventListener("click", () => {
      engineMenuOpen = !engineMenuOpen;
      renderEngineCard();
    });
    more.appendChild(toggle);
    if (engineMenuOpen) {
      const menu = document.createElement("div");
      menu.className = "engine-menu";
      menu.setAttribute("role", "menu");
      moreOptions.forEach((option) => {
        const item = pillButton(`menu-${option.value}`, "", " engine-menu-item");
        item.setAttribute("role", "menuitem");
        const name = document.createElement("span");
        name.className = "engine-menu-name";
        name.append(kindIcon(option), homeEngineLabel(option));
        const status = document.createElement("span");
        status.className = "engine-menu-status";
        status.textContent = engineReadinessLabel(option);
        item.append(name, status);
        item.addEventListener("click", () => {
          engineMenuOpen = false;
          void selectEngine(option.value);
        });
        menu.appendChild(item);
      });
      const all = pillButton("menu-settings", t("home.engineAllSettings"), " engine-menu-item engine-menu-link");
      all.setAttribute("role", "menuitem");
      all.addEventListener("click", () => {
        engineMenuOpen = false;
        void showPage("settings", { settingsTarget: "engines-more" });
      });
      menu.appendChild(all);
      more.appendChild(menu);
    }
    pills.appendChild(more);
  }
  row.append(header, pills);

  const sub = document.createElement("div");
  sub.className = "engine-sub";
  sub.setAttribute("aria-live", "polite");
  const captionKey = ENGINE_CAPTION_KEY[selectedEngine];
  sub.textContent = captionKey ? t(captionKey) : "";
  card.replaceChildren(row, sub);
  if (focusedValue) {
    card.querySelector(`[data-engine="${focusedValue}"]`)?.focus({ preventScroll: true });
  }
}

let engineSwitchPending = false;

async function selectEngine(providerChoice) {
  if (engineSwitchPending) return;
  const option = ENGINE_OPTIONS.find((entry) => entry.value === providerChoice);
  if (!option || (option.model === NEMOTRON_LOCAL_MODEL && !nemotronOffered())) return;
  engineSwitchPending = true;
  renderEngineCard();
  try {
    const ready = await window.SayTypeSettings.runEngineChange(async (actualSettings) => {
      const active = option.model
        ? actualSettings.provider === "local" && actualSettings.model === option.model
        : actualSettings.provider === providerChoice;
      if (!active) {
        const saved = option.model
          ? await ipc.invoke("set-local-model", option.model)
          : await ipc.invoke("set-provider", providerChoice);
        if (saved === false) throw new Error("Engine switch was not saved");
      }
      if (option.model) {
        return (await ipc.invoke("get-local-model-status", option.model))?.state === "ready";
      }
      const keys = await ipc.invoke("get-api-keys");
      return !!String(providerChoice === "openai" ? keys.apiKeyOpenAI || "" : keys.apiKeyGroq || "").trim();
    });
    if (!ready) {
      await refreshReadiness();
      await showPage("settings", { settingsTarget: option.model ? `local-model:${option.model}` : `engine:${providerChoice}` });
      return;
    }
    try {
      await refreshReadiness();
    } catch (error) {
      console.error("Failed to refresh engine status:", error);
      showNotification(String(error?.message || error), "warning");
    }
  } catch (error) {
    console.error("Failed to switch engine:", error);
    showNotification(String(error?.message || error), "warning");
    await showPage("settings", { settingsTarget: `engine:${providerChoice}` });
    return;
  } finally {
    engineSwitchPending = false;
    renderEngineCard();
  }
}

// The in-card Accessibility onboarding panel. The copy leads with what the
// permission is used for AND what it is not used for — the permission sounds
// scary, and Apple forbids apps from granting it to themselves, so persuading
// the user through the System Settings toggle is the whole game here.
function buildAxGuide() {
  const guide = document.createElement("div");
  guide.className = "ax-guide";

  const head = document.createElement("div");
  head.className = "ax-guide-head";
  head.appendChild(makeIcon("accessibility_new"));
  const headText = document.createElement("div");
  const title = document.createElement("div");
  title.className = "ax-guide-title";
  title.textContent = t("readiness.axGuide.title");
  const lead = document.createElement("div");
  lead.className = "ax-guide-lead";
  lead.textContent = t("readiness.axGuide.lead");
  headText.appendChild(title);
  headText.appendChild(lead);
  head.appendChild(headText);
  guide.appendChild(head);

  const list = document.createElement("ul");
  list.className = "ax-guide-list";
  [
    { icon: "keyboard", key: "readiness.axGuide.useInsert" },
    { icon: "bolt", key: "readiness.axGuide.useHotkey" },
  ].forEach(({ icon, key }) => {
    const item = document.createElement("li");
    item.appendChild(makeIcon(icon));
    const text = document.createElement("span");
    text.textContent = t(key);
    item.appendChild(text);
    list.appendChild(item);
  });
  guide.appendChild(list);

  const privacy = document.createElement("div");
  privacy.className = "ax-guide-privacy";
  privacy.appendChild(makeIcon("verified_user"));
  const privacyText = document.createElement("span");
  privacyText.textContent = t("readiness.axGuide.privacy");
  privacy.appendChild(privacyText);
  guide.appendChild(privacy);

  const actions = document.createElement("div");
  actions.className = "ax-guide-actions";
  if (axGuideWaiting) {
    const waiting = document.createElement("div");
    waiting.className = "ax-guide-waiting";
    waiting.appendChild(makeIcon("sync"));
    const label = document.createElement("span");
    label.textContent = t("readiness.axGuide.waiting");
    waiting.appendChild(label);
    actions.appendChild(waiting);
    const hint = document.createElement("div");
    hint.className = "ax-guide-hint";
    hint.textContent = t("readiness.axGuide.waitingHint");
    actions.appendChild(hint);
    actions.appendChild(buildAxRevealRow());
  } else {
    const button = document.createElement("button");
    button.className = "btn";
    button.type = "button";
    button.textContent = t("readiness.axGuide.open");
    button.addEventListener("click", () => {
      void startAccessibilityFlow();
    });
    actions.appendChild(button);
    if (axGuideTimedOut) {
      const hint = document.createElement("div");
      hint.className = "ax-guide-hint";
      hint.textContent = t("readiness.axGuide.retryHint");
      actions.appendChild(hint);
      actions.appendChild(buildAxRevealRow());
    }
  }
  guide.appendChild(actions);

  return guide;
}

/* ---------- Onboarding wizard ---------- */

// A first-launch takeover with named, platform-specific steps. Persisted engine
// intent is independent of downloads, so background completion never changes it.
let obCurrent = "welcome";
let obMicState = "unknown";
let obMicBusy = false;
let obMicRefreshVersion = 0;
let obAxGranted = false;
let obKeyProvider = "openai";
let obKeyStatus = "idle";
let obKeyError = "";
let obAdvanceTimer = null;
let obLocalStatuses = {};
let obLocalErrors = {};
let obLocalVersions = {};
let obMoreExpanded = false;
let obPaused = false;
let obSelectionPending = false;
let obLayoutSignature = "";
let obPracticeActivity = false;
let obTryFocused = false;

function obSteps() {
  const os = cachedSettings?.os || (/Mac/i.test(navigator.platform || "") ? "macos" : "windows");
  return onboardingPolicy.onboardingSteps(os);
}

function onboardingVisible() {
  const overlay = document.getElementById("onboarding");
  return !!overlay && !overlay.hidden;
}

function showOnboarding(step = "welcome") {
  const overlay = document.getElementById("onboarding");
  if (!overlay) return;
  obCurrent = obSteps().includes(step) ? step : "welcome";
  obKeyStatus = "idle";
  obKeyError = "";
  obKeyProvider = cachedSettings?.provider === "groq" ? "groq" : "openai";
  obMoreExpanded = cachedSettings?.provider === "groq" ||
    (cachedSettings?.provider === "local" && cachedSettings.model === NEMOTRON_LOCAL_MODEL);
  obPaused = false;
  obPracticeActivity = false;
  obTryFocused = false;
  const input = document.getElementById("obTryInput");
  if (input) input.value = "";
  overlay.hidden = false;
  renderObResume();
  renderOnboarding();
  void obRefreshMicState();
  void obRefreshLocalStatus();
}

function pauseOnboarding() {
  if (!onboardingVisible()) return;
  document.getElementById("onboarding").hidden = true;
  obPaused = true;
  if (obAdvanceTimer) window.clearTimeout(obAdvanceTimer);
  obAdvanceTimer = null;
  renderObResume();
}

function resumeOnboarding() {
  if (!obPaused) return;
  const overlay = document.getElementById("onboarding");
  if (!overlay) return;
  obPaused = false;
  overlay.hidden = false;
  renderObResume();
  renderOnboarding();
  void refreshReadiness();
  void obRefreshMicState();
  void obRefreshLocalStatus();
}

function renderObResume() {
  const banner = document.getElementById("onboardingResume");
  if (banner) banner.hidden = !obPaused;
}

async function finishOnboarding() {
  const overlay = document.getElementById("onboarding");
  if (overlay) overlay.hidden = true;
  obPaused = false;
  renderObResume();
  if (obAdvanceTimer) window.clearTimeout(obAdvanceTimer);
  obAdvanceTimer = null;
  try {
    await ipc.invoke("set-onboarding-completed");
    if (cachedSettings) cachedSettings.onboardingCompleted = true;
  } catch (error) {
    console.error("Failed to persist onboarding completion:", error);
  }
  void refreshReadiness();
}

function obMove(delta) {
  if (obAdvanceTimer) window.clearTimeout(obAdvanceTimer);
  obAdvanceTimer = null;
  if (obCurrent === "practice" && delta > 0) {
    void finishOnboarding();
    return;
  }
  const steps = obSteps();
  obCurrent = steps[Math.min(steps.length - 1, Math.max(0, steps.indexOf(obCurrent) + delta))];
  renderOnboarding();
  if (obCurrent === "microphone") void obRefreshMicState();
}

function obScheduleAdvance(fromStep) {
  if (!onboardingVisible() || obCurrent !== fromStep || obAdvanceTimer) return;
  obAdvanceTimer = window.setTimeout(() => {
    obAdvanceTimer = null;
    if (onboardingVisible() && obCurrent === fromStep && obStepSatisfied(fromStep)) obMove(1);
  }, 900);
}

function renderOnboarding() {
  if (!onboardingVisible()) return;
  document.querySelectorAll(".onboard-page").forEach((page) => {
    page.classList.toggle("active", page.getAttribute("data-ob-step") === obCurrent);
  });
  const dots = document.getElementById("obDots");
  if (dots) {
    dots.replaceChildren(...obSteps().map((step) => {
      const dot = document.createElement("div");
      dot.className = `ob-dot${step === obCurrent ? " active" : ""}`;
      return dot;
    }));
  }
  obRecordStep(obCurrent);
  const usageCheck = document.getElementById("obUsageStatsCheck");
  if (usageCheck && cachedSettings) usageCheck.checked = cachedSettings.usageStats !== false;
  renderObKeycaps();
  renderObMic();
  renderObAx();
  renderObLocal();
  renderObKey();
  renderObFooter();
  renderObFinal();
  renderObPracticeFeedback();
}

// Each step is counted once per install (usage.rs dedupes); this set only
// avoids re-sending on every re-render.
const obRecordedSteps = new Set();
function obRecordStep(step) {
  if (obRecordedSteps.has(step)) return;
  obRecordedSteps.add(step);
  void Promise.resolve(ipc.invoke("record-onboarding-step", step)).catch(() => {});
}

async function obSetUsageStats(input) {
  const enabled = input.checked;
  try {
    await ipc.invoke("set-usage-stats", enabled);
    if (cachedSettings) cachedSettings.usageStats = enabled;
    // Settings lives in this window and saves its whole form, switch included.
    const settingsCheck = document.getElementById("usageStatsCheck");
    if (settingsCheck) settingsCheck.checked = enabled;
  } catch (error) {
    console.error("Failed to save usage statistics choice:", error);
    input.checked = !enabled;
  }
}

function obFormatGB(bytes) {
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

async function obRefreshLocalStatus() {
  if (!cachedSettings?.localCapable) return;
  const models = [QWEN_LOCAL_MODEL, QWEN_LARGE_LOCAL_MODEL, ...(nemotronOffered() ? [NEMOTRON_LOCAL_MODEL] : [])];
  await Promise.all(models.map(async (model) => {
    const version = (obLocalVersions[model] || 0) + 1;
    obLocalVersions[model] = version;
    try {
      const status = await ipc.invoke("get-local-model-status", model);
      if (obLocalVersions[model] === version) {
        obLocalStatuses[model] = status;
        if (status?.state === "ready") obLocalErrors[model] = "";
      }
    } catch (error) {
      console.error("Failed to fetch local model status:", error);
    }
  }));
  renderObLocal();
  renderObFooter();
  renderObFinal();
}

async function obSelectLocal(model) {
  if (!cachedSettings?.localCapable || (model === NEMOTRON_LOCAL_MODEL && !nemotronOffered()) || obSelectionPending) return false;
  obSelectionPending = true;
  try {
    await window.SayTypeSettings.runEngineChange(async () => {
      const saved = await ipc.invoke("set-local-model", model);
      if (saved === false) throw new Error("Engine switch was not saved");
    });
    obKeyStatus = "idle";
    await refreshReadiness();
    if (obEngineState().selected) obScheduleAdvance("engine");
    return true;
  } catch (error) {
    obLocalErrors[model] = String(error?.message || error);
    return false;
  } finally {
    obSelectionPending = false;
    renderObLocal();
    renderObKey();
    renderObFooter();
  }
}

async function obStartLocalDownload(model) {
  if (!await obSelectLocal(model)) return;
  obLocalErrors[model] = "";
  const currentStatus = obLocalStatuses[model];
  obLocalVersions[model] = (obLocalVersions[model] || 0) + 1;
  obLocalStatuses[model] = {
    state: "downloading",
    downloadedBytes: currentStatus?.downloadedBytes || 0,
    totalBytes: currentStatus?.totalBytes || 0,
  };
  renderObLocal();
  renderObFooter();
  try {
    // The command resolves when the download finishes. Advance while it runs.
    const download = ipc.invoke("download-local-model", model);
    obScheduleAdvance("engine");
    await download;
  } catch (error) {
    obLocalErrors[model] = String(error?.message || error);
    obLocalStatuses[model] = { ...obLocalStatuses[model], state: "error" };
    renderObLocal();
    renderObFooter();
    renderObFinal();
    void obRefreshLocalStatus();
  }
}

async function obChooseCloud(provider) {
  if (obSelectionPending || obKeyStatus === "saving") return;
  obSelectionPending = true;
  if (obKeyProvider !== provider) {
    const input = document.getElementById("obKeyInput");
    if (input) input.value = "";
  }
  obKeyProvider = provider;
  obKeyStatus = "idle";
  obKeyError = "";
  renderObKey();
  try {
    await window.SayTypeSettings.runEngineChange(async () => {
      const saved = await ipc.invoke("set-provider", provider);
      if (saved === false) throw new Error("Engine switch was not saved");
    });
    await refreshReadiness();
    if (obEngineState().ready) obScheduleAdvance("engine");
  } catch (error) {
    obKeyStatus = "error";
    obKeyError = String(error?.message || error);
  } finally {
    obSelectionPending = false;
    renderObLocal();
    renderObKey();
    renderObFooter();
  }
}

function obEngineCard(entry) {
  const option = ENGINE_OPTIONS.find((item) => item.value === entry.value);
  const card = document.createElement("button");
  card.type = "button";
  card.className = option.model ? "ob-local-card" : "ob-provider";
  card.classList.toggle("prominent", !!entry.prominent || !!entry.recommended);
  card.setAttribute("data-ob-engine", entry.value);
  const ids = { "local-qwen": "obLocalQwenCard", "local-qwen-large": "obLocalQwenLargeCard", "local-nemotron": "obLocalNemotronCard", openai: "obProviderOpenai", groq: "obProviderGroq" };
  card.id = ids[entry.value];
  if (option.model) card.setAttribute("data-local-model", option.model);
  else card.setAttribute("data-provider", entry.value);
  const body = document.createElement("span");
  body.className = "ob-local-body";
  const kind = document.createElement("span");
  kind.className = "ob-engine-kind";
  const icon = makeIcon(option.model ? "computer" : "cloud");
  icon.setAttribute("aria-hidden", "true");
  kind.appendChild(icon);
  const kindLabel = document.createElement("span");
  kindLabel.textContent = t(option.model ? "onboarding.key.localKind" : "onboarding.key.cloudKind");
  kind.appendChild(kindLabel);
  body.appendChild(kind);
  const name = document.createElement("span");
  name.className = "ob-provider-name";
  name.textContent = option.model ? t(`settings.engine.${entry.value === "local-qwen" ? "localQwen" : entry.value === "local-qwen-large" ? "localQwenLarge" : "localNemotron"}.name`) : option.label;
  if (option.model) {
    const tag = document.createElement("span");
    tag.className = "ob-provider-tag";
    tag.textContent = t(entry.recommended ? "onboarding.key.localRecommendedTag" : "onboarding.key.localOfflineTag");
    name.appendChild(tag);
  }
  body.appendChild(name);
  const detail = document.createElement("span");
  detail.className = "ob-engine-detail";
  detail.textContent = t(entry.value === "local-nemotron" ? "settings.engine.localNemotron.description" :
    option.model ? "onboarding.key.localDescription" : `onboarding.key.${entry.value}Desc`);
  body.appendChild(detail);
  if (entry.note) {
    const note = document.createElement("span");
    note.className = "ob-engine-note";
    note.textContent = t(`onboarding.key.${entry.note}`);
    body.appendChild(note);
  }
  const desc = document.createElement("span");
  desc.className = "ob-provider-desc";
  body.appendChild(desc);
  if (option.model) {
    const progress = document.createElement("progress");
    progress.className = "ob-local-progress";
    progress.max = 1000;
    progress.value = 0;
    progress.hidden = true;
    body.appendChild(progress);
  }
  card.appendChild(body);
  card.addEventListener("click", () => {
    if (card.disabled || card.hidden || obSelectionPending || obKeyStatus === "saving") return;
    if (!option.model) {
      void obChooseCloud(entry.value);
      return;
    }
    const state = obLocalStatuses[option.model]?.state;
    if (state === "ready" || state === "downloading") void obSelectLocal(option.model);
    else void obStartLocalDownload(option.model);
  });
  return card;
}

function renderObLocalCard(card, model) {
  const status = obLocalStatuses[model];
  const state = status?.state || "absent";
  const selected = localEngineSelected(model);
  card.classList.toggle("selected", selected);
  card.classList.toggle("downloading", state === "downloading");
  card.setAttribute("aria-pressed", String(selected));
  const progress = card.querySelector(".ob-local-progress");
  if (progress) {
    progress.hidden = state !== "downloading";
    progress.value = obDownloadPercent(status) * 10;
  }
  const desc = card.querySelector(".ob-provider-desc");
  if (!desc) return;
  if (obLocalErrors[model]) desc.textContent = t("onboarding.key.localError", { reason: obLocalErrors[model] });
  else if (state === "downloading") desc.textContent = obDownloadLabel(model);
  else if (state === "ready") desc.textContent = t(selected ? "onboarding.key.localSelected" : "onboarding.key.localReady");
  else if (state === "partial") desc.textContent = t("onboarding.key.localResume");
  else desc.textContent = t("onboarding.key.localAbsent", { total: status?.totalBytes ? obFormatGB(status.totalBytes) : model === QWEN_LARGE_LOCAL_MODEL ? "~2.5 GB" : "~1.0 GB" });
}

function renderObLocal() {
  if (!onboardingVisible()) return;
  const main = document.getElementById("obEngineMain");
  const more = document.getElementById("obEngineMore");
  const toggle = document.getElementById("obMoreToggle");
  if (!main || !more || !toggle) return;
  const capable = !!cachedSettings?.localCapable;
  const tier = cachedSettings?.localTier || "qwen";
  const layout = onboardingPolicy.onboardingEngineLayout(tier, nemotronOffered());
  const available = (entries) => entries.filter((entry) => capable || !entry.value.startsWith("local-"));
  const signature = `${tier}:${capable}:${nemotronOffered()}:${getLocale()}`;
  if (signature !== obLayoutSignature) {
    obLayoutSignature = signature;
    main.replaceChildren(...available(layout.main).map(obEngineCard));
    more.replaceChildren(...available(layout.more).map(obEngineCard));
  }
  const title = document.getElementById("obKeyTitle");
  if (title) title.textContent = t("onboarding.key.titleLocalFirst");
  const lead = document.getElementById("obKeyLead");
  if (lead) lead.textContent = t(tier === "cloud-default" ? "onboarding.key.leadCloudDefault" : "onboarding.key.leadLocalFirst");
  more.hidden = !obMoreExpanded;
  toggle.hidden = !available(layout.more).length;
  toggle.setAttribute("aria-expanded", String(obMoreExpanded));
  toggle.textContent = t(obMoreExpanded ? "onboarding.key.moreHide" : "onboarding.key.more");
  document.querySelectorAll("#onboarding [data-local-model]").forEach((card) => {
    const model = card.getAttribute("data-local-model");
    const downloadingOther = Object.entries(obLocalStatuses).some(([id, status]) => id !== model && status?.state === "downloading");
    const needsDownload = !["ready", "downloading"].includes(obLocalStatuses[model]?.state);
    card.disabled = obSelectionPending || obKeyStatus === "saving" || (downloadingOther && needsDownload);
    renderObLocalCard(card, model);
    if (downloadingOther && needsDownload) card.querySelector(".ob-provider-desc").textContent = t("onboarding.key.otherDownloading");
  });
  renderObKey();
}

function obEngineState() {
  return onboardingPolicy.onboardingEngineState(cachedSettings, obLocalStatuses);
}

function obStepSatisfied(step) {
  if (step === "microphone") return obMicState === "granted" || obMicState === "unknown";
  if (step === "accessibility") return obAxGranted;
  if (step === "engine") return obEngineState().selected;
  return true;
}

function obDownloadPercent(status) {
  return status?.totalBytes ? Math.min(100, Math.max(0, Math.round((status.downloadedBytes || 0) / status.totalBytes * 100))) : 0;
}

function obDownloadLabel(model, suppliedStatus = null) {
  const status = suppliedStatus || obLocalStatuses[model];
  if (obLocalErrors[model] || status?.state === "error") return t("onboarding.key.downloadFailed");
  if (status?.state === "downloading") return t("onboarding.key.downloadProgress", { percent: obDownloadPercent(status) });
  return t(status?.state === "ready" ? "onboarding.key.downloadReady" : "onboarding.key.downloadMissing");
}

function renderObDownloadFooter() {
  const footer = document.getElementById("obDownloadFooter");
  if (!footer) return;
  const active = Object.entries(obLocalStatuses).filter(([model, status]) => status?.state === "downloading" || obLocalErrors[model]);
  footer.hidden = !["microphone", "accessibility", "practice"].includes(obCurrent) || !active.length;
  if (footer.hidden) return;
  footer.replaceChildren(...active.map(([model]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-btn";
    const option = ENGINE_OPTIONS.find((entry) => entry.model === model);
    button.textContent = `${t(option.labelKey)} · ${obDownloadLabel(model)}`;
    button.addEventListener("click", () => openSettings(`local-model:${model}`));
    return button;
  }));
}

function renderObFooter() {
  if (!onboardingVisible()) return;
  const satisfied = obStepSatisfied(obCurrent);
  const gated = ["engine", "microphone", "accessibility"].includes(obCurrent);
  const back = document.getElementById("obBackBtn");
  if (back) back.style.visibility = obCurrent === "welcome" ? "hidden" : "visible";
  const skip = document.getElementById("obSkipBtn");
  if (skip) skip.hidden = !["welcome", "privacy"].includes(obCurrent);
  const stepSkip = document.getElementById("obStepSkipBtn");
  if (stepSkip) stepSkip.hidden = !gated || satisfied;
  const next = document.getElementById("obNextBtn");
  if (next) {
    next.textContent = t(obCurrent === "welcome" ? "onboarding.start" : obCurrent === "practice" ? "onboarding.finish" : "onboarding.next");
    next.disabled = gated && !satisfied;
  }
  renderObDownloadFooter();
}

function renderObFinal() {
  if (!onboardingVisible() || obCurrent !== "practice") {
    obTryFocused = false;
    return;
  }
  const steps = [
    { step: "engine", icon: "graphic_eq", label: t("readiness.engine"), ok: obEngineState().ready },
    { step: "microphone", icon: "mic", label: t("readiness.microphone"), ok: obStepSatisfied("microphone") },
    ...(obSteps().includes("accessibility") ? [{ step: "accessibility", icon: "accessibility_new", label: t("readiness.accessibility"), ok: obAxGranted }] : []),
  ];
  const ready = steps.every(({ ok }) => ok);
  renderObReadySummary(steps, ready);
  const title = document.getElementById("obTryTitle");
  if (title) title.textContent = t(ready ? "onboarding.try.title" : "onboarding.tryPending.title");
  const lead = document.getElementById("obTryLead");
  if (lead) lead.textContent = t(ready ? "onboarding.try.lead" : "onboarding.tryPending.lead");
  const icon = document.getElementById("obFinalIcon");
  if (icon) icon.textContent = ready ? "celebration" : "playlist_add_check";
  const tryBox = document.getElementById("obTryBox");
  if (tryBox) tryBox.hidden = !ready;
  const checklist = document.getElementById("obChecklist");
  if (!checklist) return;
  const historyHint = document.getElementById("obHistoryHint");
  if (historyHint) historyHint.hidden = !ready;
  checklist.hidden = ready;
  if (ready) {
    checklist.replaceChildren();
    if (!obTryFocused) {
      obTryFocused = true;
      const page = document.querySelector('[data-ob-step="practice"]');
      if (page) page.scrollTop = 0;
      document.getElementById("obTryInput")?.focus({ preventScroll: true });
    }
    return;
  }
  obTryFocused = false;
  checklist.replaceChildren(...steps.map(({ step, icon: rowIcon, label, ok }) => {
    const local = step === "engine" && cachedSettings?.provider === "local";
    const actionable = !ok || local;
    const row = document.createElement(actionable ? "button" : "div");
    row.className = `ob-check-row${ok ? " ok" : ""}`;
    if (actionable) {
      row.type = "button";
      row.addEventListener("click", () => {
        if (local) openSettings(`local-model:${cachedSettings.model}`);
        else {
          obCurrent = step;
          renderOnboarding();
        }
      });
    }
    row.appendChild(makeIcon(rowIcon));
    const text = document.createElement("span");
    text.className = "ob-check-label";
    text.textContent = local ? `${label} · ${obDownloadLabel(cachedSettings.model)}` :
      step === "microphone" && obMicState === "unknown" ? `${label} · ${t("onboarding.mic.unknown")}` : label;
    row.appendChild(text);
    row.appendChild(makeIcon(ok ? "check" : "chevron_right"));
    return row;
  }));
}

function renderObReadySummary(steps, ready) {
  const summary = document.getElementById("obReadySummary");
  if (!summary) return;
  summary.hidden = !ready;
  summary.replaceChildren();
  if (!ready) return;
  steps.forEach(({ step, label, ok }) => {
    const confirmed = ok && (step !== "microphone" || obMicState === "granted");
    const row = document.createElement("li");
    row.className = confirmed ? "confirmed" : "unchecked";
    const icon = makeIcon(confirmed ? "check" : "help_outline");
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = step === "engine" ? t("onboarding.try.engineReady") :
      step === "microphone" && !confirmed ? t("onboarding.try.micUnchecked") : label;
    row.setAttribute("aria-label", confirmed && step !== "engine" ? `${label} · ${t("onboarding.key.downloadReady")}` : text.textContent);
    row.appendChild(icon);
    row.appendChild(text);
    summary.appendChild(row);
  });
}

function renderObPracticeFeedback() {
  const input = document.getElementById("obTryInput");
  const feedback = document.getElementById("obTryFeedback");
  if (!feedback) return;
  const success = !!input?.value.trim();
  feedback.hidden = !success && !obPracticeActivity;
  feedback.classList.toggle("ok", success);
  feedback.textContent = t(success ? "onboarding.try.success" : "onboarding.try.historyFallback");
}

// Fill an element from an i18n template containing a {keys} placeholder,
// rendering the shortcut as keycap chips instead of plain text.
function fillKeycapTemplate(element, key, shortcut) {
  if (!element) {
    return;
  }
  const [before, after] = t(key).split("{keys}");
  element.replaceChildren();
  if (before) {
    element.appendChild(document.createTextNode(before));
  }
  element.appendChild(keycapRow(shortcut));
  if (after) {
    element.appendChild(document.createTextNode(after));
  }
}

function renderObKeycaps() {
  const record = cachedSettings?.shortcut || "Ctrl+Shift";
  fillKeycapTemplate(document.getElementById("obStepHold"), "onboarding.welcome.holdTitle", record);
  fillKeycapTemplate(document.getElementById("obTryHint"), "onboarding.try.hint", record);

  const tryInput = document.getElementById("obTryInput");
  if (tryInput) {
    tryInput.placeholder = t("onboarding.try.placeholder", {
      keys: shortcutKeycaps(record).join(" "),
    });
  }
}

function obStatusPill(label) {
  const pill = document.createElement("span");
  pill.className = "ob-status-pill ok";
  pill.appendChild(makeIcon("check"));
  const text = document.createElement("span");
  text.textContent = label;
  pill.appendChild(text);
  return pill;
}

function obActionHint(label) {
  const hint = document.createElement("div");
  hint.className = "ob-action-hint";
  hint.textContent = label;
  return hint;
}

function obActionButton(label, onClick) {
  const button = document.createElement("button");
  button.className = "btn";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

/* --- page 3: microphone --- */

async function obRefreshMicState() {
  const version = ++obMicRefreshVersion;
  const previous = obMicState;
  try {
    const result = await ipc.invoke("check-microphone-permission");
    if (version !== obMicRefreshVersion) return;
    obMicState = result.status === "not-determined" ? "prompt" :
      ["granted", "unknown", "denied", "unavailable", "error"].includes(result.status) ? result.status : "denied";
  } catch (error) {
    if (version !== obMicRefreshVersion) return;
    console.error("Failed to check microphone permission:", error);
    obMicState = "error";
  }
  renderObMic();
  renderObFooter();
  renderObFinal();
  if (previous !== "granted" && obMicState === "granted") obScheduleAdvance("microphone");
}

async function obEnableMic() {
  if (obMicBusy) {
    return;
  }
  obMicBusy = true;
  renderObMic();
  try {
    if (cachedSettings?.os === "windows") {
      await window.SayTypeMicrophone.probe(ipc, "windows");
    } else {
      // A momentary capture purely to trigger the macOS microphone prompt now,
      // instead of surprising the user mid-first-dictation.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    }
  } catch (error) {
    console.error("Microphone request was blocked or denied:", error);
  } finally {
    obMicBusy = false;
  }
  await obRefreshMicState();
}

function renderObMic() {
  const container = document.getElementById("obMicActions");
  if (!container || !onboardingVisible()) {
    return;
  }
  container.replaceChildren();
  container.classList.toggle("ob-mic-observation", cachedSettings?.os === "windows");
  if (cachedSettings?.os === "windows" && obMicState !== "granted") {
    container.appendChild(obActionHint(t(`microphoneAccess.${obMicBusy ? "checking" : obMicState}`)));
    if (obMicState === "denied") {
      container.appendChild(obActionHint(t("microphoneAccess.deniedHint")));
      container.appendChild(obActionButton(t("onboarding.mic.openSettings"), async () => {
        try { await ipc.invoke("open-microphone-settings"); await obRefreshMicState(); }
        catch { showNotification(t("microphoneAccess.settingsFailed"), "error"); }
      }));
    }
    const button = obActionButton(t("microphoneAccess.check"), () => void obEnableMic());
    button.disabled = obMicBusy;
    container.appendChild(button);
    return;
  }
  if (obMicState === "granted") {
    container.appendChild(obStatusPill(t("onboarding.mic.granted")));
    return;
  }
  if (obMicState === "unknown") {
    container.appendChild(obActionHint(t("onboarding.mic.unknown")));
    return;
  }
  if (obMicState === "denied") {
    container.appendChild(
      obActionButton(t("onboarding.mic.openSettings"), () => {
        ipc.invoke("open-microphone-settings").catch((error) => {
          console.error("Failed to open microphone settings:", error);
        });
      })
    );
    container.appendChild(obActionHint(t("onboarding.mic.denied")));
    return;
  }
  container.appendChild(
    obActionButton(t("onboarding.mic.enable"), () => {
      void obEnableMic();
    })
  );
  container.appendChild(obActionHint(t("onboarding.mic.enableHint")));
}

/* --- page 4: accessibility (shares state + flow with the readiness card) --- */

function renderObAx() {
  const container = document.getElementById("obAxActions");
  if (!container || !onboardingVisible()) {
    return;
  }
  container.replaceChildren();
  if (obAxGranted) {
    container.appendChild(obStatusPill(t("onboarding.ax.granted")));
    return;
  }
  if (axGuideWaiting) {
    const waiting = document.createElement("div");
    waiting.className = "ob-waiting";
    waiting.appendChild(makeIcon("sync"));
    const label = document.createElement("span");
    label.textContent = t("readiness.axGuide.waiting");
    waiting.appendChild(label);
    container.appendChild(waiting);
    container.appendChild(obActionHint(t("readiness.axGuide.waitingHint")));
    container.appendChild(buildAxRevealRow());
    return;
  }
  container.appendChild(
    obActionButton(t("readiness.axGuide.open"), () => {
      void startAccessibilityFlow();
    })
  );
  container.appendChild(
    obActionHint(
      t(axGuideTimedOut ? "readiness.axGuide.retryHint" : "readiness.axGuide.waitingHint")
    )
  );
  if (axGuideTimedOut) {
    container.appendChild(buildAxRevealRow());
  }
}

/* --- page 5: provider + API key --- */

function renderObKey() {
  if (!onboardingVisible()) {
    return;
  }
  if (!obSelectionPending && obKeyStatus !== "saving" &&
      ["openai", "groq"].includes(cachedSettings?.provider) && obKeyProvider !== cachedSettings.provider) {
    obKeyProvider = cachedSettings.provider;
    obKeyStatus = "idle";
    obKeyError = "";
    const previousInput = document.getElementById("obKeyInput");
    if (previousInput) previousInput.value = "";
  }
  document.querySelectorAll(".ob-provider").forEach((card) => {
    const provider = card.getAttribute("data-provider");
    const selected = cachedSettings?.provider === provider;
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", String(selected));
    card.disabled = obSelectionPending || obKeyStatus === "saving";
    const desc = card.querySelector(".ob-provider-desc");
    if (desc) desc.textContent = t(selected && cachedSettings?.engineReady ? "onboarding.key.configured" : "onboarding.key.cloudSetup");
  });
  const cloud = document.getElementById("obCloudSection");
  if (cloud) cloud.hidden = cachedSettings?.provider === "local" && !obSelectionPending;
  const label = document.getElementById("obKeyLabel");
  if (label) label.textContent = t("onboarding.key.keyLabel", { provider: obKeyProvider === "groq" ? "Groq" : "OpenAI" });
  const notice = document.getElementById("obCloudNotice");
  if (notice) notice.textContent = t("onboarding.key.cloudNotice", { provider: obKeyProvider === "groq" ? "Groq" : "OpenAI" });
  const input = document.getElementById("obKeyInput");
  if (input) {
    input.placeholder = t(
      obKeyProvider === "groq"
        ? "onboarding.key.placeholderGroq"
        : "onboarding.key.placeholderOpenai"
    );
  }

  const help = document.getElementById("obKeyHelp");
  if (help) {
    if (obKeyStatus === "error") {
      help.className = "ob-key-help error";
      help.textContent = t("onboarding.key.error", { message: obKeyError });
    } else if (obKeyStatus === "saved") {
      help.className = "ob-key-help ok";
      help.textContent = t("onboarding.key.saved");
    } else if (cachedSettings?.engineReady && cachedSettings.provider === obKeyProvider) {
      help.className = "ob-key-help ok";
      help.textContent = t("onboarding.key.configured");
    } else {
      help.className = "ob-key-help";
      help.textContent = t(
        obKeyProvider === "groq" ? "onboarding.key.getKeyGroq" : "onboarding.key.getKeyOpenai"
      );
    }
  }

  const save = document.getElementById("obKeySaveBtn");
  if (save) {
    save.disabled = obKeyStatus === "saving" || obSelectionPending;
  }
}

async function obSaveKey() {
  const input = document.getElementById("obKeyInput");
  const key = (input?.value || "").trim();
  if (!key || obKeyStatus === "saving" || obSelectionPending) {
    input?.focus();
    return;
  }
  const provider = obKeyProvider;
  obKeyStatus = "saving";
  renderObLocal();
  renderObKey();
  try {
    await window.SayTypeSettings.runEngineChange(() => ipc.invoke("save-onboarding-api-key", provider, key));
    obKeyStatus = "saved";
    if (input) {
      input.value = "";
    }
    try {
      cachedSettings = await ipc.invoke("get-settings");
    } catch (error) {
      console.error("Failed to reload settings after key save:", error);
    }
    await refreshReadiness();
    renderObLocal();
    renderObKey();
    renderObFooter();
    renderObFinal();
    obScheduleAdvance("engine");
  } catch (error) {
    obKeyStatus = "error";
    obKeyError = error?.message || String(error);
    renderObLocal();
    renderObKey();
  }
}

/* ---------- Activities (recent + history) ---------- */

async function loadActivities() {
  try {
    const activities = await ipc.invoke("get-recent-activities");
    cachedActivities = Array.isArray(activities) ? activities : [];
  } catch (error) {
    console.error("Error loading activities:", error);
    cachedActivities = [];
  }
  renderRecent();
  renderHistory();
}

function formatTime(timestamp) {
  const locale = getLocale();
  return new Date(timestamp).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: locale === "en-US",
  });
}

function dateGroupLabel(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const startOfDay = (value) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (diffDays <= 0) {
    return t("history.today");
  }
  if (diffDays === 1) {
    return t("history.yesterday");
  }
  return date.toLocaleDateString(getLocale(), {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function activityDisplayText(activity) {
  const savedText = (activity.text ?? "").toString();
  return activity.success === false ? localizeRetryError(savedText) : savedText;
}

// Rows the user opened to read in full. Kept by id because every
// "activity-updated" rebuilds the list, which would otherwise fold them again.
const expandedActivityIds = new Set();

function buildActivityRow(activity) {
  const rawText = activityDisplayText(activity);
  // A hung local decode that the input-prompt saved for recovery: no text yet,
  // just a stored clip the user can re-transcribe (see retranscribe_pending).
  const isPending = activity.pending === true;

  const item = document.createElement("div");
  item.className = "activity-item";

  const time = document.createElement("div");
  time.className = "activity-time";
  time.textContent = formatTime(activity.timestamp);

  const text = document.createElement("div");
  text.className = "activity-text";
  if (isPending) {
    // An ordinary failure keeps its reason on the same row as the clip, so show
    // it. Hang rows saved by input-prompt carry no text and fall back to the
    // generic stalled label. Either way the clip is what makes the row retryable.
    const reason = rawText.trim();
    text.classList.add("pending");
    if (reason) text.classList.add("failed");
    text.textContent = reason || t("activity.pendingAudio");
    text.title = `${reason || t("activity.pendingAudio")}\n${t("activity.pendingHint")}`;
  } else {
    if (activity.success === false) {
      text.classList.add("failed");
    }
    text.textContent = rawText;
    // A long dictation is a paragraph; one truncated line cannot be read back.
    const setExpanded = (expanded) => {
      item.classList.toggle("expanded", expanded);
      text.setAttribute("aria-expanded", String(expanded));
      text.title = expanded ? "" : rawText;
      if (expanded) expandedActivityIds.add(activity.id);
      else expandedActivityIds.delete(activity.id);
    };
    const toggleExpanded = () => {
      const expanded = item.classList.contains("expanded");
      // Selecting text in an open row must not fold it, and a row that already
      // fits on one line has nothing to open.
      if (expanded && String(window.getSelection?.() ?? "")) return;
      if (!expanded && text.scrollWidth <= text.clientWidth) return;
      setExpanded(!expanded);
    };
    text.tabIndex = 0;
    text.setAttribute("role", "button");
    setExpanded(expandedActivityIds.has(activity.id));
    text.addEventListener("click", toggleExpanded);
    text.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleExpanded();
    });
  }

  const actions = document.createElement("div");
  actions.className = "activity-actions";

  // Dev-only: play back the original recording captured for this entry. Pending
  // rows always have one — the stored clip is the whole point of the row.
  if (cachedSettings?.isDev && activity.audioId) {
    const playBtn = document.createElement("button");
    playBtn.className = "icon-btn";
    playBtn.type = "button";
    playBtn.title = t("activity.playTitle");
    playBtn.setAttribute("aria-label", t("activity.playTitle"));
    playBtn.appendChild(makeIcon("play_arrow"));
    playBtn.addEventListener("click", () => playDebugAudio(activity.audioId, playBtn));
    actions.appendChild(playBtn);
  }

  if (isPending) {
    // Re-run transcription on the stored clip; on success the "activity-updated"
    // event refreshes this row into a normal text entry.
    const retryBtn = document.createElement("button");
    retryBtn.className = "icon-btn";
    retryBtn.type = "button";
    retryBtn.title = t("activity.retranscribeTitle");
    retryBtn.setAttribute("aria-label", t("activity.retranscribeTitle"));
    retryBtn.appendChild(makeIcon("replay"));
    retryBtn.addEventListener("click", () => retranscribePending(activity.id, retryBtn));
    actions.appendChild(retryBtn);
  } else {
    const copyBtn = document.createElement("button");
    copyBtn.className = "icon-btn";
    copyBtn.type = "button";
    copyBtn.title = t("activity.copyTitle");
    copyBtn.setAttribute("aria-label", t("activity.copyTitle"));
    copyBtn.appendChild(makeIcon("content_copy"));
    copyBtn.addEventListener("click", () => copyToClipboard(rawText, copyBtn));
    actions.appendChild(copyBtn);
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "icon-btn danger";
  deleteBtn.type = "button";
  deleteBtn.title = t("activity.deleteTitle");
  deleteBtn.setAttribute("aria-label", t("activity.deleteTitle"));
  deleteBtn.appendChild(makeIcon("delete"));
  deleteBtn.addEventListener("click", () => deleteActivity(activity.id));
  actions.appendChild(deleteBtn);

  item.appendChild(time);
  item.appendChild(text);
  item.appendChild(actions);
  return item;
}

// Re-transcribe a stored clip from History. The success path arrives via the
// "activity-updated" broadcast, which re-renders the row as normal text; on
// failure we re-enable the button so the user can try again. The reason matters
// here — it is usually something the user can act on (a key to add, an engine to
// switch), so surface it rather than a bare "try again".
async function retranscribePending(id, btn) {
  if (btn) {
    btn.disabled = true;
    btn.replaceChildren(makeIcon("hourglass_empty"));
  }
  try {
    await ipc.invoke("retranscribe-pending", id);
  } catch (error) {
    console.error("re-transcribe failed:", error);
    // Tauri rejects with the command's Err value, a raw string for Result<_, String>.
    const reason = localizeRetryError((typeof error === "string" ? error : error?.message || "").trim());
    showNotification(
      reason
        ? t("activity.retranscribeFailedReason", { reason })
        : t("activity.retranscribeFailed"),
      "warning"
    );
    if (btn) {
      btn.disabled = false;
      btn.replaceChildren(makeIcon("replay"));
    }
  }
}

// Dev-only: single in-page debug player. Only one recording plays at a time —
// clicking another row stops the previous one; clicking the playing row stops it
// (the ▶ button toggles to ⏹ while playing).
let debugAudio = null; // { audio, url, btn } | null
let debugAudioGen = 0;

function stopDebugAudio() {
  if (!debugAudio) return;
  debugAudio.audio.pause();
  URL.revokeObjectURL(debugAudio.url);
  if (debugAudio.btn) debugAudio.btn.replaceChildren(makeIcon("play_arrow"));
  debugAudio = null;
}

async function playDebugAudio(audioId, btn) {
  // Toggle: clicking the currently-playing row's button just stops it.
  const wasPlayingThis = debugAudio && debugAudio.btn === btn;
  stopDebugAudio();
  if (wasPlayingThis) return;

  const gen = ++debugAudioGen;
  try {
    const res = await ipc.invoke("read-debug-audio", audioId);
    if (gen !== debugAudioGen) return; // a newer click superseded this one
    const bytes =
      res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes);
    const blob = new Blob([bytes], { type: res.mime || "audio/mp4" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    debugAudio = { audio, url, btn };
    if (btn) btn.replaceChildren(makeIcon("stop"));
    const stopIfCurrent = () => {
      if (debugAudio && debugAudio.audio === audio) stopDebugAudio();
    };
    audio.addEventListener("ended", stopIfCurrent);
    audio.addEventListener("error", () => {
      console.error("[debug-audio] element error code:", audio.error && audio.error.code);
      stopIfCurrent();
    });
    await audio.play();
  } catch (error) {
    console.error("[debug-audio] playback failed:", error);
    stopDebugAudio();
  }
}

function renderGroupedList(container, activities) {
  container.replaceChildren();
  let lastGroup = null;
  activities.forEach((activity) => {
    const group = dateGroupLabel(activity.timestamp);
    if (group !== lastGroup) {
      lastGroup = group;
      const label = document.createElement("div");
      label.className = "activity-group-label";
      label.textContent = group;
      container.appendChild(label);
    }
    container.appendChild(buildActivityRow(activity));
  });
}

function renderRecent() {
  const container = document.getElementById("activity-container");
  if (!container) {
    return;
  }
  const viewAll = document.getElementById("viewAllBtn");
  if (viewAll) {
    viewAll.style.display = cachedActivities.length > RECENT_LIMIT ? "" : "none";
  }
  if (!cachedActivities.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("home.noActivity");
    container.replaceChildren(empty);
    return;
  }
  renderGroupedList(container, cachedActivities.slice(0, RECENT_LIMIT));
}

function renderHistory() {
  const container = document.getElementById("history-container");
  if (!container) {
    return;
  }

  // Skip rebuilding the (up to 200-row) history DOM while the History page isn't
  // visible — on every activity-updated event from Home (the common case) this
  // avoids rebuilding a hidden list. showPage('history') re-renders it on nav,
  // and the search box (the only other caller) lives on the then-active page.
  if (!document.getElementById("history-page")?.classList.contains("active")) {
    return;
  }

  if (!cachedActivities.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("history.empty");
    container.replaceChildren(empty);
    return;
  }

  const filtered = historyQuery
    ? cachedActivities.filter((activity) =>
        activityDisplayText(activity).toLowerCase().includes(historyQuery)
      )
    : cachedActivities;

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("history.noResults");
    container.replaceChildren(empty);
    return;
  }

  renderGroupedList(container, filtered);
}

async function deleteActivity(id) {
  if (!id) {
    return;
  }
  try {
    await ipc.invoke("delete-history-item", id);
  } catch (error) {
    console.error("Failed to delete history item:", error);
    return;
  }
  await loadActivities();
}

function handleClearHistory() {
  const button = document.getElementById("clearHistoryBtn");
  if (!button) {
    return;
  }

  if (!clearConfirming) {
    clearConfirming = true;
    button.textContent = t("history.confirmClear");
    clearConfirmTimer = window.setTimeout(resetClearButton, 3000);
    return;
  }

  resetClearButton();
  void clearHistory();
}

function resetClearButton() {
  const button = document.getElementById("clearHistoryBtn");
  clearConfirming = false;
  if (clearConfirmTimer) {
    window.clearTimeout(clearConfirmTimer);
    clearConfirmTimer = null;
  }
  if (button) {
    button.textContent = t("history.clearAll");
  }
}

async function clearHistory() {
  try {
    await ipc.invoke("clear-history");
  } catch (error) {
    console.error("Failed to clear history:", error);
    return;
  }
  await loadActivities();
}

/* ---------- Dictionary ---------- */

// Everything is stored as one comma-separated string. A plain entry is a word
// cloud engines get as a spelling reference, edited as a chip; `heard => wanted`
// is an automatic replacement every engine's final text goes through, edited in
// its own two-field form so nobody has to learn the syntax. The backend parses
// the same format (src-tauri/src/dictionary.rs).
const DICTIONARY_SEPARATORS = /[,\n，、;；]+/;
const DICTIONARY_RULE_ARROW = /=>|->|→/;
let dictionaryEntries = [];
let dictionarySaveChain = Promise.resolve();
let dictionaryStatusTimer = null;

function parseDictionaryRule(entry) {
  const match = DICTIONARY_RULE_ARROW.exec(entry);
  if (!match) return null;
  const heard = entry.slice(0, match.index).trim();
  const wanted = entry.slice(match.index + match[0].length).trim();
  return heard && wanted ? { heard, wanted } : null;
}

// Rules are stored in one spelling, and a second rule for the same heard text
// replaces the first instead of being dropped as a duplicate.
function normalizeDictionaryEntry(entry) {
  const rule = parseDictionaryRule(entry);
  return rule ? `${rule.heard} => ${rule.wanted}` : entry;
}

function dictionaryEntryKey(entry) {
  const rule = parseDictionaryRule(entry);
  return rule ? `rule:${rule.heard.toLowerCase()}` : entry.toLowerCase();
}

// Separators and arrows would split a replacement when it is stored, so a
// field turns them into spaces.
function cleanReplacementField(value) {
  return String(value || "")
    .replace(DICTIONARY_SEPARATORS, " ")
    .replace(new RegExp(DICTIONARY_RULE_ARROW.source, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDictionaryEntries(text) {
  return String(text || "")
    .split(DICTIONARY_SEPARATORS)
    .map((entry) => normalizeDictionaryEntry(entry.trim()))
    .filter(Boolean);
}

function renderDictionary() {
  const editor = document.getElementById("dictionaryEditor");
  const input = document.getElementById("dictionaryInput");
  if (!editor || !input) return;
  editor.querySelectorAll(".dictionary-chip").forEach((chip) => chip.remove());
  const list = document.getElementById("replacementList");
  list.replaceChildren();
  let words = 0;
  dictionaryEntries.forEach((entry, index) => {
    const rule = parseDictionaryRule(entry);
    if (rule) {
      list.append(renderReplacement(rule, index));
      return;
    }
    words += 1;
    const chip = document.createElement("span");
    chip.className = "dictionary-chip";
    chip.setAttribute("role", "listitem");
    const label = document.createElement("span");
    label.textContent = entry;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "dictionary-chip-remove";
    remove.setAttribute("aria-label", t("dictionary.remove", { entry }));
    remove.innerHTML = '<span class="material-icons" aria-hidden="true">close</span>';
    // Keep focus in the input so its blur-commit doesn't re-render the chips
    // out from under this click.
    remove.addEventListener("mousedown", (event) => event.preventDefault());
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeDictionaryEntry(index);
    });
    chip.append(label, remove);
    editor.insertBefore(chip, input);
  });
  document.getElementById("dictionaryCount").textContent =
    words === 0 ? "" : words === 1 ? t("dictionary.countOne") : t("dictionary.count", { count: words });
}

function renderReplacement(rule, index) {
  const row = document.createElement("li");
  const heard = document.createElement("span");
  heard.className = "replacement-heard";
  heard.textContent = rule.heard;
  const arrow = document.createElement("span");
  arrow.className = "material-icons replacement-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "arrow_forward";
  const wanted = document.createElement("span");
  wanted.className = "replacement-wanted";
  wanted.textContent = rule.wanted;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "dictionary-chip-remove";
  remove.setAttribute("aria-label", t("dictionary.replaceRemove", rule));
  remove.innerHTML = '<span class="material-icons" aria-hidden="true">close</span>';
  remove.addEventListener("click", () => removeDictionaryEntry(index, "replacementHeard"));
  row.append(heard, arrow, wanted, remove);
  return row;
}

function submitReplacement() {
  const heardInput = document.getElementById("replacementHeard");
  const wantedInput = document.getElementById("replacementWanted");
  const heard = cleanReplacementField(heardInput.value);
  const wanted = cleanReplacementField(wantedInput.value);
  if (!heard) {
    heardInput.focus();
    return;
  }
  if (!wanted) {
    wantedInput.focus();
    return;
  }
  heardInput.value = "";
  wantedInput.value = "";
  if (heard !== wanted) addDictionaryEntries(`${heard} => ${wanted}`);
  heardInput.focus();
}

// Saves are chained so rapid adds and removes reach the disk in order.
function persistDictionary() {
  const text = dictionaryEntries.join(", ");
  dictionarySaveChain = dictionarySaveChain
    .then(() => ipc.invoke("save-dictionary", text))
    .then(() => {
      const status = document.getElementById("dictionaryStatus");
      status.textContent = t("dictionary.saved");
      clearTimeout(dictionaryStatusTimer);
      dictionaryStatusTimer = setTimeout(() => {
        status.textContent = "";
      }, 1500);
    })
    .catch((error) => {
      console.error("Error saving dictionary:", error);
      alert(t("dictionary.saveError", { message: error.message }));
    });
}

function addDictionaryEntries(text) {
  let changed = false;
  for (const entry of parseDictionaryEntries(text)) {
    const key = dictionaryEntryKey(entry);
    const index = dictionaryEntries.findIndex((existing) => dictionaryEntryKey(existing) === key);
    if (index === -1) {
      dictionaryEntries.push(entry);
    } else if (key.startsWith("rule:") && dictionaryEntries[index] !== entry) {
      dictionaryEntries[index] = entry;
    } else {
      continue;
    }
    changed = true;
  }
  if (!changed) return;
  renderDictionary();
  persistDictionary();
}

function removeDictionaryEntry(index, focusId = "dictionaryInput") {
  dictionaryEntries.splice(index, 1);
  renderDictionary();
  persistDictionary();
  document.getElementById(focusId).focus();
}

function commitDictionaryInput() {
  const input = document.getElementById("dictionaryInput");
  const text = input.value;
  input.value = "";
  addDictionaryEntries(text);
}

// Plain entries ride along as the transcription request's `prompt`, which only
// the cloud APIs take — the local CLI invocation has no such argument. Say so
// on the page; replacement rules still apply to local engines.
// Re-read on every visit: the engine may have changed in Settings since load.
async function refreshDictionaryLocalNote() {
  try {
    cachedSettings = await ipc.invoke("get-settings");
  } catch (error) {
    console.error("Failed to load settings:", error);
  }
  applyDictionaryEngine();
}

// A local engine ignores the word list, so the section that does work there,
// automatic replacements, goes first.
function applyDictionaryEngine() {
  const isLocal = cachedSettings?.provider === "local";
  document.getElementById("dictionaryLocalNote")?.classList.toggle("hidden", !isLocal);
  const words = document.getElementById("dictionaryWordsSection");
  const replacements = document.getElementById("dictionaryReplaceSection");
  if (!words || !replacements || !words.parentNode?.insertBefore) return;
  if (isLocal) words.parentNode.insertBefore(replacements, words);
  else words.parentNode.insertBefore(words, replacements);
}

async function loadDictionary() {
  const editor = document.getElementById("dictionaryEditor");
  const input = document.getElementById("dictionaryInput");
  try {
    dictionaryEntries = [];
    const known = new Set();
    for (const entry of parseDictionaryEntries(await ipc.invoke("get-dictionary"))) {
      const key = dictionaryEntryKey(entry);
      if (known.has(key)) continue;
      known.add(key);
      dictionaryEntries.push(entry);
    }
  } catch (error) {
    console.error("Error loading dictionary:", error);
  }
  editor.addEventListener("click", () => input.focus());
  input.addEventListener("keydown", (event) => {
    // Enter during IME composition picks a candidate; it must not commit.
    if (event.isComposing) return;
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commitDictionaryInput();
    }
  });
  // A pasted list, or a full-width comma typed through an IME, commits every
  // finished entry and leaves the unfinished tail in the field.
  input.addEventListener("input", (event) => {
    if (event.isComposing || !DICTIONARY_SEPARATORS.test(input.value)) return;
    const parts = input.value.split(DICTIONARY_SEPARATORS);
    input.value = parts.pop().trimStart();
    addDictionaryEntries(parts.join(","));
  });
  input.addEventListener("compositionend", () => input.dispatchEvent(new Event("input")));
  input.addEventListener("blur", commitDictionaryInput);
  document.getElementById("replacementForm").addEventListener("submit", (event) => {
    event.preventDefault();
    submitReplacement();
  });
  // Enter in the first field moves on to the second instead of submitting a
  // half-filled replacement.
  document.getElementById("replacementHeard").addEventListener("keydown", (event) => {
    if (event.isComposing || event.key !== "Enter") return;
    event.preventDefault();
    const wanted = document.getElementById("replacementWanted");
    if (wanted.value.trim()) submitReplacement();
    else wanted.focus();
  });
  // Enter that picks an IME candidate must not submit the form.
  document.getElementById("replacementWanted").addEventListener("keydown", (event) => {
    if (event.isComposing && event.key === "Enter") event.preventDefault();
  });
  applyDictionaryEngine();
  renderDictionary();
}

/* ---------- Navigation & misc ---------- */

async function showPage(pageId, options = {}) {
  if (pageId === "settings") pauseOnboarding();
  const page = document.getElementById(`${pageId}-page`);
  const alreadyShown = !!page?.classList.contains("active");
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.remove("active");
  });
  if (page) {
    // Pages share one scroller; without this a page opens wherever the last
    // one was left, with its title scrolled out of view.
    const scroller = document.querySelector(".main-content");
    if (scroller && !alreadyShown) scroller.scrollTop = 0;
    page.classList.add("active");
  }
  document.querySelectorAll(".nav-item[data-page]").forEach((item) => {
    item.classList.toggle("active", item.getAttribute("data-page") === pageId);
  });
  if (pageId === "history") {
    renderHistory();
  }
  if (pageId === "dictionary") {
    void refreshDictionaryLocalNote();
  }
  if (pageId === "settings") {
    await window.SayTypeSettings?.show?.(options.settingsTarget || null);
  }
  return !!page;
}

function openSettings(target = null) {
  void showPage("settings", { settingsTarget: target });
}

// Help = replay the onboarding wizard. It covers everything the old shortcut
// toast did (page 1 shows the live shortcuts) plus permissions and setup, and
// it's freely skippable.
function showHelp() {
  if (obPaused) resumeOnboarding();
  else showOnboarding();
}

async function copyToClipboard(text, button) {
  const icon = button.querySelector(".material-icons");
  const originalText = icon.textContent;
  try {
    await navigator.clipboard.writeText(text);
    icon.textContent = "check";
    button.style.color = "var(--status-success)";
  } catch (error) {
    console.error("Failed to copy text:", error);
    icon.textContent = "error";
    button.style.color = "var(--status-danger)";
  }
  setTimeout(() => {
    icon.textContent = originalText;
    button.style.color = "";
  }, 2000);
}

// Toasts live in one fixed column so two messages fired close together stack
// downward instead of landing on top of each other. Styling is in main.css —
// the element only carries state classes.
function notificationStack() {
  let stack = document.getElementById("notification-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "notification-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

function showNotification(message, type = "info") {
  const notification = document.createElement("div");
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  notificationStack().appendChild(notification);

  // Flush the just-inserted hidden state so the class change transitions from
  // it. Deliberately NOT requestAnimationFrame: this window is hidden rather
  // than closed, and rAF never fires while it is, which would leave a toast
  // parked off-screen forever.
  void notification.offsetHeight;
  notification.classList.add("visible");

  setTimeout(() => {
    notification.classList.remove("visible");
    setTimeout(() => {
      notification.remove();
    }, 300);
  }, 5000);
}

window.showPage = showPage;
window.openSettings = openSettings;

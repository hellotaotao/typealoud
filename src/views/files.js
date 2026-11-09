// The Files page: transcribe audio and video files with the current engine.
// The backend (file_transcription.rs) runs the jobs and keeps the results;
// this page only lists them, shows progress and offers copy and export.
(function () {
const READY_TIMEOUT_MS = 3000;
const READY_POLL_MS = 25;

let ipc = null;
let t = (key) => key;
let items = [];
let selectedId = null;
let settings = null;
let removeConfirmId = null;
let removeConfirmTimer = null;
let copiedTimer = null;
let initialized = false;

function translate(key, vars) {
  try {
    return t(key, vars);
  } catch {
    return key;
  }
}

async function waitForDependencies() {
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    if (window.__TYPEALOUD_IPC__ && window.TypeAloudI18n) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  return false;
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

function engineName(provider, model) {
  if (provider === "openai") return "OpenAI";
  if (provider === "groq") return "Groq";
  const id = String(model || "").toLowerCase();
  if (id.includes("nemotron")) return "Nemotron";
  if (id.includes("1.7b")) return translate("home.engineLocalQwenLarge");
  return `${translate("home.engineLocalQwen")} 0.6B`;
}

function errorMessage(code) {
  const value = String(code || "");
  if (value.startsWith("API key not configured")) return translate("files.errors.API_KEY");
  const key = value.split(":")[0].trim();
  const known = [
    "FILE_UNREADABLE",
    "FILE_UNSUPPORTED",
    "FILE_NO_AUDIO",
    "FILE_TOO_LONG",
    "FILE_NO_SPEECH",
    "FILE_INTERRUPTED",
    "FILE_ENGINE_FAILED",
    "LOCAL_MODEL_MISSING",
    "EXPORT_FAILED",
  ];
  return known.includes(key) ? translate(`files.errors.${key}`) : translate("files.errors.generic");
}

function isActive(item) {
  return item.status === "queued" || item.status === "running";
}

function statusText(item) {
  switch (item.status) {
    case "queued":
      return translate("files.queued");
    case "running": {
      if (!item.totalSegments) return translate("files.reading");
      const percent = Math.floor((item.doneSegments / item.totalSegments) * 100);
      return translate("files.progress", { percent });
    }
    case "failed":
      return translate("files.failed");
    case "cancelled":
      return translate("files.cancelled");
    default:
      return formatClock(item.durationSecs);
  }
}

function plainText(item) {
  return (item.segments || [])
    .map((segment) => String(segment.text || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Rendering

function renderEngineNote() {
  const note = document.getElementById("filesEngineNote");
  if (!note || !settings) return;
  const provider = settings.provider;
  const name = engineName(provider, settings.model);
  const local = provider !== "openai" && provider !== "groq";
  note.classList.toggle("files-engine-cloud", !local);
  const text = document.createElement("span");
  text.textContent = translate(local ? "files.engineLocal" : "files.engineCloud", { engine: name });
  const change = document.createElement("button");
  change.type = "button";
  change.className = "link-btn";
  change.textContent = translate("files.changeEngine");
  change.addEventListener("click", () => window.openSettings?.("engines"));
  note.replaceChildren(text, change);
}

function renderList() {
  const list = document.getElementById("filesList");
  if (!list) return;
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = translate("files.empty");
    list.replaceChildren(empty);
    return;
  }
  const rows = items.map((item) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "files-row";
    row.classList.toggle("selected", item.id === selectedId);
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", item.id === selectedId ? "true" : "false");
    row.addEventListener("click", () => {
      selectedId = item.id;
      renderList();
      renderDetail();
    });

    const icon = document.createElement("span");
    icon.className = "material-icons files-row-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = item.status === "failed" ? "error_outline" : isActive(item) ? "graphic_eq" : "description";

    const body = document.createElement("span");
    body.className = "files-row-body";
    const name = document.createElement("span");
    name.className = "files-row-name";
    name.textContent = item.fileName;
    const meta = document.createElement("span");
    meta.className = "files-row-meta";
    meta.classList.toggle("failed", item.status === "failed");
    meta.textContent = statusText(item);
    body.append(name, meta);

    row.append(icon, body);
    if (item.status === "running" && item.totalSegments) {
      const bar = document.createElement("span");
      bar.className = "files-row-progress";
      bar.style.setProperty("--progress", `${(item.doneSegments / item.totalSegments) * 100}%`);
      row.append(bar);
    }
    return row;
  });
  list.replaceChildren(...rows);
}

function actionButton(label, onClick, { primary = false, id = null } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = primary ? "btn" : "btn-secondary";
  if (id) button.id = id;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderDetail() {
  const panel = document.getElementById("filesDetail");
  if (!panel) return;
  const item = items.find((entry) => entry.id === selectedId);
  if (!item) {
    const hint = document.createElement("p");
    hint.className = "empty-state";
    hint.textContent = items.length ? translate("files.selectHint") : "";
    panel.replaceChildren(hint);
    return;
  }

  const header = document.createElement("div");
  header.className = "files-detail-header";
  const title = document.createElement("h3");
  title.className = "files-detail-title";
  title.textContent = item.fileName;
  const meta = document.createElement("p");
  meta.className = "files-detail-meta";
  const parts = [];
  if (item.durationSecs) parts.push(formatClock(item.durationSecs));
  parts.push(engineName(item.provider, item.model));
  if (isActive(item) || item.status === "failed" || item.status === "cancelled") parts.push(statusText(item));
  meta.textContent = parts.join(" · ");
  header.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "files-detail-actions";
  const hasText = (item.segments || []).length > 0;
  if (hasText) {
    actions.append(
      actionButton(translate("files.copy"), () => copyText(item), { primary: true, id: "filesCopyBtn" }),
      actionButton(translate("files.exportTxt"), () => exportItem(item, "txt")),
      actionButton(translate("files.exportSrt"), () => exportItem(item, "srt")),
    );
  }
  if (isActive(item)) {
    actions.append(actionButton(translate("files.stop"), () => ipc.invoke("cancel-file-transcript", item.id)));
  } else {
    const confirming = removeConfirmId === item.id;
    actions.append(
      actionButton(translate(confirming ? "files.confirmRemove" : "files.remove"), () => removeItem(item)),
    );
  }

  const nodes = [header, actions];
  if (item.status === "failed" && item.error) {
    const error = document.createElement("p");
    error.className = "files-detail-error";
    error.textContent = errorMessage(item.error);
    nodes.push(error);
  }

  const transcript = document.createElement("div");
  transcript.className = "files-transcript";
  for (const segment of item.segments || []) {
    const paragraph = document.createElement("div");
    paragraph.className = "files-paragraph";
    const time = document.createElement("span");
    time.className = "files-paragraph-time";
    time.textContent = formatClock(segment.start);
    const text = document.createElement("p");
    text.textContent = segment.text;
    paragraph.append(time, text);
    transcript.append(paragraph);
  }
  if (!hasText && item.status === "done") {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = translate("files.noText");
    transcript.append(empty);
  }
  nodes.push(transcript);
  if (hasText && (item.status === "failed" || item.status === "cancelled")) {
    const partial = document.createElement("p");
    partial.className = "files-detail-note";
    partial.textContent = translate("files.partial");
    nodes.push(partial);
  }
  if (isActive(item)) {
    const note = document.createElement("p");
    note.className = "files-detail-note";
    note.textContent = translate("files.dictationNote");
    nodes.push(note);
  }
  panel.replaceChildren(...nodes);
}

function render() {
  if (!initialized) return;
  renderEngineNote();
  renderList();
  renderDetail();
}

// ---------------------------------------------------------------------------
// Actions

function showError(code) {
  const status = document.getElementById("filesStatus");
  if (!status) return;
  status.textContent = errorMessage(code);
  status.hidden = false;
}

function clearError() {
  const status = document.getElementById("filesStatus");
  if (status) {
    status.textContent = "";
    status.hidden = true;
  }
}

async function queued(promise) {
  clearError();
  try {
    const ids = await promise;
    if (Array.isArray(ids) && ids.length) {
      selectedId = ids[ids.length - 1];
      await reload();
    }
  } catch (error) {
    showError(error);
  }
}

async function copyText(item) {
  try {
    await ipc.invoke("copy-to-clipboard", plainText(item));
    const button = document.getElementById("filesCopyBtn");
    if (button) {
      button.textContent = translate("files.copied");
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => renderDetail(), 1500);
    }
  } catch (error) {
    showError(error);
  }
}

async function exportItem(item, format) {
  clearError();
  try {
    await ipc.invoke("export-file-transcript", item.id, format);
  } catch (error) {
    showError(error);
  }
}

async function removeItem(item) {
  if (removeConfirmId !== item.id) {
    removeConfirmId = item.id;
    clearTimeout(removeConfirmTimer);
    removeConfirmTimer = setTimeout(() => {
      removeConfirmId = null;
      renderDetail();
    }, 3000);
    renderDetail();
    return;
  }
  removeConfirmId = null;
  clearTimeout(removeConfirmTimer);
  await ipc.invoke("delete-file-transcript", item.id);
  if (selectedId === item.id) selectedId = null;
  await reload();
}

async function reload() {
  try {
    items = (await ipc.invoke("get-file-transcripts")) || [];
  } catch (error) {
    console.error("Failed to load file transcripts:", error);
    items = [];
  }
  if (!items.some((item) => item.id === selectedId)) {
    selectedId = items[0]?.id ?? null;
  }
  render();
}

async function refreshSettings() {
  try {
    settings = await ipc.invoke("get-settings");
  } catch {
    settings = null;
  }
  renderEngineNote();
}

function setDragState(payload) {
  const drop = document.getElementById("filesDrop");
  if (!drop) return;
  const active = !!payload?.active;
  drop.classList.toggle("dragging", active && payload.media !== false);
  drop.classList.toggle("rejecting", active && payload.media === false);
  const title = document.getElementById("filesDropTitle");
  if (title) {
    title.textContent = translate(
      !active ? "files.dropTitle" : payload.media === false ? "files.dropNotMedia" : "files.dropActive",
    );
  }
}

function applyUpdate(payload) {
  if (!payload?.id) return;
  if (payload.deleted) {
    items = items.filter((item) => item.id !== payload.id);
  } else {
    const index = items.findIndex((item) => item.id === payload.id);
    if (index >= 0) items[index] = payload;
    else items.unshift(payload);
  }
  if (!items.some((item) => item.id === selectedId)) selectedId = items[0]?.id ?? null;
  renderList();
  if (payload.id === selectedId || payload.deleted) renderDetail();
}

async function init() {
  if (initialized) return;
  if (!(await waitForDependencies())) return;
  ipc = window.__TYPEALOUD_IPC__;
  t = window.TypeAloudI18n.t;
  initialized = true;

  document.getElementById("filesPickBtn")?.addEventListener("click", () => {
    void queued(ipc.invoke("pick-transcription-files"));
  });
  ipc.on("file-transcript-updated", (_event, payload) => applyUpdate(payload));
  ipc.on("file-drag", (_event, payload) => {
    if (payload?.active && !document.getElementById("files-page")?.classList.contains("active")) {
      void window.showPage?.("files");
    }
    setDragState(payload);
  });
  ipc.on("files-dropped", (_event, payload) => {
    const paths = Array.isArray(payload?.paths) ? payload.paths : [];
    if (!paths.length) return;
    void window.showPage?.("files");
    void queued(ipc.invoke("transcribe-files", paths));
  });
  await reload();
  await refreshSettings();
}

async function show() {
  await init();
  await Promise.all([reload(), refreshSettings()]);
}

window.TypeAloudFiles = { show, render };
void init();
})();

document.documentElement.setAttribute("data-ax-cloud-js-ran", "1");

const ipc = window.__TYPEALOUD_IPC__;
const { initI18n, t } = window.TypeAloudI18n;

async function initAxCloud() {
  // Pull the UI language from settings so the cloud matches the rest of the
  // app; fall back to auto-detect if settings aren't reachable.
  try {
    const settings = await ipc.invoke("get-settings");
    initI18n(settings?.uiLanguage);
  } catch (error) {
    console.error("Failed to load UI language for the drag cloud:", error);
    initI18n("auto");
  }

  document.getElementById("hint").textContent = t("axCloud.hint");
  document.getElementById("closeBtn").setAttribute("aria-label", t("axCloud.close"));

  document.getElementById("closeBtn").addEventListener("click", () => {
    // This window is focus:false, so it receives no keyboard events — this
    // button is the only manual way to dismiss the cloud.
    ipc.invoke("dismiss-ax-cloud").catch((error) => {
      console.error("Failed to dismiss the drag cloud:", error);
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { void initAxCloud(); }, { once: true });
} else {
  void initAxCloud();
}

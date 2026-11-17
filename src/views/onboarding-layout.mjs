// Keep hardware presentation separate from persisted engine intent and readiness.
export function onboardingSteps(os) {
  // The shortcut step follows Accessibility: on macOS the key can't be heard,
  // and so can't be tested, until that permission is granted.
  return ["welcome", "privacy", "engine", "microphone", ...(os === "macos" ? ["accessibility"] : []), "shortcut", "practice"];
}

export function onboardingEngineLayout(localTier, nemotronSupported) {
  // Qwen 1.7B is a size inside the Qwen engine, offered from Settings once the
  // machine has shown it is fast enough; first-run only chooses local or cloud.
  const small = { value: "local-qwen", recommended: true };
  const openai = { value: "openai" };
  const more = [{ value: "groq" }, ...(nemotronSupported ? [{ value: "local-nemotron" }] : [])];
  if (localTier === "cloud-default") {
    return { main: [{ ...openai, note: "cloudDefault" }, { ...small, note: "localSlow" }], more };
  }
  return { main: [small, openai], more };
}

export function onboardingEngineState(settings, statuses) {
  const valid = ["local", "openai", "groq"].includes(settings?.provider);
  const ready = valid && settings.engineReady === true;
  const downloading = settings?.provider === "local" && statuses[settings.model]?.state === "downloading";
  return { selected: ready || downloading, ready };
}

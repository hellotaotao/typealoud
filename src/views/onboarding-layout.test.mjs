import assert from "node:assert/strict";
import test from "node:test";

const module = await import("./onboarding-layout.mjs").catch(() => ({}));
const small = "local-qwen", large = "local-qwen-large", nemotron = "local-nemotron";

test("onboarding uses named steps, with engine before permissions and no non-macOS Accessibility", () => {
  assert.equal(typeof module.onboardingSteps, "function", "named-step policy must exist");
  assert.deepEqual(module.onboardingSteps("macos"), ["welcome", "privacy", "engine", "microphone", "accessibility", "shortcut", "practice"]);
  for (const os of ["windows", "linux"]) assert.deepEqual(module.onboardingSteps(os), ["welcome", "privacy", "engine", "microphone", "shortcut", "practice"]);
});

test("onboarding offers Qwen and OpenRouter up front, OpenAI and Nemotron under more, and never 1.7B", () => {
  assert.equal(typeof module.onboardingEngineLayout, "function", "tier layout policy must exist");
  for (const [tier, main] of [
    ["qwen", [small, "openrouter"]],
    ["cloud-default", ["openrouter", small]],
  ]) {
    const layout = module.onboardingEngineLayout(tier, true);
    assert.deepEqual(layout.main.map(card => card.value), main);
    assert.deepEqual(layout.more.map(card => card.value), ["openai", nemotron]);
    const cards = [...layout.main, ...layout.more];
    assert.deepEqual(cards.filter(card => card.recommended).map(card => card.value), [small]);
    assert.equal(cards.some(card => card.value === large), false);
    assert.equal(module.onboardingEngineLayout(tier, false).more.some(card => card.value === nemotron), false);
  }
  assert.deepEqual(module.onboardingEngineLayout("unknown", false), module.onboardingEngineLayout("qwen", false));
});

test("selected downloading local engine permits Next but never unlocks practice", () => {
  assert.equal(typeof module.onboardingEngineState, "function", "selection and readiness must be separate");
  const settings = {provider: "local", model: "qwen", engineReady: false};
  assert.deepEqual(module.onboardingEngineState(settings, {qwen:{state:"downloading"}}), {selected: true, ready: false});
  for (const state of ["absent", "partial", "error"]) assert.deepEqual(module.onboardingEngineState(settings, {qwen:{state}}), {selected:false, ready:false});
  assert.deepEqual(module.onboardingEngineState({...settings, engineReady:true}, {qwen:{state:"ready"}}), {selected:true,ready:true});
  assert.deepEqual(module.onboardingEngineState({provider:"openrouter",engineReady:false}, {qwen:{state:"downloading"}}), {selected:false,ready:false});
});

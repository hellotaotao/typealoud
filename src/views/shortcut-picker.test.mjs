import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL("./shortcut-picker.js", import.meta.url), "utf8"), context);
const shortcuts = context.TypeAloudShortcuts;
const translate = (key, vars) => (key === "shortcut.right" ? `Right ${vars.key}` : key);

test("each platform leads with its new-install default", () => {
  // Must match settings.rs new_install_shortcut.
  assert.equal(shortcuts.options("macos")[0].value, "RightMeta");
  assert.equal(shortcuts.options("windows")[0].value, "Ctrl+Meta");
  assert.equal(shortcuts.options("linux")[0].value, "Ctrl+Shift");
  for (const os of ["macos", "windows", "linux"]) {
    assert.deepEqual(shortcuts.options(os).filter((option) => option.recommended).length, 1);
  }
});

test("a saved shortcut outside the list stays visible as the current one", () => {
  const list = shortcuts.options("macos", "Ctrl+Shift+Alt");
  assert.equal(list[0].value, "Ctrl+Shift+Alt");
  assert.equal(list[0].note, "current");
  assert.equal(shortcuts.options("macos", "RightMeta").filter((option) => option.value === "RightMeta").length, 1);
});

test("keycaps and labels name the right-hand key and use platform words", () => {
  assert.deepEqual([...shortcuts.keycaps("RightAlt", "macos", translate)], ["Right ⌥"]);
  assert.deepEqual([...shortcuts.keycaps("Ctrl+Shift", "macos", translate)], ["⌃", "⇧"]);
  assert.deepEqual([...shortcuts.keycaps("Ctrl+Meta", "windows", translate)], ["Ctrl", "Win"]);
  assert.deepEqual([...shortcuts.keycaps("Ctrl+Meta", "linux", translate)], ["Ctrl", "Super"]);
  assert.equal(shortcuts.label("RightAlt", "macos", translate), "Right Option");
  assert.equal(shortcuts.label("Ctrl+Alt", "macos", translate), "Control + Option");
  assert.equal(shortcuts.label("RightCtrl", "windows", translate), "Right Ctrl");
  // Older spellings saved by previous versions still render.
  assert.deepEqual([...shortcuts.keycaps("control+option", "macos", translate)], ["⌃", "⌥"]);
});

test("the tester passes on the first held press and teaches the double tap", () => {
  let state = { phase: "idle", passed: false, held: false, down: [] };
  state = shortcuts.nextTestState(state, { held: false, down: ["alt"], action: null });
  assert.equal(state.passed, false);
  state = shortcuts.nextTestState(state, { held: true, down: ["alt"], action: "start" });
  assert.equal(state.phase, "held");
  assert.equal(state.passed, true);
  state = shortcuts.nextTestState(state, { held: false, down: [], action: "stop" });
  assert.equal(state.phase, "heldOk");
  state = shortcuts.nextTestState(state, { held: true, down: ["alt"], action: "start" });
  state = shortcuts.nextTestState(state, { held: true, down: ["alt"], action: "lock" });
  assert.equal(state.phase, "locked");
  state = shortcuts.nextTestState(state, { held: true, down: ["alt"], action: "stop" });
  assert.equal(state.phase, "done");
  // A quick tap later doesn't take the pass away.
  state = shortcuts.nextTestState(state, { held: false, down: [], action: "tap" });
  assert.equal(state.phase, "tooShort");
  assert.equal(state.passed, true);
});

test("only a single right-hand key needs to be seen working before it is kept", () => {
  const { isOneSided } = shortcuts;
  assert.equal(isOneSided("RightAlt"), true);
  assert.equal(isOneSided("RightMeta"), true);
  assert.equal(isOneSided("RightCtrl"), true);
  assert.equal(isOneSided("Ctrl+Meta"), false);
  assert.equal(isOneSided("Ctrl+Shift"), false);
  assert.equal(isOneSided(""), false);
});

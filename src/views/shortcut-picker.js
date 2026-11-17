// Record-shortcut choices, keycap labels and the live shortcut tester, shared
// by the onboarding wizard, Settings (main window) and the recording prompt's
// hint. Plain script: exposes window.TypeAloudShortcuts.
(() => {
  // Per platform, the first entry is the new-install default (settings.rs
  // new_install_shortcut). `more` entries sit behind "More combinations".
  const OPTIONS = {
    macos: [
      { value: "RightAlt", recommended: true, note: "rightAlt" },
      { value: "RightMeta", note: "rightMeta" },
      { value: "Ctrl+Shift", note: "ctrlShift" },
      { value: "Ctrl+Alt", more: true },
      { value: "Ctrl+Meta", more: true },
      { value: "Alt+Meta", more: true },
    ],
    windows: [
      { value: "Ctrl+Meta", recommended: true, note: "ctrlWin" },
      { value: "RightCtrl", note: "rightCtrl" },
      { value: "Ctrl+Shift", note: "ctrlShiftWindows" },
      { value: "Ctrl+Alt", more: true, note: "ctrlAltWindows" },
    ],
    linux: [
      { value: "Ctrl+Shift", recommended: true },
      { value: "Ctrl+Alt" },
      { value: "Ctrl+Meta" },
      { value: "RightCtrl", note: "rightCtrl" },
    ],
  };

  const ALIASES = {
    ctrl: "ctrl", control: "ctrl",
    shift: "shift",
    alt: "alt", option: "alt",
    meta: "meta", cmd: "meta", command: "meta", super: "meta", win: "meta", windows: "meta",
  };

  function normalizeOs(os) {
    const value = String(os || "").toLowerCase();
    if (value === "macos" || value === "windows" || value === "linux") return value;
    const platform = typeof navigator === "undefined" ? "" : navigator.platform || "";
    return /Mac/i.test(platform) ? "macos" : /Win/i.test(platform) ? "windows" : "linux";
  }

  // "Ctrl+RightAlt" -> [{ key: "ctrl", right: false }, { key: "alt", right: true }]
  function parseKeys(shortcut) {
    return String(shortcut || "")
      .split("+")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean)
      .map((part) => {
        const right = part.startsWith("right") && part.length > 5;
        const name = right ? part.slice(5) : part;
        return { key: ALIASES[name] || name, right };
      });
  }

  function keyName(key, os, glyphs) {
    if (os === "macos") {
      const names = glyphs
        ? { ctrl: "⌃", shift: "⇧", alt: "⌥", meta: "⌘" }
        : { ctrl: "Control", shift: "Shift", alt: "Option", meta: "Command" };
      return names[key] || key;
    }
    const words = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", meta: os === "linux" ? "Super" : "Win" };
    return words[key] || key;
  }

  function withSide(name, right, translate) {
    return right ? translate("shortcut.right", { key: name }) : name;
  }

  // One label per keycap: Apple glyphs on macOS, words elsewhere.
  function keycaps(shortcut, os, translate) {
    const platform = normalizeOs(os);
    return parseKeys(shortcut).map(({ key, right }) => withSide(keyName(key, platform, true), right, translate));
  }

  // A plain-text label for running copy ("Right Option", "Ctrl + Win").
  function label(shortcut, os, translate) {
    const platform = normalizeOs(os);
    return parseKeys(shortcut)
      .map(({ key, right }) => withSide(keyName(key, platform, false), right, translate))
      .join(" + ");
  }

  function options(os, current) {
    const list = (OPTIONS[normalizeOs(os)] || OPTIONS.linux).map((option) => ({ ...option }));
    if (current && !list.some((option) => option.value === current)) {
      list.unshift({ value: current, note: "current" });
    }
    return list;
  }

  // What the tester says after each probe event. `passed` turns true once the
  // whole shortcut was seen held, which is all the wizard needs to go on.
  function nextTestState(state, probe) {
    const next = { ...state, held: !!probe?.held, down: probe?.down || [] };
    switch (probe?.action) {
      case "start":
        return { ...next, phase: "held", passed: true };
      case "stop":
        return { ...next, phase: state.phase === "locked" ? "done" : "heldOk" };
      case "lock":
        return { ...next, phase: "locked" };
      case "tap":
        return { ...next, phase: "tooShort" };
      case "cancel":
        return { ...next, phase: "interrupted" };
      default:
        return next;
    }
  }

  const IDLE_HINT_MS = 8000;

  // A list of shortcut cards with a tester under it. The owner saves the
  // choice (`onSelect`, which resolves to the stored value) and forwards the
  // backend's `hotkey-probe` events while the tester is the visible one.
  function createPicker({ os, translate, onSelect }) {
    const platform = normalizeOs(os);
    const root = document.createElement("div");
    root.className = "shortcut-picker";
    const list = document.createElement("div");
    list.className = "shortcut-options";
    list.setAttribute("role", "radiogroup");
    const more = document.createElement("div");
    more.className = "shortcut-options shortcut-options-more";
    more.setAttribute("role", "radiogroup");
    const moreToggle = document.createElement("button");
    moreToggle.type = "button";
    moreToggle.className = "link-btn shortcut-more-toggle";
    const tester = document.createElement("div");
    tester.className = "shortcut-tester";
    const caps = document.createElement("div");
    caps.className = "shortcut-test-keys";
    const status = document.createElement("div");
    status.className = "shortcut-test-status";
    status.setAttribute("aria-live", "polite");
    tester.append(caps, status);
    root.append(list, moreToggle, more, tester);

    let current = "";
    let saving = false;
    let moreOpen = false;
    let unavailableKey = "";
    let idleTimer = null;
    let test = { phase: "idle", passed: false, held: false, down: [], idleHint: false };

    function resetTest() {
      test = { phase: "idle", passed: false, held: false, down: [], idleHint: false };
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        idleTimer = null;
        if (test.phase === "idle" && !test.down.length) {
          test.idleHint = true;
          renderTester();
        }
      }, IDLE_HINT_MS);
    }

    function card(option) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "shortcut-option";
      button.setAttribute("role", "radio");
      button.dataset.value = option.value;
      const keys = document.createElement("span");
      keys.className = "shortcut-option-keys";
      for (const cap of keycaps(option.value, platform, translate)) {
        const kbd = document.createElement("span");
        kbd.className = "kbd";
        kbd.textContent = cap;
        keys.appendChild(kbd);
      }
      if (option.recommended) {
        const tag = document.createElement("span");
        tag.className = "shortcut-option-tag";
        tag.textContent = translate("shortcut.recommended");
        keys.appendChild(tag);
      }
      button.appendChild(keys);
      if (option.note) {
        const note = document.createElement("span");
        note.className = "shortcut-option-note";
        note.textContent = translate(`shortcut.notes.${option.note}`);
        button.appendChild(note);
      }
      button.addEventListener("click", () => void choose(option.value));
      return button;
    }

    async function choose(value) {
      if (saving || value === current) return;
      saving = true;
      render();
      try {
        current = (await onSelect(value)) || value;
        resetTest();
      } catch (error) {
        console.error("Failed to save the record shortcut:", error);
      } finally {
        saving = false;
        render();
      }
    }

    function renderTester() {
      const downKeys = new Set(test.down);
      caps.replaceChildren(...parseKeys(current).map(({ key, right }) => {
        const kbd = document.createElement("span");
        kbd.className = "kbd shortcut-test-key";
        kbd.classList.toggle("down", downKeys.has(key));
        kbd.textContent = withSide(keyName(key, platform, true), right, translate);
        return kbd;
      }));
      tester.classList.toggle("held", test.held);
      tester.classList.toggle("passed", test.passed);
      let key = `shortcut.test.${test.phase}`;
      if (unavailableKey) key = unavailableKey;
      else if (test.phase === "idle" && test.idleHint) key = "shortcut.test.noKeys";
      status.textContent = translate(key, { keys: label(current, platform, translate) });
    }

    function render() {
      const entries = options(platform, current);
      const main = entries.filter((option) => !option.more || option.value === current);
      const extra = entries.filter((option) => option.more && option.value !== current);
      const signature = `${main.map((option) => option.value).join("|")}/${extra.map((option) => option.value).join("|")}`;
      if (root.dataset.options !== signature) {
        root.dataset.options = signature;
        list.replaceChildren(...main.map(card));
        more.replaceChildren(...extra.map(card));
      }
      for (const button of root.querySelectorAll(".shortcut-option")) {
        const selected = button.dataset.value === current;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-checked", String(selected));
        button.disabled = saving;
      }
      moreToggle.hidden = !extra.length;
      more.hidden = !extra.length || !moreOpen;
      moreToggle.textContent = translate(moreOpen ? "shortcut.lessCombos" : "shortcut.moreCombos");
      moreToggle.setAttribute("aria-expanded", String(moreOpen));
      renderTester();
    }

    moreToggle.addEventListener("click", () => {
      moreOpen = !moreOpen;
      render();
    });

    return {
      element: root,
      setValue(value) {
        if (value && value !== current) {
          current = value;
          resetTest();
        }
        render();
      },
      // A reason the tester cannot hear the keys (an i18n key), or "".
      setUnavailable(reasonKey) {
        unavailableKey = reasonKey || "";
        renderTester();
      },
      // Rebuild the cards, e.g. after the UI language changed.
      refresh() {
        root.dataset.options = "";
        render();
      },
      restartTest() {
        resetTest();
        renderTester();
      },
      handleProbe(probe) {
        test = nextTestState(test, probe);
        if (test.down.length) test.idleHint = false;
        renderTester();
      },
      get passed() {
        return test.passed;
      },
    };
  }

  const api = { options, keycaps, label, parseKeys, nextTestState, createPicker };
  if (typeof window !== "undefined") window.TypeAloudShortcuts = api;
  if (typeof globalThis !== "undefined") globalThis.TypeAloudShortcuts = api;
})();

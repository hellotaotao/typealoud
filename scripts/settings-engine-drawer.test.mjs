import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8");
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function container(id) {
  return {
    id, hidden: true, children: [],
    appendChild(node) { return this.insertBefore(node, null); },
    insertBefore(node, reference) {
      const previous = node.parentElement?.children;
      if (previous) previous.splice(previous.indexOf(node), 1);
      const index = reference ? this.children.indexOf(reference) : -1;
      if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
      node.parentElement = this;
      return node;
    },
  };
}
function harness() {
  const choices = ["local-qwen", "local-qwen-large", "openrouter", "openai"];
  const nodes = {};
  // Both Qwen sizes share the Qwen row's drawer; 1.7B has no row of its own.
  for (const choice of choices.filter(choice => choice !== "local-qwen-large")) {
    nodes[`engine-drawer-${choice}`] = container(`engine-drawer-${choice}`);
    nodes[`engine-disclosure-${choice}`] = { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } };
  }
  for (const id of ["engineAdvanced", "engineActivation", "apiKeyItem", "modelItem"]) nodes[id] = { id };
  nodes.providerSelect = { value: "local-qwen", options: choices.map(value => ({ value })) };
  nodes.modelSelect = { value: "openrouter-model", options: [{ value: "openrouter-model" }] };
  const context = vm.createContext({
    document: { getElementById: id => nodes[id] },
    ENGINE_CARDS: choices.map(value => ({ value, group: value === "local-qwen-large" ? "size" : value === "openrouter" ? "more" : "main" })),
    engineMoreExpanded: false,
    isQwenChoice: value => value === "local-qwen" || value === "local-qwen-large",
    engineRowFor: value => value === "local-qwen-large" ? "local-qwen" : value,
    expandedEngineProvider: "local-qwen", inspectedLocalModel: null,
    engineCloudDrafts: new Map(), currentSettings: { provider: "local", model: "small" },
    localModelForProvider: choice => choice === "local-qwen" ? "small" : choice === "local-qwen-large" ? "large" : "",
    providerForSettings: settings => settings.model === "large" ? "local-qwen-large" : "local-qwen",
    modelOptions: { openrouter: [{ value: "openrouter-model" }] },
    updateModelOptions() {}, setSelectValue(node, value) { node.value = value; },
    refreshLocalModelStatus: async () => {},
  });
  vm.runInContext(section("function syncEngineDrawer", "function camelKey") + "\n"
    + section("function inspectEngine", "function handleProviderChange"), context);
  context.toggleProviderFields = context.syncEngineDrawer;
  context.renderEngineCards = context.syncEngineDrawer;
  return { context, nodes, choices };
}

test("engine card click opens, closes, and reopens without changing the active engine", () => {
  const h = harness();
  h.context.inspectEngine("openrouter", { toggle: true });
  assert.equal(h.nodes["engine-drawer-openrouter"].hidden, false);
  assert.equal(h.nodes["engine-drawer-local-qwen"].hidden, true);
  assert.equal(h.nodes.apiKeyItem.parentElement, h.nodes["engine-drawer-openrouter"]);
  h.context.inspectEngine("openrouter", { toggle: true });
  assert.ok(h.choices.every(choice => h.nodes[`engine-drawer-${choice}`]?.hidden ?? true));
  assert.equal(h.nodes["engine-disclosure-openrouter"].attributes["aria-expanded"], "false");
  h.context.syncEngineDrawer();
  assert.equal(h.nodes["engine-drawer-openrouter"].hidden, true, "status refresh must not reopen a collapsed drawer");
  h.context.inspectEngine("openrouter", { toggle: true });
  assert.equal(h.nodes["engine-drawer-openrouter"].hidden, false);
  assert.equal(h.context.currentSettings.provider, "local");
  assert.equal(h.context.currentSettings.model, "small");
});

test("explicit deep link opens local details even when its card is already expanded", () => {
  const h = harness();
  h.context.inspectEngine("local-qwen-large");
  h.context.inspectEngine("local-qwen-large");
  assert.equal(h.nodes["engine-drawer-local-qwen"].hidden, false, "1.7B opens in the Qwen drawer");
  assert.equal(h.nodes.engineAdvanced.parentElement, h.nodes["engine-drawer-local-qwen"]);
  assert.equal(h.nodes.engineAdvanced.open, true);
  assert.equal(h.nodes["engine-disclosure-local-qwen"].attributes["aria-expanded"], "true");
  h.context.inspectEngine("local-qwen-large", { toggle: true });
  assert.equal(h.nodes["engine-drawer-local-qwen"].hidden, true);
});

test("opening an engine behind More engines expands that group", () => {
  const h = harness();
  h.context.inspectEngine("openrouter");
  assert.equal(h.context.engineMoreExpanded, true);
});

test("the chevron only opens and closes; the row itself chooses", () => {
  const render = section("function renderEngineCards", "function syncEngineDrawer");
  assert.match(render, /disclosure\.addEventListener\("click", \(\) => inspectEngine\(rowChoice\(entry\), \{ toggle: true \}\)\)/);
  assert.match(render, /card\.addEventListener\("click", \(\) => void chooseSettingsEngine\(rowChoice\(entry\)\)\)/);
  assert.match(render, /row\.append\(card, disclosure\)/);
  assert.doesNotMatch(source, /engine-select-button|selectSettingsEngine/);
});

test("engine cards show a decorative chevron driven by expansion state", () => {
  const render = section("function renderEngineCards", "function syncEngineDrawer");
  assert.match(render, /engine-card-chevron/);
  assert.match(render, /chevron\.setAttribute\("aria-hidden", "true"\)/);
  const css = readFileSync(new URL("../src/views/settings.css", import.meta.url), "utf8");
  assert.match(css, /\.engine-disclosure\[aria-expanded="true"\] \.engine-card-chevron/);
  // A full-width row with padding must not outgrow the list, whose overflow
  // clipping would cut the chevron off the right edge.
  assert.match(css, /\.engine-card-row \{[^}]*box-sizing: border-box;[^}]*width: 100%/);
});

test("a row click switches to a usable engine, but only opens one that is not usable yet", async () => {
  const calls = [];
  const ready = new Set(["local-qwen-large", "openrouter"]);
  const context = vm.createContext({
    engineSwitchPending: false,
    currentSettings: { provider: "local", model: "small" },
    ENGINE_CARDS: ["local-qwen", "local-qwen-large", "openrouter", "openai"].map(value => ({ value })),
    engineStatus: entry => ({ tone: ready.has(entry.value) || entry.value === "local-qwen" ? "ok" : "warn" }),
    providerForSettings: settings => settings.model === "large" ? "local-qwen-large" : "local-qwen",
    inspectEngine: (choice, options = {}) => calls.push(["inspect", choice, !!options.toggle]),
    inspectedEngineTarget: () => ({ provider: "local", model: "large" }),
    activateEngine: async target => calls.push(["activate", target.model]),
  });
  vm.runInContext(section("async function chooseSettingsEngine", "function renderEngineCards"), context);
  await context.chooseSettingsEngine("local-qwen-large");
  assert.deepEqual(calls.splice(0), [["inspect", "local-qwen-large", false], ["activate", "large"]]);
  await context.chooseSettingsEngine("openai");
  assert.deepEqual(calls.splice(0), [["inspect", "openai", true]], "a missing key opens the drawer without switching");
  await context.chooseSettingsEngine("local-qwen");
  assert.deepEqual(calls.splice(0), [["inspect", "local-qwen", true]], "the active engine's row only opens or closes");
  context.engineSwitchPending = true;
  await context.chooseSettingsEngine("openrouter");
  assert.equal(calls.length, 0);
});

test("drawer content starts where the row's title does", () => {
  const css = readFileSync(new URL("../src/views/settings.css", import.meta.url), "utf8");
  const block = selector => css.match(new RegExp(`${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]+)\\}`))[1];
  const px = (rule, property) => Number(rule.match(new RegExp(`${property}: ([\\d.]+)px`))[1]);
  const row = block(".engine-card-row");
  const rowPaddingLeft = Number(row.match(/padding: [\d.]+px ([\d.]+)px/)[1]);
  const choiceGap = px(block(".engine-choice"), "gap");
  const titleInset = rowPaddingLeft + px(block(".engine-check"), "width") + choiceGap
    + px(block(".engine-card-icon"), "font-size") + choiceGap;
  const drawerBorder = Number(block(".engine-drawer").match(/border-left: ([\d.]+)px/)[1]);
  const drawerPadding = Number(css.match(/\.engine-drawer \{ padding: [\d.]+px [\d.]+px [\d.]+px ([\d.]+)px; \}/)[1]);
  assert.equal(drawerBorder + drawerPadding, titleInset);
});

test("a cloud drawer keeps its key, model and notice in order after a local drawer was opened", () => {
  const h = harness();
  h.context.toggleProviderFields = () => h.context.syncEngineDrawer();
  for (const choice of ["openrouter", "local-qwen-large", "openrouter"]) h.context.inspectEngine(choice);
  const order = h.nodes["engine-drawer-openrouter"].children.map((node) => node.id);
  assert.deepEqual(order, ["apiKeyItem", "modelItem", "engineActivation"]);
});

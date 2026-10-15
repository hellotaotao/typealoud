import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const html = readFileSync(new URL("./main.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./main.css", import.meta.url), "utf8");
function extract(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start,-1,`${name} must exist`);
  const next = source.slice(start+1).search(/\n(?:async )?function /);
  return next === -1 ? source.slice(start) : source.slice(start,start+1+next);
}

test("named onboarding DOM follows approved page order and has scroll-safe content", () => {
  assert.deepEqual([...html.matchAll(/data-ob-step="([^"]+)"/g)].map(match=>match[1]),["welcome","privacy","engine","microphone","accessibility","practice"]);
  assert.match(css,/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css,/\.onboard-page\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css,/\.onboard-page-content\s*\{[^}]*margin-block:\s*auto/s);
});

test("onboarding stores local intent before starting download, and completion never reselects provider", async () => {
  const calls=[];
  const context=vm.createContext({
    obLocalErrors:{},obLocalStatuses:{},obLocalVersions:{},
    obSelectLocal:async model=>{calls.push(["select",model]);return true;},
    renderObLocal(){},renderObFooter(){},renderObFinal(){},
    obScheduleAdvance:step=>calls.push(["advance",step]),
    obRefreshLocalStatus(){},
    ipc:{invoke:async(...args)=>calls.push(args)},
  });
  vm.runInContext(extract("obStartLocalDownload"),context);
  await context.obStartLocalDownload("qwen");
  assert.deepEqual(calls.slice(0,2),[["select","qwen"],["download-local-model","qwen"]]);
  assert.ok(calls.some(call=>call[0]==="advance"&&call[1]==="engine"));
  const progress=source.slice(source.indexOf('ipc.on("local-model-download-progress"'),source.indexOf('ipc.on("activity-updated"'));
  assert.doesNotMatch(progress,/obSelectLocal|set-local-model|set-provider/);
});

test("opening Settings pauses the wizard and resume preserves its named step", async () => {
  assert.match(extract("showPage"),/pauseOnboarding/);
  const overlay={hidden:false};
  const context=vm.createContext({
    document:{getElementById:()=>overlay,querySelectorAll:()=>[]},
    window:{clearTimeout(){}},obCurrent:"microphone",obAdvanceTimer:123,obPaused:false,
    onboardingVisible:()=>!overlay.hidden,renderObResume(){},renderOnboarding(){},obRefreshMicState(){},obRefreshLocalStatus(){},refreshReadiness(){},
  });
  vm.runInContext(extract("pauseOnboarding")+"\n"+extract("resumeOnboarding"),context);
  context.pauseOnboarding();
  assert.equal(overlay.hidden,true);
  assert.equal(context.obPaused,true);
  context.resumeOnboarding();
  assert.equal(overlay.hidden,false);
  assert.equal(context.obCurrent,"microphone");
  assert.equal(context.obPaused,false);
});

test("unknown microphone does not block practice, while denial and permission prompt do", () => {
  const context=vm.createContext({obMicState:"unknown",obAxGranted:true,obEngineState:()=>({selected:true,ready:true})});
  vm.runInContext(extract("obStepSatisfied"),context);
  assert.equal(context.obStepSatisfied("microphone"),true);
  for(const state of ["prompt","not-determined","denied","restricted"]) {context.obMicState=state;assert.equal(context.obStepSatisfied("microphone"),false);}
});

test("practice gives feedback and a History fallback", () => {
  assert.match(html,/id="obTryFeedback"[^>]*aria-live="polite"/);
  assert.match(html,/onboarding.try.historyHint/);
  assert.match(source,/obTryInput"\)\?\.addEventListener\("input"/);
  assert.match(source.slice(source.indexOf('ipc.on("activity-updated"'),source.indexOf('ipc.on("accessibility-permission-changed"')),/obPracticeActivity/);
  assert.doesNotMatch(html, /id="obTryTip"/);
  assert.doesNotMatch(extract("renderObKeycaps"), /translateShortcut|onboarding.try.tip/);
  assert.match(extract("renderObFinal"),/obDownloadLabel/);
});

test("required settings and Qwen 1.7B copy is translated, with bounded local privacy", () => {
  const context=vm.createContext({window:{},document:{documentElement:{setAttribute(){}}},navigator:{language:"en"}});
  vm.runInContext(readFileSync(new URL("./i18n.js",import.meta.url),"utf8"),context);
  const {setLanguage,t}=context.window.TypeAloudI18n;
  for(const key of ["settings.pageSubtitle","settings.engine.active","settings.engine.activeModel","settings.engine.details","settings.engine.notReadyKey","settings.engine.notReadyDownload","settings.engine.switchFailed","settings.engine.invalidModel","settings.engine.keyRequired","settings.engine.cloudNotice","settings.engine.qwen.description","settings.engine.more","settings.engine.qwenSize.suggest","settings.engine.qwenSize.slow","home.engineMore","home.engineCaptionLocalQwenLarge","settings.apiProvider.localQwenLarge"]) {
    setLanguage("en");const en=t(key);setLanguage("zh");assert.notEqual(t(key),en,key);assert.match(t(key),/[\u4e00-\u9fff]/,key);
  }
  assert.match(t("onboarding.privacy.title"),/本地听写/);
  assert.doesNotMatch(t("onboarding.key.groqDesc"),/大多数|免费随便/);
});

test("engine advance is scheduled before a long model download resolves", async () => {
  let finishDownload;
  const advances=[];
  const context=vm.createContext({
    obLocalErrors:{},obLocalStatuses:{},obLocalVersions:{},
    obSelectLocal:async()=>true,
    renderObLocal(){},renderObFooter(){},renderObFinal(){},obRefreshLocalStatus(){},
    obScheduleAdvance:step=>advances.push(step),
    ipc:{invoke:()=>new Promise(resolve=>{finishDownload=resolve;})},
  });
  vm.runInContext(extract("obStartLocalDownload"),context);
  let finished=false;
  const task=context.obStartLocalDownload("qwen").then(()=>{finished=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(advances,["engine"]);
  assert.equal(finished,false);
  assert.equal(context.obLocalStatuses.qwen.state,"downloading");
  finishDownload(true);await task;
});

test("the download event handler preserves a Groq choice made while local download runs", () => {
  const handlers={}, mutations=[];
  const context=vm.createContext({
    cachedSettings:{provider:"groq",engineReady:true},obLocalVersions:{},obLocalStatuses:{},obLocalErrors:{},
    normalizeLocalModel:model=>model,applyEngineDownloadProgress(){},renderHomeLocalReadiness(){},renderObLocal(){},renderObFooter(){},renderObFinal(){},refreshReadiness(){},obRefreshLocalStatus(){},
    obSelectLocal:model=>{mutations.push(model);context.cachedSettings.provider="local";},
    ipc:{on:(event,handler)=>{handlers[event]=handler;}},
  });
  const progress=source.slice(source.indexOf('ipc.on("local-model-download-progress"'),source.indexOf('ipc.on("activity-updated"'));
  vm.runInContext(progress,context);
  handlers["local-model-download-progress"](null,{model:"qwen",state:"ready",downloadedBytes:100,totalBytes:100});
  assert.equal(context.cachedSettings.provider,"groq");
  assert.equal(context.obLocalStatuses.qwen.state,"ready");
  assert.deepEqual(mutations,[]);
});

test("resuming after a Settings provider switch uses the current provider's key form", () => {
  const input={value:"previous-provider-secret"};
  const context=vm.createContext({
    onboardingVisible:()=>true,
    cachedSettings:{provider:"groq",engineReady:true},obKeyProvider:"openai",obSelectionPending:false,obKeyStatus:"idle",obKeyError:"",
    document:{querySelectorAll:()=>[],getElementById:id=>id==="obKeyInput"?input:null},t:key=>key,
  });
  vm.runInContext(extract("renderObKey"),context);
  context.renderObKey();
  assert.equal(context.obKeyProvider,"groq");
  assert.equal(input.value,"");
});

test("Home local-model readiness stays actionable when ready and reacts to download progress", () => {
  const makeNode=tag=>({tag,children:[],listeners:{},appendChild(node){this.children.push(node);},addEventListener(event,handler){this.listeners[event]=handler;}});
  const label={textContent:""};
  const context=vm.createContext({
    document:{createElement:makeNode,getElementById:()=>label},makeIcon:()=>makeNode("icon"),
    cachedSettings:{provider:"local",model:"qwen"},engineAvailability:new Map([["local-qwen",{state:"downloading"}]]),
    selectedEngineValue:()=>"local-qwen",obDownloadLabel:()=>"35%",t:()=>"Local model",
  });
  vm.runInContext(extract("buildPill"),context);
  const onFix=()=>{};
  const pill=context.buildPill({label:"Ready",ok:true,onFix,alwaysAction:true,labelId:"homeLocalModelStatus"});
  assert.equal(pill.tag,"button");
  assert.equal(pill.listeners.click,onFix);
  assert.equal(pill.children[1].id,"homeLocalModelStatus");
  vm.runInContext(extract("renderHomeLocalReadiness"),context);
  context.renderHomeLocalReadiness();
  assert.equal(label.textContent,"Local model · 35%");
});

test("onboarding card includes padding inside viewport-limited dimensions", () => {
  assert.match(css, /\.onboard-card\s*\{[^}]*box-sizing:\s*border-box/s);
});

function testNode(tag = "div") {
  return {
    tag, children: [], hidden: false, textContent: "", attrs: {}, listeners: {},
    classList: { toggle() {} },
    appendChild(node) { this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    focus(options) { this.focusOptions = options; },
  };
}

test("privacy explains local dictation without a cloud routing diagram or translation", () => {
  const privacy = html.slice(html.indexOf('data-ob-step="privacy"'), html.indexOf('<!-- Engine -->'));
  assert.doesNotMatch(privacy, /ob-flow-arrow|nodeCloud|privacy\.arrow|privacy\.line1/);
  const context = vm.createContext({window:{},document:{documentElement:{setAttribute(){}}},navigator:{language:"en"}});
  vm.runInContext(readFileSync(new URL("./i18n.js",import.meta.url),"utf8"),context);
  for (const language of ["en", "zh"]) {
    context.window.TypeAloudI18n.setLanguage(language);
    const copy = [...privacy.matchAll(/data-i18n="([^"]+)"/g)].map(match => context.window.TypeAloudI18n.t(match[1])).join(" ");
    assert.doesNotMatch(copy, /Groq|OpenAI|API|\bkey\b|translat|云端|翻译|账户/i);
    assert.match(copy, language === "zh" ? /本地/ : /local/i);
  }
});

test("local and cloud engine cards have explicit icons and local benefit badges", () => {
  const context = vm.createContext({
    ENGINE_OPTIONS:[{value:"local-qwen",model:"qwen"},{value:"openai",label:"OpenAI"}],
    document:{createElement:testNode},makeIcon:name=>({...testNode("span"),textContent:name}),t:key=>key,
  });
  vm.runInContext(extract("obEngineCard"),context);
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const local = flatten(context.obEngineCard({value:"local-qwen",recommended:true}));
  const cloud = flatten(context.obEngineCard({value:"openai"}));
  assert.ok(local.some(node => node.textContent === "computer"));
  assert.ok(cloud.some(node => node.textContent === "cloud"));
  assert.ok(local.some(node => node.textContent === "onboarding.key.localRecommendedTag"));
  assert.ok(local.some(node => node.textContent === "onboarding.key.localKind"));
  assert.ok(cloud.some(node => node.textContent === "onboarding.key.cloudKind"));
});

test("ready practice hides the checklist and focuses without scrolling away the title", () => {
  const nodes = Object.fromEntries(["obTryTitle","obTryLead","obFinalIcon","obTryBox","obTryInput","obChecklist","obHistoryHint"].map(id=>[id,testNode()]));
  const page = {...testNode(),scrollTop:180};
  const context = vm.createContext({
    onboardingVisible:()=>true,obCurrent:"practice",obTryFocused:false,obPracticeActivity:false,
    obEngineState:()=>({ready:true}),obStepSatisfied:()=>true,obSteps:()=>["engine","microphone","accessibility","practice"],obAxGranted:true,
    cachedSettings:{provider:"local",model:"qwen"},obMicState:"granted",engineAvailability:new Map(),
    t:key=>key,
    document:{getElementById:id=>nodes[id]||null,querySelector:()=>page,createElement:testNode},
    makeIcon:name=>({...testNode(),textContent:name}),obDownloadLabel:()=>"Ready",
  });
  vm.runInContext(extract("renderObReadySummary")+"\n"+extract("renderObFinal"),context);
  context.renderObFinal();
  assert.equal(nodes.obChecklist.hidden,true);
  assert.equal(nodes.obChecklist.children.length,0);
  assert.equal(nodes.obTryBox.hidden,false);
  assert.equal(nodes.obTryInput.focusOptions?.preventScroll,true);
  assert.equal(page.scrollTop,0);
  page.scrollTop=20;
  context.renderObFinal();
  assert.equal(page.scrollTop,20,"background refresh must not move the user's scroll position");
});

test("Accessibility action remains connected to the native permission flow", () => {
  let opens=0;
  const container=testNode();
  const context=vm.createContext({
    document:{getElementById:()=>container},onboardingVisible:()=>true,obAxGranted:false,axGuideWaiting:false,axGuideTimedOut:false,t:key=>key,
    obActionButton:(label,click)=>({label,click}),obActionHint:label=>({label}),startAccessibilityFlow:()=>{opens++;},
  });
  vm.runInContext(extract("renderObAx"),context);
  context.renderObAx();
  assert.equal(container.children[0].label,"readiness.axGuide.open");
  container.children[0].click();
  assert.equal(opens,1);
});

test("Accessibility heading names TypeAloud as the actor", () => {
  const context=vm.createContext({window:{},document:{documentElement:{setAttribute(){}}},navigator:{language:"zh"}});
  vm.runInContext(readFileSync(new URL("./i18n.js",import.meta.url),"utf8"),context);
  context.window.TypeAloudI18n.setLanguage("zh");
  assert.equal(context.window.TypeAloudI18n.t("onboarding.ax.title"),"让 TypeAloud 为你输入文字");
});

test("compact practice summary reflects verified state and applicable platform steps", () => {
  const summary=testNode();
  const context=vm.createContext({
    document:{getElementById:()=>summary,createElement:testNode},
    makeIcon:name=>({...testNode(),textContent:name}),t:key=>key,obMicState:"granted",
  });
  vm.runInContext(extract("renderObReadySummary"),context);
  const steps=[{step:"engine",label:"Engine",ok:true},{step:"microphone",label:"Microphone",ok:true},{step:"accessibility",label:"Accessibility",ok:true}];
  context.renderObReadySummary(steps,true);
  assert.equal(summary.hidden,false);
  assert.equal(summary.children.length,3);
  assert.ok(summary.children.every(row=>row.children[0].textContent==="check"));
  context.obMicState="unknown";
  context.renderObReadySummary(steps.slice(0,2),true);
  assert.equal(summary.children.length,2);
  assert.equal(summary.children[1].children[0].textContent,"help_outline");
  assert.equal(summary.children[1].children[1].textContent,"onboarding.try.micUnchecked");
  context.renderObReadySummary(steps,false);
  assert.equal(summary.hidden,true);
  assert.equal(summary.children.length,0);
});

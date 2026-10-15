import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const promptSource=readFileSync(new URL('./input-prompt.js',import.meta.url),'utf8');
function copyMethod() {
 const body=promptSource.slice(promptSource.indexOf('  async copyFailedText()'),promptSource.indexOf('\n  clearInsertFailedUi()'));
 return vm.runInNewContext(`({${body}})`,{ipc:{invoke:()=>Promise.reject(new Error('busy'))},hasMeaningfulText:s=>!!s,textShape:()=>'',t:s=>s,console:{error(){}}}).copyFailedText;
}
test('copy failure is visible and preserves the recoverable text and button',async()=>{
 const p={_failedText:'中文\nHello 🌏',recoveryShownId:'one',recordingSessionId:4,pendingRecoveryUi:{id:'one'},statusText:{textContent:'',style:{}},copyBtn:{hidden:false},scheduleHidePrompt(){}};
 await copyMethod().call(p);
 assert.equal(p.statusText.textContent,'inputPrompt.copyFailed');
 assert.equal(p._failedText,'中文\nHello 🌏');assert.equal(p.copyBtn.hidden,false);assert.equal(p.pendingRecoveryUi.id,'one');
});
test('late copy failure does not replace a newer recording status',async()=>{
 const p={_failedText:'old',recoveryShownId:'one',recordingSessionId:4,isRecording:true,statusText:{textContent:'Listening',style:{}}};
 await copyMethod().call(p);assert.equal(p.statusText.textContent,'Listening');
});
function micHarness(getUserMedia,invoke=async(_command,outcome)=>({status:outcome==='ok'?'granted':outcome})) {
 const context=vm.createContext({window:{},navigator:{mediaDevices:{getUserMedia}},console:{warn(){}},setTimeout,clearTimeout});
 vm.runInContext(readFileSync(new URL('./microphone-access.js',import.meta.url),'utf8'),context);
 return {mic:context.window.TypeAloudMicrophone,ipc:{invoke}};
}
test('Windows probe closes every track before publishing readiness and never transcribes',async()=>{
 const calls=[];const {mic,ipc}=micHarness(async constraints=>{assert.equal(constraints.audio.echoCancellation,false);return{getTracks:()=>[{stop:()=>calls.push('stop')}]};},async(command,outcome)=>{calls.push([command,outcome]);return{status:'granted'};});
 assert.equal((await mic.probe(ipc,'windows')).status,'granted');
 assert.deepEqual(calls,['stop',['report-microphone-capture','ok']]);
});
test('Windows probe reports permission, absent device and general failures separately',async()=>{
 for(const [name,outcome] of [['NotAllowedError','denied'],['PermissionDeniedError','denied'],['NotFoundError','no-device'],['NotReadableError','error']]){
  const calls=[];const {mic,ipc}=micHarness(async()=>{throw Object.assign(new Error(name),{name});},async(command,value)=>{calls.push([command,value]);return{status:value};});
  await mic.probe(ipc,'windows');assert.deepEqual(calls,[['report-microphone-capture',outcome]]);
 }
});
test('capture reporting never changes macOS permission state or blocks capture on IPC failure',async()=>{
 const stream={};const calls=[];const {mic,ipc}=micHarness(async()=>stream,async(...args)=>{calls.push(args);throw new Error('IPC unavailable');});
 assert.equal(await mic.open(ipc,'macos',{}),stream);assert.equal(calls.length,0);
 assert.equal(await mic.open(ipc,'windows',{}),stream);
 await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);
});
test('normal capture keeps its stream alive and preserves the original getUserMedia error',async()=>{
 let stopped=false;const stream={getTracks:()=>[{stop:()=>{stopped=true;}}]};const h=micHarness(async()=>stream);
 assert.equal(await h.mic.open(h.ipc,'windows',{}),stream);assert.equal(stopped,false);
 const error=Object.assign(new Error('denied'),{name:'NotAllowedError'});const e=micHarness(async()=>{throw error;});
 await assert.rejects(e.mic.open(e.ipc,'windows',{}),v=>v===error);
});
function extractFunction(file,name) {
 const s=readFileSync(new URL(file,import.meta.url),'utf8');const start=s.search(new RegExp(`(?:async )?function ${name}\\(`));assert(start>=0);
 const next=s.slice(start+1).search(/\n(?:async )?function /);return s.slice(start,next<0?undefined:start+1+next);
}
test('onboarding preserves unavailable and error states instead of mislabeling denial',async()=>{
 for(const status of ['unknown','granted','denied','unavailable','error']){
  const c=vm.createContext({obMicState:'unknown',obMicRefreshVersion:0,ipc:{invoke:async()=>({status})},renderObMic(){},renderObFooter(){},renderObFinal(){},obScheduleAdvance(){},console});
  vm.runInContext(extractFunction('./main.js','obRefreshMicState'),c);await c.obRefreshMicState();assert.equal(c.obMicState,status);
 }
});
test('Windows Settings displays unknown, no-device and errors without claiming denial',async()=>{
 for(const state of ['unknown','granted','denied','unavailable','error']){
  const label={textContent:'',className:''},button={classList:{toggle(){},remove(){}}};
  const c=vm.createContext({ipc:{invoke:async()=>({status:state})},currentSettings:{os:'windows'},microphoneProbeBusy:false,microphoneRefreshVersion:0,document:{getElementById:id=>id==='permissionStatus'?label:button},translate:s=>s,permissionState:{},renderPermissionSummary(){},console});
  vm.runInContext(extractFunction('./settings.js','checkMicrophonePermissionStatus'),c);await c.checkMicrophonePermissionStatus();
  assert.equal(label.textContent,`microphoneAccess.${state}`);assert.equal(c.permissionState.microphone,state==='granted');
 }
});
test('Windows Settings retry probes even after previous denial rather than reopening Settings forever',async()=>{
 let probes=0;const calls=[];
 const button={disabled:false};
 const c=vm.createContext({ipc:{invoke:async cmd=>{calls.push(cmd);return{status:'denied'};}},currentSettings:{os:'windows'},microphoneProbeBusy:false,window:{TypeAloudMicrophone:{probe:async()=>{probes++;}}},document:{getElementById:()=>button},checkMicrophonePermissionStatus:async()=>{},console});
 vm.runInContext(extractFunction('./settings.js','requestMicrophonePermission'),c);await c.requestMicrophonePermission();
 assert.equal(probes,1);assert(!calls.includes('open-microphone-settings'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../src/views/settings.js',import.meta.url),'utf8');
const fn = source.slice(source.indexOf('function engineStatus('),source.indexOf('function renderEngineCards'));
test('each local engine reports its own readiness, not the open panel state',()=>{
  const statuses = new Map([['qwen',{state:'ready'}],['nemotron',{state:'downloading'}]]);
  const context = vm.createContext({localModelStatuses:statuses,localModelState:'absent',LOCAL_QWEN_PROVIDER:'local-qwen',localModelForProvider:p=>p==='local-qwen'?'qwen':'nemotron'});
  vm.runInContext(fn,context);
  assert.equal(vm.runInContext('engineStatus({value:"local-qwen",local:true}).key',context),'settings.engine.status.ready');
  assert.equal(vm.runInContext('engineStatus({value:"local-nemotron",local:true}).key',context),'settings.engine.status.downloading');
  statuses.set('nemotron',{state:'ready'});
  assert.equal(vm.runInContext('engineStatus({value:"local-nemotron",local:true}).key',context),'settings.engine.status.ready');
  statuses.delete('qwen');
  assert.equal(vm.runInContext('engineStatus({value:"local-qwen",local:true}).key',context),'settings.permission.checking');
});

test('inspection draws controls for the inspected engine rather than the active engine',()=>{
  const fn = source.slice(source.indexOf('function toggleProviderFields'),source.indexOf('// --- Local model panel'));
  for (const inspected of ['qwen', 'qwen-large', 'nemotron']) {
    const hidden = {};
    const fields = Object.fromEntries(['nemotronLatencyItem','localComputeItem','apiKeyFieldOpenRouter','apiKeyFieldOpenAI'].map(id=>[id,{classList:{toggle:(_name,value)=>{hidden[id]=value;}}}]));
    const context = vm.createContext({
      currentSettings: { provider: "local", model: "nemotron" },
      inspectedLocalModel:inspected,QWEN_LOCAL_MODEL:'qwen',NEMOTRON_LOCAL_MODEL:'nemotron',
      LOCAL_QWEN_PROVIDER:'local-qwen',LOCAL_QWEN_LARGE_PROVIDER:'local-qwen-large',LOCAL_NEMOTRON_PROVIDER:'local-nemotron',
      providerForSettings:settings=> 'local-' + settings.model,
      localModelForProvider:()=> 'local',gpuRuntimeSupported:true,
      document:{getElementById:id=>fields[id]},syncEngineDrawer(){},
    });
    vm.runInContext(fn,context);
    vm.runInContext(`toggleProviderFields("${inspected==='qwen'?'local-nemotron':'local-qwen'}")`,context);
    assert.equal(hidden.nemotronLatencyItem,inspected !== 'nemotron');
    assert.equal(hidden.localComputeItem,inspected === 'nemotron');
  }
});

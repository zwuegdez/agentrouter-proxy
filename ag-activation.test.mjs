import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { activate, deactivate, loadActive, syncClients, parseJsonc, patchCodex, restoreCodex, restoreJson } from './ag-activation.mjs';
import { serviceSpec, manageService } from './ag-service.mjs';

async function root(t){const home=await mkdtemp(join(tmpdir(),'ag-active-'));t.after(()=>rm(home,{recursive:true,force:true}));return home;}
const setup={client:'codex',endpoint:'https://agentrouter.org/v1',apiKey:'secret',model:'gpt-next'};
const fetcher=async()=>new Response(JSON.stringify({data:[{id:'gpt-next'},{id:'claude-new',name:'New Claude'}]}));

test('activate persists private config for Codex, Claude and OpenCode, idempotently; deactivate restores exact previous files',async t=>{
  const home=await root(t),app=join(home,'ag'),env={PATH:''};
  await mkdir(join(home,'.codex'),{recursive:true});await mkdir(join(home,'.claude'),{recursive:true});await mkdir(join(home,'.config','opencode'),{recursive:true});
  const paths=[join(home,'.codex','config.toml'),join(home,'.claude','settings.json'),join(home,'.config','opencode','opencode.jsonc')];
  const original=['# keep\nmodel = "old"\nmodel_provider = "existing"\n[projects."/tmp"]\ntrust_level = "trusted"\n','{"env":{"EXISTING":"yes"},"model":"old-unrelated","permissions":{"deny":["Read(secret)"]}}\n','{// old provider\n"providers":{"other":{"settings":{"baseURL":"https://old"}}},"policies":[{"action":"tool.use","resource":"*","effect":"deny"}],}\n'];
  for(let i=0;i<paths.length;i++)await writeFile(paths[i],original[i]);
  const calls=[],service=async(action)=>calls.push(action),output={write:()=>{}};
  await activate(setup,{app,home,env,service,fetcher,output});
  const state=await loadActive(app);assert.equal(state.enabled,true);assert.equal(state.setup.apiKey,'secret');assert.equal((await stat(join(app,'active.json'))).mode & 0o777,0o600);
  const codex=await readFile(paths[0],'utf8');assert.match(codex,/wire_api = "responses"/);assert.match(codex,/model_catalog_json/);assert.match(codex,/trust_level/);
  const claude=JSON.parse(await readFile(paths[1],'utf8'));assert.equal(claude.env.EXISTING,'yes');assert.equal(claude.model,'gpt-next');assert.deepEqual(claude.availableModels,['gpt-next','claude-new']);assert.equal(claude.modelPicker.replaceBuiltInOptions,true);assert.equal(claude.env.ANTHROPIC_AUTH_TOKEN,state.localBearer);
  const opencode=JSON.parse(await readFile(paths[2],'utf8'));assert.equal(opencode.providers.other.settings.baseURL,'https://old');assert.equal(opencode.providers.ag_proxy.settings.apiKey,state.localBearer);assert.equal(opencode.policies[0].action,'tool.use');assert.deepEqual(opencode.policies.slice(1).map(p=>p.effect),['deny','allow']);
  const desktop=JSON.parse(await readFile(join(app,'claude-desktop.json'),'utf8'));assert.equal(desktop.inferenceProvider,'gateway');assert.equal(desktop.modelDiscoveryEnabled,true);assert.equal(desktop.inferenceGatewayApiKey,state.localBearer);
  const allModels=JSON.parse(await readFile(join(app,'claude-desktop-all-models.json'),'utf8'));assert.deepEqual(allModels.inferenceModels.map(x=>x.name),['gpt-next','claude-new']);
  await activate(setup,{app,home,env,service,fetcher,output});assert.deepEqual(calls,['install']);
  await deactivate({app,env,service,output});assert.deepEqual(calls,['install','remove']);assert.equal(await loadActive(app),null);
  for(let i=0;i<paths.length;i++)assert.equal(await readFile(paths[i],'utf8'),original[i]);
});

test('catalog refresh adds new models and deactivation preserves unrelated edits made while active',async t=>{
  const home=await root(t),app=join(home,'ag'),env={PATH:''},service=async()=>{},output={write:()=>{}};
  await activate(setup,{app,home,env,service,fetcher,output});
  const state=await loadActive(app),claudePath=join(home,'.claude','settings.json'),codexPath=join(home,'.codex','config.toml');
  const claude=JSON.parse(await readFile(claudePath,'utf8'));claude.env.NEW='added';claude.theme='dark';claude.model='claude-retired';await writeFile(claudePath,JSON.stringify(claude));
  const opencodePath=join(home,'.config','opencode','opencode.json');
  const oc=JSON.parse(await readFile(opencodePath,'utf8'));oc.policies.push({action:'tool.use',resource:'shell:*',effect:'deny'});await writeFile(opencodePath,JSON.stringify(oc));
  await writeFile(codexPath,(await readFile(codexPath,'utf8'))+'\n[new]\nvalue = "keep"\n');
  await syncClients(state,[{id:'gpt-next',display_name:'GPT'},{id:'claude-future',display_name:'Future'}],{home,env,version:2});
  assert.deepEqual(JSON.parse(await readFile(claudePath,'utf8')).availableModels,['gpt-next','claude-future']);
  assert.equal(JSON.parse(await readFile(claudePath,'utf8')).model,'claude-retired');
  await deactivate({app,env,service,output});
  const restored=JSON.parse(await readFile(claudePath,'utf8'));assert.deepEqual(restored,{env:{NEW:'added'},theme:'dark',model:'claude-retired'});
  assert.deepEqual(JSON.parse(await readFile(opencodePath,'utf8')).policies,[{action:'tool.use',resource:'shell:*',effect:'deny'}]);
  assert.match(await readFile(codexPath,'utf8'),/value = "keep"/);assert.doesNotMatch(await readFile(codexPath,'utf8'),/experimental_bearer_token/);
});

test('failed service activation restores files and rejects a non-AgentRouter endpoint before writes',async t=>{
  const home=await root(t),app=join(home,'ag'),env={PATH:''},output={write:()=>{}};
  const service=async action=>{if(action==='install')throw new Error('no service manager');};
  await assert.rejects(activate({...setup,endpoint:'https://other.example/v1'},{app,home,env,service,fetcher,output}),/only from agentrouter/);
  await assert.rejects(activate(setup,{app,home,env,service,fetcher,output}),/no service manager/);
  assert.equal(await loadActive(app),null);
  await assert.rejects(readFile(join(home,'.claude','settings.json')),/ENOENT/);
  await assert.rejects(readFile(join(home,'.codex','config.toml')),/ENOENT/);
});

test('linked client files and invalid JSON fail with rollback and no linked target modification',async t=>{
  const home=await root(t),app=join(home,'ag'),env={PATH:''},output={write:()=>{}},service=async()=>{};
  const outside=join(home,'outside');await writeFile(outside,'{}');await mkdir(join(home,'.claude'));await symlink(outside,join(home,'.claude','settings.json'));
  await assert.rejects(activate(setup,{app,home,env,service,fetcher,output}),/linked/);assert.equal(await readFile(outside,'utf8'),'{}');
});

test('JSONC parser keeps URLs/strings and rejects unsafe syntax; restoration keeps new fields',()=>{
  assert.deepEqual(parseJsonc('{"url":"https://host",/* comment */"value":",}","rows":[1,2,],}'),{url:'https://host',value:',}',rows:[1,2]});
  assert.deepEqual(parseJsonc('{"key":1, // after comma\n}'),{key:1});
  assert.throws(()=>parseJsonc('{/*'));assert.throws(()=>parseJsonc('[]'));
  assert.deepEqual(restoreJson({env:{token:'new',other:'added'}},{env:{token:'old'}},{env:{token:'new'}}),{env:{token:'old',other:'added'}});
});

test('Codex patch leaves project/provider tables and multiline strings intact; restores originals after unrelated edits',()=>{
  const raw='model = "old"\nmodel_provider="oldprovider"\nnotes = """\n[not.a.table]\nmodel = \'inside\'\n"""\n[model_providers.oldprovider]\nbase_url="https://old"\n';
  const options={model:'gpt-next',baseUrl:'http://127.0.0.1:1/v1',localBearer:'local',catalogFile:'/tmp/models.json',providerId:'ag_proxy_test'};
  const patched=patchCodex(raw,options);assert.match(patched.text,/model = 'inside'/);assert.match(patched.text,/base_url="https:\/\/old"/);
  const record={before:raw,after:patched.text,codex:patched};
  assert.equal(restoreCodex(patched.text,record),raw);
  const changed=restoreCodex(patched.text+'\n[other]\nvalue=3\n',record);assert.match(changed,/model = "old"/);assert.match(changed,/value=3/);assert.doesNotMatch(changed,/localBearer|experimental_bearer_token/);
  const edited=restoreCodex(patched.text.replace('model = \"gpt-next\"','model = \"user-choice\"'),record);assert.match(edited,/model = \"user-choice\"/);assert.doesNotMatch(edited,/model = \"old\"/);
});

test('OS service specs restart after failure and keep argument paths quoted; Linux install/remove calls managers in order',async t=>{
  const home=await root(t),app=join(home,'with space'),script=join(app,'ag.mjs');
  const linux=serviceSpec({home,app,script,platform:'linux',env:{},node:'/node with space'});assert.match(linux.content,/Restart=always/);assert.match(linux.content,/"\/node with space"/);
  const mac=serviceSpec({home,app,script,platform:'darwin',env:{}});assert.match(mac.content,/<key>KeepAlive<\/key><true\/>/);
  const win=serviceSpec({home,app,script,platform:'win32',env:{}});assert.match(win.content,/while \(Test-Path/);
  const calls=[];const run=async(command,args)=>{calls.push([command,args]);};
  await manageService('install',{home,app,script,platform:'linux',env:{},run});await manageService('remove',{home,app,script,platform:'linux',env:{},run});
  assert.deepEqual(calls.map(x=>x[1]),[['--user','daemon-reload'],['--user','enable','--now',linux.file],['--user','disable','--now','agentrouter-proxy.service'],['--user','daemon-reload']]);
});


test('all new model families refresh every client catalog without changing the selected model',async t=>{
  const home=await root(t),app=join(home,'ag'),env={PATH:''},service=async()=>{},output={write:()=>{}};
  await activate(setup,{app,home,env,service,fetcher,output});
  const state=await loadActive(app);
  const models=['gpt-next','claude-next','deepseek-next','qwen-next','gemini-next','glm-next','kimi-next','unknown-future-family'].map(id=>({id,display_name:id}));
  await syncClients(state,models,{home,env,version:2});
  const ids=models.map(model=>model.id);
  const codex=JSON.parse(await readFile(join(app,'models.json'),'utf8'));assert.deepEqual(codex.models.map(model=>model.slug),ids);
  const claude=JSON.parse(await readFile(join(home,'.claude','settings.json'),'utf8'));assert.deepEqual(claude.modelPicker.options.map(model=>model.model),ids);assert.deepEqual(claude.availableModels,ids);assert.equal(claude.model,'gpt-next');
  const opencode=JSON.parse(await readFile(join(home,'.config','opencode','opencode.json'),'utf8'));assert.deepEqual(Object.keys(opencode.providers.ag_proxy.models),ids);
  const desktop=JSON.parse(await readFile(join(app,'claude-desktop-all-models.json'),'utf8'));assert.deepEqual(desktop.inferenceModels.map(model=>model.name),ids);
  await deactivate({app,env,service,output});
});

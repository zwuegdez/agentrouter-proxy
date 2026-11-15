import { mkdir, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appDirectory, readConfiguration, safeDirectory, writePrivate } from './install.mjs';
import { createCatalog, codexCatalog } from './model-catalog.mjs';
import { createProxy, validateEndpoint } from './proxy-server.mjs';
import { buildLaunch, clientInstalled } from './client-integrations.mjs';
import { manageService } from './background-service.mjs';

const SELF = join(dirname(fileURLToPath(import.meta.url)), 'ag.mjs');
const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function parseJsonc(raw) {
  let result = '', string = false, escape = false;
  for (let i=0;i<raw.length;i++) {
    const c=raw[i], next=raw[i+1];
    if (string) { result+=c; if(escape) escape=false; else if(c==='\\') escape=true; else if(c==='"') string=false; continue; }
    if (c==='"') { string=true; result+=c; }
    else if(c==='/' && next==='/') { while(i<raw.length && raw[i]!=='\n') i++; result+='\n'; }
    else if(c==='/' && next==='*') { i+=2; while(i<raw.length && !(raw[i]==='*' && raw[i+1]==='/')) i++; if(i>=raw.length) throw new Error('Unterminated JSON comment.'); i++; }
    else if(c===',') { let j=i+1; while(/\s/.test(raw[j] || '') && j<raw.length) j++; if(!['}',']'].includes(raw[j])) result+=c; }
    else result+=c;
  }
  const value=JSON.parse(result.replace(/"(?:\\.|[^"\\])*"|,\s*[}\]]/g,match=>match[0] === ',' ? match.slice(1) : match));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Client configuration must be an object.');
  return value;
}

export function restoreJson(current, before, after) {
  const value=structuredClone(current);
  for (const key of new Set([...Object.keys(before),...Object.keys(after)])) {
    if (equal(before[key],after[key])) continue;
    if (equal(value[key],after[key])) {
      if (Object.hasOwn(before,key)) value[key]=before[key]; else delete value[key];
    } else if (key === 'policies' && Array.isArray(after[key]) && Array.isArray(value[key])) {
      const original=before[key] || [];
      const added=after[key].filter(item=>!original.some(old=>equal(old,item)));
      const removed=original.filter(item=>!after[key].some(now=>equal(now,item)));
      value[key]=[...value[key].filter(item=>!added.some(owned=>equal(owned,item))),...removed];
      if(!Object.hasOwn(before,key) && !value[key].length)delete value[key];
    } else if ([before[key],after[key],value[key]].every(x=>x && typeof x==='object' && !Array.isArray(x))) {
      value[key]=restoreJson(value[key],before[key],after[key]);
    } else if (!Object.hasOwn(before,key) && after[key] && value[key] && typeof value[key]==='object' && !Array.isArray(value[key])) {
      value[key]=restoreJson(value[key],{},after[key]); if(!Object.keys(value[key]).length)delete value[key];
    }
  }
  return value;
}

export function patchCodex(raw, { model, baseUrl, localBearer, catalogFile, providerId }) {
  const marker='# ag activation: '+providerId;
  const begin=marker+' begin\n', end=marker+' end\n';
  if(raw.includes(begin)) raw=raw.replace(new RegExp(begin+'[\\s\\S]*?'+end,'g'),'');
  const lines=raw.split(/(?<=\n)/), originals=[];
  let table=false, multiline=null;
  const kept=[];
  for (const line of lines) {
    if (!multiline && /^\s*\[/.test(line)) table=true;
    const key=!table && !multiline && /^\s*(model|model_provider|model_catalog_json)\s*=/.exec(line)?.[1];
    if(key) { if(/"""|'''/.test(line))throw new Error('Multiline Codex routing values require manual configuration.'); originals.push(line); }
    else kept.push(line);
    const clean=line.replace(/#.*$/,'');
    for (const quote of ['"""',"'''"]) if((clean.split(quote).length-1)%2) multiline=multiline===quote ? null : quote;
  }
  const root=`model = ${JSON.stringify(model)}\nmodel_provider = ${JSON.stringify(providerId)}\nmodel_catalog_json = ${JSON.stringify(catalogFile)}\n`;
  const provider=`[model_providers.${providerId}]\nname = "AgentRouter"\nbase_url = ${JSON.stringify(baseUrl)}\nwire_api = "responses"\nexperimental_bearer_token = ${JSON.stringify(localBearer)}\nrequires_openai_auth = false\nsupports_websockets = false\nmodel_catalog_url = ${JSON.stringify(baseUrl.replace(/\/v1$/,'')+'/codex/models')}\n`;
  return { text: begin+root+end+kept.join('')+'\n'+begin+provider+end, originals, root, marker };
}

export function restoreCodex(current, record) {
  if(current===record.after) return record.before;
  const begin=record.codex.marker+' begin\n',end=record.codex.marker+' end\n';
  const originalLines=new Map(record.codex.originals.map(line=>[/^\s*(\w+)\s*=/.exec(line)?.[1],line]));
  const generatedLines=new Map(record.codex.root.split('\n').filter(Boolean).map(line=>[/^(\w+)\s*=/.exec(line)?.[1],line]));
  return current.replace(new RegExp(begin+'[\\s\\S]*?'+end,'g'),block=> {
    const inner=block.slice(begin.length,-end.length);
    if(inner.trimStart().startsWith('['))return '';
    return inner.split(/(?<=\n)/).map(line=> {
      const key=/^\s*(\w+)\s*=/.exec(line)?.[1];
      return key && line.trim()===generatedLines.get(key) ? originalLines.get(key) || '' : line;
    }).join('');
  });
}

export function clientPaths({ home=homedir(),env=process.env }={}) {
  return { codex:join(env.CODEX_HOME || join(home,'.codex'),'config.toml'), claude:join(env.CLAUDE_CONFIG_DIR || join(home,'.claude'),'settings.json'), opencode:join(env.XDG_CONFIG_HOME || join(home,'.config'),'opencode','opencode.json') };
}

async function opencodeMajor(env) {
  if(!clientInstalled('opencode',{env})) return 2;
  try { const {stdout}=await promisify(execFile)('opencode',['--version'],{env,timeout:10000,shell:false}); return Number(/(?:^|\s)v?(\d+)\./.exec(stdout)?.[1]) || 2; } catch { return 2; }
}

async function changeFile(state,path,mutate) {
  const current=await readConfiguration(path);
  let record=state.files.find(record=>record.path===path);
  if(!record) { record={path,before:current,after:current}; state.files.push(record); }
  else if(current !== record.after && !record.codex && current !== null) {
    record.before=JSON.stringify(restoreJson(parseJsonc(current),parseJsonc(record.before || '{}'),parseJsonc(record.after || '{}')),null,2)+'\n';
  }
  const result=mutate(current || '');
  record.pendingAfter=result.text; if(result.codex)record.codex=result.codex;
  await writePrivate(join(state.app,'active.json'),JSON.stringify(state,null,2)+'\n',{backup:false});
  await writePrivate(path,result.text,{backup:record.before===current});
  record.after=result.text;delete record.pendingAfter;
  await writePrivate(join(state.app,'active.json'),JSON.stringify(state,null,2)+'\n',{backup:false});
}

export async function syncClients(state,models,{ env=process.env, home=homedir(), version }={}) {
  const paths=clientPaths({home,env}),baseUrl=`http://127.0.0.1:${state.port}/v1`;
  const ids=models.map(model=>model.id);
  const catalogFile=join(state.app,'models.json');
  await writePrivate(catalogFile,JSON.stringify(codexCatalog(models),null,2)+'\n',{backup:false});
  if (!state.files.some(record=>record.path===paths.codex)) await changeFile(state,paths.codex,raw=> {
    const parsed=patchCodex(raw,{model:state.setup.model,baseUrl,localBearer:state.localBearer,catalogFile,providerId:state.providerId});
    return {text:parsed.text,codex: {originals:parsed.originals,root:parsed.root,marker:parsed.marker}};
  });
  const launch=buildLaunch('claude',{model:state.setup.model,baseUrl,localBearer:state.localBearer});
  launch.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY='1';
  for (const tier of ['HAIKU','SONNET','OPUS','FABLE','MYTHOS']) {
    const matches=models.filter(model=>new RegExp('claude.*'+tier,'i').test(model.id)).sort((a,b)=>b.id.localeCompare(a.id,undefined,{numeric:true}));
    launch.env['ANTHROPIC_DEFAULT_'+tier+'_MODEL']=matches[0]?.id || state.setup.model;
  }
  await changeFile(state,paths.claude,raw=> {
    const config=parseJsonc(raw || '{}');
    const alreadyRouted=config.env?.ANTHROPIC_AUTH_TOKEN===state.localBearer;
    return { text:JSON.stringify({...config,env:{...config.env,...launch.env},apiKeyHelper:'',model:alreadyRouted && config.model ? config.model : state.setup.model, availableModels:ids,
      modelPicker:{replaceBuiltInOptions:true,options:models.map(model=>({model:model.id,label:model.display_name,description:model.description || 'AgentRouter'}))}},null,2)+'\n' };
  });
  const major=version || await opencodeMajor(env),field=major<2 ? 'provider' : 'providers';
  const alternate=paths.opencode+'c';
  const path=await readConfiguration(paths.opencode)===null && await readConfiguration(alternate)!==null ? alternate : paths.opencode;
  await changeFile(state,path,raw=> {
    const config=parseJsonc(raw || '{}');
    const provider=major<2 ? {npm:'@ai-sdk/openai-compatible',name:'AgentRouter',options:{baseURL:baseUrl,apiKey:state.localBearer},models:Object.fromEntries(models.map(model=>[model.id,{name:model.display_name}]))} : {name:'AgentRouter',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:baseUrl,apiKey:state.localBearer},models:Object.fromEntries(models.map(model=>[model.id,{name:model.display_name}]))};
    return {text:JSON.stringify({...config,[field]:{...config[field],ag_proxy:provider},model:config.model?.startsWith('ag_proxy/') ? config.model : 'ag_proxy/'+state.setup.model,
      ...(major<2 ? {enabled_providers:['ag_proxy']} : {policies:[...(config.policies || []).filter(p=>p.action!=='provider.use'),{action:'provider.use',resource:'*',effect:'deny'},{action:'provider.use',resource:'ag_proxy',effect:'allow'}]})},null,2)+'\n'};
  });
  const desktop={inferenceProvider:'gateway',inferenceCredentialKind:'static',inferenceGatewayBaseUrl:baseUrl.replace(/\/v1$/,''),inferenceGatewayApiKey:state.localBearer,inferenceGatewayAuthScheme:'bearer',modelDiscoveryEnabled:true,modelCatalogEnabled:false};
  await writePrivate(join(state.app,'claude-desktop.json'),JSON.stringify(desktop,null,2)+'\n',{backup:false});
  // shortcut: Desktop filters non-Claude discovery, reimport this file after catalog changes for GPT.
  await writePrivate(join(state.app,'claude-desktop-all-models.json'),JSON.stringify({...desktop,modelDiscoveryEnabled:false,inferenceModels:models.map(model=>({name:model.id,labelOverride:model.display_name}))},null,2)+'\n',{backup:false});
}

export async function loadActive(app=process.env.AG_APP_DIR || appDirectory()) {
  const raw=await readConfiguration(join(app,'active.json'));
  if(raw===null) return null;
  const state=JSON.parse(raw);
  if(!state || state.app!==app || !Array.isArray(state.files) || typeof state.localBearer!=='string' || !/^[a-f0-9]{64}$/.test(state.localBearer))throw new Error('Invalid activation state. Preserve active.json and its backups for recovery.');
  return state;
}

async function restoreFiles(state) {
  for (const record of [...state.files].reverse()) {
    const raw=await readConfiguration(record.path);
    if(raw===null)continue;
    if(record.pendingAfter === raw) record.after=record.pendingAfter;
    const restored=record.codex ? restoreCodex(raw,record) : raw===record.after ? record.before : JSON.stringify(restoreJson(parseJsonc(raw),parseJsonc(record.before || '{}'),parseJsonc(record.after)),null,2)+'\n';
    if(restored===null || record.before===null && !record.codex && equal(parseJsonc(restored),{})) await unlink(record.path);
    else await writePrivate(record.path,restored,{backup:false});
  }
}

async function lock(app,work) {
  await safeDirectory(app);
  const path=join(app,'activation.lock');
  try {await mkdir(path,{mode:0o700});}catch(error){if(error.code==='EEXIST')throw new Error('Another activation command is running. If it crashed, remove activation.lock after checking no ag command is running.');throw error;}
  try {return await work();}finally{await rmdir(path);}
}

async function waitForService(state) {
  for(let attempt=0;attempt<40;attempt++) {
    try {const response=await fetch(`http://127.0.0.1:${state.port}/health`,{headers:{authorization:`Bearer ${state.localBearer}`},redirect:'error',signal:AbortSignal.timeout(500)}); if(response.ok && (await response.json()).active)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('The background service did not start. Check the OS service logs and whether the port is occupied.');
}

export async function activate(setup,{app=process.env.AG_APP_DIR || appDirectory(),port=18766,home=homedir(),env=process.env,service=manageService,fetcher=fetch,output=process.stdout,relay=false}={}) {
  const endpoint=validateEndpoint(setup.endpoint);
  if(!relay && (typeof setup.apiKey !== 'string' || !setup.apiKey || /[\x00-\x20\x7f]/.test(setup.apiKey) || typeof setup.model !== 'string' || !setup.model || setup.model.length>200 || /[\x00-\x1f\x7f]/.test(setup.model)))throw new Error('Invalid saved setup. Run ag setup.');
  if(!Number.isInteger(port) || port<1 || port>65535)throw new Error('Invalid activation port.');
  if(!relay && endpoint.hostname!=='agentrouter.org' && !['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))throw new Error('Activation loads models only from agentrouter.org. Use ag proxy for another provider.');
  return lock(app,async()=> {
    const existing=await loadActive(app);
    if(existing) {
      await service('start',{app,script:SELF,home:existing.home,env});
      if(service === manageService)await waitForService(existing);
      output.write(`AgentRouter is running in the background at http://127.0.0.1:${existing.port}/v1. Use ag deactivate to stop.\n`);
      return existing;
    }
    let models;
    if(!relay) {
      const catalog=createCatalog({endpoint:setup.endpoint,apiKey:setup.apiKey,fetcher});
      try { models=await catalog.refresh(); } finally { await catalog.close(); }
      if(!models.some(model=>model.id===setup.model))throw new Error('Your saved model is unavailable in AgentRouter. Run ag setup and choose a current model.');
    }
    const state={enabled:true,app,setup:relay ? {endpoint:endpoint.href.replace(/\/$/,''),client:setup.client} : setup,mode:relay ? 'relay' : 'catalog',port,localBearer:randomBytes(32).toString('hex'),providerId:'ag_proxy_'+randomUUID().replaceAll('-',''),files:[],home,envPaths:Object.fromEntries(['CODEX_HOME','CLAUDE_CONFIG_DIR','XDG_CONFIG_HOME','PATH','Path'].filter(key=>env[key]).map(key=>[key,env[key]]))};
    await writePrivate(join(app,'active.json'),JSON.stringify(state,null,2)+'\n',{backup:false});
    let installing=false;
    try {
      if(!relay)await syncClients(state,models,{home,env});
      installing=true;
      await service('install',{app,script:SELF,home,env});
      if(service === manageService)await waitForService(state);
      output.write(`AgentRouter is running in the background at http://127.0.0.1:${port}/v1. Autostart and crash restart are enabled; closing this terminal does not stop it. Use ag deactivate to stop.\n`);
      if(!relay)output.write(`Restart Codex/Desktop and Claude Code. Run opencode reload for an existing OpenCode service.\nClaude Desktop: import ${join(app,'claude-desktop.json')} (Claude auto-discovery) or ${join(app,'claude-desktop-all-models.json')} (GPT/all models; reimport after catalog changes) in Developer > Configure Third-Party Inference, Apply Changes, then relaunch.\n`);
      return state;
    }catch(error){
      if(installing)await service('remove',{app,script:SELF,home,env}).catch(()=>{});
      try{await restoreFiles(state);await unlink(join(app,'active.json'));}catch(restore){throw new Error(`${error.message} Restore also failed: ${restore.message}. Recovery state remains in active.json.`);}
      throw error;
    }
  });
}

export async function deactivate({app=process.env.AG_APP_DIR || appDirectory(),env=process.env,service=manageService,output=process.stdout}={}) {
  return lock(app,async()=> {
    let state=await loadActive(app);
    if(!state){output.write('AgentRouter is already inactive.\n');return;}
    // Stop before reading the final journal so refresh cannot race restoration.
    await service('remove',{app,script:SELF,home:state.home,env});
    state=await loadActive(app);
    await restoreFiles(state);
    await unlink(join(app,'active.json'));
    output.write('AgentRouter deactivated. Previous CLI/OpenCode/Codex settings restored; unrelated edits preserved. Restart clients or run opencode reload.\nClaude Desktop: select your previous inference configuration in Developer > Configure Third-Party Inference and relaunch.\n');
  });
}

export async function runDaemon({app=process.env.AG_APP_DIR || appDirectory(),signals=process,output=process.stdout,refreshMs=300_000}={}) {
  const state=await loadActive(app);
  if(!state?.enabled)throw new Error('AgentRouter is inactive. Run ag activate.');
  let stopping=false;
  const relay=state.mode==='relay';
  const catalog=relay ? null : createCatalog({endpoint:state.setup.endpoint,apiKey:state.setup.apiKey,refreshMs,onChange:async models=>{
    if(stopping)return;
    await syncClients(state,models,{home:state.home,env:{...process.env,...state.envPaths}});
  }});
  // Bring up the listener even when the upstream is temporarily unavailable after reboot.
  const server=createProxy({endpoint:state.setup.endpoint,apiKey:relay ? '' : state.setup.apiKey,localBearer:relay ? '' : state.localBearer,healthBearer:state.localBearer,port:state.port,catalog});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(resolve);});
  let done; const stopped=new Promise(resolve=>{done=resolve;});
  const stop=()=>{stopping=true;catalog?.close().catch(()=>{});done();server.closeAllConnections();server.close();};
  signals.on('SIGTERM',stop);signals.on('SIGINT',stop);
  const refresh=()=>catalog.refresh(true).catch(error=>output.write(error.message+'\n'));
  const timer=relay ? null : setInterval(refresh,refreshMs);timer?.unref();
  if(!relay)refresh();
  try{await stopped;}finally{
    clearInterval(timer);signals.off('SIGTERM',stop);signals.off('SIGINT',stop);
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    // Wait for an in-flight refresh before restoration reads its journal.
    await catalog?.close();
  }
  return 0;
}

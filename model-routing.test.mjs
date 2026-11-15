import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createProxy } from './proxy-server.mjs';
import { createCatalog, endpointTypes, normalizeModels } from './model-catalog.mjs';
import { toResponses, fromResponses, translateStream } from './protocol-translation.mjs';

async function start(t,server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}
async function body(req) { const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks)); }
const auth={authorization:'Bearer local'};

test('model discovery is authenticated, refreshes new releases, removes unavailable IDs, rejects redirects and invalid metadata',async()=>{
  let rows=[{id:'gpt-new'},{id:'claude-next',supported_endpoint_types:['anthropic','openai-response']}], calls=0;
  const catalog=createCatalog({endpoint:'https://agentrouter.org/v1',apiKey:'secret',fetcher:async(url,options)=>{
    calls++;assert.equal(url.href,'https://agentrouter.org/v1/models');assert.equal(options.headers.authorization,'Bearer secret');assert.equal(options.redirect,'error');return new Response(JSON.stringify({data:rows}));
  }});
  await catalog.refresh();await catalog.refresh();assert.equal(calls,1);
  rows=[{id:'gpt-new',available:false},{id:'claude-future'}];await catalog.refresh(true);
  assert.deepEqual(catalog.models.map(x=>x.id),['claude-future']);assert.equal(await catalog.find('gpt-new'),undefined);
  assert.deepEqual(endpointTypes({id:'openai/gpt-future',supported_endpoint_types:['anthropic','chat']}),['responses']);
  assert.deepEqual(endpointTypes({id:'claude-future',supported_endpoint_types:['openai-response','anthropic']}),['responses','messages']);
  assert.throws(()=>normalizeModels({data:[{id:'bad\nmodel'}]}));
  await assert.rejects(createCatalog({endpoint:'https://agentrouter.org',apiKey:'x',fetcher:async()=>new Response('bad',{status:403})}).refresh(),/403/);
});

test('Claude GPT requests use Responses including image and tool history; unavailable models never generate',async t=>{
  const observed=[];
  const upstream=await start(t,http.createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'gpt-future'}]}));return;}
    observed.push({path:req.url,headers:req.headers,body:await body(req)});
    res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'resp1',output:[{type:'function_call',call_id:'call1',name:'read',arguments:'{"path":"a"}'}],usage:{input_tokens:12,output_tokens:8}}));
  }));
  const catalog=createCatalog({endpoint:upstream+'/v1',apiKey:'secret'});
  const proxy=await start(t,createProxy({endpoint:upstream+'/v1',apiKey:'secret',localBearer:'local',catalog}));
  const request={model:'gpt-future',max_tokens:200,system:[{type:'text',text:'code'}],tools:[{name:'read',input_schema:{type:'object'}}],messages:[{role:'assistant',content:[{type:'tool_use',id:'old',name:'read',input:{path:'b'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'old',content:'done'},{type:'image',source:{type:'base64',media_type:'image/png',data:'abc'}}]}]};
  const response=await fetch(proxy+'/v1/messages',{method:'POST',headers:auth,body:JSON.stringify(request)});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.stop_reason,'tool_use');assert.deepEqual(result.content[0].input,{path:'a'});
  assert.equal(observed[0].path,'/v1/responses');assert.equal(observed[0].headers.authorization,'Bearer secret');assert.equal(observed[0].headers['x-api-key'],undefined);
  assert.equal(observed[0].body.input[0].call_id,observed[0].body.input[1].call_id);assert.equal(observed[0].body.input[2].content[0].image_url,'data:image/png;base64,abc');
  const missing=await fetch(proxy+'/v1/messages',{method:'POST',headers:auth,body:JSON.stringify({...request,model:'retired'})});assert.equal(missing.status,404);assert.equal(observed.length,1);
  assert.equal((await fetch(proxy+'/v1/models')).status,401);
});

test('Claude endpoint selection follows metadata and only retries explicit endpoint mismatch; quota errors are preserved',async t=>{
  let status=400,requests=[];
  const upstream=await start(t,http.createServer(async(req,res)=>{
    if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'claude-new',supported_endpoint_types:['anthropic','openai-response']}]}));return;}
    requests.push(req.url);await body(req);
    if(req.url.endsWith('/messages')) {res.writeHead(status,{'content-type':'application/json','retry-after':'3'});res.end(JSON.stringify({error:{message:status===400?'unsupported endpoint':'quota exhausted'}}));}
    else {res.setHeader('content-type','application/json');res.end(JSON.stringify({output:[{type:'message',content:[{type:'output_text',text:'ok'}]}]}));}
  }));
  const catalog=createCatalog({endpoint:upstream+'/v1',apiKey:'secret'});
  const proxy=await start(t,createProxy({endpoint:upstream+'/v1',apiKey:'secret',localBearer:'local',catalog}));
  const send=()=>fetch(proxy+'/v1/messages',{method:'POST',headers:auth,body:JSON.stringify({model:'claude-new',messages:[{role:'user',content:'hi'}],max_tokens:20})});
  assert.equal((await (await send()).json()).content[0].text,'ok');assert.deepEqual(requests,['/v1/messages','/v1/responses']);
  requests=[];status=429;const limited=await send();assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'3');assert.deepEqual(requests,['/v1/messages']);assert.match(await limited.text(),/quota exhausted/);
});

test('Responses GPT stream translates to Anthropic tool and text events, preserves split UTF8 and rejects early EOF',async()=>{
  const events=[{type:'response.output_text.delta',output_index:0,delta:'hi €'},{type:'response.output_item.added',output_index:1,item:{type:'function_call',call_id:'call_x',name:'read'}},{type:'response.function_call_arguments.delta',output_index:1,delta:'{"path":'},{type:'response.function_call_arguments.delta',output_index:1,delta:'"a"}'},{type:'response.completed',response:{output:[],usage:{input_tokens:4,output_tokens:7}}}];
  const wire=Buffer.from(events.map(x=>'data: '+JSON.stringify(x)+'\r\n\r\n').join(''));
  let result='';const res={write:x=>{result+=x;},end:()=>{}};
  await translateStream(Readable.from([...wire].map(x=>Buffer.from([x]))),'responses','messages','gpt-new',res);
  assert.match(result,/message_start/);assert.match(result,/hi €/);assert.match(result,/call_x/);assert.match(result,/input_json_delta/);assert.match(result,/tool_use/);assert.match(result,/"output_tokens":7/);
  await assert.rejects(translateStream(Readable.from([Buffer.from('data: {"type":"response.output_text.delta","output_index":0,"delta":"partial"}\n\n')]),'responses','messages','gpt-new',res),/before completion/);
});

test('Codex Responses requests translate tool calls to native Claude Messages and back into Responses SSE',async t=>{
  let received;
  const upstream=await start(t,http.createServer(async(req,res)=>{
    received=await body(req);assert.equal(req.url,'/v1/messages');assert.equal(req.headers['x-api-key'],'secret');
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const value of [{type:'message_start',message:{usage:{input_tokens:2}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'ok'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}])res.write('data: '+JSON.stringify(value)+'\n\n');res.end();
  }));
  const catalog={refresh:async()=>[{id:'claude-new'}],find:async()=>({id:'claude-new',supported_endpoint_types:['anthropic']})};
  const proxy=await start(t,createProxy({endpoint:upstream+'/v1',apiKey:'secret',localBearer:'local',catalog}));
  const response=await fetch(proxy+'/v1/responses',{method:'POST',headers:auth,body:JSON.stringify({model:'claude-new',stream:true,input:[{role:'user',content:'hello'},{type:'function_call',call_id:'x',name:'read',arguments:'{}'},{type:'function_call_output',call_id:'x',output:'done'}],tools:[{type:'function',name:'read',parameters:{type:'object'}}]})});
  assert.equal(response.status,200);const wire=await response.text();assert.match(wire,/response.created/);assert.match(wire,/response.output_text.delta/);assert.match(wire,/response.completed/);assert.equal(received.messages[1].content[0].id,received.messages[2].content[0].tool_use_id);
});

test('unsupported bridge features fail instead of dropping instructions or native tools',()=>{
  assert.throws(()=>toResponses({messages:[],tools:[{type:'computer_20250124'}]},'messages'),/Native Anthropic tool/);
  assert.throws(()=>fromResponses({input:[],tools:[{type:'computer'}]},'messages'),/requires a Responses endpoint/);
  assert.throws(()=>toResponses({messages:[{role:'user',content:[{type:'document'}]}]},'messages'),/content type document/);
});

test('Codex custom tools keep raw input through native Messages tool calls',async()=>{
  const tools=[{type:'custom',name:'apply_patch',format:{type:'grammar',syntax:'lark',definition:'raw'}}];
  const request=fromResponses({input:[{type:'custom_tool_call',call_id:'x',name:'apply_patch',input:'*** patch ***'},{type:'custom_tool_call_output',call_id:'x',output:'done'}],tools},'messages');
  assert.deepEqual(request.messages[0].content[0].input,{input:'*** patch ***'});assert.equal(request.tools[0].input_schema.properties.input.type,'string');
  const events=[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'x',name:'apply_patch'}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({input:'*** patch ***'})}},{type:'message_stop'}];
  let wire='';await translateStream(Readable.from([Buffer.from(events.map(x=>'data: '+JSON.stringify(x)+'\n\n').join(''))]),'messages','responses','claude-new',{write:x=>{wire+=x;},end:()=>{}},tools);
  assert.match(wire,/response.custom_tool_call_input.delta/);assert.match(wire,/custom_tool_call/);assert.match(wire,/\*\*\* patch \*\*\*/);assert.doesNotMatch(wire,/function_call_arguments.delta/);
});

test('catalog shutdown aborts a pending fetch promptly',async()=>{
  let entered;const started=new Promise(resolve=>{entered=resolve;});
  const catalog=createCatalog({endpoint:'https://agentrouter.org/v1',apiKey:'x',fetcher:async(url,{signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  const refresh=catalog.refresh();refresh.catch(()=>{});await started;await catalog.close();await assert.rejects(refresh,/abort/i);
});


test('unfamiliar releases route every client protocol from metadata without a model-name allowlist',async t=>{
  const models=[
    {id:'deepseek-new-release',supported_endpoint_types:['chat']},
    {id:'qwen-next',endpoints:{'/v1/responses':true,'/v1/messages':false}},
    {id:'gemini-next',api_types:'openai'},
    {id:'glm-next',endpoints:[{path:'/v1/messages'}]},
    {id:'kimi-next',endpoints:[null,{type:'responses'}]},
    {id:'brand-new-family',supported_endpoint_types:['chat','responses','messages']},
  ];
  const observed=[];
  const upstream=await start(t,http.createServer(async(req,res)=>{
    const request=await body(req);observed.push({model:request.model,path:req.url});res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url.endsWith('/messages') ? {id:'m',content:[{type:'text',text:'ok'}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}} : req.url.endsWith('/responses') ? {id:'r',output:[{type:'message',content:[{type:'output_text',text:'ok'}]}],usage:{input_tokens:1,output_tokens:1}} : {id:'c',choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));
  }));
  const catalog={refresh:async()=>models,find:async id=>models.find(model=>model.id===id)};
  const proxy=await start(t,createProxy({endpoint:upstream+'/v1',apiKey:'secret',localBearer:'local',catalog}));
  for(const model of models)for(const [protocol,path] of [['messages','/v1/messages'],['chat','/v1/chat/completions'],['responses','/v1/responses']]) {
    const request={model:model.id,...(protocol==='responses' ? {input:'hi'} : {messages:[{role:'user',content:'hi'}],max_tokens:20})};
    const response=await fetch(proxy+path,{method:'POST',headers:auth,body:JSON.stringify(request)});assert.equal(response.status,200,model.id+' '+protocol);
    const result=await response.json();assert(!result.error);
    const candidates=endpointTypes(model),expected=candidates.includes(protocol) ? protocol : candidates[0];
    assert.equal(observed.at(-1).model,model.id);assert.equal(observed.at(-1).path,'/v1/'+{messages:'messages',chat:'chat/completions',responses:'responses'}[expected]);
  }
  assert.deepEqual(endpointTypes({id:'totally-new'}),['chat','responses','messages']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createProxy } from './ag-proxy.mjs';
import { forwardSse, readSse, jsonSse, writeStream, STREAM_IDLE_TIMEOUT, HEARTBEAT_MS } from './ag-streams.mjs';
import { translateStream } from './ag-protocols.mjs';

async function start(t,server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}
function sink(){return {text:'',ended:false,write(value){this.text+=value;return true;},end(value=''){this.text+=value;this.ended=true;}};}
const protocols={responses:'/v1/responses',messages:'/v1/messages',chat:'/v1/chat/completions'};
const complete={
  responses:{id:'resp1',model:'fixture',object:'response',status:'completed',output:[{id:'msg1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'STREAM_OK',annotations:[]}]}],usage:{input_tokens:1,output_tokens:2}},
  messages:{id:'msg1',type:'message',role:'assistant',model:'fixture',content:[{type:'text',text:'STREAM_OK'},{type:'tool_use',id:'call1',name:'read',input:{path:'a'}}],stop_reason:'tool_use',usage:{input_tokens:1,output_tokens:2}},
  chat:{id:'chat1',object:'chat.completion',model:'fixture',choices:[{index:0,message:{role:'assistant',content:'STREAM_OK',tool_calls:[{id:'call1',type:'function',function:{name:'read',arguments:'{"path":"a"}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:2}},
};

test('native SSE parses split UTF8, CRLF, multiline data, event-only types, and an unframed final completion',async()=>{
  const raw=': provider heartbeat\r\n\r\nevent: response.output_text.delta\r\ndata: {"delta":\r\ndata: "hi €"}\r\n\r\nevent: response.completed\r\ndata: {"response":{"id":"r","status":"completed","output":[]}}';
  const res=sink();await forwardSse(Readable.from([...Buffer.from(raw)].map(byte=>Buffer.from([byte]))),res,'responses');
  assert.match(res.text,/hi €/);assert.match(res.text,/"type":"response.completed"/);assert(res.text.endsWith('\n\n'));assert.equal(res.ended,true);
  const invalid=Readable.from([Buffer.from('event: response.completed\ndata: {"response":')]);await assert.rejects(forwardSse(invalid,sink(),'responses'),SyntaxError);
});

test('native protocol terminal evidence is required and errors/incomplete statuses are preserved',async()=>{
  const cases=[['responses','event: response.done\ndata: {"response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}',/response.incomplete/],['messages','data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_stop","index":0}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',/message_stop/],['chat','data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',/\[DONE\]/]];
  for(const [protocol,raw,expected] of cases){const res=sink();await forwardSse(Readable.from([raw]),res,protocol);assert.match(res.text,expected);}
  for(const protocol of Object.keys(protocols))await assert.rejects(forwardSse(Readable.from(['data: [DONE]\n\n']),sink(),protocol),/without/);
  await assert.rejects(forwardSse(Readable.from(['data: {"type":"response.output_text.delta","delta":"partial"}\n\n']),sink(),'responses'),/without/);
  await assert.rejects(forwardSse(Readable.from(['data: {"type":"content_block_start","index":0}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n']),sink(),'messages'),/without/);
  const res=sink();await forwardSse(Readable.from(['data: {"type":"error","error":{"message":"quota"}}\n\n']),res,'messages');assert.match(res.text,/quota/);assert.doesNotMatch(res.text,/message_stop/);
});

test('all client protocols receive native SSE from complete upstream JSON in foreground and active proxy modes',async t=>{
  let requests=0;
  const upstream=await start(t,http.createServer(async(req,res)=>{
    requests++;for await(const chunk of req){};
    const protocol=Object.keys(protocols).find(key=>protocols[key]===req.url);
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(complete[protocol]));
  }));
  for(const catalog of [null,{find:async()=>({id:'fixture',supported_endpoint_types:['responses','messages','chat']})}]) {
    const proxy=await start(t,createProxy({endpoint:upstream+'/v1',catalog}));
    for(const [protocol,path] of Object.entries(protocols)){
      const result=await fetch(proxy+path,{method:'POST',body:JSON.stringify({model:'fixture',stream:true})});assert.equal(result.status,200);assert.match(result.headers.get('content-type'),/event-stream/);
      const wire=await result.text();assert.match(wire,/STREAM_OK/);assert.match(wire,protocol==='responses' ? /response.completed/ : protocol==='messages' ? /message_stop/ : /\[DONE\]/);
      if(protocol!=='responses')assert.match(wire,/call1/);
    }
  }
  assert.equal(requests,6);
});

test('translated complete JSON generates the requested client stream',async t=>{
  const upstream=await start(t,http.createServer(async(req,res)=>{for await(const chunk of req){};res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(complete.responses));}));
  const catalog={find:async()=>({id:'gpt-fixture',supported_endpoint_types:['responses']})};
  const proxy=await start(t,createProxy({endpoint:upstream+'/v1',catalog}));
  for(const path of ['/v1/messages','/v1/chat/completions']){
    const response=await fetch(proxy+path,{method:'POST',body:JSON.stringify({model:'gpt-fixture',stream:true,messages:[{role:'user',content:'hi'}]})});const wire=await response.text();assert.equal(response.status,200);assert.match(wire,/STREAM_OK/);assert.match(wire,path.includes('messages') ? /message_stop/ : /\[DONE\]/);
  }
});

test('a real interrupted stream yields a useful protocol error without success or retry',async t=>{
  let count=0;
  const upstream=await start(t,http.createServer(async(req,res)=>{count++;for await(const chunk of req){};res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"type":"response.output_text.delta","delta":"partial","output_index":0}\n\n');}));
  const proxy=await start(t,createProxy({endpoint:upstream+'/v1'}));
  const response=await fetch(proxy+'/v1/responses',{method:'POST',body:JSON.stringify({stream:true})});const wire=await response.text();assert.match(wire,/partial/);assert.match(wire,/upstream_stream_incomplete/);assert.doesNotMatch(wire,/response.completed/);assert.equal(count,1);
});

test('all protocols keep the local connection alive during quiet upstream pauses and clean up heartbeat timers',async t=>{
  const interval=globalThis.setInterval,clear=globalThis.clearInterval,timeout=globalThis.setTimeout;
  const heartbeats=new Set();
  t.mock.method(globalThis,'setInterval',(fn,ms,...args)=>{const timer=interval(fn,ms===HEARTBEAT_MS ? 10 : ms,...args);if(ms===HEARTBEAT_MS)heartbeats.add(timer);return timer;});
  t.mock.method(globalThis,'clearInterval',timer=>{heartbeats.delete(timer);return clear(timer);});
  const upstream=await start(t,http.createServer(async(req,res)=>{
    for await(const chunk of req){};
    const protocol=Object.keys(protocols).find(key=>protocols[key]===req.url);
    res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();
    timeout(()=>res.end(jsonSse(complete[protocol],protocol).join('')),45);
  }));
  const proxy=await start(t,createProxy({endpoint:upstream+'/v1'}));
  for(const path of Object.values(protocols)){
    const response=await fetch(proxy+path,{method:'POST',body:JSON.stringify({stream:true})});const wire=await response.text();assert.match(wire,/: ag keepalive/);assert.match(wire,/STREAM_OK/);
  }
  await new Promise(resolve=>timeout(resolve,0));assert.equal(heartbeats.size,0);assert.equal(STREAM_IDLE_TIMEOUT,600_000);
});

test('the shared SSE parser bounds oversized individual events and JSON conversion rejects unfinished output',async()=>{
  await assert.rejects(async()=>{for await(const frame of readSse(Readable.from(['data: '+ 'x'.repeat(4*1024*1024+1)]))){};},/4 MiB/);
  for(const protocol of Object.keys(protocols))assert.throws(()=>jsonSse({},protocol));
});

test('translated streams accept complete final events without delimiters and finish before the provider closes',async()=>{
  const res=sink();await translateStream(Readable.from(['event: response.output_text.delta\ndata: {"output_index":0,"delta":"ok"}\n\nevent: response.completed\ndata: {"response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}']),'responses','messages','gpt-fixture',res);assert.match(res.text,/message_stop/);assert.match(res.text,/ok/);
});


test('translated terminal events finish the client even if the provider holds its socket open',async t=>{
  const upstream=await start(t,http.createServer(async(req,res)=>{for await(const chunk of req){};res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"response.output_text.delta","output_index":0,"delta":"finished"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n');}));
  const catalog={find:async()=>({id:'gpt-fixture',supported_endpoint_types:['responses']})};
  const proxy=await start(t,createProxy({endpoint:upstream+'/v1',catalog}));
  const response=await fetch(proxy+'/v1/messages',{method:'POST',signal:AbortSignal.timeout(1500),body:JSON.stringify({model:'gpt-fixture',stream:true,messages:[{role:'user',content:'hi'}]})});const wire=await response.text();assert.match(wire,/message_stop/);assert.doesNotMatch(wire,/upstream_stream_incomplete/);
});

test('backpressure waits for drain and a disconnect releases its listeners',async()=>{
  const res=new EventEmitter();res.write=()=>false;
  let done=false;const pending=writeStream(res,'data');pending.then(()=>{done=true;});await Promise.resolve();assert.equal(done,false);res.emit('drain');await pending;assert.equal(res.listenerCount('close'),0);
  const stopped=writeStream(res,'more');res.emit('close');await assert.rejects(stopped,/disconnected/);assert.equal(res.listenerCount('drain'),0);
});

test('abrupt upstream socket closure preserves partial text and sends an error for every client protocol',async t=>{
  let requests=0;
  const first={responses:{type:'response.output_text.delta',output_index:0,delta:'partial'},messages:{type:'content_block_start',index:0,content_block:{type:'text',text:'partial'}},chat:{choices:[{index:0,delta:{content:'partial'},finish_reason:null}]}};
  const upstream=await start(t,http.createServer(async(req,res)=>{requests++;for await(const chunk of req){};const protocol=Object.keys(protocols).find(key=>protocols[key]===req.url);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify(first[protocol])+'\n\n');setTimeout(()=>res.destroy(),20);}));
  const proxy=await start(t,createProxy({endpoint:upstream+'/v1'}));
  for(const [protocol,path] of Object.entries(protocols)){
    const response=await fetch(proxy+path,{method:'POST',body:JSON.stringify({stream:true})});const wire=await response.text();assert.match(wire,/partial/);assert.match(wire,/upstream_stream_incomplete/);assert.doesNotMatch(wire,/response.completed|message_stop|\[DONE\]/);
  }
  assert.equal(requests,3);
});


test('upstream idle timeout yields a protocol error and tears down the upstream request',async t=>{
  const timeout=http.IncomingMessage.prototype.setTimeout;
  t.mock.method(http.IncomingMessage.prototype,'setTimeout',function(ms,callback){return timeout.call(this,ms===STREAM_IDLE_TIMEOUT ? 30 : ms,callback);});
  const upstream=await start(t,http.createServer(async(req,res)=>{for await(const chunk of req){};res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"response.output_text.delta","output_index":0,"delta":"waiting"}\n\n');}));
  const proxy=await start(t,createProxy({endpoint:upstream+'/v1'}));
  const response=await fetch(proxy+'/v1/responses',{method:'POST',body:JSON.stringify({stream:true})});const wire=await response.text();assert.match(wire,/upstream_stream_timeout/);assert.doesNotMatch(wire,/response.completed/);
});


test('compressed upstream SSE and JSON work even when the provider ignores identity encoding',async t=>{
  for(const contentType of ['text/event-stream','application/json']) {
    const upstream=await start(t,http.createServer(async(req,res)=>{for await(const chunk of req){};res.writeHead(200,{'content-type':contentType,'content-encoding':'gzip'});res.end(gzipSync(contentType.includes('event-stream') ? jsonSse(complete.responses,'responses').join('') : JSON.stringify(complete.responses)));}));
    const proxy=await start(t,createProxy({endpoint:upstream+'/v1'}));
    const response=await fetch(proxy+'/v1/responses',{method:'POST',body:JSON.stringify({stream:true})});const wire=await response.text();assert.match(wire,/STREAM_OK/);assert.match(wire,/response.completed/);assert.equal(response.headers.get('content-encoding'),null);
  }
});


test('Responses JSON conversion starts empty items and emits tool/text data exactly once as deltas',()=>{
  const response={...complete.responses,output:[...complete.responses.output,{id:'fc1',type:'function_call',call_id:'call1',name:'read',arguments:'{"path":"a"}'}]};
  const events=jsonSse(response,'responses').map(frame=>JSON.parse(frame.split('data: ')[1]));
  assert.deepEqual(events.find(event=>event.type==='response.output_item.added').item.content,[]);
  assert.equal(events.find(event=>event.type==='response.content_part.added').part.text,'');
  assert.equal(events.filter(event=>event.type==='response.output_text.delta').map(event=>event.delta).join(''),'STREAM_OK');
  assert.equal(events.find(event=>event.type==='response.function_call_arguments.delta').delta,'{"path":"a"}');
});

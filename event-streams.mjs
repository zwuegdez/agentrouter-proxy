import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

export const STREAM_IDLE_TIMEOUT = 10 * 60_000;
export const HEARTBEAT_MS = 15_000;

export function decodeUpstream(stream,encoding) {
  const value=String(encoding || 'identity').trim().toLowerCase();
  if(value==='identity' || !value)return stream;
  const decoder=value==='gzip' ? createGunzip() : value==='deflate' ? createInflate() : value==='br' ? createBrotliDecompress() : null;
  if(!decoder)throw new Error('Unsupported upstream content encoding.');
  stream.once('error',error=>decoder.destroy(error));
  decoder.once('close',()=>{if(!stream.complete)stream.destroy();});
  return stream.pipe(decoder);
}

export async function writeStream(res, value) {
  if (res.destroyed || res.writableEnded) throw new Error('Client disconnected.');
  if(res.write(value)===false)await new Promise((resolve,reject)=>{
    const cleanup=()=>{res.off('drain',drained);res.off('close',closed);res.off('error',failed);};
    const drained=()=>{cleanup();resolve();};
    const closed=()=>{cleanup();reject(new Error('Client disconnected.'));};
    const failed=error=>{cleanup();reject(error);};
    res.once('drain',drained);res.once('close',closed);res.once('error',failed);
  });
}

export async function* readSse(stream) {
  let buffer = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const frame = raw => {
    const lines = raw.split(/\r\n|\n|\r/);
    return { raw, event: lines.find(line=>line.startsWith('event:'))?.slice(6).trim(),
      data: lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n') };
  };
  for await (const chunk of stream) {
    buffer += decoder.decode(typeof chunk==='string' ? Buffer.from(chunk) : chunk,{stream:true});
    let match;
    while ((match = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
      if (match.index > 4 * 1024 * 1024) throw new Error('Upstream SSE event exceeds 4 MiB.');
      yield frame(buffer.slice(0,match.index)); buffer=buffer.slice(match.index+match[0].length);
    }
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Upstream SSE event exceeds 4 MiB.');
  }
  buffer += decoder.decode();
  // Some gateways omit the last blank line; valid JSON still supplies an explicit terminal event.
  if (buffer.trim()) yield frame(buffer);
}

export function streamError(res, protocol, code = 'upstream_stream_incomplete') {
  if (res.destroyed || res.writableEnded) return;
  const message = code === 'upstream_stream_timeout'
    ? 'The upstream stream was idle for 10 minutes. No generation was replayed.'
    : 'The upstream stream ended before a complete response. Partial output was preserved; no generation was replayed.';
  const error={type:protocol === 'messages' ? 'api_error' : 'server_error',code,message};
  const value=protocol === 'chat' ? {error} : {type:'error',code,message,error};
  res.end(`${protocol === 'chat' ? '' : 'event: error\n'}data: ${JSON.stringify(value)}\n\n`);
}

export async function forwardSse(stream,res,protocol) {
  let terminal=false, chatFinished=false, messageStopped=false;
  const openBlocks=new Set();
  for await (const frame of readSse(stream)) {
    if (!frame.data) { await writeStream(res,frame.raw+'\n\n'); continue; }
    if (frame.data.trim()==='[DONE]') {
      if (protocol==='chat' && chatFinished) { await writeStream(res,'data: [DONE]\n\n');res.end();return; }
      if (!terminal) throw new Error('Upstream sent DONE without a protocol completion event.');
      continue;
    }
    let value=JSON.parse(frame.data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid upstream SSE payload.');
    if (protocol!=='chat' && !value.type && frame.event) value={...value,type:frame.event};
    if (protocol==='responses' && value.type==='response.done' && ['completed','incomplete','failed'].includes(value.response?.status)) value={...value,type:'response.'+value.response.status};
    const type=value.type;
    if (protocol==='responses') terminal=['response.completed','response.incomplete','response.failed','error','response.error'].includes(type);
    else if (protocol==='messages') {
      if(type==='content_block_start')openBlocks.add(value.index);
      if(type==='content_block_stop')openBlocks.delete(value.index);
      if(type==='message_delta' && value.delta?.stop_reason) messageStopped=true;
      terminal=['message_stop','error'].includes(type);
    } else {
      if(value.error) terminal=true;
      if(value.choices?.length && value.choices.every(choice=>choice.finish_reason !== null && choice.finish_reason !== undefined)) chatFinished=true;
    }
    const event=protocol==='chat' ? '' : `event: ${type || frame.event || 'message'}\n`;
    const other=frame.raw.split(/\r\n|\n|\r/).filter(line=>!line.startsWith('event:') && !line.startsWith('data:')).join('\n');
    await writeStream(res,`${other ? other+'\n' : ''}${event}data: ${JSON.stringify(value)}\n\n`);
    if(terminal){res.end();return;}
  }
  if(protocol==='chat' && chatFinished){await writeStream(res,'data: [DONE]\n\n');res.end();return;}
  if(protocol==='messages' && messageStopped && !openBlocks.size){await writeStream(res,'event: message_stop\ndata: {"type":"message_stop"}\n\n');res.end();return;}
  throw new Error('Upstream ended without a protocol completion event.');
}

export function jsonSse(value,protocol) {
  const events=[];
  const push=(type,data)=>events.push(`${protocol==='chat' ? '' : `event: ${type}\n`}data: ${JSON.stringify(protocol==='chat' ? data : {type,...data,...(protocol==='responses' ? {sequence_number:events.length} : {})})}\n\n`);
  if(value.error || value.status==='failed') {
    if(protocol==='responses' && value.status==='failed')push('response.failed',{response:value});
    else push('error',{error:value.error || {type:'server_error',message:'Upstream generation failed.'}});
  } else if(protocol==='responses') {
    if(!Array.isArray(value.output) || !['completed','incomplete'].includes(value.status))throw new Error('Upstream JSON response has no terminal status.');
    push('response.created',{response:{...value,status:'in_progress',output:[]}});
    for(const [output_index,item] of value.output.entries()) {
      const initial=item.type==='message' ? {...item,status:'in_progress',content:[]} : item.type==='function_call' ? {...item,status:'in_progress',arguments:''} : item.type==='custom_tool_call' ? {...item,status:'in_progress',input:''} : item;
      push('response.output_item.added',{output_index,item:initial});
      if(item.type==='function_call'){push('response.function_call_arguments.delta',{output_index,item_id:item.id,delta:item.arguments});push('response.function_call_arguments.done',{output_index,item_id:item.id,arguments:item.arguments});}
      if(item.type==='custom_tool_call'){push('response.custom_tool_call_input.delta',{output_index,item_id:item.id,delta:item.input});push('response.custom_tool_call_input.done',{output_index,item_id:item.id,input:item.input});}
      if(item.type==='message')for(const [content_index,part] of (item.content || []).entries()) {
        push('response.content_part.added',{output_index,content_index,item_id:item.id,part:part.type==='output_text' ? {...part,text:''} : part});
        if(part.type==='output_text'){push('response.output_text.delta',{output_index,content_index,item_id:item.id,delta:part.text});push('response.output_text.done',{output_index,content_index,item_id:item.id,text:part.text});}
        push('response.content_part.done',{output_index,content_index,item_id:item.id,part});
      }
      push('response.output_item.done',{output_index,item});
    }
    push('response.'+value.status,{response:value});
  } else if(protocol==='messages') {
    if(!Array.isArray(value.content) || !value.stop_reason)throw new Error('Upstream JSON message has no stop reason.');
    push('message_start',{message:{...value,content:[],stop_reason:null,stop_sequence:null}});
    for(const [index,block] of value.content.entries()) {
      if(block.type==='text') {
        push('content_block_start',{index,content_block:{...block,text:''}});
        push('content_block_delta',{index,delta:{type:'text_delta',text:block.text}});
      } else if(block.type==='tool_use') {
        push('content_block_start',{index,content_block:{...block,input:{}}});
        push('content_block_delta',{index,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}});
      } else if(block.type==='thinking') {
        push('content_block_start',{index,content_block:{type:'thinking',thinking:''}});
        push('content_block_delta',{index,delta:{type:'thinking_delta',thinking:block.thinking}});
        if(block.signature)push('content_block_delta',{index,delta:{type:'signature_delta',signature:block.signature}});
      } else push('content_block_start',{index,content_block:block});
      push('content_block_stop',{index});
    }
    push('message_delta',{delta:{stop_reason:value.stop_reason,stop_sequence:value.stop_sequence || null},usage:value.usage});
    push('message_stop',{});
  } else {
    if(!value.choices?.length || value.choices.some(choice=>!choice.finish_reason))throw new Error('Upstream JSON completion has no finish reason.');
    for(const choice of value.choices) {
      const {tool_calls,...message}=choice.message;
      push('',{...value,object:'chat.completion.chunk',choices:[{index:choice.index,delta:{...message,...(tool_calls ? {tool_calls:tool_calls.map((call,index)=>({...call,index}))} : {})},finish_reason:null}]});
    }
    push('',{...value,object:'chat.completion.chunk',choices:value.choices.map(choice=>({index:choice.index,delta:{},finish_reason:choice.finish_reason}))});
    events.push('data: [DONE]\n\n');
  }
  return events;
}

import { randomUUID } from 'node:crypto';
import { readSse, writeStream } from './ag-streams.mjs';

export class ProtocolError extends Error {}
const list = value => typeof value === 'string' ? [{ type: 'text', text: value }] : value || [];
const text = value => list(value).map(block => {
  if (block.type !== 'text' && block.type !== 'input_text' && block.type !== 'output_text') throw new ProtocolError(`Cannot translate content type ${block.type}. Use a native endpoint for this feature.`);
  return block.text;
}).join('\n');

function content(blocks, role) {
  return list(blocks).map(block => {
    if (['text', 'input_text', 'output_text'].includes(block.type)) return { type: role === 'assistant' ? 'output_text' : 'input_text', text: block.text };
    if (block.type === 'image') {
      const source = block.source;
      return { type: 'input_image', image_url: source.type === 'url' ? source.url : `data:${source.media_type};base64,${source.data}` };
    }
    if (block.type === 'image_url') return { type: 'input_image', image_url: block.image_url.url };
    if (block.type === 'input_image') return block;
    throw new ProtocolError(`Cannot translate content type ${block.type}. Use a native endpoint for this feature.`);
  });
}

export function toResponses(body, source) {
  if (source === 'responses') return body;
  if (!Array.isArray(body.messages)) throw new ProtocolError('messages must be an array.');
  const out = { model: body.model, input: [], stream: Boolean(body.stream) };
  if (body.system) out.instructions = text(body.system);
  for (const key of ['temperature', 'top_p']) if (body[key] !== undefined) out[key] = body[key];
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined) out.max_output_tokens = max;
  const effort=body.output_config?.effort;
  if(effort) out.reasoning={effort:effort === 'max' ? 'xhigh' : effort};
  else if(body.thinking && body.thinking.type !== 'disabled') out.reasoning={effort:'medium'};
  if(body.output_config?.format) out.text={format:body.output_config.format};
  for (const message of body.messages) {
    if (['system', 'developer'].includes(message.role)) {
      out.input.push({ role: message.role, content: content(message.content, 'user') }); continue;
    }
    if (message.role === 'tool') { out.input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: text(message.content) }); continue; }
    if (!['user', 'assistant'].includes(message.role)) throw new ProtocolError('Unsupported message role.');
    let blocks = [];
    const flush = () => { if (blocks.length) out.input.push({ role: message.role, content: content(blocks, message.role) }); blocks = []; };
    for (const block of list(message.content)) {
      if (block.type === 'tool_use') {
        flush(); out.input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      } else if (block.type === 'tool_result') {
        flush(); out.input.push({ type: 'function_call_output', call_id: block.tool_use_id, output: text(block.content) });
      } else if (!['thinking', 'redacted_thinking'].includes(block.type)) blocks.push(block);
    }
    flush();
    for (const call of message.tool_calls || []) out.input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  if (body.tools) out.tools = body.tools.map(tool => {
    if (source === 'messages') {
      if (tool.type && tool.type !== 'custom') throw new ProtocolError(`Native Anthropic tool ${tool.type} cannot use Responses.`);
      return { type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema };
    }
    if (tool.type !== 'function') throw new ProtocolError('Only function tools can be translated.');
    return { type: 'function', ...tool.function };
  });
  if (body.tool_choice) {
    const choice = body.tool_choice;
    out.tool_choice = source === 'messages' ? choice.type === 'tool' ? { type: 'function', name: choice.name } : choice.type === 'any' ? 'required' : choice.type : typeof choice === 'object' ? { type: 'function', name: choice.function.name } : choice;
  }
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.tool_choice?.disable_parallel_tool_use !== undefined) out.parallel_tool_calls = !body.tool_choice.disable_parallel_tool_use;
  if (body.stop || body.stop_sequences?.length) throw new ProtocolError('Stop sequences cannot be translated to Responses.');
  if (body.response_format) out.text = { format: body.response_format.type === 'json_schema' ? { type: 'json_schema', ...body.response_format.json_schema } : body.response_format };
  return out;
}

export function fromResponses(body, target) {
  if (target === 'responses') return body;
  const messages = [], system = [];
  if (body.instructions) system.push(body.instructions);
  for (const item of typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input || []) {
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      if (target === 'messages') messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: item.call_id, name: item.name, input: item.type === 'custom_tool_call' ? { input: item.input } : JSON.parse(item.arguments || '{}') }] });
      else messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.type === 'custom_tool_call' ? JSON.stringify({input:item.input}) : item.arguments } }] });
    } else if (['function_call_output','custom_tool_call_output'].includes(item.type)) {
      messages.push(target === 'messages' ? { role: 'user', content: [{ type: 'tool_result', tool_use_id: item.call_id, content: typeof item.output === 'string' ? item.output : text(item.output) }] } : { role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : text(item.output) });
    } else if (item.role) {
      if (['system', 'developer'].includes(item.role)) { system.push(text(item.content)); continue; }
      messages.push({ role: item.role, content: list(item.content).map(block => {
        if (['input_text', 'output_text', 'text'].includes(block.type)) return { type: 'text', text: block.text };
        if (block.type === 'input_image') {
          if (target === 'chat') return { type: 'image_url', image_url: { url: block.image_url } };
          const data = /^data:([^;]+);base64,(.*)$/s.exec(block.image_url);
          return { type: 'image', source: data ? { type: 'base64', media_type: data[1], data: data[2] } : { type: 'url', url: block.image_url } };
        }
        throw new ProtocolError(`Cannot translate Responses content ${block.type}.`);
      }) });
    } else throw new ProtocolError(`Cannot translate Responses item ${item.type}.`);
  }
  const out = { model: body.model, messages, stream: Boolean(body.stream) };
  if (target === 'messages') {
    if (system.length) out.system = system.join('\n');
    out.max_tokens = body.max_output_tokens || 8192;
    // Adjacent tool items must remain in one Anthropic message.
    out.messages = messages.reduce((all, message) => {
      const previous = all.at(-1);
      if (previous?.role === message.role) previous.content.push(...message.content); else all.push(message);
      return all;
    }, []);
  } else {
    if (system.length) out.messages.unshift({ role: 'system', content: system.join('\n') });
    if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  }
  for (const key of ['temperature', 'top_p', 'parallel_tool_calls']) if (body[key] !== undefined && !(target === 'messages' && key === 'parallel_tool_calls')) out[key] = body[key];
  if (body.tools) out.tools = body.tools.map(tool => {
    if (!['function','custom'].includes(tool.type)) throw new ProtocolError(`Responses tool ${tool.type} requires a Responses endpoint.`);
    const parameters = tool.type === 'custom' ? { type: 'object', properties: { input: { type: 'string', description: 'The complete raw tool input.' } }, required: ['input'], additionalProperties: false } : tool.parameters || { type: 'object', properties: {} };
    return target === 'messages' ? { name: tool.name, description: tool.description, input_schema: parameters } : { type: 'function', function: { name: tool.name, description: tool.description, parameters, ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } };
  });
  if (body.tool_choice) out.tool_choice = target === 'messages' ? typeof body.tool_choice === 'object' ? { type: 'tool', name: body.tool_choice.name } : { type: body.tool_choice === 'required' ? 'any' : body.tool_choice } : typeof body.tool_choice === 'object' ? { type: 'function', function: { name: body.tool_choice.name } } : body.tool_choice;
  if (target === 'messages' && body.parallel_tool_calls === false) out.tool_choice = { ...out.tool_choice || { type: 'auto' }, disable_parallel_tool_use: true };
  if(body.reasoning?.effort && body.reasoning.effort !== 'none') {
    if(target === 'messages') {out.thinking={type:'adaptive'};out.output_config={effort:body.reasoning.effort === 'xhigh' ? 'max' : body.reasoning.effort};}
    else out.reasoning_effort=body.reasoning.effort;
  }
  if(body.text?.format && body.text.format.type !== 'text') {
    if(target === 'messages') out.output_config={...out.output_config,format:body.text.format};
    else out.response_format=body.text.format.type === 'json_schema' ? {type:'json_schema',json_schema:{...body.text.format,type:undefined}} : body.text.format;
  }
  return out;
}

function normalizeResponse(body, source) {
  if (source === 'responses') return body;
  const output = [];
  let reason, usage;
  if (source === 'messages') {
    for (const block of body.content || []) {
      if (block.type === 'text') output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }] });
      else if (block.type === 'tool_use') output.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') throw new ProtocolError(`Cannot translate output ${block.type}.`);
    }
    reason = body.stop_reason; usage = { input_tokens: body.usage?.input_tokens || 0, output_tokens: body.usage?.output_tokens || 0 };
  } else {
    const choice = body.choices?.[0];
    if (!choice) throw new ProtocolError('Upstream returned no completion.');
    if (choice.message.content) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: choice.message.content, annotations: [] }] });
    for (const call of choice.message.tool_calls || []) output.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    reason = choice.finish_reason; usage = { input_tokens: body.usage?.prompt_tokens || 0, output_tokens: body.usage?.completion_tokens || 0 };
  }
  return { id: body.id || `resp_${randomUUID()}`, object: 'response', model: body.model, status: ['max_tokens', 'length'].includes(reason) ? 'incomplete' : 'completed', incomplete_details: ['max_tokens', 'length'].includes(reason) ? { reason: 'max_output_tokens' } : null, output, usage };
}

export function translateResponse(body, source, target, model, tools = []) {
  const value = normalizeResponse(body, source);
  const custom = new Set(tools.filter(tool=>tool.type === 'custom').map(tool=>tool.name));
  if (target === 'responses') value.output = value.output.map(item=>item.type === 'function_call' && custom.has(item.name) ? { ...item, type: 'custom_tool_call', input: JSON.parse(item.arguments).input, arguments: undefined } : item);
  if (target === 'responses') return value;
  const calls = value.output.filter(item => item.type === 'function_call');
  const outputText = value.output.filter(item => item.type === 'message').flatMap(item => item.content).map(block => block.text || '').join('');
  if (target === 'messages') return { id: value.id, type: 'message', role: 'assistant', model, content: [ ...(outputText ? [{ type: 'text', text: outputText }] : []), ...calls.map(item => ({ type: 'tool_use', id: item.call_id, name: item.name, input: item.type === 'custom_tool_call' ? { input: item.input } : JSON.parse(item.arguments || '{}') })) ], stop_reason: calls.length ? 'tool_use' : value.status === 'incomplete' ? 'max_tokens' : 'end_turn', stop_sequence: null, usage: { input_tokens: value.usage?.input_tokens || 0, output_tokens: value.usage?.output_tokens || 0 } };
  return { id: value.id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: outputText || null, ...(calls.length ? { tool_calls: calls.map(item => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } })) } : {}) }, finish_reason: calls.length ? 'tool_calls' : value.status === 'incomplete' ? 'length' : 'stop' }], usage: { prompt_tokens: value.usage?.input_tokens || 0, completion_tokens: value.usage?.output_tokens || 0, total_tokens: (value.usage?.input_tokens || 0) + (value.usage?.output_tokens || 0) } };
}

async function* sse(stream) {
  let size=0;
  for await(const {event,data} of readSse(stream)) {
    if(!data)continue;
    if(data.trim()==='[DONE]'){yield {type:'ag.done'};continue;}
    size+=data.length;
    if(size>32*1024*1024)throw new ProtocolError('Translated output exceeds 32 MiB.');
    const value=JSON.parse(data);
    if(!value || typeof value!=='object' || Array.isArray(value))throw new ProtocolError('Invalid upstream SSE payload.');
    if(!value.type && event)value.type=event;
    if(value.type==='response.done' && ['completed','incomplete','failed'].includes(value.response?.status))value.type='response.'+value.response.status;
    yield value;
  }
}

export async function translateStream(stream, source, target, model, res, tools = []) {
  const custom = new Set(tools.filter(tool=>tool.type === 'custom').map(tool=>tool.name));
  const id = `resp_${randomUUID()}`, items = new Map();
  let started = false, ended = false, usage = { input_tokens: 0, output_tokens: 0 }, sequence = 0, limited = false, incompleteDetails=null;
  const openBlocks=new Set();
  let pending=[];
  const flush=async()=>{for(const value of pending)await writeStream(res,value);pending=[];};
  const send = (type, value) => {
    const data = target === 'chat' ? value : { type, ...value };
    if (target === 'responses') data.sequence_number = sequence++;
    pending.push(`${target === 'chat' ? '' : `event: ${type}\n`}data: ${JSON.stringify(data)}\n\n`);
  };
  const response = status => ({ id, object: 'response', model, status, output: [...items.values()].map(item => item.call ? { id: item.id, type: custom.has(item.name) ? 'custom_tool_call' : 'function_call', call_id: item.call, name: item.name, ...(custom.has(item.name) ? { input: JSON.parse(item.value || '{}').input || '' } : { arguments: item.value }), status: 'completed' } : { id: item.id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: item.value, annotations: [] }] }), usage });
  const chat = (delta, finish_reason = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model, choices: [{ index: 0, delta, finish_reason }], ...extra });
  const start = () => {
    if (started) return; started = true;
    if (target === 'messages') send('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
    else if (target === 'responses') { send('response.created', { response: response('in_progress') }); send('response.in_progress', { response: response('in_progress') }); }
    else send('', chat({ role: 'assistant', content: '' }));
  };
  const add = (key, call, name) => {
    start();
    if (items.has(key)) return items.get(key);
    const item = { index: items.size, id: `item_${randomUUID()}`, call, name, value: '' }; items.set(key, item);
    if (target === 'messages') send('content_block_start', { index: item.index, content_block: call ? { type: 'tool_use', id: call, name, input: {} } : { type: 'text', text: '' } });
    else if (target === 'responses') {
      send('response.output_item.added', { output_index: item.index, item: call ? { id: item.id, type: custom.has(name) ? 'custom_tool_call' : 'function_call', call_id: call, name, ...(custom.has(name) ? { input: '' } : { arguments: '' }), status: 'in_progress' } : { id: item.id, type: 'message', role: 'assistant', content: [], status: 'in_progress' } });
      if (!call) send('response.content_part.added', { item_id: item.id, output_index: item.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    } else if (call) send('', chat({ tool_calls: [{ index: item.index, id: call, type: 'function', function: { name, arguments: '' } }] }));
    return item;
  };
  const delta = (item, value) => {
    item.value += value;
    if (target === 'messages') send('content_block_delta', { index: item.index, delta: item.call ? { type: 'input_json_delta', partial_json: value } : { type: 'text_delta', text: value } });
    else if (target === 'responses' && !custom.has(item.name)) send(item.call ? 'response.function_call_arguments.delta' : 'response.output_text.delta', { item_id: item.id, output_index: item.index, ...(item.call ? {} : { content_index: 0 }), delta: value });
    else if(target==='chat') send('', chat(item.call ? { tool_calls: [{ index: item.index, function: { arguments: value } }] } : { content: value }));
  };
  for await (const event of sse(stream)) {
    await flush();
    if(event.type==='ag.done'){if(!ended)throw new ProtocolError('Upstream sent DONE without completion.');break;}
    if (event.type === 'error' || event.error || ['response.failed','response.error'].includes(event.type)) throw new ProtocolError('Upstream generation failed. No request was replayed.');
    if (ended) {
      if(source==='messages' && event.type==='message_stop')break;
      if(source === 'chat' && event.usage) usage={input_tokens:event.usage.prompt_tokens || 0,output_tokens:event.usage.completion_tokens || 0};
      continue;
    }
    if (source === 'responses') {
      if (event.response?.usage) usage = event.response.usage;
      if (event.type === 'response.output_item.added' && event.item.type === 'function_call') add(event.output_index, event.item.call_id, event.item.name);
      if(event.type === 'response.refusal.delta') throw new ProtocolError('Upstream refused the request.');
      if (event.type === 'response.output_text.delta') delta(add(event.output_index), event.delta);
      if (event.type === 'response.function_call_arguments.delta') {
        const item = items.get(event.output_index); if (!item) throw new ProtocolError('Tool arguments arrived before the tool ID.'); delta(item,event.delta);
      }
      if (['response.completed','response.incomplete'].includes(event.type)) {
        limited = event.type === 'response.incomplete'; incompleteDetails=event.response?.incomplete_details || null; ended = true;
        for (const [index,item] of (event.response?.output || []).entries()) {
          if (item.type === 'function_call' && !items.has(index)) delta(add(index,item.call_id,item.name),item.arguments || '{}');
          if (item.type === 'message' && !items.has(index)) delta(add(index), (item.content || []).map(x=>x.text || '').join(''));
        }
      }
    } else if (source === 'messages') {
      if (event.message?.usage) usage = { ...usage, ...event.message.usage };
      if (event.usage) usage = { ...usage, ...event.usage };
      if (event.type === 'content_block_start') {
        openBlocks.add(event.index);
        const block = event.content_block;
        if (block.type === 'tool_use') add(event.index,block.id,block.name);
        else if (block.type === 'text') { const item=add(event.index); if(block.text) delta(item,block.text); }
        else if (!['thinking','redacted_thinking'].includes(block.type)) throw new ProtocolError(`Cannot translate output ${block.type}.`);
      }
      if (event.type === 'content_block_delta' && ['text_delta','input_json_delta'].includes(event.delta.type)) {
        const item = items.get(event.index); if (!item) throw new ProtocolError('Missing upstream content block.'); delta(item,event.delta.text ?? event.delta.partial_json);
      }
      if(event.type==='content_block_stop')openBlocks.delete(event.index);
      if (event.delta?.stop_reason === 'max_tokens') limited = true;
      if (event.delta?.stop_reason && !openBlocks.size) ended=true;
      if (event.type === 'message_stop') {ended = true;await flush();break;}
    } else {
      if (event.usage) usage = { input_tokens: event.usage.prompt_tokens || 0, output_tokens: event.usage.completion_tokens || 0 };
      const choice = event.choices?.[0];
      if (choice?.delta?.content) delta(add('text'),choice.delta.content);
      for (const call of choice?.delta?.tool_calls || []) {
        let item=items.get(`tool${call.index}`);
        if (!item) { if (!call.id || !call.function?.name) throw new ProtocolError('Tool stream is missing its ID or name.'); item=add(`tool${call.index}`,call.id,call.function.name); }
        if (call.function?.arguments) delta(item,call.function.arguments);
      }
      if (choice?.finish_reason) { limited = choice.finish_reason === 'length'; ended = true; }
    }
    await flush();
    if(source==='responses' && ended)break;
  }
  if (!ended) throw new ProtocolError('Upstream stream ended before completion. No request was replayed.');
  start();
  for (const item of items.values()) {
    if (item.call) { JSON.parse(item.value || '{}'); if (!item.value) item.value='{}'; }
    if (target === 'messages') send('content_block_stop', { index: item.index });
    else if (target === 'responses') {
      if(!item.call) send('response.content_part.done',{item_id:item.id,output_index:item.index,content_index:0,part:{type:'output_text',text:item.value,annotations:[]}});
      if(custom.has(item.name)) {
        const input=JSON.parse(item.value).input; if(typeof input !== 'string')throw new ProtocolError('Custom tool input must be a string.');
        send('response.custom_tool_call_input.delta',{item_id:item.id,output_index:item.index,delta:input});
        send('response.custom_tool_call_input.done',{item_id:item.id,output_index:item.index,input});
      } else send(item.call ? 'response.function_call_arguments.done' : 'response.output_text.done', { item_id: item.id, output_index: item.index, ...(item.call ? { arguments: item.value } : { content_index: 0, text: item.value }) });
      send('response.output_item.done', { output_index: item.index, item: response('completed').output[item.index] });
    }
  }
  const calls = [...items.values()].some(item=>item.call);
  if (target === 'messages') { send('message_delta', { delta: { stop_reason: calls ? 'tool_use' : limited ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage }); send('message_stop', {}); }
  else if (target === 'responses') send(limited ? 'response.incomplete' : 'response.completed', { response: { ...response(limited ? 'incomplete' : 'completed'), incomplete_details: limited ? incompleteDetails || { reason: 'max_output_tokens' } : null } });
  else { send('', chat({},calls ? 'tool_calls' : limited ? 'length' : 'stop',{ usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.input_tokens+usage.output_tokens } })); pending.push('data: [DONE]\n\n'); }
  await flush();
  res.end();
}

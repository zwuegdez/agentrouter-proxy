import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';

process.env.RELAY_UPSTREAM = 'https://agentrouter.org';
process.env.RELAY_PORT = '18765';

let handler, listening;
const calls = [];
const outgoing = [];
mock.method(http, 'createServer', listener => {
  handler = listener;
  return { listen(port, host, ready) { listening = { port, host }; } };
});
mock.method(https, 'request', (options, callback) => {
  const request = new EventEmitter();
  Object.assign(request, {
    end(body) { calls.push({ options, body: Buffer.from(body) }); this.callback = callback; },
    destroy() { this.destroyed = true; },
  });
  outgoing.push(request);
  return request;
});
const { stripStaleRefs } = await import('./agentrouter-coding-proxy.mjs');

function forward(path, body, headers = {}) {
  const req = new EventEmitter(), res = new PassThrough();
  Object.assign(req, { method: 'POST', url: path, headers: { authorization: 'Bearer fixture-key', 'user-agent': 'codex_exec/fixture', originator: 'codex_exec', host: '127.0.0.1:18765', ...headers } });
  res.writeHead = (status, responseHeaders) => { res.status = status; res.responseHeaders = responseHeaders; res.headersSent = true; };
  handler(req, res);
  req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end');
  return res;
}

test('packaged proxy matches the pinned relay content and keeps its loopback address', async () => {
  const packaged = await readFile(new URL('./agentrouter-coding-proxy.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(packaged).digest('hex'), 'ef70f888ec9be06d4f5064f73cbf17f04a7bb8b6ca1e0c50462ae23cdd331c29');
  assert.deepEqual(listening, { port: 18765, host: '127.0.0.1' });
});

test('the original Azure workaround preserves visible history and tool call IDs without mutating caller input', () => {
  const input = { previous_response_id: 'resp-fixture', include: ['reasoning.encrypted_content', 'other'], input: [
    { type: 'reasoning', id: 'rs-fixture', encrypted_content: 'opaque' },
    { type: 'item_reference', id: 'ref-fixture' },
    { type: 'message', id: 'msg-fixture', role: 'user', content: 'hello' },
    { type: 'function_call', id: 'fc-fixture', call_id: 'call-fixture', name: 'check', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-fixture', output: 'checked' },
  ] };
  const original = structuredClone(input), stripped = stripStaleRefs(input);
  assert.deepEqual(input, original);
  assert.equal(stripped.previous_response_id, undefined);
  assert.deepEqual(stripped.include, ['other']);
  assert.deepEqual(stripped.input.map(item => item.type), ['message', 'function_call', 'function_call_output']);
  assert(!stripped.input.some(item => 'id' in item));
  assert.equal(stripped.input[1].call_id, stripped.input[2].call_id);
});

test('the copied request handler forwards real Codex identity and authorization with stale references removed', () => {
  calls.length = 0;
  const input = { model: 'fixture-model', previous_response_id: 'resp-fixture', input: [{ role: 'user', type: 'message', id: 'msg-fixture', content: 'hello' }] };
  forward('/v1/responses?fixture=1', input, { 'x-codex-beta-features': 'remote_compaction_v2' });
  assert.equal(calls.length, 1);
  const { options, body } = calls[0];
  assert.equal(options.hostname, 'agentrouter.org');
  assert.equal(options.path, '/v1/responses?fixture=1');
  assert.equal(options.headers.authorization, 'Bearer fixture-key');
  assert.equal(options.headers['user-agent'], 'codex_exec/fixture');
  assert.equal(options.headers.originator, 'codex_exec');
  assert.equal(options.headers['x-codex-beta-features'], undefined);
  assert.equal(Number(options.headers['content-length']), body.length);
  assert.deepEqual(JSON.parse(body), stripStaleRefs(input));
});

test('the original relay streams upstream errors unchanged and does not replay failed generation', async () => {
  calls.length = 0;
  const res = forward('/v1/responses', { input: 'hello' });
  const received = [];
  res.on('data', chunk => received.push(chunk));
  const upstream = new PassThrough();
  Object.assign(upstream, { statusCode: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } });
  outgoing.at(-1).callback(upstream);
  upstream.end('{"error":{"message":"fixture quota error"}}');
  await new Promise(resolve => res.once('finish', resolve));
  assert.equal(res.status, 429);
  assert.equal(Buffer.concat(received).toString(), '{"error":{"message":"fixture quota error"}}');
  assert.equal(calls.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy, validateEndpoint, stripStaleRefs } from './ag-proxy.mjs';

async function start(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

test('endpoint validation rejects insecure remote URLs and embedded credentials', () => {
  for (const endpoint of ['http://example.com/v1', 'http://127.evil.example/v1', 'ftp://127.0.0.1', 'https://key@example.com', 'https://example.com/v1?key=x', 'https://example.com/v1#x', 'https://example.com/?', 'https://example.com/#', '']) assert.throws(() => validateEndpoint(endpoint));
  assert.equal(validateEndpoint('https://example.com/v1/').href, 'https://example.com/v1');
  assert.equal(validateEndpoint('http://[::1]:3000/v1').hostname, '[::1]');
  assert.throws(() => createProxy({ apiKey: 'private-upstream' }), /local bearer token/);
  assert.throws(() => createProxy({ apiKey: 'bad\nkey', localBearer: 'local' }), /Invalid/);
  const proxy = createProxy();
  assert.throws(() => proxy.listen(0, '0.0.0.0'), /loopback/);
});

test('stale references are removed without changing visible history or tool call matching', () => {
  const input = { previous_response_id: 'resp-old', input: [
    { type: 'reasoning', id: 'rs-old' }, { type: 'item_reference', id: 'ref-old' },
    { type: 'message', id: 'msg-old', role: 'user', content: 'hello' },
    { type: 'function_call', id: 'fn-old', call_id: 'call-current', name: 'check', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-current', output: 'done' },
  ], include: ['reasoning.encrypted_content', 'other'] };
  const previous = structuredClone(input), output = stripStaleRefs(input);
  assert.deepEqual(input, previous);
  assert.equal(output.previous_response_id, undefined);
  assert.deepEqual(output.input.map(item => item.type), ['message', 'function_call', 'function_call_output']);
  assert.equal(output.input[1].call_id, output.input[2].call_id);
  assert(output.input.every(item => !('id' in item)));
  assert.deepEqual(output.include, ['other']);
});

test('Responses streaming keeps real client headers, strips stale refs, and substitutes only configured auth', async t => {
  let observed;
  const endpoint = await start(t, http.createServer(async (req, res) => {
    observed = { url: req.url, headers: req.headers, body: await readRequest(req) };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request', connection: 'x-private-hop', 'x-private-hop': 'removed' });
    res.write('event: response.output_text.delta\ndata: {"delta":"ok"}\n\n');
    res.end('event: response.completed\ndata: {}\n\n');
  }));
  const base = await start(t, createProxy({ endpoint: endpoint + '/api/v1', apiKey: 'upstream-fixture', localBearer: 'local-fixture' }));
  const result = await fetch(base + '/v1/responses?stream=1', {
    method: 'POST', headers: { authorization: 'Bearer local-fixture', 'user-agent': 'codex/fixture', originator: 'codex_exec', 'x-codex-beta-features': 'old', 'x-api-key': 'local-fixture' },
    body: JSON.stringify({ previous_response_id: 'resp-old', input: [{ type: 'message', id: 'msg-old', content: 'hello' }] }),
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-request-id'), 'fixture-request');
  assert.equal(result.headers.get('x-private-hop'), null);
  assert.equal(await result.text(), 'event: response.output_text.delta\ndata: {"delta":"ok"}\n\nevent: response.completed\ndata: {}\n\n');
  assert.equal(observed.url, '/api/v1/responses?stream=1');
  assert.equal(observed.headers.authorization, 'Bearer upstream-fixture');
  assert.equal(observed.headers['x-api-key'], undefined);
  assert.equal(observed.headers['user-agent'], 'codex/fixture');
  assert.equal(observed.headers.originator, 'codex_exec');
  assert.equal(observed.headers['x-codex-beta-features'], undefined);
  assert.deepEqual(JSON.parse(observed.body), { input: [{ type: 'message', content: 'hello' }] });
  assert.equal(Number(observed.headers['content-length']), observed.body.length);
});

test('Claude messages preserve request bytes and get native upstream auth without a duplicated v1', async t => {
  const observed = [];
  const endpoint = await start(t, http.createServer(async (req, res) => {
    observed.push({ url: req.url, headers: req.headers, body: await readRequest(req) });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  }));
  const base = await start(t, createProxy({ endpoint: endpoint + '/v1', apiKey: 'anthropic-fixture', localBearer: 'local-fixture' }));
  const body = '{ "messages": [{"role":"user","content":"hello"}] }';
  for (const path of ['/v1/messages?beta=1', '/messages/count_tokens']) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'x-api-key': 'local-fixture', 'anthropic-version': '2023-06-01' }, body });
    assert.equal(response.status, 200); await response.text();
  }
  assert.deepEqual(observed.map(item => item.url), ['/v1/messages?beta=1', '/v1/messages/count_tokens']);
  for (const item of observed) {
    assert.equal(item.headers.authorization, 'Bearer anthropic-fixture');
    assert.equal(item.headers['x-api-key'], 'anthropic-fixture');
    assert.equal(item.headers['anthropic-version'], '2023-06-01');
    assert.equal(item.body.toString(), body);
  }
});

test('already configured clients keep their own auth and upstream errors are not retried', async t => {
  let count = 0, observed;
  const endpoint = await start(t, http.createServer(async (req, res) => {
    count++; observed = { headers: req.headers, url: req.url, body: await readRequest(req) };
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
    res.end('{"error":{"code":0,"message":"original fixture error"}}');
  }));
  const base = await start(t, createProxy({ endpoint }));
  const result = await fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer existing-key', 'x-api-key': 'existing-native-key' }, body: 'not json' });
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('retry-after'), '3');
  assert.equal(await result.text(), '{"error":{"code":0,"message":"original fixture error"}}');
  assert.equal(count, 1);
  assert.equal(observed.headers.authorization, 'Bearer existing-key');
  assert.equal(observed.headers['x-api-key'], 'existing-native-key');
  assert.equal(observed.body.toString(), 'not json');
  assert.equal(observed.url, '/v1/responses');
});

test('requests without the local secret are rejected before exposing upstream credentials', async t => {
  let count = 0;
  const endpoint = await start(t, http.createServer((req, res) => { count++; res.end('unexpected'); }));
  const base = await start(t, createProxy({ endpoint, apiKey: 'private-fixture', localBearer: 'local-fixture' }));
  for (const authorization of ['', 'Bearer wrong']) {
    const result = await fetch(base + '/v1/models', { headers: { authorization } });
    assert.equal(result.status, 401);
    assert(!((await result.text()).includes('private-fixture')));
  }
  assert.equal(count, 0);
});

test('oversized uploads are rejected without sending any upstream request', async t => {
  let count = 0;
  const endpoint = await start(t, http.createServer((req, res) => { count++; res.end(); }));
  const base = await start(t, createProxy({ endpoint }));
  const result = await new Promise((resolve, reject) => {
    const request = http.request(base + '/v1/responses', { method: 'POST', headers: { 'content-length': String(32 * 1024 * 1024 + 1) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(result, 413); assert.equal(count, 0);
});

test('chunked uploads are bounded too, without forwarding partial data upstream', async t => {
  let count = 0;
  const endpoint = await start(t, http.createServer((req, res) => { count++; res.end(); }));
  const base = await start(t, createProxy({ endpoint }));
  const result = await new Promise((resolve, reject) => {
    const request = http.request(base + '/v1/responses', { method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    request.on('error', reject);
    const chunk = Buffer.alloc(1024 * 1024, 'x');
    for (let index = 0; index < 33; index++) request.write(chunk);
    request.end();
  });
  assert.equal(result, 413); assert.equal(count, 0);
});

test('an upstream connection failure returns a generic error without revealing the configured key', async t => {
  const unavailable = http.createServer();
  await new Promise(resolve => unavailable.listen(0, '127.0.0.1', resolve));
  const port = unavailable.address().port;
  await new Promise(resolve => unavailable.close(resolve));
  const base = await start(t, createProxy({ endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'private-fixture', localBearer: 'local-fixture' }));
  const result = await fetch(base + '/models', { headers: { authorization: 'Bearer local-fixture' } });
  assert.equal(result.status, 502);
  assert.equal(await result.text(), '{"error":{"message":"Could not reach the configured upstream."}}');
});

test('client disconnect cancels a streaming upstream request', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const endpoint = await start(t, http.createServer((req, res) => {
    res.on('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n');
  }));
  const base = await start(t, createProxy({ endpoint }));
  const controller = new AbortController();
  const response = await fetch(base + '/v1/responses', { signal: controller.signal });
  const reader = response.body.getReader();
  assert((await reader.read()).value.length > 0);
  controller.abort();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream was not cancelled.')), 2000).unref())]);
});

test('a connection with no upstream headers times out without retrying', async t => {
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => originalSetTimeout(callback, delay === 60_000 ? 30 : delay, ...args));
  let requests = 0;
  const endpoint = await start(t, http.createServer((req, res) => { requests++; }));
  const base = await start(t, createProxy({ endpoint }));
  const response = await fetch(base + '/v1/responses');
  assert.equal(response.status, 504);
  assert.equal(await response.text(), '{"error":{"message":"The upstream request timed out."}}');
  assert.equal(requests, 1);
});

test('the connection/header deadline is cleared while an upstream response continues streaming', async t => {
  const originalSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => originalSetTimeout(callback, delay === 60_000 ? 30 : delay, ...args));
  const endpoint = await start(t, http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    originalSetTimeout(() => res.end('data: final\n\n'), 80);
  }));
  const base = await start(t, createProxy({ endpoint }));
  const response = await fetch(base + '/v1/responses');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: first\n\ndata: final\n\n');
});

// Local relay for Codex -> AgentRouter. Fixes "The requested item was created under a
// different Azure OpenAI resource": AgentRouter spreads turns over several Azure resources,
// and Codex replays item ids / encrypted reasoning from earlier turns that only the original
// resource accepts. This strips those references and disables the incompatible
// remote-compaction beta route; the caller remains the real Codex client.
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';

const UPSTREAM = new URL(process.env.RELAY_UPSTREAM || 'https://agentrouter.org');
const PORT = Number(process.env.RELAY_PORT) || 18765;

export function stripStaleRefs(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  delete out.previous_response_id;
  if (Array.isArray(out.input)) {
    out.input = out.input
      .filter(item => item?.type !== 'reasoning' && item?.type !== 'item_reference')
      .map(item => {
        if (!item || typeof item !== 'object') return item;
        const { id, ...rest } = item; // call_id stays: tool results are matched by it
        return rest;
      });
  }
  if (Array.isArray(out.include)) out.include = out.include.filter(x => x !== 'reasoning.encrypted_content');
  return out;
}

if (process.argv.includes('--self-test')) {
  const fixed = stripStaleRefs({
    previous_response_id: 'resp_1', include: ['reasoning.encrypted_content'],
    input: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'x' }, { type: 'message', id: 'msg_1', role: 'user', content: 'hi' },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'f', arguments: '{}' }, { type: 'function_call_output', call_id: 'call_1', output: 'ok' }]
  });
  assert.equal(fixed.previous_response_id, undefined);
  assert.deepEqual(fixed.include, []);
  assert.deepEqual(fixed.input.map(i => i.type), ['message', 'function_call', 'function_call_output']);
  assert.ok(fixed.input.every(i => !('id' in i)));
  assert.equal(fixed.input[1].call_id, 'call_1');
  console.log('self-test ok');
  process.exit(0);
}

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    if (req.method === 'POST' && /\/responses(\?|$)/.test(req.url) && body.length) {
      try { body = Buffer.from(JSON.stringify(stripStaleRefs(JSON.parse(body.toString('utf8'))))); }
      catch { /* not JSON: forward as is */ }
    }
    const headers = { ...req.headers, host: UPSTREAM.host };
    // AgentRouter's remote_compaction_v2 route returns rate-limit streams Codex cannot read.
    delete headers['x-codex-beta-features'];
    delete headers['content-length'];
    if (body.length) headers['content-length'] = String(body.length);
    const up = https.request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || 443, path: req.url, method: req.method, headers }, upRes => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    });
    up.on('error', err => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `relay: ${err.message}` } }));
    });
    res.on('close', () => { if (!res.writableEnded) up.destroy(); });
    up.end(body);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`codex relay on http://127.0.0.1:${PORT} -> ${UPSTREAM.origin}`));

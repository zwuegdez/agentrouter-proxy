import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const MAX_BODY = 32 * 1024 * 1024;
const HEADER_TIMEOUT = 60_000;
const STREAM_IDLE_TIMEOUT = 120_000;
const LOOPBACK = host => host === 'localhost' || host === '::1' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));

export function validateEndpoint(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('An upstream endpoint is required.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a valid upstream endpoint URL.'); }
  if (url.username || url.password || value.includes('?') || value.includes('#')) throw new Error('The upstream endpoint cannot contain credentials, a query, or a fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK(url.hostname))) throw new Error('Use HTTPS for remote endpoints; HTTP is allowed only on loopback.');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

export function stripStaleRefs(body) {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  delete out.previous_response_id;
  if (Array.isArray(out.input)) out.input = out.input
    .filter(item => item?.type !== 'reasoning' && item?.type !== 'item_reference')
    .map(item => {
      if (!item || typeof item !== 'object') return item;
      const { id, ...rest } = item; // Tool results still need call_id.
      return rest;
    });
  if (Array.isArray(out.include)) out.include = out.include.filter(item => item !== 'reasoning.encrypted_content');
  return out;
}

function cleanHeaders(original) {
  const headers = { ...original };
  const nominated = String(headers.connection || '').split(',').map(name => name.trim().toLowerCase());
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', ...nominated]) delete headers[name];
  return headers;
}

function upstreamPath(endpoint, target) {
  if (!target?.startsWith('/') || target.startsWith('//')) throw new Error('Invalid request target.');
  const incoming = new URL(target, 'http://127.0.0.1');
  const base = endpoint.pathname.replace(/\/+$/, '');
  let path = incoming.pathname;
  if (base && !(path === base || path.startsWith(base + '/'))) {
    if (base.endsWith('/v1') && (path === '/v1' || path.startsWith('/v1/'))) path = path.slice(3);
    path = base + path;
  }
  return path + incoming.search;
}

function matchesToken(value, expected) {
  if (typeof value !== 'string') return false;
  const provided = Buffer.from(value), wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

export function createProxy({ endpoint = 'https://agentrouter.org/v1', apiKey = '', localBearer = '', port = 18766 } = {}) {
  const upstream = validateEndpoint(endpoint);
  for (const [name, value] of [['API key', apiKey], ['local bearer', localBearer]]) {
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${name}.`);
  }
  if (apiKey && !localBearer) throw new Error('A local bearer token is required when an upstream API key is configured.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid proxy port.');
  const server = http.createServer((req, res) => {
    let request, response, rejected = false;
    const reply = (status, message) => {
      if (rejected || res.destroyed || res.writableEnded) return;
      rejected = true;
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    };
    res.on('close', () => { if (!res.writableEnded) { request?.destroy(); response?.destroy(); } });
    req.on('aborted', () => { request?.destroy(); response?.destroy(); });
    req.on('error', () => { reply(400, 'Could not read the request.'); request?.destroy(); });
    if (localBearer && !(matchesToken(req.headers.authorization, `Bearer ${localBearer}`) || matchesToken(req.headers['x-api-key'], localBearer))) {
      reply(401, 'Local proxy authorization is required.'); req.resume(); return;
    }
    let path;
    try { path = upstreamPath(upstream, req.url); } catch { reply(400, 'Invalid request target.'); req.resume(); return; }
    if (Number(req.headers['content-length']) > MAX_BODY) { reply(413, 'Request exceeds the 32 MiB proxy limit.'); req.resume(); return; }
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY) { chunks.length = 0; reply(413, 'Request exceeds the 32 MiB proxy limit.'); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected || res.destroyed) return;
      let body = Buffer.concat(chunks);
      if (req.method === 'POST' && /\/responses(?:\?|$)/.test(path) && body.length) {
        try { body = Buffer.from(JSON.stringify(stripStaleRefs(JSON.parse(body.toString('utf8'))))); } catch { /* Preserve non-JSON request bytes. */ }
      }
      const headers = cleanHeaders(req.headers);
      headers.host = upstream.host;
      delete headers['x-codex-beta-features'];
      delete headers['content-length'];
      if (body.length) headers['content-length'] = String(body.length);
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
        delete headers['api-key'];
        delete headers['x-api-key'];
        if (/\/messages(?:\/count_tokens)?(?:\?|$)/.test(path)) headers['x-api-key'] = apiKey;
      }
      let deadline;
      const fail = error => {
        clearTimeout(deadline);
        reply(error?.code === 'ETIMEDOUT' ? 504 : 502, error?.code === 'ETIMEDOUT' ? 'The upstream request timed out.' : 'Could not reach the configured upstream.');
      };
      try {
        const transport = upstream.protocol === 'http:' ? http : https;
        request = transport.request({ hostname: upstream.hostname.replace(/^\[|\]$/g, ''), port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), path, method: req.method, headers }, upRes => {
          clearTimeout(deadline);
          response = upRes;
          if (res.destroyed || rejected) { upRes.destroy(); return; }
          upRes.on('error', () => res.destroy());
          upRes.on('aborted', () => res.destroy());
          upRes.setTimeout(STREAM_IDLE_TIMEOUT, () => request.destroy(Object.assign(new Error('Upstream idle timeout.'), { code: 'ETIMEDOUT' })));
          res.writeHead(upRes.statusCode || 502, cleanHeaders(upRes.headers));
          upRes.pipe(res);
        });
        request.on('error', fail);
        deadline = setTimeout(() => request.destroy(Object.assign(new Error('Upstream header timeout.'), { code: 'ETIMEDOUT' })), HEADER_TIMEOUT);
        deadline.unref();
        request.end(body);
      } catch { fail(); }
      res.on('close', () => clearTimeout(deadline));
    });
  });
  server.requestTimeout = HEADER_TIMEOUT;
  server.headersTimeout = HEADER_TIMEOUT;
  const listen = server.listen.bind(server);
  server.listen = (requestedPort = port, host = '127.0.0.1', callback) => {
    if (typeof requestedPort === 'function') { callback = requestedPort; requestedPort = port; }
    if (typeof host === 'function') { callback = host; host = '127.0.0.1'; }
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535 || !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('The proxy must listen on a valid loopback TCP port.');
    return listen(requestedPort, host, callback);
  };
  return server;
}

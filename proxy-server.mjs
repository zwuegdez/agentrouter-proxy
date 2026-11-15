import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { endpointTypes, codexCatalog } from './model-catalog.mjs';
import { decodeUpstream, forwardSse, jsonSse, streamError, writeStream, HEARTBEAT_MS, STREAM_IDLE_TIMEOUT } from './event-streams.mjs';
import { ProtocolError, toResponses, fromResponses, translateResponse, translateStream } from './protocol-translation.mjs';

const MAX_BODY = 32 * 1024 * 1024;
const HEADER_TIMEOUT = 60_000;
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

export function createProxy({ endpoint = 'https://agentrouter.org/v1', apiKey = '', localBearer = '', healthBearer = localBearer, port = 18766, catalog = null } = {}) {
  const upstream = validateEndpoint(endpoint);
  for (const [name, value] of [['API key', apiKey], ['local bearer', localBearer], ['health bearer', healthBearer]]) {
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
    if (healthBearer && req.method === 'GET' && ['/health', '/v1/health'].includes(req.url)) {
      if (!matchesToken(req.headers.authorization, `Bearer ${healthBearer}`)) reply(401, 'Local proxy authorization is required.');
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ active: true })); }
      req.resume(); return;
    }
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
    req.on('end', async () => {
      if (rejected || res.destroyed) return;
      let body = Buffer.concat(chunks), parsed, source, target, candidates = [], model;
      const incoming = new URL(req.url,'http://localhost').pathname;
      const protocol = /\/responses$/.test(incoming) ? 'responses' : /\/chat\/completions$/.test(incoming) ? 'chat' : /\/messages$/.test(incoming) ? 'messages' : null;
      try {
        const incoming = new URL(req.url, 'http://localhost').pathname;
        if (catalog) {
          if (req.method === 'GET' && ['/health', '/v1/health'].includes(incoming)) {
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ active: true })); return;
          }
          if (req.method === 'GET' && ['/models', '/v1/models', '/codex/models'].includes(incoming)) {
            const models = await catalog.refresh();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(incoming === '/codex/models' ? codexCatalog(models) : { object: 'list', data: models, has_more: false, first_id: models[0]?.id, last_id: models.at(-1)?.id })); return;
          }
          source = /\/responses$/.test(incoming) ? 'responses' : /\/chat\/completions$/.test(incoming) ? 'chat' : /\/messages(?:\/count_tokens)?$/.test(incoming) ? 'messages' : null;
          if (req.method !== 'POST' || !source) { reply(404, 'Only AgentRouter model discovery and inference endpoints are available while active.'); return; }
          parsed = JSON.parse(body.toString('utf8'));
          model = await catalog.find(parsed.model);
          if (!model) { reply(404, `Model ${String(parsed.model).slice(0,200)} is unavailable in your AgentRouter catalog. Choose an available model; no model was substituted.`); return; }
          candidates = endpointTypes(model);
          if (/count_tokens$/.test(incoming)) {
            if (!candidates.includes('messages')) { reply(501, 'Native token counting is unavailable for this model.'); return; }
            target = source;
          } else target = candidates.includes(source) ? source : candidates[0];
          candidates = [target, ...candidates.filter(type => type !== target)];
          if (source === 'responses') parsed = stripStaleRefs(parsed);
        } else if (req.method === 'POST' && /\/responses(?:\?|$)/.test(path) && body.length) {
          try { body = Buffer.from(JSON.stringify(stripStaleRefs(JSON.parse(body.toString('utf8'))))); } catch { /* Preserve non-JSON request bytes. */ }
        }
      } catch (error) { reply(error instanceof SyntaxError ? 400 : 503, error instanceof SyntaxError ? 'The request must contain valid JSON.' : error.message); return; }
      const route = () => {
        if (!catalog) return;
        const value = source === target ? parsed : fromResponses(toResponses(parsed, source), target);
        body = Buffer.from(JSON.stringify(value));
        if (!/count_tokens(?:\?|$)/.test(path)) path = upstreamPath(upstream, '/v1/' + ({ responses: 'responses', messages: 'messages', chat: 'chat/completions' })[target] + new URL(req.url,'http://localhost').search);
      };
      try { route(); } catch (error) { reply(400, error.message); return; }

      if(!catalog && protocol && req.method==='POST') {
        try{parsed=JSON.parse(body.toString('utf8'));}catch{}
      }
      const streaming=parsed?.stream===true && protocol;
      let heartbeat;
      const beginStream=(status,responseHeaders)=>{
        for(const name of ['content-length','content-encoding','etag'])delete responseHeaders[name];
        res.writeHead(status,{...responseHeaders,'content-type':'text/event-stream','cache-control':'no-cache','x-accel-buffering':'no'});
        res.flushHeaders();
        heartbeat=setInterval(()=>{if(!res.destroyed && !res.writableEnded && !res.writableNeedDrain)res.write(': ag keepalive\n\n');},HEARTBEAT_MS);
        heartbeat.unref();
        res.once('close',()=>clearInterval(heartbeat));
      };
      const headers = cleanHeaders(req.headers);
      headers.host = upstream.host;
      delete headers['x-codex-beta-features'];
      delete headers['content-length'];
      if (body.length) headers['content-length'] = String(body.length);
      if (catalog || streaming) headers['accept-encoding'] = 'identity';
      if (apiKey) {
        headers.authorization = `Bearer ${apiKey}`;
        delete headers['api-key'];
        delete headers['x-api-key'];
        if (/\/messages(?:\/count_tokens)?(?:\?|$)/.test(path)) headers['x-api-key'] = apiKey;
      }
      let deadline;
      const fail = error => {
        clearTimeout(deadline);
        if(streaming && res.headersSent){streamError(res,protocol,error?.code==='ETIMEDOUT' ? 'upstream_stream_timeout' : 'upstream_stream_incomplete');return;}
        reply(error?.code === 'ETIMEDOUT' ? 504 : 502, error?.code === 'ETIMEDOUT' ? 'The upstream request timed out.' : 'Could not reach the configured upstream.');
      };
      const send = () => {
        if (res.destroyed || rejected) return;
        try {
        route();
        if (catalog) headers['content-type'] = 'application/json';
        if (body.length) headers['content-length'] = String(body.length);
        if (apiKey && catalog) {
          delete headers['x-api-key'];
          if (target === 'messages') headers['x-api-key'] = apiKey;
        }
        if (target === 'messages' && !headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
        const transport = upstream.protocol === 'http:' ? http : https;
        request = transport.request({ hostname: upstream.hostname.replace(/^\[|\]$/g, ''), port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80), path, method: req.method, headers }, upRes => {
          clearTimeout(deadline);
          response = upRes;
          if (res.destroyed || rejected) { upRes.destroy(); return; }
          let managedStream=false;
          const responseFailed=()=>{if(managedStream)return;if(streaming && res.headersSent)streamError(res,protocol);else if(!res.writableEnded)res.destroy();};
          upRes.on('error', responseFailed);
          upRes.on('aborted', responseFailed);
          upRes.setTimeout(STREAM_IDLE_TIMEOUT, () => request.destroy(Object.assign(new Error('Upstream idle timeout.'), { code: 'ETIMEDOUT' })));
          const status = upRes.statusCode || 502;
          const translated = catalog && source !== target;
          if (catalog && status >= 400) {
            const parts = []; let bytes = 0;
            upRes.on('data', chunk => {
              bytes += chunk.length;
              if (bytes > 4 * 1024 * 1024) { upRes.destroy(); reply(502, 'Upstream error exceeds 4 MiB.'); }
              else parts.push(chunk);
            });
            upRes.on('end', () => {
              if (res.destroyed || rejected) return;
              const raw = Buffer.concat(parts), message = raw.toString('utf8');
              const mismatch = [405, 501].includes(status) || [400,404].includes(status) && /unsupported[_ -](?:endpoint|api)|endpoint.{0,30}(?:unsupported|not supported)|cannot (?:post|get)|route not found/i.test(message);
              if (mismatch && candidates.length > 1 && !/count_tokens(?:\?|$)/.test(path)) {
                candidates.shift(); target = candidates[0]; send(); return;
              }
              if (status === 404 || /model[_ -]not[_ -]found|model.{0,40}unavailable/i.test(message)) catalog.refresh(true).catch(() => {});
              res.writeHead(status, cleanHeaders(upRes.headers)); res.end(raw);
            });
            return;
          }
          const isSse=/text\/event-stream/i.test(String(upRes.headers['content-type']));
          if(!translated && !(streaming && status<400)) {
            res.writeHead(status,cleanHeaders(upRes.headers));upRes.pipe(res);return;
          }
          const responseHeaders=cleanHeaders(upRes.headers);
          for(const name of ['content-length','content-encoding','etag'])delete responseHeaders[name];
          if(streaming && isSse) {
            let decoded;
            try{decoded=decodeUpstream(upRes,upRes.headers['content-encoding']);}catch{reply(502,'Unsupported upstream stream encoding.');upRes.destroy();return;}
            managedStream=true;
            beginStream(status,responseHeaders);
            const forwarding=translated ? translateStream(decoded,target,source,parsed.model,res,parsed.tools) : forwardSse(decoded,res,protocol);
            forwarding.catch(()=>streamError(res,protocol));
          } else {
            let decoded;
            try{decoded=decodeUpstream(upRes,upRes.headers['content-encoding']);}catch{reply(502,'Unsupported upstream response encoding.');upRes.destroy();return;}
            decoded.on('error',()=>reply(502,'Could not decode the upstream response.'));
            const parts=[];let bytes=0;
            decoded.on('data',chunk=>{bytes+=chunk.length;if(bytes>MAX_BODY){reply(502,'Upstream response exceeds 32 MiB.');upRes.destroy();}else parts.push(chunk);});
            decoded.on('end',async()=>{
              if(res.destroyed || rejected)return;
              try {
                const upstreamValue=JSON.parse(Buffer.concat(parts).toString('utf8'));
                const value=translated ? translateResponse(upstreamValue,target,source,parsed.model,parsed.tools) : upstreamValue;
                if(streaming) {
                  const events=jsonSse(value,protocol);
                  beginStream(status,responseHeaders);
                  for(const event of events)await writeStream(res,event);
                  res.end();
                } else {
                  res.writeHead(status,{...responseHeaders,'content-type':'application/json'});res.end(JSON.stringify(value));
                }
              }catch{if(res.headersSent)streamError(res,protocol);else reply(502,'Upstream did not return a complete compatible response. No generation was replayed.');}
            });
          }
        });
        request.on('error', fail);
        deadline = setTimeout(() => request.destroy(Object.assign(new Error('Upstream header timeout.'), { code: 'ETIMEDOUT' })), HEADER_TIMEOUT);
        deadline.unref();
        request.end(body);
      } catch (error) { if (error instanceof ProtocolError) reply(400,error.message); else fail(); }
      };
      send();
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

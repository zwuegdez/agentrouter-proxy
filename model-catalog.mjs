import { validateEndpoint } from './proxy-server.mjs';

export function endpointTypes(model) {
  if (/(?:^|[/:._-])(?:gpt|o[134])(?:[._-]|\d|$)/i.test(model.id)) return ['responses'];
  const raw = model.supported_endpoint_types || model.endpoints || model.api_types;
  const advertised = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : raw && typeof raw === 'object'
    ? raw.type || raw.path ? [raw] : Object.entries(raw).filter(([,enabled])=>enabled).map(([type])=>type) : [];
  const types = advertised.map(value => {
    const text = String(value && typeof value === 'object' ? value.type || value.path || '' : value || '').toLowerCase();
    if (/responses?|openai[-_]response/.test(text)) return 'responses';
    if (/messages|anthropic/.test(text)) return 'messages';
    if (/chat|completions|openai/.test(text)) return 'chat';
  }).filter(Boolean);
  return [...new Set(types.length ? types : /claude|anthropic/i.test(model.id) ? ['messages', 'responses', 'chat'] : ['chat', 'responses', 'messages'])];
}

export function normalizeModels(body) {
  if (!body || !Array.isArray(body.data)) throw new Error('AgentRouter returned an invalid model catalog.');
  const seen = new Set();
  return body.data.filter(model => {
    if (!model || typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200 || /[\x00-\x20\x7f]/.test(model.id)) throw new Error('AgentRouter returned an invalid model ID.');
    if (seen.has(model.id) || model.available === false || model.disabled === true) return false;
    seen.add(model.id); return true;
  }).map(model => ({ ...model, object: 'model', display_name: typeof (model.display_name || model.name) === 'string' ? (model.display_name || model.name).slice(0,512) : model.id, description: typeof model.description === 'string' ? model.description.slice(0,4000) : undefined }));
}

export function createCatalog({ endpoint, apiKey, fetcher = fetch, refreshMs = 300_000, onChange = async () => {} }) {
  const url = validateEndpoint(endpoint);
  url.pathname = url.pathname.replace(/\/$/, '') + (url.pathname.endsWith('/v1') ? '/models' : '/v1/models');
  let models = null, updated = 0, pending;
  const controller = new AbortController();
  return {
    get models() { return models; },
    async close() { controller.abort(); await pending?.catch(()=>{}); },
    async refresh(force = false) {
      if (pending) return pending;
      if (!force && models && Date.now() - updated < refreshMs) return models;
      pending = (async () => {
        const response = await fetcher(url, { headers: { authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000),controller.signal]) });
        if (!response.ok) throw new Error(`AgentRouter model discovery failed (HTTP ${response.status}). Check your key and account access.`);
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 4 * 1024 * 1024) throw new Error('AgentRouter model catalog exceeds 4 MiB.');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        const next = normalizeModels(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        await onChange(next);
        models = next; updated = Date.now(); return models;
      })().finally(() => { pending = undefined; });
      return pending;
    },
    async find(id) {
      await this.refresh();
      let model = models.find(model => model.id === id);
      if (!model) { await this.refresh(true); model = models.find(model => model.id === id); }
      return model;
    },
  };
}

export function codexCatalog(models) {
  // shortcut: unknown capabilities use conservative defaults, adopt provider metadata as it becomes available.
  return { models: models.map((model, priority) => ({
    slug: model.id, display_name: model.display_name, description: model.description || 'From AgentRouter',
    supported_reasoning_levels: [], shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority,
    availability_nux: null, upgrade: null, base_instructions: 'You are a coding assistant. Read the relevant code before making changes, use tools to complete the task, preserve existing user changes, and verify your work.', support_verbosity: false, default_verbosity: null, apply_patch_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [], input_modalities: Array.isArray(model.input_modalities) ? model.input_modalities.filter(mode=>['text','image'].includes(mode)) : ['text'],
    ...(Number.isSafeInteger(model.context_window) && model.context_window > 0 ? { context_window: model.context_window } : {}),
  })) };
}

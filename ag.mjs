#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDirectory, readConfiguration, writePrivate } from './install.mjs';
import { createProxy, validateEndpoint } from './ag-proxy.mjs';
import { activate, deactivate, loadActive, runDaemon } from './ag-activation.mjs';
import { CLIENTS, clientInstalled, installClient, runClient } from './ag-clients.mjs';

const DEFAULT_ENDPOINT = 'https://agentrouter.org/v1';
const DEFAULT_PORT = 18766;
export const HELP = `ag — local proxy for Codex CLI, Claude Code and OpenCode

ag                 Choose existing setup, guided setup, or saved setup
ag setup           Choose a client, endpoint, API key and model
ag start           Start your saved setup in the background with autostart
ag proxy           Background proxy; keep your client's existing credentials
ag activate        Keep AgentRouter active in the background for CLI/Desktop clients
ag deactivate      Stop the background proxy and restore previous client settings
ag status          Show activation status
ag models          Show the live AgentRouter model list while active
ag help            Show this guide

ag proxy --endpoint https://agentrouter.org/v1 --port 18766
ag start --port 18766

Setup asks before installing a missing client or saving an API key.
Saved settings: ${join(appDirectory(), 'ag.json')}
Keys saved here are plaintext in a private file. Replacement backups also contain keys.
ag start/ag activate save reversible client routing changes and private activation state.
All starts register an OS background service with autostart and crash restart.
Closing a terminal or client leaves it running; ag deactivate stops it.
Use --foreground with ag start/ag proxy for the previous temporary session mode.
Activation discovers AgentRouter models every five minutes. GPT uses Responses upstream;
Claude/OpenCode requests are translated automatically when needed.
Claude Desktop: import claude-desktop.json for Claude auto-discovery,
or claude-desktop-all-models.json for GPT/all models; reimport that list after releases.
Your endpoint must support Responses (Codex), Messages (Claude), or Chat Completions (OpenCode).
Provider account, quota and model compatibility errors still need provider fixes.`;

export function validateSetup(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved setup. Run ag setup.');
  if (!Object.hasOwn(CLIENTS, value.client)) throw new Error('Choose codex, claude, or opencode.');
  const endpoint = validateEndpoint(value.endpoint).href.replace(/\/$/, '');
  if (typeof value.apiKey !== 'string' || !value.apiKey || /[\x00-\x20\x7f]/.test(value.apiKey)) throw new Error('Enter an API key without whitespace.');
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || /[\x00-\x1f\x7f]/.test(value.model)) throw new Error('Enter a valid model name.');
  return { client: value.client, endpoint, apiKey: value.apiKey, model: value.model };
}

export async function loadSetup(file = join(appDirectory(), 'ag.json')) {
  const raw = await readConfiguration(file);
  if (raw === null) throw new Error('No saved setup. Run ag setup first, or ag proxy for an existing client.');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Saved setup is not valid JSON. Run ag setup.'); }
  return validateSetup(value);
}

export async function saveSetup(value, file = join(appDirectory(), 'ag.json')) {
  await writePrivate(file, JSON.stringify(validateSetup(value), null, 2) + '\n');
}

function prompts(input, output) {
  if (!input.isTTY || !output.isTTY) throw new Error('Open an interactive terminal for setup. Use ag help for commands.');
  let hidden = false;
  const terminal = new Writable({ write(chunk, encoding, callback) { if (!hidden) output.write(chunk, encoding); callback(); } });
  const rl = createInterface({ input, output: terminal, terminal: true });
  const cancellation = new AbortController();
  rl.on('close', () => cancellation.abort());
  rl.on('SIGINT', () => rl.close());
  return {
    async ask(label, { secret = false } = {}) {
      if (!secret) return (await rl.question(label, { signal: cancellation.signal })).trim();
      output.write(label);
      hidden = true;
      try { return (await rl.question('', { signal: cancellation.signal })).trim(); }
      finally { hidden = false; output.write('\n'); }
    },
    close() { rl.close(); },
  };
}

async function chooseClient(ui, env) {
  const clients = Object.keys(CLIENTS);
  const label = clients.map((client, i) => `${i + 1}. ${CLIENTS[client].name}${clientInstalled(client, { env }) ? ' (installed)' : ''}`).join('\n');
  const answer = await ui.ask(`${label}\nClient [1]: `);
  const client = clients[Number(answer || '1') - 1] || answer.toLowerCase();
  if (!Object.hasOwn(CLIENTS, client)) throw new Error('Choose 1, 2, or 3.');
  return client;
}

export async function guidedSetup(ui, { env = process.env, file = join(appDirectory(), 'ag.json'), output = process.stdout,
  installed = clientInstalled, install = installClient } = {}) {
  const client = await chooseClient(ui, env);
  if (!installed(client, { env })) {
    const answer = await ui.ask(`Install ${CLIENTS[client].name} with npm install --global ${CLIENTS[client].package}? [y/N]: `);
    if (!/^y(es)?$/i.test(answer)) throw new Error(`Client installation declined. Install ${client} yourself, then run ag setup again.`);
    await install(client, { env });
    if (!installed(client, { env })) throw new Error(`Installation finished but ${client} is not on PATH. Reopen your terminal and run ag setup.`);
  }
  const endpoint = await ui.ask(`Upstream endpoint [${DEFAULT_ENDPOINT}]: `) || DEFAULT_ENDPOINT;
  validateEndpoint(endpoint);
  const apiKey = env.AG_API_KEY || await ui.ask('API key (hidden; Enter to cancel): ', { secret: true });
  if (!apiKey) throw new Error('Setup cancelled. No API key was saved.');
  const model = await ui.ask('Model name from your provider: ');
  const setup = validateSetup({ client, endpoint, apiKey, model });
  const save = await ui.ask('Save this setup, including its API key, in a private plaintext file? [y/N]: ');
  if (/^y(es)?$/i.test(save)) {
    await saveSetup(setup, file);
    output.write('Setup saved. Use ag start next time. Replacements keep private backups.\n');
  }
  const start = await ui.ask('Start in the background with autostart? Activation saves a private copy of this key. [Y/n]: ');
  return { setup, start: !/^n(o)?$/i.test(start) };
}

export function proxyInstructions(client, baseUrl) {
  if (client === 'claude') return `Set ANTHROPIC_BASE_URL=${baseUrl.replace(/\/v1$/, '')} in the terminal running Claude. Keep your existing key and model, then run claude.`;
  if (client === 'opencode') return `Set your existing OpenCode provider's baseURL to ${baseUrl}. Keep its existing key, SDK and model, then run opencode. Use ag setup for automatic routing.`;
  return `In your active Codex provider, set base_url="${baseUrl}", wire_api="responses", supports_websockets=false. Keep its existing key and model, then restart codex. Use ag setup for automatic routing.`;
}

export async function launchSession({ setup, endpoint = DEFAULT_ENDPOINT, port = DEFAULT_PORT, client = 'codex' } = {},
  { env = process.env, output = process.stdout, signals = process, launch = runClient } = {}) {
  if (setup) setup = validateSetup(setup);
  const localBearer = setup ? randomBytes(32).toString('hex') : '';
  const server = createProxy({ endpoint: setup?.endpoint || endpoint, apiKey: setup?.apiKey || '', localBearer, port });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  output.write(`Proxy: ${baseUrl} -> ${setup?.endpoint || endpoint}\n`);
  let stopped;
  const stop = new Promise(resolve => { stopped = resolve; });
  const interrupt = () => { server.closeAllConnections(); server.close(); stopped(); };
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', interrupt);
  try {
    if (setup) return await launch(setup.client, { model: setup.model, baseUrl, localBearer }, { env });
    output.write(proxyInstructions(client, baseUrl) + '\nAuthorization comes from your existing client. Keep this terminal open; Ctrl+C stops the proxy.\n');
    await stop;
    return 0;
  } finally {
    signals.removeListener('SIGINT', interrupt);
    signals.removeListener('SIGTERM', interrupt);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

export async function main(args = process.argv.slice(2), { input = process.stdin, output = process.stdout, env = process.env, ui: promptUi, activation = activate } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const command = args[0] || '';
  if (['help', '--help', '-h'].includes(command)) { output.write(HELP + '\n'); return 0; }
  if (!['', 'setup', 'start', 'proxy', 'activate', 'deactivate', 'status', 'models', 'daemon'].includes(command)) throw new Error('Unknown command. Run ag help.');
  let endpoint = DEFAULT_ENDPOINT, port = DEFAULT_PORT, foreground = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--foreground' && ['start', 'proxy'].includes(command)) foreground = true;
    else if (args[i] === '--endpoint' && command === 'proxy' && args[i + 1]) endpoint = validateEndpoint(args[++i]).href.replace(/\/$/, '');
    else if (args[i] === '--port' && ['start', 'proxy', 'activate'].includes(command) && /^\d+$/.test(args[i + 1] || '') && Number(args[i + 1]) >= 1 && Number(args[i + 1]) <= 65535) port = Number(args[++i]);
    else throw new Error('Invalid option. Run ag help.');
  }
  if (command === 'deactivate') { await deactivate({ env, output }); return 0; }
  if (command === 'daemon') return runDaemon({ output });
  if (command === 'status' || command === 'models') {
    const state = await loadActive();
    if (!state) { output.write('AgentRouter is inactive. Run ag activate.\n'); return command === 'models' ? 1 : 0; }
    if(command === 'models' && state.mode === 'relay')throw new Error('Proxy-only mode keeps model discovery in your existing client. Use ag setup for the AgentRouter-only catalog.');
    let response;
    try { response = await fetch(`http://127.0.0.1:${state.port}/${command === 'models' ? 'v1/models' : 'health'}`, { headers: { authorization: `Bearer ${state.localBearer}` }, signal: AbortSignal.timeout(20_000), redirect: 'error' }); }
    catch { throw new Error('Activation is saved but the background proxy is unreachable. Check your OS service logs.'); }
    if (!response.ok) throw new Error(`AgentRouter ${command} failed (HTTP ${response.status}). Check your key, quota, and service logs.`);
    if (command === 'models') { for (const model of (await response.json()).data) output.write(model.id+'\n'); }
    else output.write(`AgentRouter is active at http://127.0.0.1:${state.port}/v1. Use ag deactivate to stop.\n`);
    return 0;
  }
  if (foreground) return launchSession(command === 'start' ? { setup: await loadSetup(), port } : { endpoint, port }, { env, output });
  const startBackground = async session => {
    const relay=!session.setup;
    const state=await activation(session.setup || session,{port,env,output,relay});
    if(state?.mode === 'relay')output.write(proxyInstructions(state.setup.client || 'codex',`http://127.0.0.1:${state.port}/v1`)+'\nAuthorization comes from your existing client.\n');
    return 0;
  };
  if(['','start','activate'].includes(command)) {
    const state=await loadActive();
    if(state)return startBackground(state.mode === 'relay' ? state.setup : {setup:state.setup});
  }
  if (command === 'start' || command === 'activate') return startBackground({setup:await loadSetup()});
  if (command === 'proxy') return startBackground({endpoint,client:'codex'});
  const ui = promptUi || prompts(input, output);
  let session;
  try {
    const choice = command === 'setup' ? '2' : await ui.ask('1. Background proxy — I already have client credentials\n2. Guided setup — choose a client, key and endpoint\n3. Start saved setup in the background\nAutostart and crash restart are enabled; use ag deactivate to stop.\nChoice [1]: ');
    if (choice === '2') {
      const result = await guidedSetup(ui, { env, output });
      if (!result.start) return 0;
      session = { setup: result.setup };
    } else if (choice === '3') session = { setup: await loadSetup() };
    else if (choice === '' || choice === '1') {
      const client = await chooseClient(ui, env);
      const selectedEndpoint = await ui.ask(`Upstream endpoint [${DEFAULT_ENDPOINT}]: `) || DEFAULT_ENDPOINT;
      session = { endpoint: validateEndpoint(selectedEndpoint).href.replace(/\/$/, ''), client };
    } else throw new Error('Choose 1, 2, or 3.');
  } finally { ui.close(); }
  return startBackground(session);
}

if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { process.exitCode = await main(); }
  catch (error) {
    console.error(error.name === 'AbortError' ? 'Setup cancelled.' : error.code === 'EADDRINUSE' ? 'Proxy port is already in use. Stop the other proxy or choose --port with ag start/ag proxy.' : error.message);
    process.exitCode = error.name === 'AbortError' ? 130 : 1;
  }
}

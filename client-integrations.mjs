import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

export const CLIENTS = Object.freeze({
  codex: { name: 'Codex CLI', package: '@openai/codex' },
  claude: { name: 'Claude Code CLI', package: '@anthropic-ai/claude-code' },
  opencode: { name: 'OpenCode CLI', package: 'opencode-ai' },
  'codex-desktop': { name: 'Codex Desktop', desktop: true, download: 'https://chatgpt.com/codex' },
  'claude-desktop': { name: 'Claude Code Desktop', desktop: true, download: 'https://claude.com/download' },
  'opencode-desktop': { name: 'OpenCode Desktop', desktop: true, download: 'https://opencode.ai/download' },
});

function clientInfo(client) {
  if (!Object.hasOwn(CLIENTS, client)) throw new Error('Choose a listed CLI or desktop client.');
  return CLIENTS[client];
}

function executable(command, { env = process.env, platform = process.platform } = {}) {
  const pathValue = env.PATH || env.Path || '';
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of pathValue.split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = join(directory.replace(/^"|"$/g, ''), command + extension);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return file;
      } catch (error) { if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error; }
    }
  }
  return null;
}

function invocation(command, options) {
  const file = executable(command, options);
  if (!file) throw new Error(`${command} is not installed or is not available on PATH.`);
  if (!/\.(cmd|bat)$/i.test(file)) return { command: file, args: [] };
  // Run official npm entrypoints directly so Windows model/argument text never reaches cmd.exe.
  let script;
  try {
    const packageRoot = join(dirname(file), 'node_modules', command === 'npm' ? 'npm' : clientInfo(command).package);
    const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[command];
    if (typeof bin !== 'string') throw new Error('Missing npm entrypoint.');
    script = resolve(packageRoot, bin);
    if (relative(packageRoot, script).startsWith('..') || !statSync(script).isFile()) throw new Error('Invalid npm entrypoint.');
  }
  catch { throw new Error(`Cannot run the ${command} Windows shim safely. Repair its installation or use a native executable.`); }
  if (/\.exe$/i.test(script)) return { command: script, args: [] };
  return { command: process.execPath, args: [script] };
}

export function clientInstalled(client, options = {}) {
  if(clientInfo(client).desktop)return false;
  return Boolean(executable(client, options));
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: false });
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGTERM', terminate);
    child.once('error', error => { process.off('SIGTERM', terminate); reject(error); });
    child.once('close', (code, signal) => { process.off('SIGTERM', terminate); resolve(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
}

export async function installClient(client, { env = process.env, platform = process.platform } = {}) {
  const info = clientInfo(client);
  if(info.desktop)throw new Error(`Install ${info.name} from ${info.download} on your desktop computer.`);
  if (clientInstalled(client, { env, platform })) return 0;
  const npm = invocation('npm', { env, platform });
  const code = await run(npm.command, [...npm.args, 'install', '--global', info.package], env);
  if (code !== 0) throw new Error(`${info.name} installation failed (exit ${code}).`);
  return code;
}

export function buildLaunch(client, { model = '', baseUrl = 'http://127.0.0.1:18766/v1', localBearer = '', opencodeVersion = 2 } = {}) {
  if(clientInfo(client).desktop)throw new Error('Desktop apps use background activation. Run ag setup or ag clients, then open the app yourself.');
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('The client must connect to the local proxy URL.');
  if (typeof model !== 'string' || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw new Error('Invalid model name.');
  if (typeof localBearer !== 'string' || !localBearer || /[\x00-\x20\x7f]/.test(localBearer)) throw new Error('A local session token is required.');
  baseUrl = url.href.replace(/\/$/, '');
  if (client === 'codex') {
    const providerId = `ag_proxy_${randomUUID().replaceAll('-', '')}`; // Avoid inheriting a saved provider's authentication settings.
    const fields = { model_provider: providerId, [`model_providers.${providerId}.name`]: 'Local proxy', [`model_providers.${providerId}.base_url`]: baseUrl,
      [`model_providers.${providerId}.env_key`]: 'AG_PROXY_TOKEN', [`model_providers.${providerId}.wire_api`]: 'responses',
      [`model_providers.${providerId}.supports_websockets`]: false, [`model_providers.${providerId}.requires_openai_auth`]: false };
    const args = model ? ['--model', model] : [];
    for (const [key, value] of Object.entries(fields)) args.push('-c', `${key}=${JSON.stringify(value)}`);
    return { command: client, args, env: { AG_PROXY_TOKEN: localBearer } };
  }
  if (client === 'claude') {
    url.pathname = url.pathname.replace(/\/v1\/?$/, '') || '/';
    const env = { ANTHROPIC_BASE_URL: url.href.replace(/\/$/, ''), ANTHROPIC_AUTH_TOKEN: localBearer, ANTHROPIC_API_KEY: localBearer,
      CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0', CLAUDE_CODE_USE_GATEWAY: '0',
      CLAUDE_CODE_USE_MANTLE: '0', CLAUDE_CODE_USE_ANTHROPIC_AWS: '0', CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: '0', CLAUDE_CODE_OAUTH_TOKEN: '' };
    if (model) Object.assign(env, { ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model });
    return { command: client, args: model ? ['--model', model] : [], env };
  }
  if (!model) throw new Error('Choose a model for OpenCode.');
  const modelRef = `ag_proxy/${model}`;
  const provider = opencodeVersion < 2
    ? { npm: '@ai-sdk/openai-compatible', name: 'Local proxy', options: { baseURL: baseUrl, apiKey: '{env:AG_PROXY_TOKEN}' }, models: { [model]: { name: model } } }
    : { name: 'Local proxy', env: ['AG_PROXY_TOKEN'], package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: baseUrl }, models: { [model]: { name: model } } };
  const config = { $schema: 'https://opencode.ai/config.json', [opencodeVersion < 2 ? 'provider' : 'providers']: { ag_proxy: provider }, model: modelRef };
  return { command: client, args: opencodeVersion < 2 ? ['--model', modelRef] : ['--standalone'], env: { AG_PROXY_TOKEN: localBearer, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } };
}

export async function runClient(client, options, { env = process.env, platform = process.platform, extraArgs = [] } = {}) {
  if(clientInfo(client).desktop)throw new Error('Desktop apps use background activation. Run ag setup or ag clients, then open the app yourself.');
  const binary = invocation(client, { env, platform });
  if (!Array.isArray(extraArgs) || extraArgs.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid client arguments.');
  if (client === 'opencode') {
    const result = await promisify(execFile)(binary.command, [...binary.args, '--version'], { env, timeout: 10000 });
    const major = /(?:^|\s)v?(\d+)\./.exec(result.stdout)?.[1];
    if (!major) throw new Error('Could not identify the installed OpenCode version.');
    options = { ...options, opencodeVersion: Number(major) };
  }
  const launch = buildLaunch(client, options);
  const childEnv = { ...env, ...launch.env };
  for (const key of ['NO_PROXY', 'no_proxy']) childEnv[key] = [...new Set([...(env[key] || '').split(',').filter(Boolean), '127.0.0.1', 'localhost', '::1'])].join(',');
  if (client === 'opencode' && env.OPENCODE_CONFIG_CONTENT) {
    let previous;
    try { previous = JSON.parse(env.OPENCODE_CONFIG_CONTENT); }
    catch { throw new Error('Existing OpenCode inline configuration must be valid JSON; it was not changed.'); }
    if (!previous || typeof previous !== 'object' || Array.isArray(previous)) throw new Error('Existing OpenCode inline configuration must be a JSON object.');
    const added = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT);
    const field = options.opencodeVersion < 2 ? 'provider' : 'providers';
    childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...previous, ...added, [field]: { ...previous[field], ...added[field] } });
  }
  let temporary;
  try {
    if (client === 'claude') {
      temporary = await mkdtemp(join(tmpdir(), 'ag-claude-session-'));
      const settings = join(temporary, 'settings.json');
      await writeFile(settings, JSON.stringify({ env: launch.env, apiKeyHelper: '' }), { mode: 0o600, flag: 'wx' });
      launch.args.push('--settings', settings);
    }
    return await run(binary.command, [...binary.args, ...launch.args, ...extraArgs], childEnv);
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}

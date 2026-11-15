import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { clientInstalled, installClient, buildLaunch, runClient } from './client-integrations.mjs';

const token = 'local-fixture-token';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ag-client-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('client detection checks executable PATH entries and Windows shims without installing', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(root, 'claude.cmd'), 'fixture', { mode: 0o600 });
  assert.equal(clientInstalled('codex', { env: { PATH: root }, platform: 'linux' }), true);
  assert.equal(clientInstalled('claude', { env: { PATH: root }, platform: 'linux' }), false);
  assert.equal(clientInstalled('claude', { env: { Path: root }, platform: 'win32' }), true);
  assert.equal(clientInstalled('opencode', { env: { PATH: root }, platform: 'linux' }), false);
  assert.equal(await installClient('codex', { env: { PATH: root }, platform: 'linux' }), 0);
  await assert.rejects(installClient('claude', { env: { PATH: '' }, platform: 'linux' }), /npm is not installed/);
  assert.throws(() => clientInstalled('other'), /Choose/);
});

test('desktop choices require official app installation and cannot launch as CLI clients',async()=>{
  for(const client of ['codex-desktop','claude-desktop','opencode-desktop']) {
    assert.equal(clientInstalled(client,{env:{PATH:''}}),false);
    await assert.rejects(installClient(client,{env:{PATH:''}}),/Install .* from https:/);
    assert.throws(()=>buildLaunch(client,{localBearer:token}),/background activation/);
    await assert.rejects(runClient(client,{localBearer:token},{env:{PATH:''}}),/background activation/);
  }
});

test('Codex launch supplies only session overrides and keeps its token out of arguments', () => {
  const result = buildLaunch('codex', { model: 'model-with-"quotes"', localBearer: token });
  assert.deepEqual(result.args.slice(0, 2), ['--model', 'model-with-"quotes"']);
  const selected = result.args.find(arg => arg.startsWith('model_provider='));
  const providerId = JSON.parse(selected.slice('model_provider='.length));
  assert.match(providerId, /^ag_proxy_[a-f0-9]{32}$/);
  assert(result.args.includes(`model_providers.${providerId}.base_url="http://127.0.0.1:18766/v1"`));
  assert(result.args.includes(`model_providers.${providerId}.wire_api="responses"`));
  assert(result.args.includes(`model_providers.${providerId}.supports_websockets=false`));
  assert(result.args.includes(`model_providers.${providerId}.requires_openai_auth=false`));
  assert.notEqual(buildLaunch('codex', { localBearer: token }).args.find(arg => arg.startsWith('model_provider=')), selected);
  assert(!result.args.join(' ').includes(token));
  assert.deepEqual(result.env, { AG_PROXY_TOKEN: token });
});

test('Claude uses the Messages API root and overrides incompatible authentication modes', () => {
  const result = buildLaunch('claude', { baseUrl: 'http://127.0.0.1:18766/prefix/v1', model: 'claude-fixture', localBearer: token });
  assert.equal(result.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18766/prefix');
  assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, token);
  assert.equal(result.env.ANTHROPIC_API_KEY, token);
  assert.equal(result.env.CLAUDE_CODE_USE_VERTEX, '0');
  assert.equal(result.env.CLAUDE_CODE_USE_BEDROCK, '0');
  assert.equal(result.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'claude-fixture');
  assert(!result.args.join(' ').includes(token));
});

test('OpenCode uses version-appropriate custom provider schema and a private v2 server', () => {
  const current = buildLaunch('opencode', { model: 'fixture-model', localBearer: token });
  const config = JSON.parse(current.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.providers.ag_proxy.package, '@opencode/ai/providers/openai-compatible');
  assert.equal(config.providers.ag_proxy.settings.baseURL, 'http://127.0.0.1:18766/v1');
  assert.deepEqual(config.providers.ag_proxy.env, ['AG_PROXY_TOKEN']);
  assert.equal(config.model, 'ag_proxy/fixture-model');
  assert.deepEqual(current.args, ['--standalone']);
  assert(!current.env.OPENCODE_CONFIG_CONTENT.includes(token));
  const legacy = buildLaunch('opencode', { model: 'fixture-model', localBearer: token, opencodeVersion: 1 });
  const oldConfig = JSON.parse(legacy.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(oldConfig.provider.ag_proxy.npm, '@ai-sdk/openai-compatible');
  assert.equal(oldConfig.provider.ag_proxy.options.apiKey, '{env:AG_PROXY_TOKEN}');
  assert.deepEqual(legacy.args, ['--model', 'ag_proxy/fixture-model']);
});

test('invalid client connection/model/token input is rejected before launch', () => {
  for (const baseUrl of ['https://remote.example/v1', 'http://user:secret@localhost/v1', 'http://localhost/v1?key=secret']) assert.throws(() => buildLaunch('codex', { baseUrl, localBearer: token }), /local proxy URL/);
  assert.throws(() => buildLaunch('codex', { model: 'bad\nmodel', localBearer: token }), /model/);
  assert.throws(() => buildLaunch('codex', { localBearer: '' }), /session token/);
  assert.throws(() => buildLaunch('opencode', { localBearer: token }), /Choose a model/);
});

test('running a client preserves existing inline settings and bypass entries without writing user config', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), output = join(root, 'observed.json');
  const client = join(root, 'opencode');
  await writeFile(client, `#!${process.execPath}\nimport fs from 'node:fs';\nif (process.argv.includes('--version')) { console.log('opencode v2.1.4'); } else { fs.writeFileSync(process.env.OUTPUT, JSON.stringify({args: process.argv.slice(2), inline: process.env.OPENCODE_CONFIG_CONTENT, noProxy: process.env.NO_PROXY})); }\n`, { mode: 0o700 });
  const previous = { providers: { existing: { name: 'Keep me' } }, permission: { edit: 'ask' } };
  const env = { PATH: root, OUTPUT: output, OPENCODE_CONFIG_CONTENT: JSON.stringify(previous), NO_PROXY: 'existing.example' };
  const original = structuredClone(env);
  assert.equal(await runClient('opencode', { model: 'fixture-model', localBearer: token }, { env, platform: 'linux' }), 0);
  assert.deepEqual(env, original);
  const observed = JSON.parse(await readFile(output, 'utf8'));
  const inline = JSON.parse(observed.inline);
  assert.deepEqual(inline.providers.existing, previous.providers.existing);
  assert.deepEqual(inline.permission, previous.permission);
  assert(inline.providers.ag_proxy);
  assert.equal(observed.noProxy, 'existing.example,127.0.0.1,localhost,::1');
  assert.deepEqual(observed.args, ['--standalone']);
  assert.deepEqual((await readdir(root)).sort(), ['observed.json', 'opencode']);
});

test('Windows command shims without official npm entrypoints are rejected before shell execution', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'codex.cmd'), 'do not execute');
  await assert.rejects(runClient('codex', { model: 'fixture', localBearer: token }, { env: { PATH: root }, platform: 'win32' }), /safely/);
});

test('Windows npm shims launch the declared entrypoint directly and preserve model text as one argument', async t => {
  const root = await fixture(t), output = join(root, 'observed.json');
  const packageRoot = join(root, 'node_modules', '@openai', 'codex');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(root, 'codex.cmd'), 'this shell file must never execute');
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ bin: { codex: 'entry.mjs' } }));
  await writeFile(join(packageRoot, 'entry.mjs'), "import fs from 'node:fs'; fs.writeFileSync(process.env.OUTPUT,JSON.stringify(process.argv.slice(2)));\n");
  const model = 'model & echo $(do-not-execute)';
  assert.equal(await runClient('codex', { model, localBearer: token }, { env: { PATH: root, OUTPUT: output }, platform: 'win32' }), 0);
  const args = JSON.parse(await readFile(output, 'utf8'));
  assert.deepEqual(args.slice(0, 2), ['--model', model]);
  assert(!args.join(' ').includes(token));
});

test('Claude session overrides use a private temporary file that is removed after launch', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), output = join(root, 'observed.json');
  await writeFile(join(root, 'claude'), `#!${process.execPath}\nimport fs from 'node:fs';\nconst file=process.argv[process.argv.indexOf('--settings')+1];\nfs.writeFileSync(process.env.OUTPUT,JSON.stringify({file,settings:JSON.parse(fs.readFileSync(file,'utf8')),mode:fs.statSync(file).mode&0o777}));\n`, { mode: 0o700 });
  const env = { PATH: root, OUTPUT: output, ANTHROPIC_AUTH_TOKEN: 'old-secret', ANTHROPIC_BASE_URL: 'https://old.example', CLAUDE_CODE_USE_BEDROCK: '1' };
  assert.equal(await runClient('claude', { model: 'fixture', localBearer: token }, { env, platform: 'linux' }), 0);
  const observed = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(observed.mode, 0o600);
  assert.equal(observed.settings.env.ANTHROPIC_AUTH_TOKEN, token);
  assert.equal(observed.settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18766');
  assert.equal(observed.settings.env.CLAUDE_CODE_USE_BEDROCK, '0');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'old-secret');
  await assert.rejects(readFile(observed.file), { code: 'ENOENT' });
});

test('an explicit missing-client install calls only the selected official package', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t), output = join(root, 'install.json');
  await writeFile(join(root, 'npm'), `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(process.env.OUTPUT, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  await installClient('opencode', { env: { PATH: root, OUTPUT: output }, platform: 'linux' });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), ['install', '--global', 'opencode-ai']);
  assert.equal(clientInstalled('codex', { env: { PATH: root }, platform: 'linux' }), false);
});

test('terminating the launcher stops its client and removes the signal listener', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'codex'), `#!${process.execPath}\nconsole.log('client-ready'); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const harness = join(root, 'launch.mjs');
  await writeFile(harness, `import { runClient } from ${JSON.stringify(new URL('./client-integrations.mjs', import.meta.url).href)};\nconsole.log('status:' + await runClient('codex', { model: 'fixture', localBearer: 'fixture-token' }));\nconsole.log('listeners:' + process.listenerCount('SIGTERM'));\n`);
  const child = spawn(process.execPath, [harness], { env: { ...process.env, PATH: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let output = '', errors = '', signalled = false;
  child.stdout.on('data', chunk => {
    output += chunk;
    if (!signalled && output.includes('client-ready')) { signalled = true; child.kill('SIGTERM'); }
  });
  child.stderr.on('data', chunk => errors += chunk);
  const code = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Launcher did not stop its client.')); }, 5000);
    child.once('error', error => { clearTimeout(deadline); reject(error); });
    child.once('close', code => { clearTimeout(deadline); resolve(code); });
  });
  assert.equal(code, 0, errors);
  assert.match(output, /status:1/);
  assert.match(output, /listeners:0/);
});

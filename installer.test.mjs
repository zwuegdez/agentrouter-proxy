import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOnly, appDirectory, writePrivate } from './install.mjs';

async function directory(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'agentrouter-install-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('proxy-only installation preserves existing Codex, credentials, configuration and old services', async t => {
  const home = await directory(t), app = join(home, 'app');
  for (const file of ['legacy/start.mjs', 'legacy/installed.json', '.codex/config.toml', '.codex/auth.json', '.config/systemd/user/codex-relay.service', 'app/api-key', 'app/client-options.json']) {
    await mkdir(join(home, file, '..'), { recursive: true });
    await writeFile(join(home, file), 'existing fixture');
  }
  const result = await installOnly({ app });
  assert.equal(await readFile(result.proxyPath, 'utf8'), await readFile(new URL('./agentrouter-coding-proxy.mjs', import.meta.url), 'utf8'));
  for (const file of ['legacy/start.mjs', 'legacy/installed.json', '.codex/config.toml', '.codex/auth.json', '.config/systemd/user/codex-relay.service', 'app/api-key', 'app/client-options.json']) assert.equal(await readFile(join(home, file), 'utf8'), 'existing fixture');
  assert.deepEqual((await readdir(app)).sort(), ['agentrouter-coding-proxy.mjs', 'api-key', 'client-options.json']);
});

test('a fresh install copies exactly one proxy file and no client, credential or startup files', async t => {
  const app = await directory(t);
  await installOnly({ app });
  assert.deepEqual(await readdir(app), ['agentrouter-coding-proxy.mjs']);
});

test('private replacement preserves a backup and reruns do not make duplicate backups', async t => {
  const app = await directory(t), path = join(app, 'proxy');
  await writePrivate(path, 'old'); await writePrivate(path, 'new'); await writePrivate(path, 'new');
  const backups = (await readdir(app)).filter(file => file.includes('agentrouter-backup-'));
  assert.equal(backups.length, 1); assert.equal(await readFile(join(app, backups[0]), 'utf8'), 'old');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert(!(await readdir(app)).some(file => file.endsWith('.tmp')));
});

test('linked installation targets are rejected without touching their contents', { skip: process.platform === 'win32' }, async t => {
  const root = await directory(t), outside = join(root, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'keep'), 'original');
  await symlink(outside, join(root, 'linked-dir'));
  await assert.rejects(installOnly({ app: join(root, 'linked-dir') }), /Unsafe/);
  const app = join(root, 'app'); await mkdir(app);
  await symlink(join(outside, 'keep'), join(app, 'agentrouter-coding-proxy.mjs'));
  await assert.rejects(installOnly({ app }), /linked/);
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'original');
});

test('installation directories honor explicit user data roots without changing them', () => {
  const env = { XDG_DATA_HOME: '/fixture/data', CODEX_HOME: '/fixture/codex' };
  assert.equal(appDirectory('/fixture/home', 'linux', env), join('/fixture/data', 'agentrouter-codex-relay'));
  assert.equal(appDirectory('/fixture/home', 'win32', { LOCALAPPDATA: '/fixture/local' }), join('/fixture/local', 'AgentRouterCodexRelay'));
  assert.deepEqual(env, { XDG_DATA_HOME: '/fixture/data', CODEX_HOME: '/fixture/codex' });
});


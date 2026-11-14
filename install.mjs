#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, lstat, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SELF = dirname(fileURLToPath(import.meta.url));

export function appDirectory(home = homedir(), platform = process.platform, env = process.env) {
  return platform === 'win32' ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'AgentRouterCodexRelay')
    : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'agentrouter-codex-relay');
}

export async function safeDirectory(directory) {
  const absolute = resolve(directory);
  for (let current = absolute;; current = dirname(current)) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe installation directory: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
}

export async function readConfiguration(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to replace a linked or non-file installation: ${path}`);
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writePrivate(path, value) {
  await safeDirectory(dirname(path));
  const previous = await readConfiguration(path);
  if (previous === value) { await chmod(path, 0o600); return; }
  if (previous !== null) await writeFile(`${path}.agentrouter-backup-${randomUUID()}`, previous, { mode: 0o600, flag: 'wx' });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function installOnly({ app = appDirectory() } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  await safeDirectory(app);
  const proxyPath = join(app, 'agentrouter-coding-proxy.mjs');
  await readConfiguration(proxyPath);
  await writePrivate(proxyPath, await readFile(join(SELF, 'agentrouter-coding-proxy.mjs'), 'utf8'));
  return { app, proxyPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    console.log('node install.mjs\nInstalls your existing AgentRouter relay for your existing Codex CLI on this computer or VPS.\nNo key prompts, model selection, Codex installation/configuration, launchers or service startup.');
  } else {
    try {
      const result = await installOnly();
      console.log(`Installed Codex AgentRouter relay: ${result.proxyPath}\nInstallation complete. Existing Codex and settings were preserved; no process was started.`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

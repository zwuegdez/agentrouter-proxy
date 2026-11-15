#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename, lstat, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

async function privateWindowsPath(path, directory = false) {
  if (process.platform !== 'win32') return;
  const script = `$ErrorActionPreference = 'Stop'
$acl = if ($env:AG_PRIVATE_DIRECTORY -eq '1') { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($env:AG_PRIVATE_DIRECTORY -eq '1') { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inheritance, 'None', 'Allow'))
}
Set-Acl -LiteralPath $env:AG_PRIVATE_PATH -AclObject $acl`;
  try {
    await promisify(execFile)(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env: { ...process.env, AG_PRIVATE_PATH: resolve(path), AG_PRIVATE_DIRECTORY: directory ? '1' : '0' }, timeout: 10000 });
  } catch { throw new Error('Could not restrict Windows file permissions. Check PowerShell availability and directory access.'); }
}

export async function writePrivate(path, value, { backup = true } = {}) {
  await safeDirectory(dirname(path));
  const previous = await readConfiguration(path);
  await privateWindowsPath(dirname(path), true);
  if (previous !== null) await privateWindowsPath(path);
  if (previous === value) { await chmod(path, 0o600); return; }
  if (previous !== null && backup) await writeFile(`${path}.agentrouter-backup-${randomUUID()}`, previous, { mode: 0o600, flag: 'wx' });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    await chmod(path, 0o600);
    await privateWindowsPath(path);
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

export async function installAssistant({ app = appDirectory(), bin = process.env.AG_BIN_DIR || join(homedir(), '.local', 'bin'), platform = process.platform } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  app = resolve(app);
  const commandPath = platform === 'win32' ? join(app, 'ag.cmd') : join(resolve(bin), 'ag');
  await safeDirectory(app);
  await safeDirectory(dirname(commandPath));
  const marker = platform === 'win32' ? '@echo off\r\nrem agentrouter-proxy launcher\r\n' : '#!/bin/sh\n# agentrouter-proxy launcher\n';
  const previous = await readConfiguration(commandPath);
  if (previous !== null && !previous.startsWith(marker)) throw new Error(`Refusing to replace an unrelated ag command: ${commandPath}`);
  const files = ['ag.mjs', 'client-integrations.mjs', 'proxy-server.mjs', 'model-catalog.mjs', 'protocol-translation.mjs', 'event-streams.mjs', 'background-service.mjs', 'activation.mjs', 'install.mjs', 'agentrouter-coding-proxy.mjs'];
  const contents = await Promise.all(files.map(file => readFile(join(SELF, file), 'utf8')));
  for (const file of files) await readConfiguration(join(app, file));
  let launcher;
  if (platform === 'win32') {
    const quote = value => {
      if (/["\r\n]/.test(value)) throw new Error('Invalid Windows launcher path.');
      return `"${value.replaceAll('%', '%%')}"`;
    };
    launcher = `${marker}setlocal DisableDelayedExpansion\r\n${quote(process.execPath)} ${quote(join(app, 'ag.mjs'))} %*\r\n`;
  } else {
    const quote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
    launcher = `${marker}exec ${quote(process.execPath)} ${quote(join(app, 'ag.mjs'))} "$@"\n`;
  }
  for (let i = 0; i < files.length; i++) await writePrivate(join(app, files[i]), contents[i]);
  await writePrivate(commandPath, launcher);
  if (platform !== 'win32') await chmod(commandPath, 0o700);
  return { app, commandPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node install.mjs [--relay-only]\nInstalls the ag setup assistant and local proxy. Run ag afterward.\n--relay-only copies only the original Codex relay.\nNo client installation, key prompts, configuration changes or service startup.');
  } else {
    try {
      if (args.some(arg => arg !== '--relay-only')) throw new Error('Unknown installer option. Use --help.');
      if (args.includes('--relay-only')) {
        const result = await installOnly();
        console.log(`Installed Codex AgentRouter relay: ${result.proxyPath}\nInstallation complete. Existing Codex and settings were preserved; no process was started.`);
      } else {
        const result = await installAssistant();
        const direct = process.platform === 'win32' ? `& '${result.commandPath.replaceAll("'", "''")}'` : `'${result.commandPath.replaceAll("'", "'\"'\"'")}'`;
        console.log(`Installed ag: ${result.commandPath}\nRun: ag help\nIf ag is not on PATH, run: ${direct} help\nAdd ${dirname(result.commandPath)} to your user PATH to use ag from any folder.\nExisting client settings were preserved; no process was started.`);
      }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}

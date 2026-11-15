import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { writePrivate } from './install.mjs';

const exec = promisify(execFile);
const xml = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const unitQuote = value => '"' + value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%') + '"';
export function serviceSpec({ app, script, home = homedir(), platform = process.platform, env = process.env, node = process.execPath }) {
  if ([app, script, home, node].some(value => /[\r\n\x00]/.test(value))) throw new Error('Invalid service path.');
  if (platform === 'linux') return {
    file: join(env.XDG_CONFIG_HOME || join(home,'.config'),'systemd','user','agentrouter-proxy.service'),
    content: `[Unit]\nDescription=AgentRouter local coding proxy\nAfter=network-online.target\n\n[Service]\nExecStart=${unitQuote(node)} ${unitQuote(script)} daemon\nEnvironment=${unitQuote('AG_APP_DIR='+app)}\nRestart=always\nRestartSec=5\nTimeoutStopSec=10\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
  };
  if (platform === 'darwin') return {
    file: join(home,'Library','LaunchAgents','org.agentrouter.proxy.plist'),
    content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>org.agentrouter.proxy</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>daemon</string></array><key>EnvironmentVariables</key><dict><key>AG_APP_DIR</key><string>${xml(app)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>StandardOutPath</key><string>${xml(join(app,'daemon.log'))}</string><key>StandardErrorPath</key><string>${xml(join(app,'daemon.log'))}</string></dict></plist>`,
  };
  if (platform === 'win32') return { file: join(app,'service.ps1'), content: `$ErrorActionPreference = 'Stop'\n$env:AG_APP_DIR = '${app.replaceAll("'","''")}'\nwhile (Test-Path -LiteralPath (Join-Path $env:AG_APP_DIR 'active.json')) {\n & '${node.replaceAll("'","''")}' '${script.replaceAll("'","''")}' daemon\n Start-Sleep -Seconds 5\n}\n` };
  throw new Error('Persistent activation supports Linux, macOS, and Windows.');
}
export async function manageService(action, options = {}) {
  const platform = options.platform || process.platform, env = options.env || process.env, run = options.run || exec;
  const spec = serviceSpec(options), call = (command,args) => run(command,args,{ env, timeout: 20_000 });
  if (action === 'install') await writePrivate(spec.file,spec.content);
  if (platform === 'linux') {
    if (action === 'install') { await call('systemctl',['--user','daemon-reload']); await call('systemctl',['--user','enable','--now',spec.file]); }
    else { await call('systemctl',['--user','disable','--now','agentrouter-proxy.service']); await unlink(spec.file).catch(e=>{if(e.code!=='ENOENT')throw e;}); await call('systemctl',['--user','daemon-reload']); }
  } else if (platform === 'darwin') {
    const domain = `gui/${process.getuid()}`;
    if (action === 'install') { await call('launchctl',['bootstrap',domain,spec.file]); await call('launchctl',['kickstart','-k',domain+'/org.agentrouter.proxy']); }
    else { await call('launchctl',['bootout',domain+'/org.agentrouter.proxy']).catch(error=>{if(!/could not find|no such process/i.test(error.stderr || error.message))throw error;}); await unlink(spec.file).catch(e=>{if(e.code!=='ENOENT')throw e;}); }
  } else {
    const shell = join(env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const ps = action === 'install' ? `$a=New-ScheduledTaskAction -Execute '${shell.replaceAll("'","''")}' -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${spec.file.replaceAll("'","''")}"'; $t=New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name); $s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Register-ScheduledTask -TaskName 'AgentRouterProxy' -Action $a -Trigger $t -Settings $s -Force | Out-Null; Start-ScheduledTask -TaskName 'AgentRouterProxy'` : `Stop-ScheduledTask -TaskName 'AgentRouterProxy' -ErrorAction SilentlyContinue; if (Get-ScheduledTask -TaskName 'AgentRouterProxy' -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName 'AgentRouterProxy' -Confirm:$false }`;
    await call(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop'; "+ps,'utf16le').toString('base64')]);
    if (action !== 'install') await unlink(spec.file).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
  return spec;
}

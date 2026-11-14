# agentrouter-proxy

A local AgentRouter proxy for **Codex CLI only**. It removes stale Azure resource references from Codex requests and streams AgentRouter responses. The relay is an exact copy of the original working Codex relay; the installer only copies that file.

## Download and install

[Download the latest ZIP](https://github.com/zwuegdez/agentrouter-proxy/releases/latest/download/agentrouter-proxy.zip), extract it, open a terminal inside the `agentrouter-proxy` folder, and run:

```sh
node install.mjs
```

Node.js 22+ is required. This offline installation copies only the bundled proxy. It does not install Codex or Node, ask for keys or models, change Codex settings, start a process, or register a service.

Alternatively, use the GitHub installer for macOS, Linux, VPS, or Android in Termux:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.0.0/install.sh | bash
```

Windows PowerShell:

```powershell
$installer = Join-Path ([IO.Path]::GetTempPath()) ('agentrouter-proxy-' + [Guid]::NewGuid().ToString('N') + '.ps1')
try {
    Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.0.0/install.ps1' -OutFile $installer
    & $installer
} finally {
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
```

Both download scripts fetch only the installer and relay from this repository's `v1.0.0` tag. If a PowerShell policy prevents script execution, use the extracted ZIP's `node install.mjs` command.

## Devices

- Windows PC, macOS, Linux, or Linux VPS: requires Node.js 22+ and an existing compatible Codex CLI.
- Android phone/tablet: run in Termux with Node.js 22+ and a compatible Codex CLI already available.
- iPhone/iPad: use an SSH app to run Codex and this installer on a computer/VPS.

Ordinary mobile browsers cannot run this Node.js relay. This download does not add native Codex support to unsupported systems.

## Installation behavior

The proxy is copied to `${XDG_DATA_HOME:-~/.local/share}/agentrouter-codex-relay/agentrouter-coding-proxy.mjs` on Unix and `%LOCALAPPDATA%\AgentRouterCodexRelay\agentrouter-coding-proxy.mjs` on Windows. This separate directory preserves older generated launchers. Reinstalling the same content makes no extra backup; changed contents are backed up before replacement.

Installing alone does not connect Codex to the proxy. The relay listens at `http://127.0.0.1:18765` when run; the existing Codex provider connection uses `/v1` and the Responses API. The installer leaves that configuration to the existing installation.

## What the relay does

It removes `previous_response_id`, resource-specific input item IDs, opaque reasoning and item references, and the Codex beta-feature header. It preserves visible messages and tool call IDs and forwards the client's authorization to AgentRouter without saving credentials. Opaque reasoning cannot be reconstructed.

This is a workaround for stale Azure resource references, not a guarantee that every Azure, account, quota, or provider error will disappear. The exact original relay has no request-body size cap, upstream deadline, independent local key validation, or modern error normalization. Keep it on loopback rather than exposing it publicly.

## Checks

```sh
node --test --experimental-test-isolation=none installer.test.mjs proxy.test.mjs
node agentrouter-coding-proxy.mjs --self-test
```

The tests verify installation preserves existing files, backup behavior, linked-target rejection, pinned relay content, request transformation, authorization forwarding, and unchanged upstream error streams. The relay-content SHA-256 is `ef70f888ec9be06d4f5064f73cbf17f04a7bb8b6ca1e0c50462ae23cdd331c29`.

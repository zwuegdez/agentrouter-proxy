# AgentRouter proxy

`ag` connects Codex, Claude Code, and OpenCode to AgentRouter. It supports CLI clients and the desktop clients' provider configuration. Requires Node.js 22+, an AgentRouter API key, and access to your selected model.

## Install

Linux/macOS:

```sh
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.2.2/install.sh | bash
ag setup
```

Windows PowerShell:

```powershell
$installer = Join-Path ([IO.Path]::GetTempPath()) ('ag-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')
try {
    curl.exe --proto '=https' --tlsv1.2 -fsSL 'https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.2.2/install.ps1' -o $installer
    if ($LASTEXITCODE -ne 0) { throw 'Installer download failed.' }
    & $installer
} finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }
& (Join-Path $env:LOCALAPPDATA 'AgentRouterCodexRelay\ag.cmd') setup
```

Or download the [v1.2.2 ZIP](https://github.com/zwuegdez/agentrouter-proxy/archive/refs/tags/v1.2.2.zip), extract it, and run `node install.mjs`. npm users can run `npm install --global github:zwuegdez/agentrouter-proxy#v1.2.2` (requires Git). This is a GitHub installation; no npm registry release is required.

Installation starts no service and preserves existing client settings. Setup asks before installing a missing CLI client or saving a key. Desktop apps are installed separately through their official installers. If `ag` is missing from PATH, use the printed launcher path or add its directory to your user PATH.

## Activate and deactivate

Run `ag setup`, choose `https://agentrouter.org/v1`, enter your key and a current model ID, and save the setup. Then:

```sh
ag activate
ag status
ag models
ag deactivate
```

`ag activate --port 18767` selects another port. Activation configures all three clients and starts a loopback-only service. It stays enabled until `ag deactivate`; closing the terminal or a client does not stop it. Linux uses a user systemd service, macOS uses a LaunchAgent, and Windows uses a scheduled task with a restart loop. Linux needs an available user systemd manager; use `loginctl enable-linger "$USER"` if you want it to start at boot and survive logout. macOS/Windows start at user login. An asleep or powered-off device cannot serve requests.

Activation validates your authenticated AgentRouter catalog before changing settings and checks that the service starts. A failed activation restores changed settings. Run one activation command at a time. If a command crashes, inspect `active.json` and the service before removing a stale `activation.lock` directory.

| Client | After activation |
| --- | --- |
| Codex CLI and Codex Desktop | Restart the client/app. Uses `CODEX_HOME/config.toml` or `~/.codex/config.toml`, a Responses provider, and an AgentRouter-only model catalog. |
| Claude Code CLI | Restart `claude`. User settings contain the local gateway, catalog model picker, and aliases for available Claude tiers. GPT selections use the Responses bridge. |
| OpenCode CLI and Desktop | Restart the desktop app or run `opencode reload` for an existing service. Global config contains the AgentRouter provider and provider-use policy. OpenCode v1 uses its legacy schema; v2 uses `providers` and `policies`. |
| Claude Code Desktop | Import the generated `claude-desktop.json` as described below, then relaunch. Its inference settings are separate from CLI settings. |

Claude Desktop: **Help → Troubleshooting → Enable Developer Mode → Developer → Configure Third-Party Inference**. Choose **Import configuration**, select the file printed by `ag activate`, click **Apply Changes**, then relaunch. Keep your previous inference configuration so you can select it again after deactivation. The generated file contains a private local token, not your upstream key. Current desktop releases encrypt saved credentials using OS secure storage; `ag` supplies an import file instead of editing that internal storage. An organization's managed inference configuration may override local imports.

`claude-desktop.json` uses automatic discovery for Claude releases. Claude Desktop filters non-Claude IDs from discovery. To select GPT or every AgentRouter model there, import `claude-desktop-all-models.json` instead. This explicit list is regenerated every refresh; import it again to show newly released or removed models. The proxy enforces the live catalog either way; it never silently substitutes a retired model.

`ag deactivate` stops the service and restores previous Codex, Claude CLI, and OpenCode settings. It preserves unrelated edits made while active. If you edited the same routing setting yourself, restoration preserves your new value. Restart clients or run `opencode reload`. For Claude Desktop, choose your previous inference configuration and relaunch.

A client's explicit command-line options, project config, custom config paths, or administrator policy can override global configuration. The proxy rejects model IDs outside its authenticated catalog. It cannot control a client you explicitly point at another provider.

## Models and endpoints

While active, the proxy fetches **only authenticated AgentRouter `/v1/models`**, on startup and every five minutes. No third-party model catalog supplies selectable IDs. New releases from every model family appear in Codex, Claude Code, and OpenCode automatically; removed or disabled models leave the catalog. Existing client pickers may need a reload or restart to display the refreshed list. Catalog metadata is fetched without redirects to avoid sending the key to another host.

GPT models always use upstream **Responses**. Claude models prefer the client's native endpoint when AgentRouter advertises it; otherwise the proxy chooses an advertised compatible endpoint. If endpoint metadata is absent, Claude defaults to Messages, then Responses/Chat as compatible candidates. Every other family, including DeepSeek, Qwen, Gemini, GLM, Kimi, and previously unknown names, uses AgentRouter endpoint metadata; absent metadata it tries compatible Chat, Responses, or Messages endpoints. There is no family allowlist. New model IDs use these rules without a hardcoded release list.

Claude Code speaks Anthropic Messages, and OpenCode's compatible provider speaks Chat Completions. The proxy translates these to Responses for GPT, including text, images, streaming, function tools, and tool-result history. Codex Responses can also translate to native Claude Messages, including Codex custom tool input. Native requests retain provider-specific fields. Translation cannot preserve every provider-specific feature: unsupported content/tools or stop sequences return an explicit error. Custom tool grammars become a string argument and their upstream grammar enforcement is lost. Hidden signed reasoning is not replayed across protocols.

Endpoint fallback happens only on a clear endpoint rejection (HTTP 405/501 or an explicit unsupported-endpoint error). It keeps the same model ID. It never retries quota/auth errors, a network failure, or a partially generated stream. An unavailable model triggers catalog refresh and an error; choose another model yourself. An upstream outage does not remove the enabled background service. Requests wait for working model discovery before inference resumes.

## Stream disconnect fixes

The shared proxy handles Responses, Anthropic Messages, and Chat Completions streams in active and foreground modes. It repairs missing final SSE separators, fills an omitted JSON event type from the SSE event name, recognizes `response.done` only when the response has an explicit terminal status, and streams complete JSON replies when a gateway ignores `stream: true`. It decompresses gzip/deflate/Brotli upstream output and respects slow-client backpressure.

Keepalive comments every 15 seconds help local connections survive quiet periods; the upstream idle deadline is 10 minutes. Completion events end the local stream promptly even when an upstream Responses/Messages connection stays open. A Chat finish reason or a Messages stop reason with all content blocks closed can supply a missing final marker at clean EOF. Provider error and incomplete statuses remain errors/incomplete; a bare `[DONE]`, partial JSON, or text delta alone is never treated as a successful completion.

A real network cutoff or unfinished upstream generation still fails with `upstream_stream_incomplete` or `upstream_stream_timeout`. Output already received is preserved. The proxy cannot reconstruct missing model output and does not replay generation. This fixes identifiable compatibility problems, not every cause of a disconnect.

The original `--relay-only` single-file Azure workaround is preserved; use the `ag` proxy for these stream improvements.

## Storage and troubleshooting

Saved setup and activation state live in `~/.local/share/agentrouter-codex-relay` (`XDG_DATA_HOME` honored), or `%LOCALAPPDATA%\AgentRouterCodexRelay` on Windows. **Saved upstream keys, local tokens, and restoration snapshots are plaintext in private files.** Unix uses mode `0600`; Windows applies user/SYSTEM/Administrators ACLs. Initial replacements keep private `.agentrouter-backup-*` files; catalog refresh avoids accumulating backups. Preserve recovery state until deactivation succeeds.

| Problem | Action |
| --- | --- |
| No saved setup | Run `ag setup` and save it. |
| Saved model unavailable | Select a model accessible to your AgentRouter key and save the setup again. |
| Service cannot start / occupied port | Check OS service logs; choose `ag activate --port 18767`. |
| HTTP 401/403 | Check key and account access. |
| HTTP 402/429 | Check provider balance, quota, and rate limits. |
| HTTP 404 model unavailable | Refresh with `ag models`, reload the client picker, and choose an available model. |
| HTTP 400 translation error | Use a native compatible endpoint/model or remove the unsupported feature. |
| HTTP 502/504 | Check upstream availability, network, and service logs. |
| Configuration parse error | Correct the existing client config. Linked/non-file targets are rejected. |

Linux logs: `journalctl --user -u agentrouter-proxy.service`. macOS logs: the app directory's `daemon.log`. Windows service: scheduled task `AgentRouterProxy`. Requests are limited to 32 MiB, model catalogs/errors to 4 MiB, upstream headers to 60 seconds, and idle upstream streams to 10 minutes. The local stream receives a keepalive comment every 15 seconds. Keep loopback private.

To update `ag`, deactivate, install the desired pinned release, then reactivate. Client updates are independent; the proxy uses published configuration/API contracts, but arbitrary future breaking changes may need a proxy update. To uninstall, deactivate first, then remove the launcher and app directory after checking keys/backups. npm: `npm uninstall --global agentrouter-proxy`. Desktop apps and CLI clients remain installed.

## Foreground modes

`ag start` launches your saved CLI setup with temporary settings and stops when that client exits. `ag proxy` forwards the existing client's credentials and prints routing instructions. Both keep the terminal open and stop with Ctrl+C; model restriction and automatic protocol selection are part of persistent activation.

```sh
ag start
ag proxy --endpoint https://provider.example/v1 --port 18767
ag help
```

## Verification

```sh
node --test
```

Tests cover activation rollback/restoration, private settings, model refresh/removal, endpoint selection, Responses/Messages/Chat translation, split UTF-8 SSE, tool history/custom tool input, authentication, cancellation, timeouts, installers, and prior relay behavior. OpenCode 2.1.4 listed only the generated AgentRouter fixture models. Codex 0.169.0 app-server accepted the catalog and returned only those IDs. A real Linux user service served mock discovery, restarted after SIGKILL, and stopped/restored on deactivation.

Installed Claude Code completed a GPT mock request through Messages → Responses with `CLIENT_PROXY_OK`. OpenCode accepted and restricted the provider/catalog, but its standalone generation check stalled during server startup before reaching the proxy.

Installed Codex and Claude Code also completed against a mock that returned non-streaming JSON to streaming requests, each returning `CLIENT_PROXY_OK`.

Native desktop UI execution, Windows/macOS service execution, and funded inference with this protocol bridge remain unverified. An account's catalog listing does not guarantee quota or operational availability.

References: [Codex configuration](https://developers.openai.com/codex/config-reference/), [Claude gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [Claude Desktop configuration/import](https://claude.com/docs/third-party/claude-desktop/in-app-configuration), [OpenCode policies](https://opencode.ai/docs/policies).

## Original Codex relay tutorial (v1.0.0)

This local proxy helps Codex CLI continue conversations when AgentRouter returns **“The requested item was created under a different Azure OpenAI resource.”** It removes stale resource references and forwards the request to AgentRouter.

The installer only copies the proxy. Starting it and connecting Codex are separate manual steps below.

## Requirements

- Node.js **22 or newer**: [download Node.js](https://nodejs.org/en/download).
- An existing Codex CLI installation: [official installation guide](https://developers.openai.com/codex/cli/).
- A working AgentRouter account, an authorized model, and your existing AgentRouter credentials.
- Internet access to GitHub during download and to AgentRouter during use.

Check your installation:

```sh
node --version
codex --version
```

Use the proxy on the same computer or VPS as Codex. For a phone, follow the SSH tutorial below. It does not run inside a web browser.

## 1. Install the proxy

Choose one installation method. Downloads use the pinned `v1.0.0` version.

### macOS, Linux, or VPS: curl

Open Bash and run:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.0.0/install.sh | bash
```

To download and inspect the script first:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.0.0/install.sh -o install.sh
cat install.sh
bash install.sh
```

### Windows: PowerShell with curl

Open PowerShell and run:

```powershell
$installer = Join-Path ([IO.Path]::GetTempPath()) ('agentrouter-proxy-' + [Guid]::NewGuid().ToString('N') + '.ps1')
try {
    curl.exe --proto '=https' --tlsv1.2 -fsSL 'https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.0.0/install.ps1' -o $installer
    if ($LASTEXITCODE -ne 0) { throw 'Installer download failed.' }
    & $installer
} finally {
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
```

Use `curl.exe` because `curl` can refer to a PowerShell alias. If your PowerShell policy blocks scripts, use the ZIP method instead.

### Any supported computer: ZIP

1. Download the [versioned source ZIP](https://github.com/zwuegdez/agentrouter-proxy/archive/refs/tags/v1.0.0.zip).
2. Extract the ZIP.
3. Open a terminal in the extracted folder containing `install.mjs`.
4. Run:

   ```sh
   node install.mjs
   ```

This method installs from the extracted files without further downloads.

### Install from Git

With Git already installed:

```sh
git clone --branch v1.0.0 --depth 1 https://github.com/zwuegdez/agentrouter-proxy.git
cd agentrouter-proxy
node install.mjs
```

### What installation changes

The installer prints the installed proxy's exact path. The default locations are:

| System | Proxy file |
| --- | --- |
| macOS/Linux/VPS | `~/.local/share/agentrouter-codex-relay/agentrouter-coding-proxy.mjs` |
| Windows | `%LOCALAPPDATA%\AgentRouterCodexRelay\agentrouter-coding-proxy.mjs` |

On Unix, a configured `XDG_DATA_HOME` replaces `~/.local/share`. The folder is separate from older generated launchers.

Installation preserves existing Codex settings and credentials. It does not install Node.js or Codex, request a key or model, register a service, or start a process. If it replaces changed proxy contents, it saves a backup beside the file. Reinstalling identical contents does not create another backup.

## 2. Check and start the proxy

Run the local self-test first. It makes no upstream request.

macOS/Linux/VPS:

```bash
node "${XDG_DATA_HOME:-$HOME/.local/share}/agentrouter-codex-relay/agentrouter-coding-proxy.mjs" --self-test
```

Windows PowerShell:

```powershell
node (Join-Path $env:LOCALAPPDATA 'AgentRouterCodexRelay\agentrouter-coding-proxy.mjs') --self-test
```

Expected result: `self-test ok`.

Start the proxy in a terminal and leave it open:

macOS/Linux/VPS:

```bash
node "${XDG_DATA_HOME:-$HOME/.local/share}/agentrouter-codex-relay/agentrouter-coding-proxy.mjs"
```

Windows PowerShell:

```powershell
node (Join-Path $env:LOCALAPPDATA 'AgentRouterCodexRelay\agentrouter-coding-proxy.mjs')
```

Expected startup message:

```text
codex relay on http://127.0.0.1:18765 -> https://agentrouter.org
```

Press **Ctrl+C** in this terminal to stop it. The foreground proxy stops when its terminal/session closes. On a VPS, you can keep it in an existing terminal multiplexer session; the installer does not configure autostart.

## 3. Connect your existing Codex installation

Skip editing configuration if Codex already uses this local proxy.

1. Back up your Codex configuration before editing it. The default file is `~/.codex/config.toml` or `$HOME\.codex\config.toml` on Windows. If you set `CODEX_HOME`, use that directory's `config.toml`.
2. Find the active provider selected by `model_provider`. A profile or command-line option can override the value in your main configuration; edit the provider Codex actually uses.
3. In that existing `[model_providers.<provider-id>]` section, replace only these fields:

   ```toml
   base_url = "http://127.0.0.1:18765/v1"
   wire_api = "responses"
   supports_websockets = false
   ```

4. Keep your provider ID, selected model, key source, and other existing authentication settings. Edit the existing section; do not append a duplicate TOML section.
5. Leave the proxy running, then restart Codex in another terminal:

   ```sh
   codex
   ```

If your provider uses `env_key`, it names the environment variable containing your AgentRouter key. That variable must be available in the shell starting Codex. The proxy forwards Codex's authorization and does not supply or save a key.

The `/v1` suffix belongs in Codex's base URL. The relay uses streamed HTTP Responses requests; it does not support WebSocket upgrades. These manual steps do not change the install-only behavior of the installer.

## 4. Use from a phone

1. Have SSH access to the computer or VPS where Codex will run.
2. Open an SSH client on the phone and connect to that machine.
3. Follow the installation and startup instructions in that remote terminal.
4. Open another SSH terminal to run Codex. Keep the proxy terminal/session running.

Both processes run on the remote machine. No proxy installation is required on the phone, and no public proxy port needs to be opened.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `node` is missing or older than 22 | Install/update Node.js, reopen your terminal, and check `node --version` before retrying. |
| `curl` is missing | Install curl using your OS's package manager, or use the ZIP method. On Windows try `curl.exe`. |
| GitHub download fails | Check your internet connection and DNS. Use the ZIP method if raw-file access is unavailable. |
| PowerShell blocks the installer | Use the ZIP method and run `node install.mjs`; no PowerShell installer execution is needed. |
| `Unsafe installation directory` | The installer rejects symbolic links/junctions and non-directory targets. Choose a real directory for `XDG_DATA_HOME` or inspect the printed path. Do not delete existing files just to bypass the check. |
| `EADDRINUSE` or port already in use | Another process already owns port 18765. Check whether the proxy is already running before starting another copy. |
| Codex cannot connect to `127.0.0.1:18765` | Start the proxy on the same machine as Codex. Check the configured base URL and whether a system proxy is intercepting loopback traffic. |
| HTTP 401/403 | Check your existing AgentRouter key, endpoint, account access, and key availability in Codex's shell. The proxy cannot grant provider access. |
| HTTP 402/429 | Check provider budget, quota, or rate limits and follow the provider's retry guidance. The proxy does not retry failed generation. |
| HTTP 502 with `relay:` | The proxy could not connect successfully to AgentRouter. Check DNS, network access, and the provider's availability. |
| Azure resource error continues | Confirm Codex uses the local `/v1` URL, then try a fresh conversation with the visible task history. The workaround does not cover every client/provider failure. |
| Stream disconnects or generation stops | Check the network/provider and preserve the original error. The proxy does not invent missing output or replay a partial generation. |

If an HTTP proxy intercepts localhost, preserve your existing proxy-bypass list and add `127.0.0.1`, `localhost`, and `::1` to `NO_PROXY` and `no_proxy` in the terminal that starts Codex.

## Update, restore, or uninstall

To reinstall this version, run the same installation command. Future pinned versions require their corresponding version URL; this command does not automatically upgrade Node.js or Codex. Restart a running proxy after replacing its file.

To restore a previous proxy, stop it and use the `agentrouter-coding-proxy.mjs.agentrouter-backup-*` file saved beside it, if one was created.

To uninstall:

1. Stop the proxy with **Ctrl+C**. If you separately configured a service, stop/remove that service yourself.
2. Restore your previous Codex provider base URL from your configuration backup before using Codex again.
3. Delete the installed `agentrouter-codex-relay` or `AgentRouterCodexRelay` folder after checking its contents. Keep any backups you need.

Codex itself and its credentials remain installed.

## What the proxy does and its limits

The relay forwards to `https://agentrouter.org` and listens only on `127.0.0.1:18765`. It removes `previous_response_id`, resource-specific top-level input item IDs, opaque reasoning and item references, `reasoning.encrypted_content` requests, and the Codex beta-feature header. It preserves visible messages and tool call IDs and streams upstream responses.

Opaque reasoning cannot be reconstructed. The relay does not convert other protocols, repair model/client compatibility, normalize provider errors, or fix account/budget restrictions. It has no request-body size cap, upstream deadline, or independent local key validation. Keep it local to a trusted machine rather than exposing it as a public relay.

Advanced users can change the listening port with `RELAY_PORT` or the HTTPS upstream origin with `RELAY_UPSTREAM` before starting Node. If you change the port, update Codex's base URL to match. Changing the upstream sends your requests and authorization to that provider; keep the default unless you intend that change.

## Verification and references

From the repository folder:

```sh
node --test installer.test.mjs proxy.test.mjs
node agentrouter-coding-proxy.mjs --self-test
```

Nine focused tests cover installation preservation, backups, linked-target rejection, relay-content identity, history transformation, authorization forwarding, and unchanged upstream error streams. The original relay's SHA-256 is `ef70f888ec9be06d4f5064f73cbf17f04a7bb8b6ca1e0c50462ae23cdd331c29`.

The curl installation was checked on Linux in an isolated data directory. On 2026-11-14, the exact downloaded `v1.0.0` relay completed a real Codex CLI 0.169.0 request with `gpt-6.1-sol`, returning `PROXY_OK` in 4.03 seconds with no errors. This check used a temporary port and isolated Codex configuration, with no custom model catalog or changes to the running proxy.

That single no-tools turn verifies connectivity, authorization, and streamed completion for the tested account/model. Native Windows/macOS execution, live tool use, long conversations, and every Azure error remain unverified.

- [Codex configuration reference](https://developers.openai.com/codex/config-reference/)
- [Codex advanced configuration](https://developers.openai.com/codex/config-advanced/)

# Installation and usage guide

`ag` starts a local proxy for **Codex CLI, Claude Code, and OpenCode**. Choose an existing client setup, guided setup with an endpoint and API key, or your saved setup. The proxy removes stale Responses references that can cause AgentRouter's Azure resource error.

## Install and use ag

Requires **Node.js 22+**, a compatible provider endpoint, API key, and model. Each client uses its own protocol: Codex requires Responses, Claude requires Messages, and OpenCode requires Chat Completions. The proxy forwards those protocols; your endpoint must support the chosen client.

### Linux, macOS, or VPS: curl

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.1.0/install.sh | bash
ag help
ag
```

The installer copies the files and prints the command path. It starts no process. If `ag` is not on PATH, run:

```bash
"$HOME/.local/bin/ag" help
"$HOME/.local/bin/ag"
```

Add `~/.local/bin` to your shell's PATH to use `ag` from any folder. For a custom bin directory, set `AG_BIN_DIR` when running the installer and use its printed path.

To inspect the installer before running it:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.1.0/install.sh -o install.sh
cat install.sh
bash install.sh
```

### Windows: PowerShell with curl

```powershell
$installer = Join-Path ([IO.Path]::GetTempPath()) ('ag-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')
try {
    curl.exe --proto '=https' --tlsv1.2 -fsSL 'https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.1.0/install.ps1' -o $installer
    if ($LASTEXITCODE -ne 0) { throw 'Installer download failed.' }
    & $installer
} finally {
    Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
& (Join-Path $env:LOCALAPPDATA 'AgentRouterCodexRelay\ag.cmd') help
& (Join-Path $env:LOCALAPPDATA 'AgentRouterCodexRelay\ag.cmd')
```

Add `%LOCALAPPDATA%\AgentRouterCodexRelay` to your user PATH to use `ag help`. If your script policy blocks the installer, use the ZIP or npm method.

### ZIP, Git, or npm

Download the [v1.1.0 ZIP](https://github.com/zwuegdez/agentrouter-proxy/archive/refs/tags/v1.1.0.zip), extract it, open its folder in a terminal, and run `node install.mjs`. You can also use `node ag.mjs help` directly from that folder.

With Git installed:

```sh
git clone --branch v1.1.0 --depth 1 https://github.com/zwuegdez/agentrouter-proxy.git
cd agentrouter-proxy
node install.mjs
ag help
```

To install the command with npm from GitHub:

```sh
npm install --global github:zwuegdez/agentrouter-proxy#v1.1.0
ag help
ag
```

This is a GitHub installation, not an npm registry release. npm also needs Git for this method. The client packages are installed separately, only if you accept the setup prompt.

### Choose a mode

| Command or menu choice | Behavior |
| --- | --- |
| `ag` | Shows all three choices. |
| **1. Proxy only** | Choose a client and endpoint; keep its existing credentials and model. Prints routing instructions and leaves the proxy running. |
| **2. Guided setup** or `ag setup` | Choose Codex, Claude, or OpenCode. Detects the selected client, asks before installing it, asks for endpoint/key/model, then asks about saving and starting. |
| **3. Start saved setup** or `ag start` | Loads the setup you chose to save, starts the proxy, and launches that client. |
| `ag proxy` | Starts only the proxy with the default AgentRouter endpoint. |
| `ag help` | Shows commands, configuration location, and limits. |

API-key entry is hidden. You can supply `AG_API_KEY` through your existing environment instead; it is never printed or passed in command arguments. Saving is optional. When declined, the new key stays in memory for that session and existing saved settings remain available.

Saved settings live at `~/.local/share/agentrouter-codex-relay/ag.json` on Unix (`XDG_DATA_HOME` is honored), or `%LOCALAPPDATA%\AgentRouterCodexRelay\ag.json` on Windows. **Saved keys are plaintext**, protected with Unix mode `0600` or Windows ACLs allowing your user, SYSTEM, and Administrators. Replacing a saved setup creates a private `ag.json.agentrouter-backup-*` file containing the old key. Keep or remove those backups deliberately.

Guided launches give the selected client temporary connection settings and a random local token. They preserve existing client configuration files. The proxy supplies your provider key upstream. In proxy-only mode, authorization comes from the existing client; point that client at the displayed local address and run it in a second terminal. Use guided setup if you want automatic session routing.

The default address is `http://127.0.0.1:18766/v1`. It is separate from the original relay's port `18765`. Stop with **Ctrl+C**; a guided session also stops its proxy when the client exits. No service or autostart is registered.

For another endpoint or an occupied port:

```sh
ag proxy --endpoint https://provider.example/v1 --port 18767
ag start --port 18767
```

For Claude proxy-only mode, set `ANTHROPIC_BASE_URL` to the displayed address with the final `/v1` removed. For OpenCode, set the existing provider's `baseURL` to the displayed `/v1` address. Keep the key, model, and provider SDK already working in that client. For Codex, use the provider fields shown in the original relay tutorial below with port **18766**.

### Phone access, troubleshooting, updates, and removal

From a phone, connect to your computer/VPS with an SSH client and run `ag` there. Both client and proxy run on that machine; the proxy remains on loopback. Keep your SSH session open or use a terminal multiplexer you already have.

| Problem | What to do |
| --- | --- |
| `ag` not found | Run the printed full path; add its directory to PATH. For npm, check your global npm bin location. |
| Client missing | Accept its installation prompt, or install the client yourself and reopen the terminal. Declining installs nothing. |
| No saved setup | Run `ag setup`, or `ag proxy` for an existing client. |
| Port already in use | Use `ag start --port 18767` or `ag proxy --port 18767`. |
| HTTP 401/403 | Check provider key and account access. In proxy-only mode, check the key reaches the existing client. |
| HTTP 402/429 | Check provider budget/quota/rate limits. Failed generations are not automatically retried. |
| HTTP 502/504 | Check endpoint, DNS and upstream availability; the upstream header deadline is 60 seconds. |
| Model or API unsupported | Choose a model and endpoint supporting the selected client's protocol. |
| Key-saving permission error on Windows | Saving requires PowerShell to set a private ACL. Fix the stated permission problem, or decline saving and use a session only. |
| Existing `ag` command conflict | The installer refuses to overwrite an unrelated command. Choose another bin directory or resolve that command yourself. |

Requests are capped at 32 MiB; an upstream stream idle for 120 seconds is closed. The proxy strips stale references on Responses requests and preserves upstream error bodies. Removing references cannot recover hidden reasoning or fix every Azure, provider, or client error. Proxy-only mode has no independent local token check: keep it on a trusted machine.

To update, run the installer URL for the version you want, or repeat npm installation with that tag. Stop active sessions before updating. The installer preserves client settings and saves backups when replacing changed files.

To remove a curl/ZIP installation, stop it, remove the installed `ag` launcher, then remove the app directory after checking its contents and backups. Undo any routing edits you made for proxy-only mode. For npm use `npm uninstall --global agentrouter-proxy`; saved app settings and backups need separate removal. Client installations are separate.

### Verification

```sh
node --test
```

Local tests cover setup consent, key persistence/permissions/backups, validation, installation preservation, executable launchers, forwarding, stale references, streaming, authorization, cancellation, and client session settings. Linux terminal checks verify hidden key entry and declining save/start without writes. Installed Codex CLI and OpenCode completed requests against local mock providers; the previous implementation's Claude check also reached a local mock.

Funded inference through the new assistant, long conversations, and native Windows/macOS execution remain untested. The historical live check below applies to the original `v1.0.0` relay.

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

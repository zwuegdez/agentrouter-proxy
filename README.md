# Installation tutorial

1. Use a computer or VPS with Node.js 22+, Codex CLI, Bash and curl already installed.
2. Open a terminal and run:

   ```sh
   curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.0.0/install.sh | bash
   ```

The installer copies the proxy file and prints its location. It preserves your existing settings and credentials. It does not install Codex or Node.js, ask for a key, configure Codex, or start the proxy.

To use your phone, connect to that computer or VPS through an SSH app and run the same installation there. Codex and the proxy run on the computer or VPS.

Installing the files alone does not connect Codex to the proxy. Keep the relay local; it cannot fix provider account or quota errors.

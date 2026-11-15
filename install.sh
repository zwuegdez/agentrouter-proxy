#!/usr/bin/env bash
set -euo pipefail
umask 077

site='https://raw.githubusercontent.com/zwuegdez/agentrouter-proxy/v1.2.3'
command -v curl >/dev/null 2>&1 || { echo 'curl is required to download the proxy.' >&2; exit 1; }
node_bin=$(command -v node || true)
if [[ -z "$node_bin" ]] || ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  echo 'Node.js 22+ is required. Install it first, then run this proxy installer again.' >&2
  echo 'No proxy, client or runtime was installed.' >&2
  exit 1
fi
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/agentrouter-install.XXXXXXXX")
chmod 700 "$work_dir"
trap 'rm -rf "$work_dir"' EXIT
for file in install.mjs ag.mjs ag-clients.mjs ag-proxy.mjs ag-models.mjs ag-protocols.mjs ag-streams.mjs ag-service.mjs ag-activation.mjs agentrouter-coding-proxy.mjs; do
  curl --proto '=https' --tlsv1.2 -fsSL "$site/$file" -o "$work_dir/$file"
  chmod 600 "$work_dir/$file"
done
"$node_bin" "$work_dir/install.mjs" "$@"

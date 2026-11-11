#!/bin/sh
set -eu

if [ "${1:-}" = "--help" ]; then
  printf '%s\n' \
    'Start the Aurelia HTTP media gateway on 127.0.0.1:3103 with temporary macOS idle-sleep prevention.' \
    'Uses the exported MEDIA_GATEWAY_TOKEN or the existing .runtime/media-local.env.' \
    'Requires Node 24.15+ (major 24); AURELIA_NODE_BINARY can select its executable.' \
    'Keep this terminal open. Ctrl+C stops the gateway and releases idle-sleep prevention.' \
    'Display sleep is allowed. Lid-close, manual sleep, shutdown and low battery are not prevented.'
  exit 0
fi
if [ "$#" -ne 0 ]; then
  printf '%s\n' 'Use npm run start:media:awake, without arguments (or -- --help).' >&2
  exit 1
fi
if [ "$(uname -s)" != "Darwin" ] || [ ! -x /usr/bin/caffeinate ]; then
  printf '%s\n' 'This command requires macOS with /usr/bin/caffeinate. Use start:media on other hosts.' >&2
  exit 1
fi

task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$task_root"
task_node=${AURELIA_NODE_BINARY:-node}
if ! "$task_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 24 && minor >= 15 ? 0 : 1)' 2>/dev/null; then
  printf '%s\n' 'Node 24.15+ (major 24) is required. Activate Node 24 or set AURELIA_NODE_BINARY.' >&2
  exit 1
fi

set --
if [ -z "${MEDIA_GATEWAY_TOKEN:-}" ]; then
  task_env_file="$task_root/.runtime/media-local.env"
  if [ ! -r "$task_env_file" ]; then
    printf '%s\n' 'The existing media token file is missing. Restore .runtime/media-local.env or export MEDIA_GATEWAY_TOKEN.' >&2
    exit 1
  fi
  unset MEDIA_GATEWAY_TOKEN
  set -- "--env-file=$task_env_file"
fi

# This session serves the existing Funnel HTTP backend; env files cannot widen its bind address.
export HOSTNAME=127.0.0.1 PORT=3103
export MEDIA_GATEWAY_TLS_CERT_FILE= MEDIA_GATEWAY_TLS_KEY_FILE=
printf '%s\n' 'Starting Aurelia media; requesting temporary idle-sleep prevention. Ctrl+C stops it.'
# exec avoids a supervisor forwarding terminal signals twice. caffeinate follows the utility lifetime.
exec /usr/bin/caffeinate -i "$task_node" "$@" --import tsx "$task_root/scripts/media-session.mjs"

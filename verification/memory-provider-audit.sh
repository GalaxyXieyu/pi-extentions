#!/bin/sh
set -eu

if rg -n 'recall\.invalidate\(\)|viking_forget|deleteSession|DELETE|client\.delete' extensions/pi-agents-memory/providers/openviking; then
  echo 'audit failed: stale lifecycle or remote deletion capability found' >&2
  exit 1
fi
rg -n 'createSession\(id\)|provider\.recall|provider\.capture|provider\.commit|searchContext' extensions/pi-agents-memory/providers/openviking/index.ts extensions/pi-agents-memory/providers/openviking/sync.ts extensions/pi-agents-memory/providers/openviking/provider.ts extensions/pi-agents-memory/providers/openviking/client.ts >/dev/null
rg -n 'sanitizeSensitive(Text|Value)' extensions/pi-agents-memory/core extensions/pi-agents-memory/providers/openviking extensions/pi-agents-memory/providers/viking-memory >/dev/null
printf '%s\n' 'static-audit=pass'

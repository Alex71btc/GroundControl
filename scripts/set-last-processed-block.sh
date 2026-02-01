#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  echo "Usage: $0 tip-2 | <height>"
  exit 1
fi

# Read BITCOIN_RPC from .env (supports '=' in passwords)
BITCOIN_RPC="$(grep '^BITCOIN_RPC=' .env | cut -d= -f2-)"
if [[ -z "$BITCOIN_RPC" ]]; then
  echo "BITCOIN_RPC not found in .env"
  exit 1
fi
export BITCOIN_RPC

# Extract user/pass/host/port using python (robust for special chars)
read -r RPC_USER RPC_PASS RPC_HOST RPC_PORT < <(python3 - <<'PY'
import os
from urllib.parse import urlparse, unquote
u = urlparse(os.environ["BITCOIN_RPC"])
print(unquote(u.username or ""), unquote(u.password or ""), u.hostname or "", str(u.port or 8332))
PY
)

if [[ "$MODE" == "tip-2" ]]; then
  H=$(curl -sS --user "$RPC_USER:$RPC_PASS" \
    -H 'content-type: text/plain;' \
    --data-binary '{"jsonrpc":"1.0","id":"gc","method":"getblockcount","params":[]}' \
    "http://$RPC_HOST:$RPC_PORT/" | python3 -c "import sys,json; print(json.load(sys.stdin)['result'])")
  TARGET=$((H-2))
else
  TARGET="$MODE"
fi

echo "Setting LAST_PROCESSED_BLOCK = $TARGET"

mysql -u gc -p groundcontrol -e "
INSERT INTO key_value (\`key\`, \`value\`)
VALUES ('LAST_PROCESSED_BLOCK', '$TARGET')
ON DUPLICATE KEY UPDATE \`value\`=VALUES(\`value\`);
"

echo "Done."

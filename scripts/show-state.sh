#!/usr/bin/env bash
set -euo pipefail

echo "== services =="
systemctl --no-pager --full status groundcontrol-api groundcontrol-sender groundcontrol-mempool groundcontrol-blockprocessor | sed -n '1,18p'

echo
echo "== key_value =="
mysql -u gc -p groundcontrol -e "SELECT \`key\`, \`value\` FROM key_value;" || true

echo
echo "== token counts =="
mysql -u gc -p groundcontrol -e "
SELECT 'token_to_address' t, COUNT(*) c FROM token_to_address
UNION ALL SELECT 'token_to_txid' t, COUNT(*) c FROM token_to_txid
UNION ALL SELECT 'token_to_hash' t, COUNT(*) c FROM token_to_hash;
" || true

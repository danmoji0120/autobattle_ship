#!/usr/bin/env bash
# Read-only checks: safe to run while Render is the sole active world writer.
set -euo pipefail

test -d /opt/siderarium/releases
test "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 20
sudo -n systemctl is-enabled siderarium.service >/dev/null

sudo -n bash -c '
  set -euo pipefail
  set -a
  source /etc/siderarium/server.env
  set +a
  test "${SIDERARIUM_REQUIRE_DB:-}" = 1
  test -n "${DATABASE_URL:-}"
  psql "$DATABASE_URL" -XAtqc "SELECT 1" | grep -qx 1
'

# A 502 is expected before the Node server is deployed; TLS must still work.
http_status="$(curl --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' \
  https://siderarium.duckdns.org/)"
case "$http_status" in
  200|502) echo "OCI_PREFLIGHT_OK (HTTPS $http_status, DB read-only SELECT 1)" ;;
  *) echo "Unexpected HTTPS status: $http_status" >&2; exit 1 ;;
esac

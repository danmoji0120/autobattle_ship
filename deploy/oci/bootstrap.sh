#!/usr/bin/env bash
# Run once on the OCI host: sudo bash bootstrap.sh [ssh-login-user]
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo 'Run this script with sudo.' >&2
  exit 1
fi

deploy_user="${1:-ubuntu}"
if ! id "$deploy_user" >/dev/null 2>&1; then
  echo "Unknown Linux user: $deploy_user" >&2
  exit 1
fi

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo 'Node.js 22 is required. Install Node.js before running this setup.' >&2
  exit 1
fi
node_major="$("$node_bin" -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 20 )); then
  echo "Node.js 20+ required (found major version $node_major)." >&2
  exit 1
fi

deploy_group="$(id -gn "$deploy_user")"
install -d -m 755 -o "$deploy_user" -g "$deploy_group" /opt/siderarium
install -d -m 755 -o "$deploy_user" -g "$deploy_group" /opt/siderarium/releases
install -d -m 700 -o root -g root /etc/siderarium

if [[ ! -e /etc/siderarium/server.env ]]; then
  umask 077
  printf 'PORT=8080\nSIDERARIUM_REQUIRE_DB=1\nSAVE_INTERVAL_S=30\n' > /etc/siderarium/server.env
  chmod 600 /etc/siderarium/server.env
  echo 'Created /etc/siderarium/server.env. Add DATABASE_URL before deployment.'
else
  echo 'Kept the existing /etc/siderarium/server.env unchanged.'
fi

cat > /etc/systemd/system/siderarium.service <<UNIT
[Unit]
Description=SIDERARIUM persistent multiplayer server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${deploy_user}
Group=${deploy_group}
WorkingDirectory=/opt/siderarium/current
EnvironmentFile=/etc/siderarium/server.env
ExecStart=${node_bin} dist-server/server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
KillSignal=SIGTERM
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable siderarium.service
echo 'Service registered but NOT started. Set DATABASE_URL and configure GitHub secrets first.'

#!/usr/bin/env bash
# Executed over SSH by the deploy workflow. Takes only a 40-char Git commit SHA.
set -euo pipefail

release_sha="${1:-}"
if [[ ! "$release_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'A full 40-character Git SHA is required.' >&2
  exit 1
fi

base=/opt/siderarium
release="$base/releases/$release_sha"
archive="/tmp/siderarium-${release_sha}.tar.gz"

if [[ ! -f "$archive" || ! -d "$base/releases" ]]; then
  echo 'Release archive or bootstrapped directory is missing.' >&2
  exit 1
fi

# Never unpack over the running release; every SHA has its own directory.
mkdir -p "$release"
tar -xzf "$archive" -C "$release"
test -f "$release/dist/index.html"
test -f "$release/dist-server/server.mjs"
test -d "$release/node_modules"
rm -- "$archive"

ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"

# systemd sends SIGTERM, allowing the old server to persist its world before exit.
if ! sudo -n systemctl restart siderarium.service; then
  echo 'Service restart failed. No automatic rollback (world migration may have run).' >&2
  exit 1
fi

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 2 \
      http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "SIDERARIUM deployed: $release_sha"
    exit 0
  fi
  sleep 2
done

echo 'Health check failed. Inspect journalctl -u siderarium -n 100.' >&2
echo 'Automatic rollback is intentionally disabled to protect saved-world migrations.' >&2
exit 1

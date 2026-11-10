# SIDERARIUM: Oracle E2.Micro production deployment

This setup deploys **only** pushes to `deploy/production`. It builds the Vite client and the
Node 20+ server on GitHub's runner, then uploads the runtime files to the Oracle VM.
The 1 GiB E2.Micro instance never builds the project. `npm start` is equivalent to
`node dist-server/server.mjs`, served on local port 8080.

## Important storage safety

- **Do not connect Oracle and Render to the same writable Supabase world simultaneously.**
  Concurrent saves from different server versions can overwrite one another.
- `SIDERARIUM_REQUIRE_DB=1` is mandatory for this production setup. With it, an
  unavailable/missing PostgreSQL connection stops the server instead of silently
  starting a new file-based world. This switch is implemented on this branch.
- Back up the production world and accounts before any cutover, and verify the
  backup. The application can automatically migrate stored world versions on startup.
- Do not set `WORLD_RESET` or `CONTENT_MIGRATE=apply` during routine deployment.
- New releases are retained under `/opt/siderarium/releases/<commit-sha>`; no
  automatic binary rollback is attempted because a world migration may have
  committed. If startup fails, inspect the logs and stored world before reverting.

## 1. Prepare the Oracle Ubuntu 24.04 host (once)

The host requires **Node.js 22**, `curl`, `tar`, and `systemd`. Install Node.js 22
using an official, reviewed installation method (for example, NodeSource's
Ubuntu packages), then verify:

```bash
node -v
command -v node
sudo apt-get update
sudo apt-get install -y curl tar
```

Copy this repository's `deploy/oci/bootstrap.sh` to the VM using `scp`, or open
the script in the checked-out repository directly on the VM. Then run:

```bash
sudo bash bootstrap.sh ubuntu
sudoedit /etc/siderarium/server.env
```

The bootstrap creates `/opt/siderarium/releases`, a systemd unit, and a root-only
environment file. It **enables but does not start** the service.

In `/etc/siderarium/server.env`, keep these settings and add the actual database
URL **directly on the server** (never in Git, GitHub Actions logs, or chat):

```ini
PORT=8080
SIDERARIUM_REQUIRE_DB=1
SAVE_INTERVAL_S=30
DATABASE_URL='postgresql://USER:PASSWORD@HOST:PORT/DB?sslmode=require'
```

`SAVE_INTERVAL_S=30` retains the application's existing default; adjust only
after evaluating persistence cost, bandwidth, and crash-loss tolerance.

The OCI SSH login user must have permission to write `/opt/siderarium/releases`
and run `sudo -n systemctl restart siderarium.service`. The default OCI
`ubuntu` account typically has passwordless sudo; verify it before enabling CI.

## 2. Set up dedicated GitHub Actions SSH access

Create a **separate** SSH key for deployments, distinct from your Windows login
key. Add its **public** key to the Oracle user's `~/.ssh/authorized_keys`.
Keep its **private** key only in GitHub Actions secrets.

In repository **Settings > Secrets and variables > Actions** add:

| Type | Name | Value |
|---|---|---|
| Secret | `OCI_SSH_PRIVATE_KEY` | Full dedicated deployment private key (never send in chat) |
| Secret | `OCI_SSH_KNOWN_HOSTS` | Exact verified `ssh-keyscan -t ed25519 HOST` line |
| Variable | `OCI_HOST` | Oracle VM's public IP or resolvable host |
| Variable | `OCI_SSH_USER` | `ubuntu` (unless a dedicated deployment user was configured) |
| Variable | `OCI_DEPLOY_ENABLED` | **Leave unset** until cutover; then `true` |

Verify the ED25519 host-key fingerprint out-of-band before storing the
`known_hosts` line. Do not disable `StrictHostKeyChecking`; the workflow checks it.

## 3. Test build, then cut over

1. Pushing to `deploy/production` runs the GitHub Actions **build** job.
   While `OCI_DEPLOY_ENABLED` is unset, the **deploy** job is skipped.
2. Verify the build job succeeds and the packaged runtime contains `dist/`,
   `dist-server/`, and production `node_modules/`.
3. With Render still running, verify the host configuration using an **isolated
   test DB only**; never test against the live writable production world.
4. Back up/verify Supabase world **and account/session tables**.
5. Stop the old Render server to eliminate concurrent writers. Confirm it has
   saved and fully stopped before any Oracle process uses the live DB URL.
6. Set `OCI_DEPLOY_ENABLED=true` in GitHub Actions variables. Push a reviewed
   commit to `deploy/production` to start the production deployment.
7. Verify the **GitHub Actions deployment** and the systemd journal on Oracle:

   ```bash
   sudo systemctl status siderarium --no-pager
   sudo journalctl -u siderarium -n 100 --no-pager
   curl -fsS http://127.0.0.1:8080/health
   free -h
   ```

   The application log must say `storage=postgres (...)` and `world restored`
   for an existing world. `health` alone does not confirm world persistence.

## 4. HTTPS/WSS and public access

The Node server listens on port 8080. Keep **8080 closed to the Internet**;
install Caddy and reverse-proxy a DNS name to `127.0.0.1:8080` using
`deploy/oci/Caddyfile.example`. Caddy handles TLS and WebSocket upgrades.

Set the DNS A record to the VM's public IP, allow only TCP **80/443** for the
website through OCI VCN ingress rules and the VM firewall, and keep SSH 22
restricted as practical. Confirm HTTPS, login cookies, and `wss://.../ws`
before redirecting any users from Render. A custom domain/DNS is not configured
by this repository change.

## 5. Frequent feature branches

This setup never auto-deploys from `codex/*` branches. Merge a **reviewed and
tested** feature branch into `deploy/production` (for example, with a GitHub PR
targeting `deploy/production`). The resulting push automatically builds and
deploys exactly the merge commit. The default branch is not changed.

## Operational notes

- Runtime logs: `sudo journalctl -u siderarium -f`
- Current release: `readlink -f /opt/siderarium/current`
- Release space: `du -sh /opt/siderarium/releases/*` and `df -h /`
- No old release is automatically deleted, to preserve recoverability.
- GitHub Secrets are not sent to the game process. The Supabase password stays
  in root-owned `/etc/siderarium/server.env` on the VM.
- Build verification only tests packaging and TypeScript. It does not replace
  staged PostgreSQL migration checks, live WebSocket checks, or memory monitoring.

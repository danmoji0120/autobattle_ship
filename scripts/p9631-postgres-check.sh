#!/usr/bin/env bash
# Disposable local-only database: these tests drop their tables. Never point them at an existing DB.
set -euo pipefail
task_docker=(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock)
task_password=$(openssl rand -hex 20)
task_name="siderarium-p9631-test-$$"
task_id=''
cleanup() { if [[ -n "$task_id" ]]; then "${task_docker[@]}" rm -f "$task_id" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
"${task_docker[@]}" info --format '{{.ServerVersion}}' >/dev/null
"${task_docker[@]}" image inspect postgres:16-alpine >/dev/null
printf '%s\n' 'Starting disposable PostgreSQL bound only to loopback.'
task_id=$("${task_docker[@]}" run -d --rm --name "$task_name" -p 127.0.0.1::5432 -e POSTGRES_USER=p9631_test -e POSTGRES_DB=p9631_test -e "POSTGRES_PASSWORD=$task_password" postgres:16-alpine)
task_port=$("${task_docker[@]}" port "$task_id" 5432/tcp)
if [[ ! "$task_port" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then echo 'Container is not bound exclusively to loopback' >&2; exit 1; fi
task_port=${BASH_REMATCH[1]}
task_ready=false
for _ in {1..30}; do
  if "${task_docker[@]}" exec "$task_id" pg_isready -U p9631_test -d p9631_test >/dev/null 2>&1; then task_ready=true; break; fi
  sleep 1
done
if [[ "$task_ready" != true ]]; then
  echo 'Disposable PostgreSQL did not become ready within 30 seconds.' >&2
  "${task_docker[@]}" logs --tail 20 "$task_id" >&2 || true
  exit 1
fi
printf '%s\n' 'Disposable PostgreSQL ready; running isolated tests.'
PG_TEST_URL="postgres://p9631_test:${task_password}@127.0.0.1:${task_port}/p9631_test" npx vitest run tests/pg-migrate.test.ts --maxWorkers=1 --reporter=verbose

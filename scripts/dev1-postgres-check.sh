#!/usr/bin/env bash
# Disposable local-only database; never use an existing server or inherited DATABASE_URL.
set -euo pipefail
task_docker=(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock)
task_password=$(openssl rand -hex 20)
task_name="siderarium-dev1-test-$$"
task_id=''
cleanup() { if [[ -n "$task_id" ]]; then "${task_docker[@]}" rm -f "$task_id" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
"${task_docker[@]}" info --format '{{.ServerVersion}}' >/dev/null
"${task_docker[@]}" image inspect postgres:16-alpine >/dev/null
printf '%s\n' 'Starting disposable PostgreSQL bound only to loopback.'
task_id=$("${task_docker[@]}" run -d --rm --name "$task_name" -p 127.0.0.1::5432 -e POSTGRES_USER=dev1_test -e POSTGRES_DB=siderarium_dev1_test -e "POSTGRES_PASSWORD=$task_password" postgres:16-alpine)
task_port=$("${task_docker[@]}" port "$task_id" 5432/tcp)
if [[ ! "$task_port" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then echo 'Container is not bound exclusively to loopback' >&2; exit 1; fi
task_port=${BASH_REMATCH[1]}
task_ready=false
for _ in {1..30}; do
  if "${task_docker[@]}" exec "$task_id" pg_isready -U dev1_test -d siderarium_dev1_test >/dev/null 2>&1; then task_ready=true; break; fi
  sleep 1
done
if [[ "$task_ready" != true ]]; then echo 'Disposable PostgreSQL did not become ready within 30 seconds.' >&2; exit 1; fi
printf '%s\n' 'Disposable PostgreSQL ready; running isolated tests.'
DEV1_DISPOSABLE_DB=1 DEV1_PG_TEST_URL="postgres://dev1_test:${task_password}@127.0.0.1:${task_port}/siderarium_dev1_test" npx vitest run tests/dev1-pg.test.ts --maxWorkers=1 --reporter=verbose

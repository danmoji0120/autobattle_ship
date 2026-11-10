#!/usr/bin/env bash
# Creates and deletes a loopback-only disposable database. Never use production credentials.
set -euo pipefail
task_docker=(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock)
task_password=$(openssl rand -hex 20)
task_name="siderarium-p982-test-$$"
task_id=''
cleanup() { if [[ -n "$task_id" ]]; then "${task_docker[@]}" rm -f "$task_id" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
"${task_docker[@]}" info --format '{{.ServerVersion}}' >/dev/null
"${task_docker[@]}" image inspect postgres:16-alpine >/dev/null
task_id=$("${task_docker[@]}" run -d --rm --name "$task_name" -p 127.0.0.1::5432 -e POSTGRES_USER=dev1_test -e POSTGRES_DB=siderarium_dev1_test -e "POSTGRES_PASSWORD=$task_password" postgres:16-alpine)
task_port=$("${task_docker[@]}" port "$task_id" 5432/tcp)
if [[ ! "$task_port" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then echo 'Container is not bound exclusively to loopback' >&2; exit 1; fi
task_port=${BASH_REMATCH[1]}
task_ready=false
for _ in {1..30}; do
  if "${task_docker[@]}" exec "$task_id" pg_isready -U dev1_test -d siderarium_dev1_test >/dev/null 2>&1; then task_ready=true; break; fi
  sleep 1
done
if [[ "$task_ready" != true ]]; then echo 'Disposable PostgreSQL did not become ready.' >&2; exit 1; fi
echo 'Running PostgreSQL migration, restart and DEV-1 authentication against separate disposable local databases.'
"${task_docker[@]}" exec "$task_id" createdb -U dev1_test p982_world_test
task_world_url="postgres://dev1_test:${task_password}@127.0.0.1:${task_port}/p982_world_test"
task_auth_url="postgres://dev1_test:${task_password}@127.0.0.1:${task_port}/siderarium_dev1_test"
PG_TEST_URL="$task_world_url" npx vitest run tests/pg-migrate.test.ts --maxWorkers=1 --reporter=verbose
DEV1_PG_TEST_URL="$task_auth_url" DEV1_DISPOSABLE_DB=1 npx vitest run tests/dev1-pg.test.ts --maxWorkers=1 --reporter=verbose

#!/usr/bin/env bash
# A fresh, password-protected, loopback-only, disposable database. The test suite drops tables;
# never point it at an existing or deployed database.
set -euo pipefail
task_docker=(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock)
task_password=$(openssl rand -hex 20)
task_name="siderarium-p96-test-$$"
task_id=''
cleanup() { if [[ -n "$task_id" ]]; then "${task_docker[@]}" rm -f "$task_id" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
"${task_docker[@]}" info --format '{{.ServerVersion}}' >/dev/null
"${task_docker[@]}" image inspect postgres:16-alpine >/dev/null
task_id=$("${task_docker[@]}" run -d --rm --name "$task_name" -p 127.0.0.1::5432 -e POSTGRES_USER=p96_test -e POSTGRES_DB=p96_test -e "POSTGRES_PASSWORD=$task_password" postgres:16-alpine)
task_port=$("${task_docker[@]}" port "$task_id" 5432/tcp)
if [[ ! "$task_port" =~ ^127\.0\.0\.1:([0-9]+)$ ]]; then echo 'Container is not bound exclusively to loopback' >&2; exit 1; fi
task_port=${BASH_REMATCH[1]}
for _ in {1..30}; do
  if "${task_docker[@]}" exec "$task_id" pg_isready -U p96_test -d p96_test >/dev/null 2>&1; then break; fi
  sleep 1
done
"${task_docker[@]}" exec "$task_id" pg_isready -U p96_test -d p96_test >/dev/null
PG_TEST_URL="postgres://p96_test:${task_password}@127.0.0.1:${task_port}/p96_test" npx vitest run tests/pg-migrate.test.ts --maxWorkers=1 --reporter=verbose

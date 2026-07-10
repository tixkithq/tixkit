#!/usr/bin/env bash
set -euo pipefail

container_name="${1:?Playwright container name is required}"
port="${2:?Playwright server port is required}"
playwright_version='1.61.1'
playwright_image='mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48'

if [[ ! "$container_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "Invalid Playwright container name: $container_name" >&2
  exit 2
fi
if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
  echo "Invalid Playwright server port: $port" >&2
  exit 2
fi

installed_version="$(bunx playwright --version)"
if [[ "$installed_version" != "Version $playwright_version" ]]; then
  echo "Installed Playwright version does not match the trusted container: $installed_version" >&2
  exit 1
fi

docker rm -f "$container_name" >/dev/null 2>&1 || true
docker run --detach --name "$container_name" --init \
  --add-host host.docker.internal:host-gateway \
  --publish "127.0.0.1:$port:$port" \
  "$playwright_image" \
  /bin/sh -lc "npx --yes playwright@$playwright_version run-server --host 0.0.0.0 --port $port"

for attempt in {1..60}; do
  if bash -c "</dev/tcp/127.0.0.1/$port" 2>/dev/null; then
    echo "Playwright server ready on port $port"
    exit 0
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null || true)" != 'true' ]]; then
    docker logs "$container_name" 2>/dev/null || true
    echo 'Playwright server container exited before becoming ready' >&2
    exit 1
  fi
  sleep 2
done

docker logs "$container_name" 2>/dev/null || true
echo 'Playwright server did not become ready before the timeout' >&2
exit 1

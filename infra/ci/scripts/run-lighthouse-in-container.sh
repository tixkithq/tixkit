#!/usr/bin/env bash
set -euo pipefail

container_name="${1:?Playwright container name is required}"
target_url="${2:?Lighthouse target URL is required}"

if [[ ! "$container_name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  echo "Invalid Playwright container name: $container_name" >&2
  exit 2
fi
if [[ ! "$target_url" =~ ^http://localhost:(3201|3202)/ ]]; then
  echo "Lighthouse container target must use the trusted checkout or admin loopback port" >&2
  exit 2
fi

docker exec --interactive "$container_name" /bin/bash -s -- "$target_url" <<'CONTAINER_SCRIPT'
set -euo pipefail

target_url="$1"
debug_port=9222
chrome_log="$(mktemp)"
chrome_pid=''

cleanup() {
  result=$?
  if [[ -n "$chrome_pid" ]]; then
    kill "$chrome_pid" >/dev/null 2>&1 || true
    wait "$chrome_pid" >/dev/null 2>&1 || true
  fi
  if ((result != 0)); then
    cat "$chrome_log" >&2 || true
  fi
  rm -f "$chrome_log"
  exit "$result"
}
trap cleanup EXIT

chrome_path="$(find /ms-playwright -type f -path '*/chrome-linux/chrome' -print -quit)"
if [[ -z "$chrome_path" ]]; then
  echo 'Pinned Playwright image does not contain Chromium' >&2
  exit 1
fi

"$chrome_path" \
  --headless=new \
  --no-sandbox \
  --disable-dev-shm-usage \
  '--host-resolver-rules=MAP localhost host.docker.internal' \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$debug_port" \
  about:blank >"$chrome_log" 2>&1 &
chrome_pid=$!

for attempt in {1..60}; do
  if curl --fail --silent "http://127.0.0.1:$debug_port/json/version" >/dev/null; then
    npx --yes lighthouse@12.8.2 "$target_url" \
      --quiet \
      --preset=desktop \
      --only-categories=performance \
      --output=json \
      --output-path=stdout \
      --port="$debug_port"
    exit 0
  fi
  if ! kill -0 "$chrome_pid" >/dev/null 2>&1; then
    echo 'Containerized Chromium exited before its debugging port became ready' >&2
    exit 1
  fi
  sleep 1
done

echo 'Containerized Chromium debugging port did not become ready' >&2
exit 1
CONTAINER_SCRIPT

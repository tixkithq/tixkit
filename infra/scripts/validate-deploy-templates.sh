#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'deploy template validation failed: %s\n' "$1" >&2
  exit 1
}

require_file() {
  local path="$1"
  test -f "${path}" || fail "missing ${path}"
}

require_file infra/fly/api.toml
require_file infra/render.yaml
require_file infra/helm/tixkit/values.yaml

expected_cors_origins='https://checkout.example.com,https://admin.example.com'

grep -Eq '^[[:space:]]*TRUST_PROXY[[:space:]]*=[[:space:]]*"1"[[:space:]]*$' infra/fly/api.toml ||
  fail 'infra/fly/api.toml must set API TRUST_PROXY to bounded hop count "1"'

grep -Eq '^[[:space:]]*CORS_ALLOWED_ORIGINS[[:space:]]*=[[:space:]]*"https://checkout\.example\.com,https://admin\.example\.com"[[:space:]]*$' infra/fly/api.toml ||
  fail "infra/fly/api.toml must set API CORS_ALLOWED_ORIGINS to ${expected_cors_origins}"

awk '
  function reset_service_state() {
    pending_trust_proxy_value = 0
    pending_cors_origins_value = 0
    pending_temporal_task_queue_value = 0
    trust_proxy_count = 0
    cors_origins_count = 0
    temporal_address_count = 0
    temporal_namespace_count = 0
    temporal_task_queue_count = 0
    bad_trust_proxy_value = 0
    bad_cors_origins_value = 0
    bad_temporal_task_queue_value = 0
  }
  function finish_service() {
    if (!in_api && !in_worker) {
      return
    }

    has_bad_temporal_config = temporal_address_count != 1 || temporal_namespace_count != 1 ||
      temporal_task_queue_count != 1 || bad_temporal_task_queue_value ||
      pending_temporal_task_queue_value
    has_bad_api_config = in_api && (trust_proxy_count != 1 || cors_origins_count != 1 ||
      bad_trust_proxy_value || bad_cors_origins_value ||
      pending_trust_proxy_value || pending_cors_origins_value)
    if (has_bad_api_config || has_bad_temporal_config) {
      exit 1
    }
  }
  /^  - type: / {
    finish_service()
    in_api = 0
    in_worker = 0
    reset_service_state()
  }
  /^    name: tixkit-api$/ {
    in_api = 1
    found_api = 1
    reset_service_state()
  }
  /^    name: tixkit-worker$/ {
    in_worker = 1
    found_worker = 1
    reset_service_state()
  }
  in_api && /^[[:space:]]*- key: TRUST_PROXY$/ {
    trust_proxy_count += 1
    pending_trust_proxy_value = 1
    next
  }
  in_api && pending_trust_proxy_value && /^[[:space:]]*value:/ {
    if ($0 !~ /^[[:space:]]*value:[[:space:]]*1[[:space:]]*$/) {
      bad_trust_proxy_value = 1
    }
    pending_trust_proxy_value = 0
    next
  }
  in_api && pending_trust_proxy_value && /^[[:space:]]*- key:/ {
    bad_trust_proxy_value = 1
    pending_trust_proxy_value = 0
  }
  in_api && /^[[:space:]]*- key: CORS_ALLOWED_ORIGINS$/ {
    cors_origins_count += 1
    pending_cors_origins_value = 1
    next
  }
  in_api && pending_cors_origins_value && /^[[:space:]]*value:/ {
    if ($0 !~ /^[[:space:]]*value:[[:space:]]*https:\/\/checkout\.example\.com,https:\/\/admin\.example\.com[[:space:]]*$/) {
      bad_cors_origins_value = 1
    }
    pending_cors_origins_value = 0
    next
  }
  in_api && pending_cors_origins_value && /^[[:space:]]*- key:/ {
    bad_cors_origins_value = 1
    pending_cors_origins_value = 0
  }
  (in_api || in_worker) && /^[[:space:]]*- key: TEMPORAL_ADDRESS$/ {
    temporal_address_count += 1
    next
  }
  (in_api || in_worker) && /^[[:space:]]*- key: TEMPORAL_NAMESPACE$/ {
    temporal_namespace_count += 1
    next
  }
  (in_api || in_worker) && /^[[:space:]]*- key: TEMPORAL_TASK_QUEUE$/ {
    temporal_task_queue_count += 1
    pending_temporal_task_queue_value = 1
    next
  }
  (in_api || in_worker) && pending_temporal_task_queue_value && /^[[:space:]]*value:/ {
    if ($0 !~ /^[[:space:]]*value:[[:space:]]*tixkit-production[[:space:]]*$/) {
      bad_temporal_task_queue_value = 1
    }
    pending_temporal_task_queue_value = 0
    next
  }
  (in_api || in_worker) && pending_temporal_task_queue_value && /^[[:space:]]*- key:/ {
    bad_temporal_task_queue_value = 1
    pending_temporal_task_queue_value = 0
  }
  END {
    finish_service()
    exit found_api && found_worker ? 0 : 1
  }
' infra/render.yaml ||
  fail "infra/render.yaml must set tixkit-api TRUST_PROXY=1, CORS_ALLOWED_ORIGINS=${expected_cors_origins}, and explicit TEMPORAL_ADDRESS/TEMPORAL_NAMESPACE/TEMPORAL_TASK_QUEUE=tixkit-production for tixkit-api and tixkit-worker"

grep -Eq "^[[:space:]]*trustProxy:[[:space:]]*'1'[[:space:]]*$" infra/helm/tixkit/values.yaml ||
  fail 'infra/helm/tixkit/values.yaml must set API trustProxy to bounded hop count 1'

awk '
  /^[[:space:]]*corsAllowedOrigins:$/ {
    in_cors = 1
    next
  }
  in_cors && /^[^[:space:]]/ {
    in_cors = 0
  }
  in_cors && /^[[:space:]]*-[[:space:]]*https:\/\/checkout\.example\.com[[:space:]]*$/ {
    checkout = 1
  }
  in_cors && /^[[:space:]]*-[[:space:]]*https:\/\/admin\.example\.com[[:space:]]*$/ {
    admin = 1
  }
  END {
    exit checkout && admin ? 0 : 1
  }
' infra/helm/tixkit/values.yaml ||
  fail "infra/helm/tixkit/values.yaml must include API CORS origins ${expected_cors_origins}"

if command -v helm >/dev/null 2>&1; then
  rendered_config="$(helm template tixkit infra/helm/tixkit --namespace tixkit --show-only templates/configmap.yaml)"
  printf '%s\n' "${rendered_config}" | grep -Eq '^[[:space:]]*TRUST_PROXY:[[:space:]]*"1"[[:space:]]*$' ||
    fail 'rendered Helm ConfigMap must set API TRUST_PROXY to bounded hop count 1'
  printf '%s\n' "${rendered_config}" | grep -Eq '^[[:space:]]*CORS_ALLOWED_ORIGINS:[[:space:]]*"https://checkout\.example\.com,https://admin\.example\.com"[[:space:]]*$' ||
    fail "rendered Helm ConfigMap must set API CORS_ALLOWED_ORIGINS to ${expected_cors_origins}"
else
  printf '%s\n' 'helm not found; skipped rendered Helm TRUST_PROXY validation' >&2
fi

printf '%s\n' 'Deploy template validation passed'

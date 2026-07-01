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

render_service_health_check_path() {
  local service_name="$1"

  awk -v service_name="${service_name}" '
    /^  - type: / {
      in_service = 0
    }
    $0 == "    name: " service_name {
      in_service = 1
      found_service = 1
      next
    }
    in_service && /^[[:space:]]*healthCheckPath:/ {
      sub(/^[[:space:]]*healthCheckPath:[[:space:]]*/, "")
      sub(/[[:space:]]*$/, "")
      print
      found_path = 1
      exit
    }
    END {
      exit found_service && found_path ? 0 : 1
    }
  ' infra/render.yaml
}

next_app_route_file_for_path() {
  local app_root="$1"
  local route_path="$2"

  route_path="${route_path%/}"
  if [[ -z "${route_path}" ]]; then
    route_path="/"
  fi
  if [[ ! "${route_path}" =~ ^/[A-Za-z0-9/_-]*$ ]]; then
    return 1
  fi

  local route_segments="${route_path#/}"
  if [[ -z "${route_segments}" ]]; then
    printf '%s/route.ts\n' "${app_root}"
    return 0
  fi

  printf '%s/%s/route.ts\n' "${app_root}" "${route_segments}"
}

expected_cors_origins='https://checkout.example.com,https://admin.example.com'
expected_render_api_origin='https://tixkit-api.onrender.com'
expected_render_checkout_api_base_url="${expected_render_api_origin}/v1"

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

awk -v checkout_api_base_url="${expected_render_checkout_api_base_url}" \
  -v admin_api_base_url="${expected_render_api_origin}" '
  function reset_service_state() {
    checkout_api_count = 0
    admin_api_count = 0
    pending_checkout_api = 0
    pending_admin_api = 0
    bad_checkout_api = 0
    bad_admin_api = 0
  }
  function finish_service() {
    if (in_checkout && (checkout_api_count != 1 || bad_checkout_api || pending_checkout_api)) {
      exit 1
    }
    if (in_admin && (admin_api_count != 1 || bad_admin_api || pending_admin_api)) {
      exit 1
    }
  }
  /^  - type: / {
    finish_service()
    in_checkout = 0
    in_admin = 0
    reset_service_state()
  }
  /^    name: tixkit-checkout$/ {
    in_checkout = 1
    found_checkout = 1
    reset_service_state()
  }
  /^    name: tixkit-admin$/ {
    in_admin = 1
    found_admin = 1
    reset_service_state()
  }
  in_checkout && /^[[:space:]]*- key: NEXT_PUBLIC_TIXKIT_API_BASE_URL$/ {
    checkout_api_count += 1
    pending_checkout_api = 1
    next
  }
  in_checkout && pending_checkout_api && /^[[:space:]]*value:/ {
    expected = "^[[:space:]]*value:[[:space:]]*" checkout_api_base_url "[[:space:]]*$"
    if ($0 !~ expected) {
      bad_checkout_api = 1
    }
    pending_checkout_api = 0
    next
  }
  in_checkout && pending_checkout_api && /^[[:space:]]*- key:/ {
    bad_checkout_api = 1
    pending_checkout_api = 0
  }
  in_admin && /^[[:space:]]*- key: NEXT_PUBLIC_ADMIN_API_BASE_URL$/ {
    admin_api_count += 1
    pending_admin_api = 1
    next
  }
  in_admin && pending_admin_api && /^[[:space:]]*value:/ {
    expected = "^[[:space:]]*value:[[:space:]]*" admin_api_base_url "[[:space:]]*$"
    if ($0 !~ expected) {
      bad_admin_api = 1
    }
    pending_admin_api = 0
    next
  }
  in_admin && pending_admin_api && /^[[:space:]]*- key:/ {
    bad_admin_api = 1
    pending_admin_api = 0
  }
  END {
    finish_service()
    exit found_checkout && found_admin ? 0 : 1
  }
' infra/render.yaml ||
  fail "infra/render.yaml must set tixkit-checkout NEXT_PUBLIC_TIXKIT_API_BASE_URL=${expected_render_checkout_api_base_url} and tixkit-admin NEXT_PUBLIC_ADMIN_API_BASE_URL=${expected_render_api_origin}"

checkout_health_path="$(render_service_health_check_path tixkit-checkout)" ||
  fail 'infra/render.yaml must set tixkit-checkout healthCheckPath'
test "${checkout_health_path}" = '/health' ||
  fail 'infra/render.yaml must set tixkit-checkout healthCheckPath to /health'
checkout_health_route="$(next_app_route_file_for_path apps/checkout/src/app "${checkout_health_path}")" ||
  fail "infra/render.yaml tixkit-checkout healthCheckPath ${checkout_health_path} must map to a static Next app route"
require_file "${checkout_health_route}"

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

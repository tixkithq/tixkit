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
  function finish_api() {
    if (!in_api) {
      return
    }

    has_bad_api_config = trust_proxy_count != 1 || cors_origins_count != 1 ||
      bad_trust_proxy_value || bad_cors_origins_value ||
      pending_trust_proxy_value || pending_cors_origins_value
    if (has_bad_api_config) {
      exit 1
    }
  }
  /^  - type: / {
    finish_api()
    in_api = 0
    pending_trust_proxy_value = 0
    pending_cors_origins_value = 0
    trust_proxy_count = 0
    cors_origins_count = 0
    bad_trust_proxy_value = 0
    bad_cors_origins_value = 0
  }
  /^    name: tixkit-api$/ {
    in_api = 1
    found_api = 1
    pending_trust_proxy_value = 0
    pending_cors_origins_value = 0
    trust_proxy_count = 0
    cors_origins_count = 0
    bad_trust_proxy_value = 0
    bad_cors_origins_value = 0
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
  END {
    finish_api()
    exit found_api ? 0 : 1
  }
' infra/render.yaml ||
  fail "infra/render.yaml must set exactly one tixkit-api TRUST_PROXY=1 and CORS_ALLOWED_ORIGINS=${expected_cors_origins}"

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

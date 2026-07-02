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
require_file infra/docker-compose.yml
require_file .github/workflows/release-dry-run.yml
require_file .github/workflows/trusted-release-dry-run.yml
require_file Dockerfile.api
require_file Dockerfile.worker
require_file Dockerfile.checkout
require_file Dockerfile.admin

require_workflow_step_order() {
  local workflow="$1"
  local before_step="$2"
  local after_step="$3"
  local failure_message="$4"

  awk -v before_step="${before_step}" -v after_step="${after_step}" '
    $0 ~ "^[[:space:]]*- run:[[:space:]]*" before_step "[[:space:]]*$" && before_line == 0 {
      before_line = NR
    }
    $0 ~ "^[[:space:]]*- run:[[:space:]]*" after_step "[[:space:]]*$" && after_line == 0 {
      after_line = NR
    }
    END {
      exit before_line > 0 && after_line > 0 && before_line < after_line ? 0 : 1
    }
  ' "${workflow}" || fail "${failure_message}"
}

require_workflow_step_order \
  .github/workflows/release-dry-run.yml \
  'bun run deploy:check' \
  'bun run iac:lint' \
  'public release dry-run workflow must run bun run deploy:check before bun run iac:lint'

require_workflow_step_order \
  .github/workflows/trusted-release-dry-run.yml \
  'bun run deploy:check' \
  'bun run iac:lint' \
  'trusted release dry-run workflow must run bun run deploy:check before bun run iac:lint'

validate_runtime_image_pins() {
  local dockerfile
  local latest_tag_pattern
  latest_tag_pattern='(^|[^[:alnum:]_.-]):lates''t([^[:alnum:]_.-]|$)'
  for dockerfile in Dockerfile.api Dockerfile.worker Dockerfile.checkout Dockerfile.admin; do
    awk '
      /^[[:space:]]*FROM[[:space:]]+/ && $0 !~ /@sha256:[0-9a-f]{64}/ {
        exit 1
      }
    ' "${dockerfile}" || fail "${dockerfile} must pin every FROM image with @sha256 digest"
  done

  if grep -REn "${latest_tag_pattern}" \
    Dockerfile.api Dockerfile.worker Dockerfile.checkout Dockerfile.admin \
    infra/helm/tixkit/values.yaml infra/docker-compose.yml infra/scripts >/dev/null; then
    fail 'runtime image references must not use mutable latest tags'
  fi

  if grep -REn 'minio/(minio|mc):[^[:space:]]+' \
    infra/helm/tixkit/values.yaml infra/docker-compose.yml infra/scripts |
    grep -v '@sha256:' >/dev/null; then
    fail 'MinIO server/client image references must include @sha256 digests'
  fi

  local helm_image_key
  for helm_image_key in postgres.image redis.image temporal.image temporal.postgresqlImage; do
    awk -v component="${helm_image_key%%.*}" -v key="${helm_image_key#*.}" '
      $0 == component ":" {
        in_component = 1
        next
      }
      in_component && /^[^[:space:]]/ {
        in_component = 0
      }
      in_component && $0 ~ "^[[:space:]]*" key ":[[:space:]]*" {
        value = $0
        sub("^[[:space:]]*" key ":[[:space:]]*", "", value)
        gsub(/^["'\'']|["'\'']$/, "", value)
        found = 1
        if (value !~ /@sha256:[0-9a-f]{64}$/) {
          bad = 1
        }
      }
      END {
        exit found && !bad ? 0 : 1
      }
    ' infra/helm/tixkit/values.yaml ||
      fail "infra/helm/tixkit/values.yaml must pin ${helm_image_key} with @sha256:<64 lowercase hex chars>"
  done

  if grep -Eq '^[[:space:]]*imageTag:' infra/helm/tixkit/values.yaml; then
    fail 'first-party Helm images must use per-component imageDigest values instead of global imageTag'
  fi

  local component
  for component in api worker checkout admin migrations; do
    awk -v component="${component}" '
      $0 == component ":" {
        in_component = 1
        next
      }
      in_component && /^[^[:space:]]/ {
        in_component = 0
      }
      in_component && /^[[:space:]]*imageDigest:[[:space:]]*sha256:[0-9a-f]{64}[[:space:]]*$/ {
        found = 1
      }
      END {
        exit found ? 0 : 1
      }
    ' infra/helm/tixkit/values.yaml ||
      fail "infra/helm/tixkit/values.yaml must set ${component}.imageDigest to sha256:<64 lowercase hex chars>"
  done
}

validate_runtime_image_pins

validate_frontend_public_api_build_config() {
  grep -Eq '^ARG NEXT_PUBLIC_TIXKIT_API_BASE_URL$' Dockerfile.checkout ||
    fail 'Dockerfile.checkout must declare NEXT_PUBLIC_TIXKIT_API_BASE_URL as a build arg'
  grep -Eq '^ENV NEXT_PUBLIC_TIXKIT_API_BASE_URL=\$\{NEXT_PUBLIC_TIXKIT_API_BASE_URL\}$' Dockerfile.checkout ||
    fail 'Dockerfile.checkout must export NEXT_PUBLIC_TIXKIT_API_BASE_URL before build'
  grep -Fq 'test -n "${NEXT_PUBLIC_TIXKIT_API_BASE_URL}"' Dockerfile.checkout ||
    fail 'Dockerfile.checkout must reject missing NEXT_PUBLIC_TIXKIT_API_BASE_URL before build'
  grep -Fq 'https://*) ;;' Dockerfile.checkout ||
    fail 'Dockerfile.checkout must require an HTTPS public API origin before build'
  grep -Fq 'http://localhost*|http://127.*|http://0.0.0.0*' Dockerfile.checkout ||
    fail 'Dockerfile.checkout must reject local public API origins before build'

  for variable in NEXT_PUBLIC_ADMIN_API_BASE_URL NEXT_PUBLIC_API_BASE_URL; do
    grep -Eq "^ARG ${variable}$" Dockerfile.admin ||
      fail "Dockerfile.admin must declare ${variable} as a build arg"
    grep -Eq "^ENV ${variable}=\\$\\{${variable}\\}$" Dockerfile.admin ||
      fail "Dockerfile.admin must export ${variable} before build"
    grep -Fq "test -n \"\${${variable}}\"" Dockerfile.admin ||
      fail "Dockerfile.admin must reject missing ${variable} before build"
  done
  grep -Fq 'https://*) ;;' Dockerfile.admin ||
    fail 'Dockerfile.admin must require HTTPS public API origins before build'
  grep -Fq 'http://localhost*|http://127.*|http://0.0.0.0*' Dockerfile.admin ||
    fail 'Dockerfile.admin must reject local public API origins before build'

  awk '
    /^\[build\.args\]$/ {
      in_build_args = 1
      in_env = 0
      next
    }
    /^\[env\]$/ {
      in_build_args = 0
      in_env = 1
      next
    }
    /^\[/ {
      in_build_args = 0
      in_env = 0
    }
    in_build_args && /^NEXT_PUBLIC_TIXKIT_API_BASE_URL = "https:\/\/api\.example\.com\/v1"$/ {
      build_arg = 1
    }
    in_env && /^NEXT_PUBLIC_TIXKIT_API_BASE_URL = "https:\/\/api\.example\.com\/v1"$/ {
      runtime_env = 1
    }
    END {
      exit build_arg && runtime_env ? 0 : 1
    }
  ' infra/fly/checkout.toml ||
    fail 'infra/fly/checkout.toml must pass NEXT_PUBLIC_TIXKIT_API_BASE_URL as both a build arg and runtime env'

  awk '
    /^\[build\.args\]$/ {
      in_build_args = 1
      in_env = 0
      next
    }
    /^\[env\]$/ {
      in_build_args = 0
      in_env = 1
      next
    }
    /^\[/ {
      in_build_args = 0
      in_env = 0
    }
    in_build_args && /^NEXT_PUBLIC_ADMIN_API_BASE_URL = "https:\/\/api\.example\.com"$/ {
      admin_build_arg = 1
    }
    in_build_args && /^NEXT_PUBLIC_API_BASE_URL = "https:\/\/api\.example\.com\/v1"$/ {
      api_build_arg = 1
    }
    in_env && /^NEXT_PUBLIC_ADMIN_API_BASE_URL = "https:\/\/api\.example\.com"$/ {
      admin_runtime_env = 1
    }
    in_env && /^NEXT_PUBLIC_API_BASE_URL = "https:\/\/api\.example\.com\/v1"$/ {
      api_runtime_env = 1
    }
    END {
      exit admin_build_arg && api_build_arg && admin_runtime_env && api_runtime_env ? 0 : 1
    }
  ' infra/fly/admin.toml ||
    fail 'infra/fly/admin.toml must pass admin public API origins as build args and runtime env'
}

validate_frontend_public_api_build_config

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

require_helm_frontend_probe_values() {
  local component="$1"
  local expected_path="$2"

  awk -v component="${component}" -v expected_path="${expected_path}" '
    $0 == component ":" {
      in_component = 1
      next
    }
    in_component && /^[^[:space:]]/ {
      in_component = 0
    }
    in_component && /^[[:space:]]*readiness:$/ {
      in_readiness = 1
      in_liveness = 0
      readiness_section = 1
      next
    }
    in_component && /^[[:space:]]*liveness:$/ {
      in_readiness = 0
      in_liveness = 1
      liveness_section = 1
      next
    }
    in_component && (in_readiness || in_liveness) && /^[[:space:]]*path:/ {
      value = $0
      sub(/^[[:space:]]*path:[[:space:]]*/, "", value)
      sub(/[[:space:]]*$/, "", value)
      gsub(/^'\''|'\''$/, "", value)
      gsub(/^"|"$/, "", value)
      if (in_readiness && value == expected_path) {
        readiness_path = 1
      }
      if (in_liveness && value == expected_path) {
        liveness_path = 1
      }
      next
    }
    in_component && (in_readiness || in_liveness) && /^[[:space:]]*initialDelaySeconds:[[:space:]]*[0-9]+[[:space:]]*$/ {
      initial_delay_count += 1
      next
    }
    in_component && (in_readiness || in_liveness) && /^[[:space:]]*periodSeconds:[[:space:]]*[0-9]+[[:space:]]*$/ {
      period_count += 1
      next
    }
    in_component && (in_readiness || in_liveness) && /^[[:space:]]*timeoutSeconds:[[:space:]]*[0-9]+[[:space:]]*$/ {
      timeout_count += 1
      next
    }
    in_component && (in_readiness || in_liveness) && /^[[:space:]]*failureThreshold:[[:space:]]*[0-9]+[[:space:]]*$/ {
      failure_count += 1
      next
    }
    END {
      exit readiness_section && liveness_section && readiness_path && liveness_path &&
        initial_delay_count == 2 && period_count == 2 && timeout_count == 2 && failure_count == 2 ? 0 : 1
    }
  ' infra/helm/tixkit/values.yaml ||
    fail "infra/helm/tixkit/values.yaml must configure ${component} readiness/liveness probes for ${expected_path}"
}

require_rendered_frontend_probes() {
  local rendered_chart="$1"
  local component="$2"
  local expected_path="$3"

  printf '%s\n' "${rendered_chart}" | awk -v component="${component}" -v expected_path="${expected_path}" '
    /^[[:space:]]*app.kubernetes.io\/component:[[:space:]]*/ {
      if ($2 == component) {
        seen_component = 1
      }
    }
    seen_component && /^[[:space:]]*containers:[[:space:]]*$/ {
      in_target = 1
      next
    }
    in_target && /^[[:space:]]*readinessProbe:[[:space:]]*$/ {
      in_readiness = 1
      in_liveness = 0
      readiness = 1
      next
    }
    in_target && /^[[:space:]]*livenessProbe:[[:space:]]*$/ {
      in_readiness = 0
      in_liveness = 1
      liveness = 1
      next
    }
    in_target && /^[[:space:]]*path:[[:space:]]*/ {
      value = $0
      sub(/^[[:space:]]*path:[[:space:]]*/, "", value)
      gsub(/^"|"$/, "", value)
      if (in_readiness && value == expected_path) {
        readiness_path = 1
      }
      if (in_liveness && value == expected_path) {
        liveness_path = 1
      }
      next
    }
    in_target && /^[[:space:]]*port:[[:space:]]*http[[:space:]]*$/ {
      if (in_readiness) {
        readiness_port = 1
      }
      if (in_liveness) {
        liveness_port = 1
      }
      next
    }
    in_target && /^---$/ {
      exit readiness && liveness && readiness_path && liveness_path && readiness_port && liveness_port ? 0 : 1
    }
    END {
      exit readiness && liveness && readiness_path && liveness_path && readiness_port && liveness_port ? 0 : 1
    }
  ' ||
    fail "rendered Helm ${component} deployment must include readinessProbe and livenessProbe on ${expected_path}"
}

require_rendered_component_image_digest() {
  local rendered_chart="$1"
  local component="$2"
  local expected_ref_pattern="$3"

  printf '%s\n' "${rendered_chart}" | awk -v component="${component}" -v expected_ref_pattern="${expected_ref_pattern}" '
    /^[[:space:]]*app.kubernetes.io\/component:[[:space:]]*/ {
      in_component = $2 == component
      next
    }
    in_component && /^[[:space:]]*image:[[:space:]]*/ {
      value = $0
      sub(/^[[:space:]]*image:[[:space:]]*/, "", value)
      gsub(/^"|"$/, "", value)
      found = 1
      if (value !~ expected_ref_pattern || value !~ /@sha256:[0-9a-f]{64}$/) {
        bad = 1
      }
    }
    END {
      exit found && !bad ? 0 : 1
    }
  ' ||
    fail "rendered Helm ${component} image must match ${expected_ref_pattern} and include @sha256:<64 lowercase hex chars>"
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

awk '
  function reset_service_state() {
    in_api = 0
    in_worker = 0
    in_redis = 0
    service_type = ""
    database_url_count = 0
    redis_url_count = 0
    pending_database_from_database = 0
    pending_database_name = 0
    pending_database_property = 0
    pending_redis_from_service = 0
    pending_redis_type = 0
    pending_redis_name = 0
    pending_redis_property = 0
    redis_has_ip_allow_list = 0
  }
  function fail_pending_datastore_refs() {
    if (pending_database_from_database || pending_database_name || pending_database_property ||
      pending_redis_from_service || pending_redis_type || pending_redis_name || pending_redis_property) {
      bad_datastore_refs = 1
    }
    pending_database_from_database = 0
    pending_database_name = 0
    pending_database_property = 0
    pending_redis_from_service = 0
    pending_redis_type = 0
    pending_redis_name = 0
    pending_redis_property = 0
  }
  function finish_service() {
    fail_pending_datastore_refs()
    if ((in_api || in_worker) && (database_url_count != 1 || redis_url_count != 1)) {
      bad_datastore_refs = 1
    }
    if (in_redis && (service_type != "keyvalue" || !redis_has_ip_allow_list)) {
      bad_redis_service = 1
    }
  }
  BEGIN {
    reset_service_state()
  }
  /^databases:$/ {
    in_databases = 1
    next
  }
  /^[^[:space:]]/ {
    in_databases = 0
  }
  in_databases && /^  - name: tixkit-redis$/ {
    bad_redis_database = 1
  }
  /^  - type: / {
    finish_service()
    reset_service_state()
    service_type = $3
    next
  }
  /^    name: tixkit-api$/ {
    in_api = 1
    next
  }
  /^    name: tixkit-worker$/ {
    in_worker = 1
    next
  }
  /^    name: tixkit-redis$/ {
    in_redis = 1
    found_redis_service = 1
    next
  }
  in_redis && /^[[:space:]]*ipAllowList:[[:space:]]*\[\][[:space:]]*$/ {
    redis_has_ip_allow_list = 1
    next
  }
  (in_api || in_worker) && /^[[:space:]]*- key: DATABASE_URL$/ {
    fail_pending_datastore_refs()
    database_url_count += 1
    pending_database_from_database = 1
    next
  }
  (in_api || in_worker) && pending_database_from_database && /^[[:space:]]*fromDatabase:[[:space:]]*$/ {
    pending_database_from_database = 0
    pending_database_name = 1
    next
  }
  (in_api || in_worker) && pending_database_name && /^[[:space:]]*name:[[:space:]]*postgres[[:space:]]*$/ {
    pending_database_name = 0
    pending_database_property = 1
    next
  }
  (in_api || in_worker) && pending_database_property && /^[[:space:]]*property:[[:space:]]*connectionString[[:space:]]*$/ {
    pending_database_property = 0
    next
  }
  (in_api || in_worker) && /^[[:space:]]*- key: REDIS_URL$/ {
    fail_pending_datastore_refs()
    redis_url_count += 1
    pending_redis_from_service = 1
    next
  }
  (in_api || in_worker) && pending_redis_from_service && /^[[:space:]]*fromService:[[:space:]]*$/ {
    pending_redis_from_service = 0
    pending_redis_type = 1
    next
  }
  (in_api || in_worker) && pending_redis_type && /^[[:space:]]*type:[[:space:]]*keyvalue[[:space:]]*$/ {
    pending_redis_type = 0
    pending_redis_name = 1
    next
  }
  (in_api || in_worker) && pending_redis_name && /^[[:space:]]*name:[[:space:]]*tixkit-redis[[:space:]]*$/ {
    pending_redis_name = 0
    pending_redis_property = 1
    next
  }
  (in_api || in_worker) && pending_redis_property && /^[[:space:]]*property:[[:space:]]*connectionString[[:space:]]*$/ {
    pending_redis_property = 0
    next
  }
  END {
    finish_service()
    exit !bad_datastore_refs && !bad_redis_service && !bad_redis_database && found_redis_service ? 0 : 1
  }
' infra/render.yaml ||
  fail 'infra/render.yaml must use object-form Render datastore refs and declare tixkit-redis as a keyvalue service with ipAllowList'

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

admin_health_path="$(render_service_health_check_path tixkit-admin)" ||
  fail 'infra/render.yaml must set tixkit-admin healthCheckPath'
test "${admin_health_path}" = '/health' ||
  fail 'infra/render.yaml must set tixkit-admin healthCheckPath to /health'
admin_health_route="$(next_app_route_file_for_path apps/admin-dashboard/src/app "${admin_health_path}")" ||
  fail "infra/render.yaml tixkit-admin healthCheckPath ${admin_health_path} must map to a static Next app route"
test "${admin_health_route}" = 'apps/admin-dashboard/src/app/health/route.ts' ||
  fail 'infra/render.yaml tixkit-admin healthCheckPath must map to apps/admin-dashboard/src/app/health/route.ts'
require_file "${admin_health_route}"

grep -Eq "^[[:space:]]*trustProxy:[[:space:]]*'1'[[:space:]]*$" infra/helm/tixkit/values.yaml ||
  fail 'infra/helm/tixkit/values.yaml must set API trustProxy to bounded hop count 1'
grep -Eq '^[[:space:]]*temporalTaskQueue:[[:space:]]*tixkit-production[[:space:]]*$' infra/helm/tixkit/values.yaml ||
  fail 'infra/helm/tixkit/values.yaml must set secrets.temporalTaskQueue to tixkit-production'
grep -Eq '^[[:space:]]*TEMPORAL_TASK_QUEUE:[[:space:]]*\{\{[[:space:]]*\.Values\.secrets\.temporalTaskQueue[[:space:]]*\|[[:space:]]*quote[[:space:]]*\}\}[[:space:]]*$' infra/helm/tixkit/templates/configmap.yaml ||
  fail 'infra/helm/tixkit/templates/configmap.yaml must render TEMPORAL_TASK_QUEUE from secrets.temporalTaskQueue'

require_helm_frontend_probe_values checkout /health
require_helm_frontend_probe_values admin /health

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
  rendered_chart="$(helm template tixkit infra/helm/tixkit --namespace tixkit)"
  first_party_images="$(printf '%s\n' "${rendered_chart}" | awk '
    /^[[:space:]]*image:[[:space:]]*ghcr\.io\/your-org\/tixkit\// {
      sub(/^[[:space:]]*image:[[:space:]]*/, "")
      gsub(/^"|"$/, "")
      print
    }
  ')"
  first_party_image_count="$(printf '%s\n' "${first_party_images}" | awk 'NF { count += 1 } END { print count + 0 }')"
  test "${first_party_image_count}" = '5' ||
    fail "rendered Helm chart must include five first-party images, found ${first_party_image_count}"
  printf '%s\n' "${first_party_images}" | awk '
    NF && $0 !~ /^ghcr\.io\/your-org\/tixkit\/(api|worker|checkout|admin-dashboard|db-migrate)@sha256:[0-9a-f]{64}$/ {
      exit 1
    }
  ' ||
    fail 'rendered Helm first-party image references must use ghcr.io/your-org/tixkit/<image>@sha256:<digest>'
  for component in api worker checkout admin-dashboard db-migrate; do
    printf '%s\n' "${first_party_images}" | grep -Eq "^ghcr\\.io/your-org/tixkit/${component}@sha256:[0-9a-f]{64}$" ||
      fail "rendered Helm chart must include digest-addressed first-party image ${component}"
  done
  require_rendered_component_image_digest "${rendered_chart}" postgres '^postgres:16-alpine@sha256:[0-9a-f]{64}$'
  require_rendered_component_image_digest "${rendered_chart}" redis '^redis:7-alpine@sha256:[0-9a-f]{64}$'
  require_rendered_component_image_digest "${rendered_chart}" temporal-postgres '^postgres:16-alpine@sha256:[0-9a-f]{64}$'
  require_rendered_component_image_digest "${rendered_chart}" temporal '^temporalio/auto-setup:1\.24@sha256:[0-9a-f]{64}$'
  require_rendered_frontend_probes "${rendered_chart}" checkout /health
  require_rendered_frontend_probes "${rendered_chart}" admin /health

  rendered_config="$(helm template tixkit infra/helm/tixkit --namespace tixkit --show-only templates/configmap.yaml)"
  printf '%s\n' "${rendered_config}" | grep -Eq '^[[:space:]]*TRUST_PROXY:[[:space:]]*"1"[[:space:]]*$' ||
    fail 'rendered Helm ConfigMap must set API TRUST_PROXY to bounded hop count 1'
  printf '%s\n' "${rendered_config}" | grep -Eq '^[[:space:]]*CORS_ALLOWED_ORIGINS:[[:space:]]*"https://checkout\.example\.com,https://admin\.example\.com"[[:space:]]*$' ||
    fail "rendered Helm ConfigMap must set API CORS_ALLOWED_ORIGINS to ${expected_cors_origins}"
  printf '%s\n' "${rendered_config}" | grep -Eq '^[[:space:]]*TEMPORAL_TASK_QUEUE:[[:space:]]*"tixkit-production"[[:space:]]*$' ||
    fail 'rendered Helm ConfigMap must set TEMPORAL_TASK_QUEUE to tixkit-production'
else
  printf '%s\n' 'helm not found; skipped rendered Helm TRUST_PROXY validation' >&2
fi

printf '%s\n' 'Deploy template validation passed'

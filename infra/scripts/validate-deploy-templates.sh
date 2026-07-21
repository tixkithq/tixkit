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
require_file infra/helm/tixkit/values-evaluation.yaml
require_file infra/helm/tixkit/values-production.yaml
require_file infra/scripts/run-helm-migration.sh
require_file infra/docker-compose.yml
require_file .github/workflows/release-dry-run.yml
require_file .github/workflows/trusted-release-dry-run.yml
require_file .github/workflows/public-artifact-release.yml
require_file .github/workflows/production-dr.yml
require_file scripts/create-hosted-production-dr-receipt.mjs
require_file scripts/prepare-production-dr-workflow.mjs
require_file scripts/stage-production-dr-bundle.mjs
require_file Dockerfile.api
require_file Dockerfile.worker
require_file Dockerfile.checkout
require_file Dockerfile.admin
require_file .dockerignore

reject_placeholder_production_origins() {
  if grep -REn '(^|[^[:alnum:]_-])([[:alnum:].-]+\.)?example\.com([^[:alnum:]_-]|$)' \
    infra/fly infra/render.yaml infra/helm/tixkit/values.yaml infra/helm/tixkit/templates >/dev/null; then
    fail 'production deploy descriptors must not contain example.com placeholder origins'
  fi
}

reject_placeholder_production_origins

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

validate_runtime_image_context() {
  local required_ignore
  for required_ignore in .git '.env.*' node_modules graphify-out '**/__tests__'; do
    grep -Fxq "${required_ignore}" .dockerignore ||
      fail ".dockerignore must exclude ${required_ignore} from production build contexts"
  done

  local dockerfile
  for dockerfile in Dockerfile.api Dockerfile.worker Dockerfile.checkout Dockerfile.admin; do
    awk '
      /^[[:space:]]*FROM[[:space:]]+/ {
        stage += 1
      }
      stage > 1 && /^[[:space:]]*COPY[[:space:]]+(\.([[:space:]]+|$)|--[^[:space:]]+[[:space:]]+\.([[:space:]]+|$))/ {
        exit 1
      }
    ' "${dockerfile}" || fail "${dockerfile} final runtime stage must not copy the full repository"

    grep -Eq '^[[:space:]]*FROM[[:space:]].+[[:space:]]+AS[[:space:]]+runtime[[:space:]]*$' "${dockerfile}" ||
      fail "${dockerfile} must define an explicit runtime stage"
  done
}

validate_runtime_image_context

validate_frontend_public_api_build_config() {
  local expected_fly_api_origin='https://tixkit-api.fly.dev'

  for dockerfile in Dockerfile.checkout Dockerfile.admin; do
    if grep -Eq '^(ARG|ENV)[[:space:]]+NEXT_PUBLIC_' "${dockerfile}"; then
      fail "${dockerfile} must remain deployment-neutral and must not bake NEXT_PUBLIC_* configuration"
    fi
    if grep -Fq 'ALLOW_INSECURE_LOCAL_ORIGINS' "${dockerfile}"; then
      fail "${dockerfile} must not accept a deployment-origin build escape"
    fi
  done

  if grep -Eq '^(ARG|ENV)[[:space:]]+NEXT_PUBLIC_' Dockerfile.admin; then
    fail 'Dockerfile.admin must remain deployment-neutral and must not bake NEXT_PUBLIC_* configuration'
  fi
  if grep -Fq 'ALLOW_INSECURE_LOCAL_ORIGINS' Dockerfile.admin; then
    fail 'Dockerfile.admin must not accept a deployment-origin build escape'
  fi
  if grep -Eq '^(ARG|ENV)[[:space:]]+TIXKIT_BUILD_REVISION' Dockerfile.admin; then
    fail 'Dockerfile.admin revision identity must be supplied at runtime from immutable release metadata'
  fi
  grep -Fq 'docker build --file "$DOCKERFILE" --tag "${repository}:${candidate}" .' .github/workflows/public-artifact-release.yml ||
    fail 'public artifact release must build the generic admin image without deployment-specific build arguments'
  if grep -Eq 'docker build[^[:space:]]*.*--build-arg' .github/workflows/public-artifact-release.yml; then
    fail 'public artifact release must not pass deployment-specific Docker build arguments'
  fi

  if grep -Eq '^\[build\.args\]$|NEXT_PUBLIC_' infra/fly/checkout.toml; then
    fail 'infra/fly/checkout.toml must use the generic checkout image without build args or NEXT_PUBLIC configuration'
  fi
  for assignment in \
    'TIXKIT_DEPLOYMENT_PROFILE = "production"' \
    "API_BASE_URL = \"${expected_fly_api_origin}\"" \
    'TIXKIT_CHECKOUT_URL = "https://tixkit-checkout.fly.dev"' \
    'ALLOW_INSECURE_LOCAL_ORIGINS = "0"'; do
    grep -Fqx "${assignment}" infra/fly/checkout.toml ||
      fail "infra/fly/checkout.toml must set ${assignment}"
  done
  grep -Fq 'STRIPE_PUBLISHABLE_KEY="$STRIPE_PUBLISHABLE_KEY"' infra/fly/checkout.toml ||
    fail 'infra/fly/checkout.toml must document the required Stripe publishable key secret'
  grep -Fq 'path = "/ready"' infra/fly/checkout.toml ||
    fail 'infra/fly/checkout.toml must gate traffic on checkout runtime readiness'

  if grep -Eq '^\[build\.args\]$|NEXT_PUBLIC_' infra/fly/admin.toml; then
    fail 'infra/fly/admin.toml must use the generic admin image without legacy build or NEXT_PUBLIC configuration'
  fi
  for assignment in \
    'TIXKIT_DEPLOYMENT_PROFILE = "production"' \
    "API_BASE_URL = \"${expected_fly_api_origin}\"" \
    'TIXKIT_CHECKOUT_URL = "https://tixkit-checkout.fly.dev"' \
    'TIXKIT_DOCS_URL = "https://docs.tixkit.com"' \
    'AUTH_PROVIDER = "clerk"' \
    'ALLOW_INSECURE_LOCAL_ORIGINS = "0"'; do
    grep -Fqx "${assignment}" infra/fly/admin.toml ||
      fail "infra/fly/admin.toml must set ${assignment}"
  done
  grep -Fq 'TIXKIT_BUILD_REVISION must be the selected admin image'"'"'s source commit or release tag.' infra/fly/admin.toml ||
    fail 'infra/fly/admin.toml must bind TIXKIT_BUILD_REVISION to the selected immutable admin artifact'
  grep -Fq 'fly secrets set CLERK_PUBLISHABLE_KEY="$CLERK_PUBLISHABLE_KEY" CLERK_SECRET_KEY="$CLERK_SECRET_KEY" S3_PUBLIC_ENDPOINT="$S3_PUBLIC_ENDPOINT" TIXKIT_BUILD_REVISION="$TIXKIT_BUILD_REVISION"' infra/fly/admin.toml ||
    fail 'infra/fly/admin.toml must explicitly require operator-supplied Clerk, upload-origin, and build-revision runtime values'
  if grep -Eq '^(CLERK_PUBLISHABLE_KEY|CLERK_SECRET_KEY|S3_PUBLIC_ENDPOINT|TIXKIT_BUILD_REVISION)[[:space:]]*=' infra/fly/admin.toml; then
    fail 'infra/fly/admin.toml must not commit operator-specific Clerk, upload-origin, or build-revision values'
  fi
  grep -Fq 'fly secrets set S3_PUBLIC_ENDPOINT="$S3_PUBLIC_ENDPOINT"' infra/fly/api.toml ||
    fail 'infra/fly/api.toml and infra/fly/admin.toml must consume the same operator S3_PUBLIC_ENDPOINT value'
  awk '
    /^\[\[http_service\.checks\]\]$/ { in_check = 1; next }
    /^\[/ { in_check = 0 }
    in_check && $0 == "method = \"GET\"" { method = 1 }
    in_check && $0 == "path = \"/ready\"" { path = 1 }
    END { exit method && path ? 0 : 1 }
  ' infra/fly/admin.toml ||
    fail 'infra/fly/admin.toml must gate traffic on GET /ready runtime configuration readiness'
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

require_render_service_env_key() {
  local service_name="$1"
  local env_key="$2"

  awk -v service_name="${service_name}" -v env_key="${env_key}" '
    /^  - type: / {
      in_service = 0
    }
    $0 == "    name: " service_name {
      in_service = 1
      found_service = 1
      next
    }
    in_service && $0 == "      - key: " env_key {
      found_key = 1
      exit
    }
    END {
      exit found_service && found_key ? 0 : 1
    }
  ' infra/render.yaml ||
    fail "infra/render.yaml service ${service_name} must declare ${env_key}"
}

require_render_service_env_value() {
  local service_name="$1"
  local env_key="$2"
  local expected_value="$3"

  awk -v service_name="${service_name}" -v env_key="${env_key}" -v expected_value="${expected_value}" '
    /^  - type: / {
      in_service = 0
      pending_key = 0
    }
    $0 == "    name: " service_name {
      in_service = 1
      found_service = 1
      pending_key = 0
      next
    }
    in_service && $0 == "      - key: " env_key {
      found_key = 1
      pending_key = 1
      next
    }
    in_service && pending_key && /^[[:space:]]*value:/ {
      value = $0
      sub(/^[[:space:]]*value:[[:space:]]*/, "", value)
      sub(/[[:space:]]*$/, "", value)
      if (value == expected_value) {
        found_value = 1
      }
      pending_key = 0
      exit
    }
    in_service && pending_key && /^[[:space:]]*- key:/ {
      pending_key = 0
      exit
    }
    END {
      exit found_service && found_key && found_value ? 0 : 1
    }
  ' infra/render.yaml ||
    fail "infra/render.yaml service ${service_name} must set ${env_key}=${expected_value}"
}

require_render_service_env_sync_false() {
  local service_name="$1"
  local env_key="$2"

  awk -v service_name="${service_name}" -v env_key="${env_key}" '
    /^  - type: / {
      in_service = 0
      pending_key = 0
    }
    $0 == "    name: " service_name {
      in_service = 1
      found_service = 1
      next
    }
    in_service && $0 == "      - key: " env_key {
      key_count += 1
      pending_key = 1
      next
    }
    in_service && pending_key && /^[[:space:]]*sync:[[:space:]]*false[[:space:]]*$/ {
      sync_false_count += 1
      pending_key = 0
      next
    }
    in_service && pending_key && /^[[:space:]]*(value:|- key:)/ {
      bad_value = 1
      pending_key = 0
      next
    }
    END {
      exit found_service && key_count == 1 && sync_false_count == 1 && !bad_value && !pending_key ? 0 : 1
    }
  ' infra/render.yaml ||
    fail "infra/render.yaml service ${service_name} must declare operator-supplied ${env_key} with sync: false"
}

require_render_service_env_group() {
  local service_name="$1"
  local group_name="$2"

  awk -v service_name="${service_name}" -v group_name="${group_name}" '
    /^  - type: / { in_service = 0 }
    $0 == "    name: " service_name { in_service = 1; found_service = 1; next }
    in_service && $0 == "      - fromGroup: " group_name { group_count += 1 }
    END { exit found_service && group_count == 1 ? 0 : 1 }
  ' infra/render.yaml ||
    fail "infra/render.yaml service ${service_name} must consume shared env group ${group_name} exactly once"
}

validate_render_public_storage_group() {
  awk '
    /^envVarGroups:$/ { in_groups = 1; next }
    in_groups && /^  - name: tixkit-public-storage$/ { in_target = 1; group_count += 1; next }
    in_groups && /^  - name:/ { in_target = 0 }
    in_target && /^    envVars: \[\]$/ { empty_inventory = 1; next }
    in_target && /^[[:space:]]+- key:/ { embedded_key = 1 }
    END { exit group_count == 1 && empty_inventory && !embedded_key ? 0 : 1 }
  ' infra/render.yaml ||
    fail 'infra/render.yaml must preserve an operator-managed, shared tixkit-public-storage env group without embedded values'
  grep -Fq '# group in the Render Dashboard. Blueprint groups cannot use sync: false.' infra/render.yaml ||
    fail 'infra/render.yaml must explain how to supply the shared S3_PUBLIC_ENDPOINT without an invalid Blueprint sync:false group key'
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
  local expected_readiness_path="$2"
  local expected_liveness_path="${3:-$2}"

  awk -v component="${component}" -v expected_readiness_path="${expected_readiness_path}" -v expected_liveness_path="${expected_liveness_path}" '
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
      if (in_readiness && value == expected_readiness_path) {
        readiness_path = 1
      }
      if (in_liveness && value == expected_liveness_path) {
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
    fail "infra/helm/tixkit/values.yaml must configure ${component} readiness=${expected_readiness_path} and liveness=${expected_liveness_path}"
}

require_rendered_frontend_probes() {
  local rendered_chart="$1"
  local component="$2"
  local expected_readiness_path="$3"
  local expected_liveness_path="${4:-$3}"

  printf '%s\n' "${rendered_chart}" | awk -v component="${component}" -v expected_readiness_path="${expected_readiness_path}" -v expected_liveness_path="${expected_liveness_path}" '
    /^---$/ {
      seen_component = 0
      in_target = 0
      in_readiness = 0
      in_liveness = 0
      next
    }
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
      if (in_readiness && value == expected_readiness_path) {
        readiness_path = 1
      }
      if (in_liveness && value == expected_liveness_path) {
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
    fail "rendered Helm ${component} deployment must include readinessProbe=${expected_readiness_path} and livenessProbe=${expected_liveness_path}"
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

expected_fly_cors_origins='https://tixkit-checkout.fly.dev,https://tixkit-admin.fly.dev'
expected_render_api_origin='https://tixkit-api.onrender.com'
expected_render_checkout_origin='https://tixkit-checkout.onrender.com'
expected_render_admin_origin='https://tixkit-admin.onrender.com'
expected_render_cors_origins="${expected_render_checkout_origin},${expected_render_admin_origin}"
expected_render_checkout_api_base_url="${expected_render_api_origin}/v1"
expected_helm_api_origin='https://api.tixkit.com'
expected_helm_checkout_origin='https://checkout.tixkit.com'
expected_helm_admin_origin='https://admin.tixkit.com'
expected_helm_docs_origin='https://docs.tixkit.com'
expected_helm_upload_origin='https://uploads.tixkit.com'
expected_helm_cors_origins="${expected_helm_checkout_origin},${expected_helm_admin_origin}"

compact_internal_api_count="$(grep -Fc 'INTERNAL_API_BASE_URL: http://api:4000' infra/compact/compose.yml)"
test "${compact_internal_api_count}" = '2' ||
  fail 'Compact checkout and admin must each use the in-network API origin'
if grep -Fq 'INTERNAL_API_BASE_URL' infra/fly/admin.toml; then
  fail 'Fly admin must fall back to its validated public HTTPS API origin'
fi
if grep -Fq 'INTERNAL_API_BASE_URL' infra/render.yaml; then
  fail 'Render frontends must fall back to their validated public HTTPS API origin'
fi

for render_api_required_env in \
  AUTH_PROVIDER \
  API_BASE_URL \
  METRICS_BEARER_TOKEN \
  STRIPE_SECRET_KEY \
  STRIPE_WEBHOOK_SECRET \
  S3_ENDPOINT \
  S3_BUCKET \
  S3_ACCESS_KEY_ID \
  S3_SECRET_ACCESS_KEY \
  S3_REGION \
  CLERK_SECRET_KEY \
  CLERK_PUBLISHABLE_KEY \
  CLERK_WEBHOOK_SECRET; do
  require_render_service_env_key tixkit-api "${render_api_required_env}"
done
require_render_service_env_value tixkit-api AUTH_PROVIDER clerk
require_render_service_env_value tixkit-api API_BASE_URL "${expected_render_api_origin}"
require_render_service_env_value tixkit-api CUSTOM_DOMAIN_CORS_ENABLED true
require_render_service_env_key tixkit-checkout STRIPE_PUBLISHABLE_KEY

grep -Eq '^[[:space:]]*TRUST_PROXY[[:space:]]*=[[:space:]]*"1"[[:space:]]*$' infra/fly/api.toml ||
  fail 'infra/fly/api.toml must set API TRUST_PROXY to bounded hop count "1"'

grep -Fq "CORS_ALLOWED_ORIGINS = \"${expected_fly_cors_origins}\"" infra/fly/api.toml ||
  fail "infra/fly/api.toml must set API CORS_ALLOWED_ORIGINS to ${expected_fly_cors_origins}"

grep -Eq '^[[:space:]]*CUSTOM_DOMAIN_CORS_ENABLED[[:space:]]*=[[:space:]]*"true"[[:space:]]*$' infra/fly/api.toml ||
  fail 'infra/fly/api.toml must enable API CUSTOM_DOMAIN_CORS_ENABLED'

awk -v expected_cors_origins="${expected_render_cors_origins}" '
  function reset_service_state() {
    pending_trust_proxy_value = 0
    pending_cors_origins_value = 0
    pending_custom_domain_cors_value = 0
    pending_temporal_task_queue_value = 0
    trust_proxy_count = 0
    cors_origins_count = 0
    custom_domain_cors_count = 0
    temporal_address_count = 0
    temporal_namespace_count = 0
    temporal_task_queue_count = 0
    bad_trust_proxy_value = 0
    bad_cors_origins_value = 0
    bad_custom_domain_cors_value = 0
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
      custom_domain_cors_count != 1 || bad_trust_proxy_value || bad_cors_origins_value ||
      bad_custom_domain_cors_value || pending_trust_proxy_value || pending_cors_origins_value ||
      pending_custom_domain_cors_value)
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
    value = $0
    sub(/^[[:space:]]*value:[[:space:]]*/, "", value)
    sub(/[[:space:]]*$/, "", value)
    if (value != expected_cors_origins) {
      bad_cors_origins_value = 1
    }
    pending_cors_origins_value = 0
    next
  }
  in_api && pending_cors_origins_value && /^[[:space:]]*- key:/ {
    bad_cors_origins_value = 1
    pending_cors_origins_value = 0
  }
  in_api && /^[[:space:]]*- key: CUSTOM_DOMAIN_CORS_ENABLED$/ {
    custom_domain_cors_count += 1
    pending_custom_domain_cors_value = 1
    next
  }
  in_api && pending_custom_domain_cors_value && /^[[:space:]]*value:/ {
    if ($0 !~ /^[[:space:]]*value:[[:space:]]*true[[:space:]]*$/) {
      bad_custom_domain_cors_value = 1
    }
    pending_custom_domain_cors_value = 0
    next
  }
  in_api && pending_custom_domain_cors_value && /^[[:space:]]*- key:/ {
    bad_custom_domain_cors_value = 1
    pending_custom_domain_cors_value = 0
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
  fail "infra/render.yaml must set tixkit-api TRUST_PROXY=1, CORS_ALLOWED_ORIGINS=${expected_render_cors_origins}, CUSTOM_DOMAIN_CORS_ENABLED=true, and explicit TEMPORAL_ADDRESS/TEMPORAL_NAMESPACE/TEMPORAL_TASK_QUEUE=tixkit-production for tixkit-api and tixkit-worker"

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

require_render_service_env_value tixkit-checkout TIXKIT_DEPLOYMENT_PROFILE production
require_render_service_env_value tixkit-checkout API_BASE_URL "${expected_render_api_origin}"
require_render_service_env_value tixkit-checkout TIXKIT_CHECKOUT_URL "${expected_render_checkout_origin}"
require_render_service_env_value tixkit-checkout ALLOW_INSECURE_LOCAL_ORIGINS 0
for operator_value in STRIPE_PUBLISHABLE_KEY TIXKIT_BUILD_REVISION; do
  require_render_service_env_sync_false tixkit-checkout "${operator_value}"
done
require_render_service_env_value tixkit-admin TIXKIT_DEPLOYMENT_PROFILE production
require_render_service_env_value tixkit-admin API_BASE_URL "${expected_render_api_origin}"
require_render_service_env_value tixkit-admin TIXKIT_CHECKOUT_URL "${expected_render_checkout_origin}"
require_render_service_env_value tixkit-admin TIXKIT_DOCS_URL https://docs.tixkit.com
require_render_service_env_value tixkit-admin AUTH_PROVIDER clerk
require_render_service_env_value tixkit-admin ALLOW_INSECURE_LOCAL_ORIGINS 0
for operator_value in CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY TIXKIT_BUILD_REVISION; do
  require_render_service_env_sync_false tixkit-admin "${operator_value}"
done
validate_render_public_storage_group
require_render_service_env_group tixkit-api tixkit-public-storage
require_render_service_env_group tixkit-checkout tixkit-public-storage
require_render_service_env_group tixkit-admin tixkit-public-storage
grep -Fq '# Set to the exact deployed Git commit or immutable release tag.' infra/render.yaml ||
  fail 'infra/render.yaml must bind TIXKIT_BUILD_REVISION to the selected immutable source or release'

if awk '
  /^  - type: / { in_checkout = 0 }
  /^    name: tixkit-checkout$/ { in_checkout = 1; next }
  in_checkout && /NEXT_PUBLIC_/ { found = 1 }
  END { exit found ? 0 : 1 }
' infra/render.yaml; then
  fail 'infra/render.yaml tixkit-checkout must not declare legacy NEXT_PUBLIC_* runtime values'
fi

if awk '
  /^  - type: / { in_admin = 0 }
  /^    name: tixkit-admin$/ { in_admin = 1; next }
  in_admin && /NEXT_PUBLIC_/ { found = 1 }
  END { exit found ? 0 : 1 }
' infra/render.yaml; then
  fail 'infra/render.yaml tixkit-admin must not declare legacy NEXT_PUBLIC_* runtime values'
fi

checkout_health_path="$(render_service_health_check_path tixkit-checkout)" ||
  fail 'infra/render.yaml must set tixkit-checkout healthCheckPath'
test "${checkout_health_path}" = '/ready' ||
  fail 'infra/render.yaml must set tixkit-checkout healthCheckPath to /ready'
checkout_health_route="$(next_app_route_file_for_path apps/checkout/src/app "${checkout_health_path}")" ||
  fail "infra/render.yaml tixkit-checkout healthCheckPath ${checkout_health_path} must map to a static Next app route"
require_file "${checkout_health_route}"

admin_health_path="$(render_service_health_check_path tixkit-admin)" ||
  fail 'infra/render.yaml must set tixkit-admin healthCheckPath'
test "${admin_health_path}" = '/ready' ||
  fail 'infra/render.yaml must set tixkit-admin healthCheckPath to /ready'
admin_health_route="$(next_app_route_file_for_path apps/admin-dashboard/src/app "${admin_health_path}")" ||
  fail "infra/render.yaml tixkit-admin healthCheckPath ${admin_health_path} must map to a static Next app route"
test "${admin_health_route}" = 'apps/admin-dashboard/src/app/ready/route.ts' ||
  fail 'infra/render.yaml tixkit-admin healthCheckPath must map to apps/admin-dashboard/src/app/ready/route.ts'
require_file "${admin_health_route}"

grep -Eq "^[[:space:]]*trustProxy:[[:space:]]*'1'[[:space:]]*$" infra/helm/tixkit/values.yaml ||
  fail 'infra/helm/tixkit/values.yaml must set API trustProxy to bounded hop count 1'
grep -Eq '^[[:space:]]*temporalTaskQueue:[[:space:]]*tixkit-production[[:space:]]*$' infra/helm/tixkit/values.yaml ||
  fail 'infra/helm/tixkit/values.yaml must set secrets.temporalTaskQueue to tixkit-production'
grep -Eq '^[[:space:]]*TEMPORAL_TASK_QUEUE:[[:space:]]*\{\{[[:space:]]*\.Values\.secrets\.temporalTaskQueue[[:space:]]*\|[[:space:]]*quote[[:space:]]*\}\}[[:space:]]*$' infra/helm/tixkit/templates/configmap.yaml ||
  fail 'infra/helm/tixkit/templates/configmap.yaml must render TEMPORAL_TASK_QUEUE from secrets.temporalTaskQueue'

require_helm_frontend_probe_values checkout /ready /health
require_helm_frontend_probe_values admin /ready /health

awk -v api_origin="${expected_helm_api_origin}" \
  -v checkout_origin="${expected_helm_checkout_origin}" \
  -v admin_origin="${expected_helm_admin_origin}" '
  function strip(value) {
    sub(/^[[:space:]]*/, "", value)
    sub(/[[:space:]]*$/, "", value)
    gsub(/^["'\'']|["'\'']$/, "", value)
    return value
  }
  $0 == "global:" {
    in_global = 1
    next
  }
  in_global && /^[^[:space:]]/ {
    in_global = 0
  }
  in_global && /^[[:space:]]*apiBaseUrl:/ {
    value = $0
    sub(/^[[:space:]]*apiBaseUrl:[[:space:]]*/, "", value)
    if (strip(value) == api_origin) {
      api_base = 1
    }
    next
  }
  in_global && /^[[:space:]]*checkoutUrl:/ {
    value = $0
    sub(/^[[:space:]]*checkoutUrl:[[:space:]]*/, "", value)
    if (strip(value) == checkout_origin) {
      checkout_url = 1
    }
    next
  }
  in_global && /^[[:space:]]*adminUrl:/ {
    value = $0
    sub(/^[[:space:]]*adminUrl:[[:space:]]*/, "", value)
    if (strip(value) == admin_origin) {
      admin_url = 1
    }
    next
  }
  in_global && /^[[:space:]]*customDomainCorsEnabled:/ {
    value = $0
    sub(/^[[:space:]]*customDomainCorsEnabled:[[:space:]]*/, "", value)
    if (strip(value) == "true") {
      custom_domain_cors = 1
    }
    next
  }
  in_global && /^[[:space:]]*corsAllowedOrigins:$/ {
    in_cors = 1
    next
  }
  in_cors && /^[^[:space:]]/ {
    in_cors = 0
  }
  in_cors && /^[[:space:]]*-[[:space:]]*/ {
    value = $0
    sub(/^[[:space:]]*-[[:space:]]*/, "", value)
    value = strip(value)
    if (value == checkout_origin) {
      checkout_cors = 1
    }
    if (value == admin_origin) {
      admin_cors = 1
    }
  }
  $0 == "ingress:" {
    in_ingress = 1
    next
  }
  in_ingress && /^[^[:space:]]/ {
    in_ingress = 0
  }
  in_ingress && /^[[:space:]]*apiHost:/ {
    value = $0
    sub(/^[[:space:]]*apiHost:[[:space:]]*/, "", value)
    if (strip(value) == "api.tixkit.com") {
      api_host = 1
    }
    next
  }
  in_ingress && /^[[:space:]]*checkoutHost:/ {
    value = $0
    sub(/^[[:space:]]*checkoutHost:[[:space:]]*/, "", value)
    if (strip(value) == "checkout.tixkit.com") {
      checkout_host = 1
    }
    next
  }
  in_ingress && /^[[:space:]]*adminHost:/ {
    value = $0
    sub(/^[[:space:]]*adminHost:[[:space:]]*/, "", value)
    if (strip(value) == "admin.tixkit.com") {
      admin_host = 1
    }
    next
  }
  END {
    exit api_base && checkout_url && admin_url && checkout_cors && admin_cors &&
      custom_domain_cors && api_host && checkout_host && admin_host ? 0 : 1
  }
' infra/helm/tixkit/values.yaml ||
  fail "infra/helm/tixkit/values.yaml must set production API/admin/checkout origins, CORS origins to ${expected_helm_cors_origins}, and customDomainCorsEnabled=true"

grep -Fq "docsUrl: ${expected_helm_docs_origin}" infra/helm/tixkit/values.yaml ||
  fail "infra/helm/tixkit/values.yaml must set the public docs origin to ${expected_helm_docs_origin}"
grep -Fq "s3PublicEndpoint: ${expected_helm_upload_origin}" infra/helm/tixkit/values.yaml ||
  fail "infra/helm/tixkit/values.yaml must set the public upload origin to ${expected_helm_upload_origin}"

command -v helm >/dev/null 2>&1 || fail 'helm is required for deployment template validation'
helm lint infra/helm/tixkit -f infra/helm/tixkit/values-evaluation.yaml >/dev/null
helm template tixkit infra/helm/tixkit \
  -f infra/helm/tixkit/values-production.yaml \
  --set global.imageRegistry=ghcr.io/tixkit/tixkit \
  --set secrets.name=tixkit-production-secrets \
  --set api.imageDigest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --set worker.imageDigest=sha256:123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0 \
  --set checkout.imageDigest=sha256:23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01 \
  --set admin.imageDigest=sha256:3456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef012 \
  --set global.buildRevision=release-2026.08.10 \
  --set migrations.imageDigest=sha256:456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123 \
  --set uploads.malwareScanner.host=clamav.production.svc.cluster.local \
  --set 'networkPolicy.externalEgressCidrs[0]=192.0.2.0/24' \
  --set 'networkPolicy.externalEgressCidrs[1]=2001:db8::/32' \
  --set 'networkPolicy.databaseEgressCidrs[0]=198.51.100.0/24' >/dev/null
bun test scripts/__tests__/helm-production-profile.test.mjs

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
  require_rendered_frontend_probes "${rendered_chart}" checkout /ready /health
  require_rendered_frontend_probes "${rendered_chart}" admin /ready /health

  rendered_frontend_internal_api_count="$(
    helm template tixkit infra/helm/tixkit --namespace tixkit --show-only templates/apps.yaml |
      grep -c 'name: INTERNAL_API_BASE_URL'
  )"
  test "${rendered_frontend_internal_api_count}" = '2' ||
    fail 'rendered Helm checkout and admin must each receive INTERNAL_API_BASE_URL'

  rendered_config="$(helm template tixkit infra/helm/tixkit --namespace tixkit --show-only templates/configmap.yaml)"
  printf '%s\n' "${rendered_config}" | grep -Eq '^[[:space:]]*TRUST_PROXY:[[:space:]]*"1"[[:space:]]*$' ||
    fail 'rendered Helm ConfigMap must set API TRUST_PROXY to bounded hop count 1'
  printf '%s\n' "${rendered_config}" | grep -Fq "API_BASE_URL: \"${expected_helm_api_origin}\"" ||
    fail "rendered Helm ConfigMap must set API_BASE_URL to ${expected_helm_api_origin}"
  printf '%s\n' "${rendered_config}" | grep -Fq "TIXKIT_CHECKOUT_URL: \"${expected_helm_checkout_origin}\"" ||
    fail "rendered Helm ConfigMap must set TIXKIT_CHECKOUT_URL to ${expected_helm_checkout_origin}"
  printf '%s\n' "${rendered_config}" | grep -Fq "TIXKIT_DOCS_URL: \"${expected_helm_docs_origin}\"" ||
    fail "rendered Helm ConfigMap must set TIXKIT_DOCS_URL to ${expected_helm_docs_origin}"
  printf '%s\n' "${rendered_config}" | grep -Fq "S3_PUBLIC_ENDPOINT: \"${expected_helm_upload_origin}\"" ||
    fail "rendered Helm ConfigMap must set S3_PUBLIC_ENDPOINT to ${expected_helm_upload_origin}"
  printf '%s\n' "${rendered_config}" | grep -Fq 'ALLOW_INSECURE_LOCAL_ORIGINS: "0"' ||
    fail 'rendered Helm ConfigMap must disable insecure local origins'
  printf '%s\n' "${rendered_config}" | grep -Fq "CORS_ALLOWED_ORIGINS: \"${expected_helm_cors_origins}\"" ||
    fail "rendered Helm ConfigMap must set API CORS_ALLOWED_ORIGINS to ${expected_helm_cors_origins}"
  printf '%s\n' "${rendered_config}" | grep -Fq 'CUSTOM_DOMAIN_CORS_ENABLED: "true"' ||
    fail 'rendered Helm ConfigMap must enable CUSTOM_DOMAIN_CORS_ENABLED'
  printf '%s\n' "${rendered_config}" | grep -Eq '^[[:space:]]*INTERNAL_API_BASE_URL:[[:space:]]*"http://tixkit-tixkit-api:4000"[[:space:]]*$' ||
    fail 'rendered Helm ConfigMap must provide the in-cluster frontend API transport origin'
  if printf '%s\n' "${rendered_config}" | grep -Fq 'NEXT_PUBLIC_'; then
    fail 'rendered Helm ConfigMap must not carry legacy frontend build-time configuration'
  fi
  printf '%s\n' "${rendered_config}" | grep -Eq '^[[:space:]]*TEMPORAL_TASK_QUEUE:[[:space:]]*"tixkit-production"[[:space:]]*$' ||
    fail 'rendered Helm ConfigMap must set TEMPORAL_TASK_QUEUE to tixkit-production'
fi

printf '%s\n' 'Deploy template validation passed'

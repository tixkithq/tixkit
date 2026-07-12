#!/usr/bin/env bash
set -euo pipefail

release="${RELEASE_NAME:-tixkit}"
namespace="${NAMESPACE:-tixkit}"
chart="${CHART_DIR:-infra/helm/tixkit}"
values="${VALUES_FILE:?VALUES_FILE must reference the operator-reviewed production values file}"
secret_name="${SECRET_NAME:?SECRET_NAME must name the reconciled runtime Secret}"
timeout="${MIGRATION_TIMEOUT:-15m}"
default_invocation="$(printf '%s-%03d' "$(date -u +%y%m%d%H%M%S)" "$(( $$ % 1000 ))")"
invocation="${MIGRATION_INVOCATION:-${default_invocation}}"
helm_bin="${HELM:-helm}"
kubectl_bin="${KUBECTL:-kubectl}"
if command -v sha256sum >/dev/null 2>&1; then
  release_hash="$(printf '%s' "${release}" | sha256sum | awk '{ print substr($1, 1, 8) }')"
else
  release_hash="$(printf '%s' "${release}" | shasum -a 256 | awk '{ print substr($1, 1, 8) }')"
fi
lock_suffix="${release_hash}-migration-lock"
lock_prefix="${release:0:$((62 - ${#lock_suffix}))}"
lock_name="${lock_prefix}-${lock_suffix}"

command -v "${helm_bin}" >/dev/null || { printf 'helm is required\n' >&2; exit 1; }
command -v "${kubectl_bin}" >/dev/null || { printf 'kubectl is required\n' >&2; exit 1; }
"${kubectl_bin}" --namespace "${namespace}" get secret "${secret_name}" >/dev/null

if ! "${kubectl_bin}" --namespace "${namespace}" create configmap "${lock_name}" \
  --from-literal="invocation=${invocation}" >/dev/null; then
  printf 'another migration owns lock %s/%s\n' "${namespace}" "${lock_name}" >&2
  exit 1
fi
release_lock() {
  "${kubectl_bin}" --namespace "${namespace}" delete configmap "${lock_name}" --ignore-not-found >/dev/null 2>&1 || true
}
trap release_lock EXIT INT TERM

external_secret_render="$("${helm_bin}" template "${release}" "${chart}" \
  --namespace "${namespace}" \
  --values "${values}" \
  --set secrets.name="${secret_name}" \
  --set migrations.strategy=manual \
  --show-only templates/external-secret.yaml)"
required_keys=()
while IFS= read -r key; do
  required_keys+=("${key}")
done < <(printf '%s\n' "${external_secret_render}" | awk '/secretKey:/ { sub(/^.*secretKey:[[:space:]]*/, ""); print }')
(( ${#required_keys[@]} > 0 )) || {
  printf 'production values did not render an ExternalSecret key inventory\n' >&2
  exit 1
}

for key in "${required_keys[@]}"; do
  test -n "$("${kubectl_bin}" --namespace "${namespace}" get secret "${secret_name}" -o "jsonpath={.data.${key}}")" || {
    printf 'runtime Secret %s is missing %s\n' "${secret_name}" "${key}" >&2
    exit 1
  }
done

migration_policy="$("${helm_bin}" template "${release}" "${chart}" \
  --namespace "${namespace}" \
  --values "${values}" \
  --set secrets.mode=existing \
  --set secrets.name="${secret_name}" \
  --set migrations.strategy=manual \
  --show-only templates/migration-network-policy.yaml |
  "${kubectl_bin}" --namespace "${namespace}" apply -f - -o name)"
policy_resources=()
while IFS= read -r resource; do
  [[ -n "${resource}" ]] && policy_resources+=("${resource}")
done <<<"${migration_policy}"
(( ${#policy_resources[@]} == 1 )) &&
  [[ "${policy_resources[0]}" == networkpolicy.networking.k8s.io/* || "${policy_resources[0]}" == networkpolicy/* ]] || {
  printf 'migration setup did not apply exactly one NetworkPolicy: %s\n' "${migration_policy}" >&2
  exit 1
}

resource_name="$("${helm_bin}" template "${release}" "${chart}" \
  --namespace "${namespace}" \
  --values "${values}" \
  --set secrets.mode=existing \
  --set secrets.name="${secret_name}" \
  --set migrations.strategy=manual \
  --set migrations.execution=manual-run \
  --set migrations.invocation="${invocation}" \
  --show-only templates/migrations.yaml |
  "${kubectl_bin}" --namespace "${namespace}" create -f - -o name)"
resources=()
while IFS= read -r resource; do
  [[ -n "${resource}" ]] && resources+=("${resource}")
done <<<"${resource_name}"
(( ${#resources[@]} == 1 )) && [[ "${resources[0]}" == job.batch/* || "${resources[0]}" == job/* ]] || {
  printf 'migration render did not create exactly one Job: %s\n' "${resource_name}" >&2
  exit 1
}
resource_name="${resources[0]}"

if ! "${kubectl_bin}" --namespace "${namespace}" wait --for=condition=complete "${resource_name}" --timeout="${timeout}"; then
  "${kubectl_bin}" --namespace "${namespace}" logs "${resource_name}" --all-containers=true >&2 || true
  exit 1
fi
"${kubectl_bin}" --namespace "${namespace}" logs "${resource_name}" --all-containers=true

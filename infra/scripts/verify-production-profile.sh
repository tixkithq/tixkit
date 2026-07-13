#!/usr/bin/env bash
set -euo pipefail

umask 077

namespace="${NAMESPACE:-tixkit}"
release="${RELEASE_NAME:-tixkit}"
expected_context="${EXPECTED_KUBE_CONTEXT:?EXPECTED_KUBE_CONTEXT must name the reviewed production-like cluster context}"
drill_id="${DRILL_ID:?DRILL_ID must identify this evidence run}"
evidence_dir="${EVIDENCE_DIR:?EVIDENCE_DIR must be an operator-owned evidence directory}"
timeout="${ROLLOUT_TIMEOUT:-10m}"
replacement_timeout_seconds="${REPLACEMENT_TIMEOUT_SECONDS:-600}"
replacement_poll_seconds="${REPLACEMENT_POLL_SECONDS:-2}"
kubectl_bin="${KUBECTL:-kubectl}"
disruption_ack="${PRODUCTION_DISRUPTION_ACK:-}"

[[ "${drill_id}" =~ ^[a-z0-9]([-a-z0-9]{0,62})$ ]] || {
  printf 'DRILL_ID must be lowercase DNS-safe and at most 63 characters\n' >&2
  exit 1
}
[[ "${disruption_ack}" == "" || "${disruption_ack}" == "evict-one-pod-per-component" ]] || {
  printf 'PRODUCTION_DISRUPTION_ACK is invalid\n' >&2
  exit 1
}
[[ "${replacement_timeout_seconds}" =~ ^[1-9][0-9]{0,3}$ ]] || {
  printf 'REPLACEMENT_TIMEOUT_SECONDS must be an integer between 1 and 9999\n' >&2
  exit 1
}
[[ "${replacement_poll_seconds}" =~ ^(0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*(\.[0-9]+)?)$ ]] || {
  printf 'REPLACEMENT_POLL_SECONDS must be positive\n' >&2
  exit 1
}

command -v "${kubectl_bin}" >/dev/null || { printf 'kubectl is required\n' >&2; exit 1; }
command -v jq >/dev/null || { printf 'jq is required\n' >&2; exit 1; }
current_context="$("${kubectl_bin}" config current-context)"
[[ "${current_context}" == "${expected_context}" ]] || {
  printf 'refusing cluster drill: current context %s does not match EXPECTED_KUBE_CONTEXT %s\n' \
    "${current_context}" "${expected_context}" >&2
  exit 1
}
"${kubectl_bin}" --context "${expected_context}" get namespace "${namespace}" >/dev/null

mkdir -p "${evidence_dir}"
[[ ! -L "${evidence_dir}" && -d "${evidence_dir}" ]] || {
  printf 'EVIDENCE_DIR must be a real directory, not a symlink\n' >&2
  exit 1
}
evidence_file="${evidence_dir%/}/${drill_id}.json"
[[ ! -L "${evidence_file}" ]] || {
  printf 'refusing symlink evidence path %s\n' "${evidence_file}" >&2
  exit 1
}
set -o noclobber
if ! { exec 9>"${evidence_file}"; } 2>/dev/null; then
  printf 'refusing to overwrite evidence %s\n' "${evidence_file}" >&2
  exit 1
fi

selector="app.kubernetes.io/instance=${release}"
components=(api worker checkout admin)

deployment_for_component() {
  local component="$1"
  "${kubectl_bin}" --context "${expected_context}" --namespace "${namespace}" get deployments \
    --selector "${selector},app.kubernetes.io/component=${component}" -o json
}

assert_component_ready() {
  local component="$1"
  local deployment_json="$2"
  jq -e --arg component "${component}" '
    (.items | length) == 1 and
    (.items[0].spec.replicas >= 2) and
    ((.items[0].status.availableReplicas // 0) == .items[0].spec.replicas) and
    ((.items[0].status.readyReplicas // 0) == .items[0].spec.replicas) and
    ((.items[0].status.updatedReplicas // 0) == .items[0].spec.replicas) and
    ((.items[0].status.unavailableReplicas // 0) == 0) and
    ((.items[0].status.observedGeneration // 0) >= .items[0].metadata.generation) and
    (.items[0].spec.strategy.type == "RollingUpdate") and
    ((.items[0].spec.strategy.rollingUpdate.maxUnavailable == 0) or
      (.items[0].spec.strategy.rollingUpdate.maxUnavailable == "0")) and
    (((.items[0].spec.strategy.rollingUpdate.maxSurge | tonumber) // 0) >= 1) and
    ((.items[0].spec.minReadySeconds // 0) >= 1) and
    ((.items[0].spec.progressDeadlineSeconds // 0) >= 60) and
    (.items[0].spec.template.spec.containers | length) == 1 and
    (.items[0].spec.template.spec.containers[0].image |
      test("@sha256:[a-f0-9]{64}$"))
  ' >/dev/null <<<"${deployment_json}" || {
    printf 'production deployment invariant failed for %s\n' "${component}" >&2
    exit 1
  }
}

before='[]'
for component in "${components[@]}"; do
  deployment_json="$(deployment_for_component "${component}")"
  assert_component_ready "${component}" "${deployment_json}"
  deployment_name="$(jq -r '.items[0].metadata.name' <<<"${deployment_json}")"
  pdb_json="$("${kubectl_bin}" --context "${expected_context}" --namespace "${namespace}" get poddisruptionbudgets \
    --selector "${selector},app.kubernetes.io/component=${component}" -o json)"
  jq -e '
    (.items | length) == 1 and
    ((.items[0].spec.minAvailable | tonumber) >= 1) and
    ((.items[0].status.currentHealthy // 0) >= (.items[0].spec.minAvailable | tonumber))
  ' >/dev/null <<<"${pdb_json}" || {
    printf 'production disruption-budget invariant failed for %s\n' "${component}" >&2
    exit 1
  }
  if [[ "${disruption_ack}" == "evict-one-pod-per-component" ]]; then
    jq -e '(.items[0].status.disruptionsAllowed // 0) >= 1' >/dev/null <<<"${pdb_json}" || {
      printf 'production disruption budget currently forbids a %s pod eviction\n' "${component}" >&2
      exit 1
    }
  fi
  row="$(jq -n \
    --arg component "${component}" \
    --arg deployment "${deployment_name}" \
    --arg image "$(jq -r '.items[0].spec.template.spec.containers[0].image' <<<"${deployment_json}")" \
    --argjson replicas "$(jq '.items[0].spec.replicas' <<<"${deployment_json}")" \
    --argjson ready "$(jq '.items[0].status.availableReplicas' <<<"${deployment_json}")" \
    '{component: $component, deployment: $deployment, image: $image, replicas: $replicas, readyReplicas: $ready}')"
  before="$(jq --argjson row "${row}" '. + [$row]' <<<"${before}")"
done

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
disruptions='[]'
if [[ "${disruption_ack}" == "evict-one-pod-per-component" ]]; then
  for component in "${components[@]}"; do
    deployment_json="$(deployment_for_component "${component}")"
    deployment_name="$(jq -r '.items[0].metadata.name' <<<"${deployment_json}")"
    pod_json="$("${kubectl_bin}" --context "${expected_context}" --namespace "${namespace}" get pods \
      --selector "${selector},app.kubernetes.io/component=${component}" -o json)"
    old_pod="$(jq -c '
      [.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))]
      | sort_by(.metadata.name) | .[0] // null
    ' <<<"${pod_json}")"
    old_pod_name="$(jq -r '.metadata.name // empty' <<<"${old_pod}")"
    old_pod_uid="$(jq -r '.metadata.uid // empty' <<<"${old_pod}")"
    old_pod_uids="$(jq -c '[.items[].metadata.uid]' <<<"${pod_json}")"
    [[ -n "${old_pod_name}" && -n "${old_pod_uid}" ]] || {
      printf 'no %s pod is available for the disruption drill\n' "${component}" >&2
      exit 1
    }
    evicted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '%s\n' \
      'apiVersion: policy/v1' \
      'kind: Eviction' \
      'metadata:' \
      "  name: ${old_pod_name}" \
      "  namespace: ${namespace}" |
      "${kubectl_bin}" --context "${expected_context}" --namespace "${namespace}" create -f - >/dev/null

    replacement='null'
    replacement_deadline="$(( $(date +%s) + replacement_timeout_seconds ))"
    while (( $(date +%s) <= replacement_deadline )); do
      pod_json="$("${kubectl_bin}" --context "${expected_context}" --namespace "${namespace}" get pods \
        --selector "${selector},app.kubernetes.io/component=${component}" -o json)"
      if ! jq -e --arg uid "${old_pod_uid}" '.items | any(.metadata.uid == $uid)' >/dev/null <<<"${pod_json}"; then
        replacement="$(jq -c --argjson oldUids "${old_pod_uids}" '
          [.items[] |
            select(.metadata.uid as $uid | ($oldUids | index($uid)) == null) |
            select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))]
          | sort_by(.metadata.name) | .[0] // null
        ' <<<"${pod_json}")"
        [[ "${replacement}" != "null" ]] && break
      fi
      sleep "${replacement_poll_seconds}"
    done
    new_pod_name="$(jq -r '.metadata.name // empty' <<<"${replacement}")"
    new_pod_uid="$(jq -r '.metadata.uid // empty' <<<"${replacement}")"
    [[ -n "${new_pod_name}" && -n "${new_pod_uid}" ]] &&
      jq -e --arg uid "${new_pod_uid}" 'index($uid) == null' >/dev/null <<<"${old_pod_uids}" || {
      printf 'timed out waiting for a distinct Ready replacement pod for %s\n' "${component}" >&2
      exit 1
    }
    "${kubectl_bin}" --context "${expected_context}" --namespace "${namespace}" rollout status \
      "deployment/${deployment_name}" --timeout="${timeout}" >/dev/null
    deployment_json="$(deployment_for_component "${component}")"
    assert_component_ready "${component}" "${deployment_json}"
    replaced_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    disruption="$(jq -n \
      --arg component "${component}" \
      --arg oldPodName "${old_pod_name}" \
      --arg oldPodUid "${old_pod_uid}" \
      --arg newPodName "${new_pod_name}" \
      --arg newPodUid "${new_pod_uid}" \
      --arg evictedAt "${evicted_at}" \
      --arg replacedAt "${replaced_at}" \
      '{component: $component, oldPodName: $oldPodName, oldPodUid: $oldPodUid,
        newPodName: $newPodName, newPodUid: $newPodUid,
        evictedAt: $evictedAt, replacedAt: $replacedAt}')"
    disruptions="$(jq --argjson row "${disruption}" '. + [$row]' <<<"${disruptions}")"
  done
fi
completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

after='[]'
for component in "${components[@]}"; do
  deployment_json="$(deployment_for_component "${component}")"
  assert_component_ready "${component}" "${deployment_json}"
  row="$(jq -n \
    --arg component "${component}" \
    --arg deployment "$(jq -r '.items[0].metadata.name' <<<"${deployment_json}")" \
    --arg image "$(jq -r '.items[0].spec.template.spec.containers[0].image' <<<"${deployment_json}")" \
    --argjson replicas "$(jq '.items[0].spec.replicas' <<<"${deployment_json}")" \
    --argjson ready "$(jq '.items[0].status.availableReplicas' <<<"${deployment_json}")" \
    '{component: $component, deployment: $deployment, image: $image, replicas: $replicas, readyReplicas: $ready}')"
  after="$(jq --argjson row "${row}" '. + [$row]' <<<"${after}")"
done

jq -n \
  --arg schemaVersion 'tixkit-production-profile-proof-v1' \
  --arg drillId "${drill_id}" \
  --arg context "${current_context}" \
  --arg namespace "${namespace}" \
  --arg release "${release}" \
  --arg startedAt "${started_at}" \
  --arg completedAt "${completed_at}" \
  --argjson disruption "$([[ "${disruption_ack}" == "evict-one-pod-per-component" ]] && printf true || printf false)" \
  --argjson before "${before}" \
  --argjson after "${after}" \
  --argjson disruptions "${disruptions}" \
  '{schemaVersion: $schemaVersion, drillId: $drillId, context: $context, namespace: $namespace,
    release: $release, startedAt: $startedAt, completedAt: $completedAt,
    disruptionPerformed: $disruption, before: $before, after: $after,
    disruptions: $disruptions}' >&9
exec 9>&-
chmod 0400 "${evidence_file}"

printf '%s\n' "${evidence_file}"

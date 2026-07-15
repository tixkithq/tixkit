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
command -v shasum >/dev/null || { printf 'shasum is required\n' >&2; exit 1; }
current_context="$("${kubectl_bin}" config current-context)"
[[ "${current_context}" == "${expected_context}" ]] || {
  printf 'refusing cluster drill: current context %s does not match EXPECTED_KUBE_CONTEXT %s\n' \
    "${current_context}" "${expected_context}" >&2
  exit 1
}
cluster_server="$("${kubectl_bin}" --context "${expected_context}" config view --minify \
  -o 'jsonpath={.clusters[0].cluster.server}')"
cluster_ca_material="$("${kubectl_bin}" --context "${expected_context}" config view --minify --raw --flatten \
  -o 'jsonpath={.clusters[0].cluster.certificate-authority-data}')"
[[ "${cluster_server}" =~ ^https:// && -n "${cluster_ca_material}" ]] || {
  printf 'cluster identity requires an HTTPS server and CA material\n' >&2
  exit 1
}
cluster_ca_hash="$(printf '%s' "${cluster_ca_material}" | shasum -a 256 | awk '{print $1}')"
kube_system_json="$("${kubectl_bin}" --context "${expected_context}" get namespace kube-system -o json)"
namespace_json="$("${kubectl_bin}" --context "${expected_context}" get namespace "${namespace}" -o json)"
kube_system_uid="$(jq -r '.metadata.uid // empty' <<<"${kube_system_json}")"
namespace_uid="$(jq -r '.metadata.uid // empty' <<<"${namespace_json}")"
[[ -n "${kube_system_uid}" && -n "${namespace_uid}" ]] || {
  printf 'cluster identity requires kube-system and target namespace UIDs\n' >&2
  exit 1
}
helm_releases="$("${kubectl_bin}" --context "${expected_context}" --namespace "${namespace}" get secrets \
  --selector "owner=helm,name=${release}" -o json)"
helm_release="$(jq -c '
  [.items[] | select((.metadata.labels.version // "") | test("^[1-9][0-9]*$"))]
  | sort_by(.metadata.labels.version | tonumber) | last // null
' <<<"${helm_releases}")"
[[ "${helm_release}" != "null" ]] || {
  printf 'cluster identity requires a Helm release record for %s\n' "${release}" >&2
  exit 1
}
helm_payload="$(jq -r '.data.release // empty' <<<"${helm_release}")"
[[ -n "${helm_payload}" ]] || { printf 'Helm release record has no payload\n' >&2; exit 1; }
helm_payload_hash="$(printf '%s' "${helm_payload}" | shasum -a 256 | awk '{print $1}')"
helm_identity="$(jq -c --arg payloadHash "${helm_payload_hash}" '{
  secretUid: .metadata.uid,
  revision: (.metadata.labels.version | tonumber),
  status: .metadata.labels.status,
  chart: .metadata.labels.chart,
  appVersion: .metadata.labels.appVersion,
  releasePayloadSha256: $payloadHash
}' <<<"${helm_release}")"
nodes_json="$("${kubectl_bin}" --context "${expected_context}" get nodes -o json)"

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
chmod 0400 /dev/fd/9

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
    ((.items[0].metadata.labels["helm.sh/chart"] // "") | length) > 0 and
    ((.items[0].metadata.labels["app.kubernetes.io/version"] // "") | length) > 0 and
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
    (.items[0].spec.template.spec.topologySpreadConstraints | length) >= 1 and
    (.items[0].spec.template.spec.topologySpreadConstraints | any(
      .topologyKey == "topology.kubernetes.io/zone" and
      .whenUnsatisfiable == "DoNotSchedule" and
      ((.minDomains // 0) >= 2) and
      ((.maxSkew // 0) <= 1)
    )) and
    (.items[0].spec.template.spec.containers | length) == 1 and
    (.items[0].spec.template.spec.containers[0].image |
      test("@sha256:[a-f0-9]{64}$"))
  ' >/dev/null <<<"${deployment_json}" || {
    printf 'production deployment invariant failed for %s\n' "${component}" >&2
    exit 1
  }
}

component_snapshot() {
  local component="$1"
  local deployment_json="$2"
  local desired deployment_name pod_json ready_pods hpa_json hpa pdb_json pdb
  deployment_name="$(jq -r '.items[0].metadata.name' <<<"${deployment_json}")"
  pod_json="$("${kubectl_bin}" --context "${expected_context}" --namespace "${namespace}" get pods \
    --selector "${selector},app.kubernetes.io/component=${component}" -o json)"
  ready_pods="$(jq -c --argjson nodes "${nodes_json}" '[
    .items[]
    | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))
    | . as $pod
    | ($nodes.items | map(select(.metadata.name == $pod.spec.nodeName)) | .[0] // null) as $node
    | {
        name: $pod.metadata.name,
        uid: $pod.metadata.uid,
        nodeName: $pod.spec.nodeName,
        nodeUid: $node.metadata.uid,
        zone: $node.metadata.labels["topology.kubernetes.io/zone"]
      }
  ]' <<<"${pod_json}")"
  jq -e --argjson expectedReady "$(jq '.items[0].status.readyReplicas' <<<"${deployment_json}")" '
    length == $expectedReady and
    length >= 2 and
    all(.[]; (.uid | length) > 0 and (.nodeName | length) > 0 and
      (.nodeUid | length) > 0 and (.zone | length) > 0) and
    ([.[].zone] | unique | length) >= 2
  ' >/dev/null <<<"${ready_pods}" || {
    printf 'production zone-spread invariant failed for %s\n' "${component}" >&2
    exit 1
  }

  hpa_json="$("${kubectl_bin}" --context "${expected_context}" --namespace "${namespace}" get horizontalpodautoscalers \
    --selector "${selector},app.kubernetes.io/component=${component}" -o json)"
  jq -e '(.items | length) <= 1' >/dev/null <<<"${hpa_json}" || {
    printf 'multiple autoscalers target %s\n' "${component}" >&2
    exit 1
  }
  hpa="$(jq -c '.items[0] // null' <<<"${hpa_json}")"
  desired="$(jq '.items[0].spec.replicas' <<<"${deployment_json}")"
  if [[ "${hpa}" != "null" ]]; then
    jq -e --arg deployment "${deployment_name}" '
      (.spec.scaleTargetRef.kind == "Deployment") and
      (.spec.scaleTargetRef.name == $deployment) and
      (.spec.minReplicas >= 2) and
      (.spec.maxReplicas >= .spec.minReplicas) and
      (.status.desiredReplicas >= .spec.minReplicas) and
      (.status.desiredReplicas <= .spec.maxReplicas)
    ' >/dev/null <<<"${hpa}" || {
      printf 'production autoscaler invariant failed for %s\n' "${component}" >&2
      exit 1
    }
    desired="$(jq '.status.desiredReplicas' <<<"${hpa}")"
  fi

  pdb_json="$("${kubectl_bin}" --context "${expected_context}" --namespace "${namespace}" get poddisruptionbudgets \
    --selector "${selector},app.kubernetes.io/component=${component}" -o json)"
  jq -e '(.items | length) == 1' >/dev/null <<<"${pdb_json}" || {
    printf 'production disruption-budget invariant failed for %s\n' "${component}" >&2
    exit 1
  }
  pdb="$(jq -c '.items[0] // null' <<<"${pdb_json}")"
  jq -e --argjson desired "${desired}" '
    . != null and
    ((.spec.minAvailable | tonumber) >= 1) and
    ((.spec.minAvailable | tonumber) < $desired) and
    ((.status.currentHealthy // 0) >= (.spec.minAvailable | tonumber)) and
    ((.status.disruptionsAllowed // 0) >= 1)
  ' >/dev/null <<<"${pdb}" || {
    printf 'production disruption-budget invariant failed for %s\n' "${component}" >&2
    exit 1
  }

  jq -n \
    --arg component "${component}" \
    --arg deployment "${deployment_name}" \
    --arg image "$(jq -r '.items[0].spec.template.spec.containers[0].image' <<<"${deployment_json}")" \
    --arg chart "$(jq -r '.items[0].metadata.labels["helm.sh/chart"]' <<<"${deployment_json}")" \
    --arg appVersion "$(jq -r '.items[0].metadata.labels["app.kubernetes.io/version"]' <<<"${deployment_json}")" \
    --argjson replicas "$(jq '.items[0].spec.replicas' <<<"${deployment_json}")" \
    --argjson ready "$(jq '.items[0].status.availableReplicas' <<<"${deployment_json}")" \
    --argjson readyPods "${ready_pods}" \
    --argjson topologyConstraint "$(jq -c '[.items[0].spec.template.spec.topologySpreadConstraints[] | select(.topologyKey == "topology.kubernetes.io/zone")][0]' <<<"${deployment_json}")" \
    --argjson autoscaler "${hpa}" \
    --argjson disruptionBudget "${pdb}" \
    '{component: $component, deployment: $deployment, image: $image,
      chart: $chart, appVersion: $appVersion,
      replicas: $replicas, readyReplicas: $ready, readyPods: $readyPods,
      topologyConstraint: $topologyConstraint,
      autoscaler: (if $autoscaler == null then null else {
        uid: $autoscaler.metadata.uid, minReplicas: $autoscaler.spec.minReplicas,
        maxReplicas: $autoscaler.spec.maxReplicas,
        desiredReplicas: $autoscaler.status.desiredReplicas
      } end),
      disruptionBudget: {
        uid: $disruptionBudget.metadata.uid,
        minAvailable: ($disruptionBudget.spec.minAvailable | tonumber),
        disruptionsAllowed: $disruptionBudget.status.disruptionsAllowed
      }}'
}

before='[]'
for component in "${components[@]}"; do
  deployment_json="$(deployment_for_component "${component}")"
  assert_component_ready "${component}" "${deployment_json}"
  row="$(component_snapshot "${component}" "${deployment_json}")"
  before="$(jq --argjson row "${row}" '. + [$row]' <<<"${before}")"
done

chart_identity="$(jq -r '[.[].chart] | unique | if length == 1 then .[0] else empty end' <<<"${before}")"
app_version_identity="$(jq -r '[.[].appVersion] | unique | if length == 1 then .[0] else empty end' <<<"${before}")"
[[ -n "${chart_identity}" && -n "${app_version_identity}" ]] || {
  printf 'workloads do not share one Helm chart and application version identity\n' >&2
  exit 1
}
helm_identity="$(jq -c --arg chart "${chart_identity}" --arg appVersion "${app_version_identity}" \
  '.chart = $chart | .appVersion = $appVersion' <<<"${helm_identity}")"

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
  row="$(component_snapshot "${component}" "${deployment_json}")"
  after="$(jq --argjson row "${row}" '. + [$row]' <<<"${after}")"
done

jq -n \
  --arg schemaVersion 'tixkit-production-profile-proof-v1' \
  --arg drillId "${drill_id}" \
  --arg context "${current_context}" \
  --arg clusterServer "${cluster_server}" \
  --arg clusterCaSha256 "${cluster_ca_hash}" \
  --arg kubeSystemUid "${kube_system_uid}" \
  --arg namespaceUid "${namespace_uid}" \
  --arg namespace "${namespace}" \
  --arg release "${release}" \
  --argjson helmRelease "${helm_identity}" \
  --arg startedAt "${started_at}" \
  --arg completedAt "${completed_at}" \
  --argjson disruption "$([[ "${disruption_ack}" == "evict-one-pod-per-component" ]] && printf true || printf false)" \
  --argjson before "${before}" \
  --argjson after "${after}" \
  --argjson disruptions "${disruptions}" \
  '{schemaVersion: $schemaVersion, drillId: $drillId, context: $context,
    cluster: {server: $clusterServer, caSha256: $clusterCaSha256,
      kubeSystemNamespaceUid: $kubeSystemUid},
    namespace: $namespace, namespaceUid: $namespaceUid,
    release: $release, helmRelease: $helmRelease,
    startedAt: $startedAt, completedAt: $completedAt,
    disruptionPerformed: $disruption, before: $before, after: $after,
    disruptions: $disruptions}' >&9
exec 9>&-

printf '%s\n' "${evidence_file}"

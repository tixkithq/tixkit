#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
helm_bin="${HELM:-helm}"
arc_chart_version="${ARC_CHART_VERSION:-0.14.2}"

kubectl apply -f "${repo_root}/infra/ci/k8s/arc-hardening.yaml"

"${helm_bin}" upgrade --install arc \
  --namespace arc-systems \
  --create-namespace \
  -f "${repo_root}/infra/ci/arc/controller-values.yaml" \
  --version "${arc_chart_version}" \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller

"${helm_bin}" upgrade --install tixkit-epyc-trusted \
  --namespace arc-runners \
  --create-namespace \
  -f "${repo_root}/infra/ci/arc/runner-values.yaml" \
  --version "${arc_chart_version}" \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set

kubectl rollout status deploy/arc-gha-rs-controller -n arc-systems --timeout=180s
kubectl get autoscalingrunnersets -n arc-runners

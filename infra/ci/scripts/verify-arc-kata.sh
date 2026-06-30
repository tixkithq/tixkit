#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
runner_values="${repo_root}/infra/ci/arc/runner-values.yaml"
install_script="${repo_root}/infra/ci/scripts/install-arc.sh"

verify_arc_supply_chain_pins() {
  local unpinned_images
  unpinned_images="$(awk '/^[[:space:]]*image: / && $0 !~ /@sha256:[0-9a-f]{64}/ { print FILENAME ":" FNR ":" $0 }' "${runner_values}")"
  if [[ -n "${unpinned_images}" ]]; then
    printf 'ARC runner image references must include sha256 digests:\n%s\n' "${unpinned_images}" >&2
    return 1
  fi

  if grep -nE '(:latest|image:[[:space:]]+docker:dind($|[[:space:]]))' "${runner_values}"; then
    printf 'ARC runner values must not use mutable runner or dind tags.\n' >&2
    return 1
  fi

  if ! grep -q -- '--storage-driver=vfs' "${runner_values}"; then
    printf 'ARC runner dind sidecar must force the vfs storage driver for Kata compatibility.\n' >&2
    return 1
  fi

  if ! grep -q -- 'containerd-snapshotter=false' "${runner_values}"; then
    printf 'ARC runner dind sidecar must disable the containerd overlay snapshotter for Kata compatibility.\n' >&2
    return 1
  fi

  if [[ "$(grep -c -- '--version "${arc_chart_version}"' "${install_script}")" -lt 2 ]]; then
    printf 'ARC chart installs must pass --version "${arc_chart_version}" for both charts.\n' >&2
    return 1
  fi

  if ! grep -q 'arc_chart_version="${ARC_CHART_VERSION:-0.14.2}"' "${install_script}"; then
    printf 'ARC chart version must default to the documented 0.14.2 baseline.\n' >&2
    return 1
  fi
}

verify_arc_supply_chain_pins

if [[ "${1:-}" == "--supply-chain-only" ]]; then
  exit 0
fi

kubectl get nodes -o wide
kubectl get runtimeclass
kubectl get pods -n arc-systems -o wide
kubectl get autoscalingrunnersets -n arc-runners -o wide
kubectl get autoscalinglisteners -n arc-systems -o wide
kubectl get networkpolicy -A

kubectl delete pod kata-smoke --ignore-not-found=true --wait=true
kubectl run kata-smoke \
  --image=busybox:1.36 \
  --restart=Never \
  --overrides='{"apiVersion":"v1","spec":{"runtimeClassName":"kata","nodeSelector":{"node-role.kubernetes.io/ci":"true"},"tolerations":[{"key":"dedicated","operator":"Equal","value":"ci","effect":"NoSchedule"}],"containers":[{"name":"kata-smoke","image":"busybox:1.36","command":["sh","-c","uname -a; grep -m1 \"model name\" /proc/cpuinfo"]}]}}'
kubectl wait --for=condition=Ready pod/kata-smoke --timeout=180s
kubectl logs kata-smoke
kubectl delete pod kata-smoke --wait=false

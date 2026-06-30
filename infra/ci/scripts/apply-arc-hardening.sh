#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

kubectl apply -f "${repo_root}/infra/ci/k8s/arc-hardening.yaml"
kubectl get namespaces arc-systems arc-runners --show-labels
kubectl get networkpolicy -n arc-systems
kubectl get networkpolicy -n arc-runners

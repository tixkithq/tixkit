#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_APP_ID:?Set GITHUB_APP_ID to the GitHub App ID}"
: "${GITHUB_APP_INSTALLATION_ID:?Set GITHUB_APP_INSTALLATION_ID to the app installation ID for nkgotcode/tixkit}"
: "${GITHUB_APP_PRIVATE_KEY_FILE:?Set GITHUB_APP_PRIVATE_KEY_FILE to the GitHub App private key PEM path}"

namespace="${ARC_RUNNERS_NAMESPACE:-arc-runners}"
secret_name="${ARC_GITHUB_AUTH_SECRET:-arc-github-auth}"

kubectl create namespace "${namespace}" --dry-run=client -o yaml | kubectl apply -f -
kubectl create secret generic "${secret_name}" \
  -n "${namespace}" \
  --from-literal=github_app_id="${GITHUB_APP_ID}" \
  --from-literal=github_app_installation_id="${GITHUB_APP_INSTALLATION_ID}" \
  --from-file=github_app_private_key="${GITHUB_APP_PRIVATE_KEY_FILE}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl get secret "${secret_name}" -n "${namespace}"

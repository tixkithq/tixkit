#!/usr/bin/env bash
set -euo pipefail

chart_dir="${CHART_DIR:-infra/helm/tixkit}"
release_name="${RELEASE_NAME:-tixkit}"
namespace="${NAMESPACE:-tixkit}"

bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
bun run deploy:check
helm lint "${chart_dir}"
helm template "${release_name}" "${chart_dir}" --namespace "${namespace}" >/tmp/tixkit-release-rendered.yaml

echo "Rendered Kubernetes manifest: /tmp/tixkit-release-rendered.yaml"
echo "Dry-run pipeline completed: build, typecheck, lint, helm lint, helm template"

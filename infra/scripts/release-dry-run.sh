#!/usr/bin/env bash
set -euo pipefail

chart_dir="${CHART_DIR:-infra/helm/tixkit}"
release_name="${RELEASE_NAME:-tixkit}"
namespace="${NAMESPACE:-tixkit}"

bun install --frozen-lockfile
bun run docs:check
bun run --filter @tixkit/docs build:static
bun run export:oss -- --out /tmp/tixkit-release-oss-export
bun run build
bun run typecheck
bun run lint
bun run deploy:check
helm lint "${chart_dir}"
helm template "${release_name}" "${chart_dir}" --namespace "${namespace}" >/tmp/tixkit-release-rendered.yaml

echo "Rendered Kubernetes manifest: /tmp/tixkit-release-rendered.yaml"
echo "Dry-run pipeline completed: docs validation/static build/OSS export, build, typecheck, lint, helm lint, helm template"

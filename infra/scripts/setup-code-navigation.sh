#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(pwd)}"
repo_name="$(basename "$repo_root")"

cd "$repo_root"

if command -v graphify >/dev/null 2>&1; then
  if [ -f graphify-out/graph.json ]; then
    graphify update .
  else
    echo "graphify-out/graph.json not found. Run the full Graphify extraction flow first."
  fi
  graphify export wiki || true
  graphify tree --label "$repo_name" || true
  graphify hook install || true
else
  echo "graphify not found; install Graphify before running this setup."
fi

if command -v serena >/dev/null 2>&1; then
  if [ ! -f .serena/project.yml ]; then
    serena project create .
  fi
  serena project health-check .
  serena project index .
else
  echo "serena not found; install Serena before running this setup."
fi

cat <<'EOF'

Navigation setup complete where supported.

Next manual checks:
- Ensure .serena/project.yml has the right project_name, languages, ignored_paths, and initial_prompt.
- Add or update .serena/memories/core.md and topic memories.
- Add AGENTS.md Graphify + Serena rules for this repo.
- Restart the Serena MCP/client process after changing .serena/project.yml.
EOF

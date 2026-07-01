#!/usr/bin/env bash
set -euo pipefail

failures=0

while IFS=: read -r path line raw_line; do
  ref="${raw_line#*uses:}"
  ref="${ref%%#*}"
  ref="${ref#\"}"
  ref="${ref%\"}"
  ref="${ref#\'}"
  ref="${ref%\'}"
  ref="${ref#"${ref%%[![:space:]]*}"}"
  ref="${ref%"${ref##*[![:space:]]}"}"

  if [[ -z "${ref}" || "${ref}" == ./* ]]; then
    continue
  fi

  if [[ ! "${ref}" =~ ^[^[:space:]@]+(/[^[:space:]@]+)+@[0-9a-f]{40}$ ]]; then
    printf '%s:%s uses mutable or malformed action ref: %s\n' "${path}" "${line}" "${ref}" >&2
    failures=1
  fi
done < <(rg --no-heading --line-number '^[[:space:]-]*uses:[[:space:]]*' .github/workflows .github/actions)

exit "${failures}"

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

while IFS= read -r workflow; do
  if ! awk '
    /^permissions:[[:space:]]*$/ {
      in_permissions = 1
      found_permissions = 1
      next
    }
    in_permissions && /^[^[:space:]][^:]*:/ {
      in_permissions = 0
    }
    in_permissions && /^[[:space:]]+contents:[[:space:]]*read[[:space:]]*$/ {
      found_contents_read = 1
    }
    END {
      exit found_permissions && found_contents_read ? 0 : 1
    }
  ' "${workflow}"; then
    printf '%s must declare top-level permissions with contents: read\n' "${workflow}" >&2
    failures=1
  fi
done < <(find .github/workflows -maxdepth 1 -type f -name '*.yml' | sort)

exit "${failures}"

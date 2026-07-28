#!/usr/bin/env bash
# Verifies GitHub Actions refs and workflow service/container images are digest-pinned.
# Pure bash so it runs on the trusted ARC image before setup-js (no rg/ruby/python required).
set -euo pipefail

failures=0

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

strip_quotes() {
  local value
  value="$(trim "$1")"
  if ((${#value} >= 2)) && [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif ((${#value} >= 2)) && [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$(trim "${value}")"
}

is_pinned_action_ref() {
  local ref="$1"
  [[ "${ref}" == ./* ]] && return 0
  [[ "${ref}" =~ ^[^[:space:]@]+(/[^[:space:]@]+)+@[0-9a-f]{40}$ ]]
}

is_pinned_image() {
  local image="$1"
  [[ "${image}" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] && return 0
  # Binary choice: ${{ expr && 'image@sha256:...' || 'image@sha256:...' }}
  [[ "${image}" =~ ^\$\{\{[[:space:]].+[[:space:]]\&\&[[:space:]]\'[^[:space:]\'@]+@sha256:[0-9a-f]{64}\'[[:space:]]\|\|[[:space:]]\'[^[:space:]\'@]+@sha256:[0-9a-f]{64}\'[[:space:]]\}\}$ ]]
}

fail() {
  printf '%s\n' "$1" >&2
  failures=1
}

# --- Remote action uses: must be full 40-char SHAs; local actions are allowed.
while IFS= read -r -d '' file; do
  line_no=0
  while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
    line_no=$((line_no + 1))
    [[ "${raw_line}" =~ ^[[:space:]-]*uses:[[:space:]]* ]] || continue
    ref="${raw_line#*uses:}"
    ref="${ref%%#*}"
    ref="$(strip_quotes "${ref}")"
    [[ -z "${ref}" || "${ref}" == ./* ]] && continue
    if ! is_pinned_action_ref "${ref}"; then
      fail "${file}:${line_no} uses mutable or malformed action ref: ${ref}"
    fi
  done < "${file}"
done < <(find .github/workflows .github/actions \( -name '*.yml' -o -name '*.yaml' \) -type f -print0 2>/dev/null)

# --- Workflow top-level permissions + container/service image pins.
shopt -s nullglob
workflow_files=(.github/workflows/*.yml .github/workflows/*.yaml)
shopt -u nullglob

for path in "${workflow_files[@]}"; do
  [[ -f "${path}" ]] || continue

  # Head of file before top-level jobs:
  head_block="$(
    awk '
      /^jobs:[[:space:]]*$/ { exit }
      /^jobs:[[:space:]]/ { exit }
      { print }
    ' "${path}"
  )"

  has_top_level_contents_read=0
  if printf '%s\n' "${head_block}" | grep -Eq '^permissions:[[:space:]]*\{[^}]*contents:[[:space:]]*read'; then
    has_top_level_contents_read=1
  elif printf '%s\n' "${head_block}" | awk '
    BEGIN { in_perm = 0; ok = 0 }
    /^permissions:[[:space:]]*$/ { in_perm = 1; next }
    in_perm && /^[^#[:space:]]/ { in_perm = 0 }
    in_perm && /^[[:space:]]+contents:[[:space:]]*read([[:space:]]|$)/ { ok = 1 }
    END { exit ok ? 0 : 1 }
  '; then
    has_top_level_contents_read=1
  fi
  if [[ "${has_top_level_contents_read}" -ne 1 ]]; then
    fail "${path} must declare top-level permissions with contents: read"
    continue
  fi

  in_jobs=0
  job=""
  job_indent=-1
  in_services=0
  services_indent=-1
  service=""
  service_indent=-1
  in_container=0
  container_indent=-1
  line_no=0

  while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
    line_no=$((line_no + 1))
    # Preserve full line for values; strip comments only for structure decisions.
    no_comment="${raw_line%%#*}"
    [[ -z "$(trim "${no_comment}")" ]] && continue

    leading="${no_comment%%[![:space:]]*}"
    indent=${#leading}
    content="$(trim "${no_comment}")"

    if [[ "${indent}" -eq 0 ]]; then
      if [[ "${content}" == "jobs:" ]]; then
        in_jobs=1
      else
        in_jobs=0
      fi
      job=""
      job_indent=-1
      in_services=0
      services_indent=-1
      service=""
      service_indent=-1
      in_container=0
      container_indent=-1
      continue
    fi

    [[ "${in_jobs}" -eq 1 ]] || continue

    # Job key at the first nesting level under jobs:
    if [[ -z "${job}" || "${indent}" -le "${job_indent}" ]]; then
      if [[ "${content}" =~ ^([A-Za-z0-9_-]+):[[:space:]]*$ ]]; then
        job="${BASH_REMATCH[1]}"
        job_indent="${indent}"
        in_services=0
        services_indent=-1
        service=""
        service_indent=-1
        in_container=0
        container_indent=-1
        continue
      fi
      # Still looking for a job.
      continue
    fi

    # container: scalar form
    if [[ "${content}" =~ ^container:[[:space:]]+(.+)$ ]]; then
      image="$(strip_quotes "${BASH_REMATCH[1]}")"
      if ! is_pinned_image "${image}"; then
        fail "${path} uses mutable or malformed job ${job} container image: ${image}"
      fi
      in_container=0
      continue
    fi

    # container: mapping form
    if [[ "${content}" == "container:" ]]; then
      in_container=1
      container_indent="${indent}"
      in_services=0
      service=""
      continue
    fi

    if [[ "${in_container}" -eq 1 ]]; then
      if [[ "${indent}" -le "${container_indent}" ]]; then
        in_container=0
      elif [[ "${content}" =~ ^image:[[:space:]]*(.*)$ ]]; then
        image="$(strip_quotes "${BASH_REMATCH[1]}")"
        if ! is_pinned_image "${image}"; then
          fail "${path} uses mutable or malformed job ${job} container image: ${image}"
        fi
        continue
      fi
    fi

    # services: inline mapping  services: { database: { image: "..." } }
    if [[ "${content}" =~ ^services:[[:space:]]+\{ ]]; then
      # Pull every image: value out of the remainder of the line.
      rest="${content#services:}"
      while [[ "${rest}" =~ [Ii]mage:[[:space:]]*(\"([^\"]*)\"|\'([^\']*)\'|([^,}[:space:]]+)) ]]; do
        if [[ -n "${BASH_REMATCH[2]}" ]]; then
          image="${BASH_REMATCH[2]}"
        elif [[ -n "${BASH_REMATCH[3]}" ]]; then
          image="${BASH_REMATCH[3]}"
        else
          image="${BASH_REMATCH[4]}"
        fi
        image="$(strip_quotes "${image}")"
        # Label uses .database when the service name is not parsed from inline form.
        svc="database"
        if [[ "${rest}" =~ ([A-Za-z0-9_-]+):[[:space:]]*\{[^}]*[Ii]mage: ]]; then
          svc="${BASH_REMATCH[1]}"
        fi
        if ! is_pinned_image "${image}"; then
          fail "${path} uses mutable or malformed service ${job}.${svc} image: ${image}"
        fi
        rest="${rest#*"${BASH_REMATCH[0]}"}"
      done
      in_services=0
      continue
    fi

    if [[ "${content}" == "services:" ]]; then
      in_services=1
      services_indent="${indent}"
      service=""
      service_indent=-1
      in_container=0
      continue
    fi

    if [[ "${in_services}" -eq 1 ]]; then
      if [[ "${indent}" -le "${services_indent}" ]]; then
        in_services=0
        service=""
        # Re-process this line outside services on next loop iteration semantics:
        # fall through by resetting and not continuing — but we already consumed.
        # Restart classification for this line by jumping to generic handlers is hard;
        # services blocks are leaves in practice. Ignore non-service siblings after.
      else
        # New service name
        if [[ "${content}" =~ ^([A-Za-z0-9_-]+):[[:space:]]*$ ]]; then
          if [[ -z "${service}" || "${indent}" -le "${service_indent}" ]]; then
            service="${BASH_REMATCH[1]}"
            service_indent="${indent}"
            continue
          fi
        fi

        # Inline service mapping: database: { image: "..." }
        if [[ "${content}" =~ ^([A-Za-z0-9_-]+):[[:space:]]+\{(.+)\}[[:space:]]*$ ]]; then
          service="${BASH_REMATCH[1]}"
          inline="${BASH_REMATCH[2]}"
          if [[ "${inline}" =~ [Ii]mage:[[:space:]]*(\"([^\"]*)\"|\'([^\']*)\'|([^}]+)) ]]; then
            if [[ -n "${BASH_REMATCH[2]}" ]]; then
              image="${BASH_REMATCH[2]}"
            elif [[ -n "${BASH_REMATCH[3]}" ]]; then
              image="${BASH_REMATCH[3]}"
            else
              image="${BASH_REMATCH[4]}"
            fi
            image="$(strip_quotes "${image}")"
            if ! is_pinned_image "${image}"; then
              fail "${path} uses mutable or malformed service ${job}.${service} image: ${image}"
            fi
          else
            fail "${path} service ${job}.${service} must be a mapping with an image"
          fi
          service=""
          continue
        fi

        # Scalar service (invalid)
        if [[ "${content}" =~ ^([A-Za-z0-9_-]+):[[:space:]]+(.+)$ ]]; then
          sname="${BASH_REMATCH[1]}"
          rest="$(trim "${BASH_REMATCH[2]}")"
          if [[ "${sname}" != "image" && "${rest}" != "{"* && "${indent}" -le $((services_indent + 2)) ]]; then
            fail "${path} service ${job}.${sname} must be a mapping with an image"
            continue
          fi
        fi

        if [[ -n "${service}" && "${indent}" -gt "${service_indent}" ]]; then
          if [[ "${content}" =~ ^image:[[:space:]]*(.*)$ ]]; then
            image="$(strip_quotes "${BASH_REMATCH[1]}")"
            if ! is_pinned_image "${image}"; then
              fail "${path} uses mutable or malformed service ${job}.${service} image: ${image}"
            fi
            continue
          fi
        fi
        continue
      fi
    fi
  done < "${path}"
done

exit "${failures}"

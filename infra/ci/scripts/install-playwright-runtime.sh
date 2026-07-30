#!/usr/bin/env bash
set -euo pipefail

readonly playwright_version='1.62.0'
readonly browser_name="${1:-chromium}"
case "$browser_name" in
  chromium | firefox | webkit) ;;
  *)
    echo "Unsupported Playwright browser: $browser_name" >&2
    exit 1
    ;;
esac
readonly runner_temp="${RUNNER_TEMP:-${TMPDIR:-/tmp}/tixkit-runner}"
if [[ "$runner_temp" != /* || "$runner_temp" == *$'\n'* || "$runner_temp" == *'"'* ]]; then
  echo 'Runner temporary directory must be an absolute path without newlines or quotes' >&2
  exit 1
fi
if [[ -e "$runner_temp" && ( ! -d "$runner_temp" || -L "$runner_temp" || ! -O "$runner_temp" ) ]]; then
  echo 'Runner temporary directory must be an owned, non-symlink directory' >&2
  exit 1
fi
mkdir -p "$runner_temp"

readonly runtime_root="$runner_temp/playwright-runtime"
readonly package_dir="$runtime_root/packages"
readonly library_root="$runtime_root/root"
readonly apt_root="$runtime_root/apt"
readonly apt_config="$apt_root/apt.conf"

installed_version="$(bunx playwright --version)"
if [[ "$installed_version" != "Version $playwright_version" ]]; then
  echo "Installed Playwright version does not match the trusted runtime: $installed_version" >&2
  exit 1
fi

if [[ "$(uname -s)" != 'Linux' ]]; then
  echo 'The trusted Playwright runtime installer supports Linux runners only' >&2
  exit 1
fi
for command_name in apt-get dpkg-deb; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command is unavailable: $command_name" >&2
    exit 1
  fi
done

rm -rf "$runtime_root"
mkdir -p \
  "$package_dir" \
  "$library_root" \
  "$apt_root/state/lists/partial" \
  "$apt_root/cache/archives/partial" \
  "$apt_root/empty.conf.d"
touch "$apt_root/empty.conf"
cat >"$apt_config" <<EOF
Dir::State "$apt_root/state";
Dir::State::status "/var/lib/dpkg/status";
Dir::State::lists "$apt_root/state/lists";
Dir::Cache "$apt_root/cache";
Dir::Cache::archives "$apt_root/cache/archives";
Dir::Etc::sourcelist "/etc/apt/sources.list";
Dir::Etc::sourceparts "/etc/apt/sources.list.d";
Dir::Etc::main "$apt_root/empty.conf";
Dir::Etc::parts "$apt_root/empty.conf.d";
APT::Get::List-Cleanup "0";
APT::Update::Error-Mode "any";
Acquire::Retries "3";
EOF
export APT_CONFIG="$apt_config"
apt-get update

set +e
dependency_report="$(bunx playwright install-deps --dry-run "$browser_name" 2>&1)"
dependency_status=$?
set -e

if ((dependency_status != 0)); then
  mapfile -t missing_packages < <(
    sed -n '/^Missing system dependencies ([0-9][0-9]*):$/,$p' <<<"$dependency_report" |
      sed -n 's/^  \([a-zA-Z0-9][a-zA-Z0-9+.:_-]*\)$/\1/p'
  )
  if ((${#missing_packages[@]} == 0)); then
    printf '%s\n' "$dependency_report" >&2
    echo 'Playwright dependency detection failed without a parseable missing-package list' >&2
    exit 1
  fi

  (
    cd "$package_dir"
    apt-get download "${missing_packages[@]}"
  )
  shopt -s nullglob
  packages=("$package_dir"/*.deb)
  shopt -u nullglob
  if ((${#packages[@]} == 0)); then
    echo 'No Debian packages were downloaded for the missing Playwright dependencies' >&2
    exit 1
  fi
  for package_path in "${packages[@]}"; do
    dpkg-deb --extract "$package_path" "$library_root"
  done

  mapfile -t library_dirs < <(
    find "$library_root" \( -type f -o -type l \) -name '*.so*' -print0 |
      xargs -0 -r -n1 dirname |
      sort -u
  )
  if ((${#library_dirs[@]} > 0)); then
    runtime_library_path="$(IFS=:; echo "${library_dirs[*]}")"
    export LD_LIBRARY_PATH="$runtime_library_path${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    if [[ -n "${GITHUB_ENV:-}" ]]; then
      printf 'LD_LIBRARY_PATH=%s\n' "$LD_LIBRARY_PATH" >>"$GITHUB_ENV"
    fi
  fi
  export XDG_DATA_DIRS="$library_root/usr/share:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    printf 'XDG_DATA_DIRS=%s\n' "$XDG_DATA_DIRS" >>"$GITHUB_ENV"
  fi
  echo "Extracted ${#missing_packages[@]} missing Playwright dependency packages into runner-temporary storage"
fi

bunx playwright install "$browser_name"
PLAYWRIGHT_BROWSER="$browser_name" bun -e "import * as playwright from '@playwright/test'; const browserType = playwright[process.env.PLAYWRIGHT_BROWSER]; if (!browserType) process.exit(1); const browser = await browserType.launch({ headless: true }); const page = await browser.newPage(); await page.setContent('<main>trusted browser smoke</main>'); if (await page.textContent('main') !== 'trusted browser smoke') process.exit(1); await browser.close();"
echo "Playwright $playwright_version $browser_name runtime is ready"

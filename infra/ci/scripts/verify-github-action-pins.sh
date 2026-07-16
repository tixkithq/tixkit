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

if ! ruby <<'RUBY'
require 'yaml'

PINNED_IMAGE = /\A[^\s@]+@sha256:[0-9a-f]{64}\z/
PINNED_BINARY_CHOICE = /\A\$\{\{\s+.+\s+&&\s+'[^\s@]+@sha256:[0-9a-f]{64}'\s+\|\|\s+'[^\s@]+@sha256:[0-9a-f]{64}'\s+\}\}\z/

failures = []

def check_image(path, location, image, failures)
  unless image.is_a?(String) && (PINNED_IMAGE.match?(image) || PINNED_BINARY_CHOICE.match?(image))
    failures << "#{path} uses mutable or malformed #{location} image: #{image.inspect}"
  end
end

Dir['.github/workflows/*.{yml,yaml}'].sort.each do |path|
  begin
    document = YAML.safe_load(File.read(path), aliases: true)
  rescue Psych::Exception => error
    failures << "#{path} is not valid YAML: #{error.message}"
    next
  end

  unless document.is_a?(Hash) && document['permissions'].is_a?(Hash) &&
         document['permissions']['contents'] == 'read'
    failures << "#{path} must declare top-level permissions with contents: read"
  end

  jobs = document.is_a?(Hash) ? document['jobs'] : nil
  next unless jobs.is_a?(Hash)

  jobs.each do |job_name, job|
    next unless job.is_a?(Hash)

    container = job['container']
    if container.is_a?(String)
      check_image(path, "job #{job_name} container", container, failures)
    elsif container.is_a?(Hash)
      check_image(path, "job #{job_name} container", container['image'], failures)
    elsif !container.nil?
      failures << "#{path} job #{job_name} container must be a string or mapping"
    end

    services = job['services']
    next if services.nil?
    unless services.is_a?(Hash)
      failures << "#{path} job #{job_name} services must be a mapping"
      next
    end
    services.each do |service_name, service|
      if service.is_a?(Hash)
        check_image(path, "service #{job_name}.#{service_name}", service['image'], failures)
      else
        failures << "#{path} service #{job_name}.#{service_name} must be a mapping with an image"
      end
    end
  end
end

warn failures.join("\n") unless failures.empty?
exit failures.empty? ? 0 : 1
RUBY
then
  failures=1
fi

exit "${failures}"

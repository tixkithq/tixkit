'use client';

export function ContractVersionSelector({
  versions,
  selected,
  onChange,
  disabled = false,
}: {
  versions: readonly string[];
  selected: string;
  onChange: (version: string) => void;
  disabled?: boolean;
}) {
  const base = `/contracts/${selected}`;
  return (
    <div>
      <label>
        Contract version
        <select
          value={selected}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        >
          {versions.map((version) => (
            <option key={version}>{version}</option>
          ))}
        </select>
      </label>
      <ul>
        {[
          ['OpenAPI JSON', 'openapi.json'],
          ['OpenAPI YAML', 'openapi.yaml'],
          ['TypeScript declarations', 'openapi.d.ts'],
          ['Webhook catalog', 'webhook-events.json'],
          ['Examples', 'examples.json'],
          ['API diff', 'api-diff.json'],
          ['Changelog', 'CHANGELOG.md'],
          ['Release manifest', 'release-manifest.json'],
          ['Checksums', 'CHECKSUMS.sha256'],
        ].map(([label, file]) => (
          <li key={file}>
            <a href={`${base}/${file}`} download>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

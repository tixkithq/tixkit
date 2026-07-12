export const LEGACY_DOCUMENTATION_REFERENCES = [
  'docs/admin-dashboard-user-guide.md',
  'docs/api-reference.md',
  'docs/clerk-setup-guide.md',
  'docs/incident-runbooks.md',
  'docs/managed-database-compatibility.md',
  'docs/pluggable-auth-guide.md',
  'docs/production-deployment-guide.md',
  'docs/temporal-operations-guide.md',
  'docs/webhook-guide.md',
  'docs/widget-embed-guide.md',
  'docs/sdk-guides/',
];

export const LEGACY_DOCUMENTATION_REDIRECTS = Object.freeze({
  '/docs/admin-dashboard-user-guide': '/operators/events',
  '/docs/api-reference': '/developers/api-fundamentals',
  '/docs/clerk-setup-guide': '/self-hosting/authentication',
  '/docs/incident-runbooks': '/operations/incidents',
  '/docs/managed-database-compatibility': '/self-hosting/databases',
  '/docs/pluggable-auth-guide': '/self-hosting/authentication',
  '/docs/production-deployment-guide': '/self-hosting/deployment',
  '/docs/sdk-guides': '/sdks/javascript',
  '/docs/sdk-guides/android': '/sdks/android',
  '/docs/sdk-guides/flutter': '/sdks/flutter',
  '/docs/sdk-guides/go': '/sdks/go',
  '/docs/sdk-guides/ios': '/sdks/ios',
  '/docs/sdk-guides/javascript': '/sdks/javascript',
  '/docs/sdk-guides/nextjs': '/sdks/nextjs',
  '/docs/sdk-guides/react-native': '/sdks/react-native',
  '/docs/sdk-guides/rust': '/sdks/rust',
  '/docs/sdk-guides/sveltekit': '/sdks/sveltekit',
  '/docs/temporal-operations-guide': '/operations/temporal',
  '/docs/webhook-guide': '/developers/webhooks/setup',
  '/docs/widget-embed-guide': '/developers/widget/embedding',
});

const HISTORICAL_EVIDENCE_SCRIPTS = [
  'scripts/validate-completion-backlog.mjs',
  'scripts/validate-final-evidence-checklist.mjs',
  'scripts/validate-high-care-ledger.mjs',
  'scripts/validate-user-story-matrix.mjs',
  'scripts/validate-validation-runbook.mjs',
];

export function isActiveRepositorySurface(path) {
  if (path.startsWith('docs/')) return path.startsWith('docs/public/');
  if (path === 'implementation-plan.md') return false;
  if (path === 'scripts/docs/generate-documentation-inventory.mjs') return false;
  if (path === 'scripts/docs/lib/legacy-references.mjs') return false;
  if (path === 'scripts/docs/check-legacy-references.mjs') return false;
  if (path === 'scripts/__tests__/legacy-documentation-references.test.mjs') return false;
  if (HISTORICAL_EVIDENCE_SCRIPTS.includes(path)) return false;
  if (
    path.startsWith('scripts/__tests__/validate-completion-backlog') ||
    path.startsWith('scripts/__tests__/validate-final-evidence-checklist') ||
    path.startsWith('scripts/__tests__/validate-high-care-ledger') ||
    path.startsWith('scripts/__tests__/validate-user-story-matrix') ||
    path.startsWith('scripts/__tests__/validate-validation-runbook')
  )
    return false;
  return (
    /^(?:apps|packages|scripts|\.github)\//.test(path) ||
    /^(?:README|ARCHITECTURE|CONTRIBUTING|SECURITY|SUPPORT|CODE_OF_CONDUCT|ROADMAP)\.md$/.test(
      path,
    ) ||
    path === 'package.json'
  );
}

export function findLegacyDocumentationReferences(files) {
  const errors = [];
  for (const { path, content } of files) {
    if (!isActiveRepositorySurface(path)) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      for (const legacyReference of LEGACY_DOCUMENTATION_REFERENCES) {
        if (lines[index].includes(legacyReference)) {
          errors.push(
            `${path}:${index + 1}: legacy documentation reference ${legacyReference}; use docs/public or a typed public route`,
          );
        }
      }
    }
  }
  return errors;
}

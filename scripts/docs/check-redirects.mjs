import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNoErrors,
  loadPublicDocuments,
  rootFromMeta,
  validateRedirects,
} from './lib/content.mjs';
import { LEGACY_DOCUMENTATION_REDIRECTS } from './lib/legacy-references.mjs';

export function checkRedirects(root) {
  const { documents, errors } = loadPublicDocuments(root);
  const redirects = JSON.parse(readFileSync(resolve(root, 'docs/redirects.json'), 'utf8'));
  const legacyRedirectErrors = Object.entries(LEGACY_DOCUMENTATION_REDIRECTS)
    .filter(([source, destination]) => redirects[source] !== destination)
    .map(
      ([source, destination]) =>
        `docs/redirects.json: required legacy redirect ${source} -> ${destination} is missing or changed`,
    );
  return [
    ...errors,
    ...legacyRedirectErrors,
    ...validateRedirects(documents, redirects, {
      // These legacy authentication guides were intentionally consolidated into one canonical task.
      allowedDuplicateDestinations: [
        '/developers/api-fundamentals',
        '/sdks/javascript',
        '/self-hosting/authentication',
      ],
    }),
  ];
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  assertNoErrors(checkRedirects(rootFromMeta(import.meta.url)), 'docs redirects');
}

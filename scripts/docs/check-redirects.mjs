import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertNoErrors,
  loadPublicDocuments,
  rootFromMeta,
  validateRedirects,
} from './lib/content.mjs';

export function checkRedirects(root) {
  const { documents, errors } = loadPublicDocuments(root);
  const redirects = JSON.parse(readFileSync(resolve(root, 'docs/redirects.json'), 'utf8'));
  return [
    ...errors,
    ...validateRedirects(documents, redirects, {
      // These legacy authentication guides were intentionally consolidated into one canonical task.
      allowedDuplicateDestinations: [
        '/developers/api-fundamentals',
        '/self-hosting/authentication',
      ],
    }),
  ];
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  assertNoErrors(checkRedirects(rootFromMeta(import.meta.url)), 'docs redirects');
}

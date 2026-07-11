import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { docRoutes } from '../../packages/docs-core/dist/index.js';
import {
  assertNoErrors,
  extractMarkdownLinks,
  loadPublicDocuments,
  rootFromMeta,
  validateDocumentLinks,
  walkFiles,
} from './lib/content.mjs';

export function checkLinks(root) {
  const { documents, errors } = loadPublicDocuments(root);
  errors.push(...validateDocumentLinks(documents));
  const publicRoutes = new Set(documents.map((document) => document.route));
  for (const [routeId, route] of Object.entries(docRoutes)) {
    if (route !== '/' && !publicRoutes.has(route))
      errors.push(`packages/docs-core/src/routes.ts: ${routeId} targets missing page ${route}`);
  }
  const markdownFiles = [
    'README.md',
    ...walkFiles(root, 'packages', (path) => path.endsWith('/README.md')),
  ];
  for (const path of markdownFiles) {
    if (!existsSync(resolve(root, path))) continue;
    for (const link of extractMarkdownLinks(readFileSync(resolve(root, path), 'utf8'))) {
      const target = link.target.split('#', 1)[0];
      if (target === '' || /^(?:https?:|mailto:|tel:)/.test(target)) continue;
      const absolute = resolve(root, path, '..', target);
      if (!existsSync(absolute)) errors.push(`${path}: broken repository link ${link.target}`);
    }
  }
  return errors;
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  assertNoErrors(checkLinks(rootFromMeta(import.meta.url)), 'docs links');

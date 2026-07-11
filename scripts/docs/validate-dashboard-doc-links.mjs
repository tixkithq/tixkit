import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dashboardHelpRegistry, docRoutes } from '../../packages/docs-core/dist/index.js';
import { assertNoErrors, loadPublicDocuments, rootFromMeta, walkFiles } from './lib/content.mjs';

export function validateDashboardDocLinks(root) {
  const { documents, errors } = loadPublicDocuments(root);
  const routes = new Set(documents.map((document) => document.route));
  for (const entry of dashboardHelpRegistry) {
    for (const routeId of [
      entry.docRouteId,
      ...entry.commonTasks.map((item) => item.docRouteId),
      ...entry.troubleshooting.map((item) => item.docRouteId),
    ]) {
      const route = docRoutes[routeId];
      if (route !== '/' && !routes.has(route))
        errors.push(
          `packages/docs-core/src/help-registry.ts: ${entry.id} targets missing page ${route}`,
        );
    }
  }
  for (const path of walkFiles(root, 'apps/admin-dashboard/src', (file) =>
    /\.(?:ts|tsx)$/.test(file),
  )) {
    if (/\.test\.(?:ts|tsx)$/.test(path)) continue;
    const source = readFileSync(resolve(root, path), 'utf8');
    if (/routes\.help\s*}\s*#developer-api|routes\.help\}#developer-api/.test(source))
      errors.push(`${path}: generic #developer-api Help link is forbidden`);
    if (
      /https?:\/\/[^'"`\s]+\/(?:getting-started|operators|developers|sdks|reference|self-hosting|operations|contributing)\//.test(
        source,
      )
    ) {
      errors.push(`${path}: use a DocRouteId instead of a hard-coded documentation URL`);
    }
  }
  return errors;
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  assertNoErrors(
    validateDashboardDocLinks(rootFromMeta(import.meta.url)),
    'dashboard documentation links',
  );

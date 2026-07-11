import { resolveDocUrl, type DocRouteId } from '@tixkit/docs-core';

const localDocsOrigin = 'http://localhost:3002';

export function dashboardDocUrl(routeId: DocRouteId): string {
  const configuredOrigin = process.env.NEXT_PUBLIC_TIXKIT_DOCS_URL?.trim();
  return resolveDocUrl(routeId, configuredOrigin || localDocsOrigin);
}

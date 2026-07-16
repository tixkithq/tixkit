import { resolveDocUrl, type DocRouteId } from '@tixkit/docs-core';
import { useRuntimeConfig } from '@/context/runtime-config-provider';
import type { PublicAdminRuntimeConfig } from './runtime-config-contract';

export function dashboardDocUrl(routeId: DocRouteId, config: PublicAdminRuntimeConfig): string {
  return resolveDocUrl(routeId, config.docsUrl);
}

export function useDashboardDocUrl(): (routeId: DocRouteId) => string {
  const config = useRuntimeConfig();
  return (routeId) => dashboardDocUrl(routeId, config);
}

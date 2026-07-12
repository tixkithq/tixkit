import type { AdoptionPath } from './content-schema.js';

const allPaths = ['sell', 'platform', 'self-hosted'] as const satisfies readonly AdoptionPath[];

const exactRoutes: Readonly<Record<string, readonly AdoptionPath[]>> = {
  '/': allPaths,
  '/getting-started/platform-overview': allPaths,
  '/getting-started/deployment-model': allPaths,
  '/getting-started/local-quickstart': ['self-hosted'],
  '/getting-started/first-event': ['sell'],
  '/getting-started/test-checkout': ['sell'],
  '/getting-started/first-api-call': ['platform'],
  '/support': allPaths,
};

const routePrefixes = [
  ['/operators/', ['sell']],
  ['/developers/', ['platform']],
  ['/sdks/', ['platform']],
  ['/reference/', ['sell', 'platform', 'self-hosted']],
  ['/self-hosting/', ['self-hosted']],
  ['/operations/', ['self-hosted']],
] as const satisfies ReadonlyArray<readonly [string, readonly AdoptionPath[]]>;

export function adoptionPathsForRoute(
  route: string,
  explicit?: readonly AdoptionPath[],
): readonly AdoptionPath[] {
  if (explicit?.length) return explicit;
  const exact = exactRoutes[route];
  if (exact) return exact;
  return routePrefixes.find(([prefix]) => route.startsWith(prefix))?.[1] ?? [];
}

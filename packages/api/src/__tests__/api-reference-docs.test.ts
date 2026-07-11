import { describe, expect, it } from 'vitest';
import { openApiSpec } from '@tixkit/openapi';

function apiReferenceScopeFor(method: string, routePath: string) {
  const normalizedPath = routePath
    .replace(/^\/v1/, '')
    .replaceAll(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
  const paths = openApiSpec.paths as unknown as Record<
    string,
    Partial<Record<string, { 'x-required-permissions'?: readonly string[] }>>
  >;
  const operation = paths[normalizedPath]?.[method.toLowerCase()];
  return operation?.['x-required-permissions'];
}

describe('API reference route scopes', () => {
  it.each([
    ['GET', '/v1/organizations'],
    ['GET', '/v1/brands'],
  ] as const)('documents %s %s as settings.write', (method, routePath) => {
    expect(apiReferenceScopeFor(method, routePath)).toEqual(['settings.write']);
  });

  it.each([
    ['POST', '/v1/webhook-events/:eventId/replay'],
    ['POST', '/v1/webhook-endpoints/:endpointId/events/:eventId/replay'],
  ] as const)('documents %s %s as developers.write', (method, routePath) => {
    expect(apiReferenceScopeFor(method, routePath)).toEqual(['developers.write']);
  });
});

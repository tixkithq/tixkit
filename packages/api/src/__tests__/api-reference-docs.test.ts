import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function repoPath(relativePath: string) {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..', relativePath);
}

function apiReferenceScopeFor(method: string, routePath: string) {
  const apiReference = readFileSync(repoPath('docs/api-reference.md'), 'utf8');
  const row = apiReference
    .split('\n')
    .find((line) => line.includes(`| \`${method}\``) && line.includes(`| \`${routePath}\``));

  if (!row) return undefined;

  const cells = row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  return cells[2]?.replace(/^`|`$/g, '');
}

describe('API reference route scopes', () => {
  it.each([
    ['GET', '/v1/organizations'],
    ['GET', '/v1/brands'],
  ] as const)('documents %s %s as settings.write', (method, routePath) => {
    expect(apiReferenceScopeFor(method, routePath)).toBe('settings.write');
  });
});

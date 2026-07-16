import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src');
const sourceExtensions = ['.ts', '.tsx'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.includes(extname(path)) &&
      !path.includes('/__tests__/') &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('.test.tsx')
      ? [path]
      : [];
  });
}

function resolveLocalImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;
  const base = specifier.startsWith('@/')
    ? resolve(sourceRoot, specifier.slice(2))
    : resolve(dirname(importer), specifier);
  for (const candidate of [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => resolve(base, `index${extension}`)),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function clientImportClosure(): Set<string> {
  const roots = sourceFiles(sourceRoot).filter((file) =>
    /^['"]use client['"];?/u.test(readFileSync(file, 'utf8').trimStart()),
  );
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /import\s+(?!type\b)[\s\S]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/gu,
    )) {
      const resolved = resolveLocalImport(file, match[1] ?? match[2] ?? '');
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return visited;
}

function importClosure(roots: string[]): Set<string> {
  const visited = new Set<string>();
  const pending = roots.map((file) => resolve(sourceRoot, file));
  while (pending.length) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /import\s+(?!type\b)[\s\S]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/gu,
    )) {
      const resolved = resolveLocalImport(file, match[1] ?? match[2] ?? '');
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return visited;
}

describe('checkout immutable runtime boundary', () => {
  it('waits for a request before parsing runtime configuration', () => {
    const source = readFileSync(resolve(sourceRoot, 'app/layout.tsx'), 'utf8');
    expect(source.indexOf('await connection()')).toBeGreaterThan(0);
    expect(source.indexOf('parseCheckoutRuntimeConfig()')).toBeGreaterThan(
      source.indexOf('await connection()'),
    );
    expect(source).toContain("export const dynamic = 'force-dynamic'");
  });

  it('keeps deployment and Node-only configuration out of the complete client import graph', () => {
    const closure = clientImportClosure();
    expect(closure.size).toBeGreaterThan(20);
    for (const file of closure) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/runtime-config-server|api-server|node:/u);
      expect(source, file).not.toContain('NEXT_PUBLIC_');
      expect(source.replaceAll('process.env.NODE_ENV', ''), file).not.toContain('process.env');
      expect(source, file).not.toContain('INTERNAL_API_BASE_URL');
    }
  });

  it('keeps server-safe runtime and host helpers out of the client module graph', () => {
    const closure = importClosure([
      'lib/hosts.ts',
      'lib/api-server.ts',
      'lib/runtime-config-server.ts',
    ]);
    for (const file of closure) {
      const source = readFileSync(file, 'utf8').trimStart();
      expect(source, file).not.toMatch(/^['"]use client['"]/u);
      expect(source, file).not.toContain('runtime-config-browser');
    }
  });
});

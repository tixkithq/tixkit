import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceRoot = resolve(process.cwd(), 'src');
const sourceExtensions = ['.ts', '.tsx'] as const;

function sourceFiles(directory = sourceRoot): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : sourceExtensions.includes(extname(path) as (typeof sourceExtensions)[number]) &&
          !path.endsWith('.test.ts') &&
          !path.endsWith('.test.tsx')
        ? [path]
        : [];
  });
}

function resolveSourceImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return undefined;
  const base = specifier.startsWith('@/')
    ? resolve(sourceRoot, specifier.slice(2))
    : resolve(dirname(importer), specifier);
  for (const candidate of [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => resolve(base, `index${extension}`)),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next supported source form.
    }
  }
  return undefined;
}

function localImports(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const imports = [
    ...source.matchAll(/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu),
    ...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/gu),
  ];
  return imports
    .map((match) => resolveSourceImport(path, match[1] ?? ''))
    .filter((candidate): candidate is string => Boolean(candidate));
}

function closure(roots: readonly string[]): Set<string> {
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    pending.push(...localImports(path));
  }
  return visited;
}

describe('admin client runtime boundary', () => {
  it('keeps every client import closure free of server and internal runtime modules', () => {
    const clientRoots = sourceFiles().filter((path) =>
      /^\s*['"]use client['"];?/u.test(readFileSync(path, 'utf8')),
    );
    expect(clientRoots.length).toBeGreaterThan(0);
    for (const path of closure(clientRoots)) {
      const name = relative(sourceRoot, path);
      const source = readFileSync(path, 'utf8');
      expect(name).not.toMatch(/(?:^|\/)(?:runtime-config-server|auth-server|api-server)\.ts$/u);
      expect(source).not.toContain('INTERNAL_API_BASE_URL');
      expect(source).not.toMatch(/from\s+['"]node:/u);
    }
  });

  it('keeps server runtime closures free of client modules', () => {
    const serverRoots = ['runtime-config-server.ts', 'auth-server.ts', 'api-server.ts'].map(
      (file) => resolve(sourceRoot, 'lib', file),
    );
    for (const path of closure(serverRoots)) {
      expect(readFileSync(path, 'utf8'), relative(sourceRoot, path)).not.toMatch(
        /^\s*['"]use client['"];?/u,
      );
    }
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isTemplateKey } from '@tixkit/domain';

const REPO_ROOT = resolve(new URL('../../../../', import.meta.url).pathname);
const SOURCE_ROOTS = ['packages/workflows/src', 'packages/api/src'];
const TEMPLATE_KEY_LITERAL = /templateKey:\s*(['"])([^'"]+)\1/g;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === '__tests__') continue;
      files.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry) || /\.(test|spec)\.(ts|tsx)$/.test(entry)) continue;
    files.push(path);
  }
  return files;
}

describe('template key registry drift guard', () => {
  it('keeps production templateKey literals registered in the domain lifecycle registry', () => {
    const invalid: string[] = [];

    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(resolve(REPO_ROOT, root))) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(TEMPLATE_KEY_LITERAL)) {
          const key = match[2];
          if (!isTemplateKey(key)) {
            invalid.push(`${relative(REPO_ROOT, file)}: ${key}`);
          }
        }
      }
    }

    expect(invalid).toEqual([]);
  });
});

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { assertNoErrors, rootFromMeta } from './lib/content.mjs';
import { findLegacyDocumentationReferences } from './lib/legacy-references.mjs';

export function checkLegacyReferences(root) {
  let paths;
  try {
    paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    const ignoredDirectories = new Set([
      '.git',
      '.next',
      '.turbo',
      'coverage',
      'dist',
      'node_modules',
      'out',
      'playwright-report',
      'test-results',
    ]);
    const discovered = [];
    const visit = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        const absolutePath = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(absolutePath);
        else if (entry.isFile()) discovered.push(relative(root, absolutePath));
      }
    };
    visit(root);
    paths = discovered;
  }
  paths.sort();
  const files = paths.flatMap((path) => {
    try {
      return [{ path, content: readFileSync(resolve(root, path), 'utf8') }];
    } catch {
      return [];
    }
  });
  return findLegacyDocumentationReferences(files);
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  assertNoErrors(checkLegacyReferences(rootFromMeta(import.meta.url)), 'legacy docs references');

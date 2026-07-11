import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { assertNoErrors, rootFromMeta } from './lib/content.mjs';

const SEARCH_GZIP_BUDGET_BYTES = 150 * 1024;

export function checkDocsPerformance(root) {
  const errors = [];
  const searchIndex = readFileSync(resolve(root, 'apps/docs/public/search-index.json'));
  const compressedSearchBytes = gzipSync(searchIndex).byteLength;
  if (compressedSearchBytes > SEARCH_GZIP_BUDGET_BYTES) {
    errors.push(
      `apps/docs/public/search-index.json: gzip size ${compressedSearchBytes} exceeds ${SEARCH_GZIP_BUDGET_BYTES}`,
    );
  }

  for (const path of [
    'apps/docs/src/app/layout.tsx',
    'apps/docs/src/components/docs-header.tsx',
    'apps/docs/src/components/search-dialog.tsx',
  ]) {
    const source = readFileSync(resolve(root, path), 'utf8');
    if (/openapi-reference|generated\/openapi/i.test(source)) {
      errors.push(`${path}: global documentation shell must not load the generated API reference`);
    }
  }
  return errors;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  assertNoErrors(checkDocsPerformance(rootFromMeta(import.meta.url)), 'docs performance');
}

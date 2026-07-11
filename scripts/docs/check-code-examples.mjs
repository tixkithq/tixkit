import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertNoErrors, loadPublicDocuments, readJson, rootFromMeta } from './lib/content.mjs';

const fencePattern = /```([^\n]*)\n([\s\S]*?)```/g;
const forbidden = [
  [/\b(?:TODO|TBD|placeholder|implement logic|rest of code here)\b/i, 'placeholder marker'],
  [/\btk_[a-f0-9]{24,}\b/i, 'credential-like API key'],
  [/\bwhsec_[A-Za-z0-9]{16,}\b/, 'credential-like webhook secret'],
  [/(?:sk_live|pk_live)_[A-Za-z0-9]{16,}/, 'live payment credential'],
];

export function checkCodeExamples(root) {
  const { documents, errors } = loadPublicDocuments(root);
  const rootPackage = readJson(resolve(root, 'package.json'));
  for (const document of documents) {
    for (const match of document.body.matchAll(fencePattern)) {
      const info = match[1].trim();
      const code = match[2];
      if (info === '') errors.push(`${document.path}: fenced code block is missing a language`);
      for (const [pattern, label] of forbidden)
        if (pattern.test(code)) errors.push(`${document.path}: code block contains ${label}`);
      if (/^(?:bash|sh|shell)(?:\s|$)/.test(info)) {
        for (const command of code.matchAll(/\bbun run ([a-zA-Z0-9:_-]+)/g)) {
          if (
            !Object.hasOwn(rootPackage.scripts ?? {}, command[1]) &&
            !command[1].startsWith('--filter')
          ) {
            errors.push(`${document.path}: documents unknown root script bun run ${command[1]}`);
          }
        }
      }
    }
  }
  const cliSource = readFileSync(resolve(root, 'packages/cli/src/index.ts'), 'utf8');
  const cliReadme = readFileSync(resolve(root, 'packages/cli/README.md'), 'utf8');
  for (const command of [
    'quickstart',
    'setup:check',
    'init',
    'seed:sample-data',
    'dev:webhooks',
    'embed:generate',
  ]) {
    if (!cliSource.includes(command))
      errors.push(`packages/cli/src/index.ts: missing required command ${command}`);
    if (!cliReadme.includes(command))
      errors.push(`packages/cli/README.md: missing documented command ${command}`);
  }
  return errors;
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  assertNoErrors(checkCodeExamples(rootFromMeta(import.meta.url)), 'docs code examples');

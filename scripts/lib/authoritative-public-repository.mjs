import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validatePublicDistribution } from './public-distribution.mjs';

const authoritativeRepository = 'github.com/tixkit/tixkit';
const forbiddenTrackedPaths = [
  'CLAUDE.md',
  'implementation-plan.md',
  'managed/',
  'docs/completion/',
  'docs/internal/',
  'scripts/__tests__/export-oss.test.mjs',
  'scripts/__tests__/repository-cutover-rehearsal.test.mjs',
  'scripts/__tests__/repository-history-cutover.test.mjs',
  'scripts/__tests__/repository-content-review.test.mjs',
  'scripts/export-oss.mjs',
  'scripts/rehearse-repository-cutover.mjs',
  'scripts/rehearse-repository-history-cutover.mjs',
  'scripts/validate-repository-content-review.mjs',
];

function sourceTokens(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    const next = source[index + 1];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      index = source.indexOf('\n', index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1)
        throw new Error('authoritative OpenAPI source contains an unterminated comment');
      index = end + 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
          value += source[index + 1] ?? '';
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      if (source[index] !== quote)
        throw new Error('authoritative OpenAPI source contains an unterminated string');
      tokens.push({ kind: 'string', value });
      index += 1;
      continue;
    }
    if (character === '`') {
      index += 1;
      while (index < source.length && source[index] !== '`')
        index += source[index] === '\\' ? 2 : 1;
      if (source[index] !== '`')
        throw new Error('authoritative OpenAPI source contains an unterminated template literal');
      index += 1;
      continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][\w$]*/u)?.[0];
    if (identifier) {
      tokens.push({ kind: 'identifier', value: identifier });
      index += identifier.length;
      continue;
    }
    tokens.push({ kind: 'punctuation', value: character });
    index += 1;
  }
  return tokens;
}

function declaredRawOpenApiVersion(tokens, declarationIndex) {
  if (tokens[declarationIndex + 2]?.value !== '=' || tokens[declarationIndex + 3]?.value !== '{')
    throw new Error('rawOpenApiSpec must be declared as an object literal');
  let depth = 1;
  let infoDepth;
  let infoCount = 0;
  let version;
  let versionCount = 0;
  for (let index = declarationIndex + 4; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === '{') depth += 1;
    else if (token.value === '}') {
      if (depth === infoDepth) infoDepth = undefined;
      depth -= 1;
      if (depth === 0) break;
    }
    const isSpread =
      token.value === '.' && tokens[index + 1]?.value === '.' && tokens[index + 2]?.value === '.';
    const isComputedProperty = token.value === '[' && ['{', ','].includes(tokens[index - 1]?.value);
    if ((depth === 1 || depth === infoDepth) && (isSpread || isComputedProperty))
      throw new Error('rawOpenApiSpec info must use a canonical property-only object shape');
    if (
      depth === 1 &&
      token.value === 'info' &&
      tokens[index + 1]?.value === ':' &&
      tokens[index + 2]?.value === '{'
    ) {
      infoCount += 1;
      if (infoCount !== 1) throw new Error('rawOpenApiSpec must declare one canonical info object');
      infoDepth = 2;
      continue;
    }
    if (depth === 1 && token.value === 'info')
      throw new Error('rawOpenApiSpec must declare one canonical info object');
    if (
      infoDepth !== undefined &&
      depth === infoDepth &&
      token.value === 'version' &&
      tokens[index + 1]?.value === ':' &&
      tokens[index + 2]?.kind === 'string'
    ) {
      versionCount += 1;
      version = tokens[index + 2].value;
      if (versionCount !== 1)
        throw new Error('rawOpenApiSpec info must declare one canonical version');
    } else if (infoDepth !== undefined && depth === infoDepth && token.value === 'version') {
      throw new Error('rawOpenApiSpec info must declare one canonical version');
    }
  }
  if (infoCount !== 1 || versionCount !== 1)
    throw new Error('rawOpenApiSpec must declare one canonical info version');
  return version;
}

function git(root, arguments_, options = {}) {
  return execFileSync('/usr/bin/git', arguments_, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    env: { ...process.env, ...options.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
}

export function canonicalGitHubRepository(remote) {
  const value = remote.trim().replace(/\.git$/u, '');
  const match = value.match(
    /^(?:https:\/\/|ssh:\/\/git@|git@)(github\.com)(?::|\/)([^/]+\/[^/]+)$/u,
  );
  if (!match) return undefined;
  return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
}

export function authoritativeApiVersion(root) {
  const source = readFileSync(resolve(root, 'packages/openapi/src/index.ts'), 'utf8');
  const tokens = sourceTokens(source);
  const declarations = tokens
    .map((token, index) =>
      token.value === 'const' && tokens[index + 1]?.value === 'rawOpenApiSpec' ? index : -1,
    )
    .filter((index) => index >= 0);
  if (declarations.length !== 1)
    throw new Error('authoritative OpenAPI source must declare rawOpenApiSpec exactly once');
  const version = declaredRawOpenApiVersion(tokens, declarations[0]);
  if (!version?.match(/^\d{4}-\d{2}-\d{2}$/u))
    throw new Error('authoritative OpenAPI source does not declare a date API version');
  const distribution = JSON.parse(
    readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
  );
  const activeContract = distribution.release?.contracts?.[0];
  if (activeContract !== `artifacts/api/${version}`)
    throw new Error(
      `authoritative OpenAPI source version ${version} differs from the first release contract ${String(activeContract)}`,
    );
  for (const path of ['apps/docs/public/openapi.json', `${activeContract}/openapi.json`]) {
    const generatedVersion = JSON.parse(readFileSync(resolve(root, path), 'utf8')).info?.version;
    if (generatedVersion !== version)
      throw new Error(
        `authoritative OpenAPI source version ${version} differs from generated ${path} version ${String(generatedVersion)}`,
      );
  }
  return version;
}

export function assertSecureGitProvenanceRoot(root) {
  const replacementReferences = git(root, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/replace',
  ]).trim();
  if (replacementReferences)
    throw new Error('API release provenance forbids Git replacement references');
  const flaggedPaths = git(root, ['ls-files', '-v', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((entry) => entry[0] === 'S' || entry[0] === entry[0].toLowerCase())
    .map((entry) => entry.slice(2));
  if (flaggedPaths.length > 0)
    throw new Error(
      `API release provenance forbids assume-unchanged or skip-worktree paths: ${flaggedPaths.join(', ')}`,
    );
}

export function assertAuthoritativePublicRepository(root) {
  assertSecureGitProvenanceRoot(root);
  const origin = git(root, ['remote', 'get-url', 'origin']).trim();
  if (canonicalGitHubRepository(origin) !== authoritativeRepository)
    throw new Error(
      `API release provenance may be rebound only in ${authoritativeRepository}, not ${origin}`,
    );
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
  );
  const nonPublicClassifications = [
    ...(manifest.classification?.topLevel?.privateCloud ?? []),
    ...(manifest.classification?.topLevel?.internalPlanning ?? []),
    ...(manifest.classification?.docs?.internalPlanning ?? []),
    ...(manifest.classification?.historical?.privateCloud ?? []),
    ...(manifest.classification?.historical?.internalPlanning ?? []),
  ];
  if (nonPublicClassifications.length > 0)
    throw new Error('API release provenance rebinding requires a public-only classification');
  const trackedPaths = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const forbidden = trackedPaths.filter((path) =>
    forbiddenTrackedPaths.some((entry) =>
      entry.endsWith('/') ? path.startsWith(entry) : path === entry,
    ),
  );
  if (forbidden.length > 0)
    throw new Error(
      `API release provenance rebinding found private or transitional paths: ${forbidden.join(', ')}`,
    );
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status !== '')
    throw new Error('API release provenance rebinding requires a clean authoritative public tree');
  validatePublicDistribution(manifest, root);
}

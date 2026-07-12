import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const ZERO_OBJECT = /^0+$/u;
const RAW_CHANGE = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*$/u;
const SECRET_PATTERNS = [
  ['aws-access-key', /(?:AKIA|ASIA)[0-9A-Z]{16}/gu],
  ['github-token', /(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/gu],
  ['npm-token', /npm_[A-Za-z0-9]{20,}/gu],
  ['stripe-api-key', /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}/gu],
  ['stripe-webhook-secret', /whsec_[A-Za-z0-9_]{16,}/gu],
  ['tixkit-api-key', /tk_(?:live|test)_[A-Za-z0-9_-]{16,}/gu],
  ['private-key', /-----BEGIN (?:EC |ENCRYPTED |OPENSSH |RSA )?PRIVATE KEY-----/gu],
];
// Reviewed deterministic safety-test fixtures. Store only fingerprints so the
// allowlist cannot become a credential disclosure surface.
const KNOWN_FIXTURE_DIGESTS = new Set([
  '1a5d44a2dca19669d72edf4c4f1c27c4c1ca4b4408fbb17f6ce4ad452d78ddb3',
  '4c1da690e2f8b9c80f263b406145bedf1d42485bbc0062778683ac6c0c402b6b',
  '738f70854d93671dff564ed455a66562cf259b6f9a11f85ce44db6c6b1acc6ea',
  '9577070e9b4a71d5e361ab242d6d6b92043ccad9a459e12a4aa151c56fd5b5c2',
]);

function git(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    input: options.input,
    maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function matchesRoot(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

export function classifyHistoricalPath(manifest, path) {
  for (const [classification, paths] of Object.entries(manifest.classification.historical))
    if (paths.includes(path)) return classification;
  if (path.startsWith('docs/')) {
    for (const [classification, roots] of Object.entries(manifest.classification.docs))
      if (roots.some((root) => matchesRoot(path, root))) return classification;
    return undefined;
  }
  for (const [classification, roots] of Object.entries(manifest.classification.topLevel))
    if (roots.some((root) => matchesRoot(path, root))) return classification;
  if (manifest.classification.generatedRoots.some((root) => matchesRoot(path, root)))
    return 'generated';
  return undefined;
}

export function parseRawHistory(output) {
  const tokens = output.split('\0').filter(Boolean);
  const blobs = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const metadata = tokens[index];
    const path = tokens[index + 1];
    const match = metadata.match(RAW_CHANGE);
    if (!match || path === undefined)
      throw new Error(`unsupported raw history record at token ${index}`);
    for (const objectId of [match[3], match[4]]) {
      if (ZERO_OBJECT.test(objectId)) continue;
      const paths = blobs.get(objectId) ?? new Set();
      paths.add(path);
      blobs.set(objectId, paths);
    }
  }
  return blobs;
}

function blobMetadata(root, objectIds) {
  if (objectIds.length === 0) return [];
  const output = git(
    root,
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    {
      input: `${objectIds.join('\n')}\n`,
    },
  );
  const records = output.trim().split('\n');
  if (records.length !== objectIds.length) throw new Error('Git blob metadata count mismatch');
  return records.map((record, index) => {
    const match = record.match(/^([0-9a-f]{40,64}) (\S+) (\d+)$/u);
    if (!match || match[1] !== objectIds[index] || match[2] !== 'blob')
      throw new Error(`unexpected Git object metadata: ${record}`);
    return { objectId: match[1], size: Number.parseInt(match[3], 10) };
  });
}

function parseBatchContent(output, metadata) {
  const contents = new Map();
  let offset = 0;
  for (const expected of metadata) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) throw new Error('truncated Git blob batch header');
    const header = output.subarray(offset, newline).toString('utf8');
    const match = header.match(/^([0-9a-f]{40,64}) blob (\d+)$/u);
    if (!match || match[1] !== expected.objectId || Number(match[2]) !== expected.size)
      throw new Error(`unexpected Git blob batch header: ${header}`);
    const start = newline + 1;
    const end = start + expected.size;
    if (end >= output.length || output[end] !== 0x0a)
      throw new Error(`truncated Git blob content: ${expected.objectId}`);
    contents.set(expected.objectId, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error('unexpected trailing Git blob batch content');
  return contents;
}

function readBlobBatch(root, metadata) {
  const expectedBytes = metadata.reduce((total, entry) => total + entry.size + 128, 0);
  const output = git(root, ['cat-file', '--batch'], {
    encoding: 'buffer',
    input: Buffer.from(`${metadata.map(({ objectId }) => objectId).join('\n')}\n`),
    maxBuffer: expectedBytes + 1024,
  });
  return parseBatchContent(output, metadata);
}

export function highConfidenceSecretKinds(content) {
  const text = content.toString('utf8');
  const kinds = new Set();
  for (const [kind, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern))
      if (!KNOWN_FIXTURE_DIGESTS.has(sha256(match[0]))) kinds.add(kind);
  }
  return [...kinds].sort();
}

function publicationRefs(root) {
  const refs = git(root, ['show-ref', '--head', '--dereference'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((record) => {
      const [objectId, ref] = record.split(' ');
      return { ref, objectId };
    })
    .filter(({ ref }) => ref === 'HEAD' || (ref.startsWith('refs/tags/') && !ref.endsWith('^{}')));
  if (refs.filter(({ ref }) => ref === 'HEAD').length !== 1)
    throw new Error('repository history audit requires exactly one HEAD ref');
  return refs.sort((left, right) =>
    left.ref === 'HEAD' ? -1 : right.ref === 'HEAD' ? 1 : left.ref.localeCompare(right.ref),
  );
}

function batches(metadata, maximumBytes = 32 * 1024 * 1024) {
  const output = [];
  let current = [];
  let size = 0;
  for (const entry of metadata) {
    if (current.length > 0 && size + entry.size > maximumBytes) {
      output.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += entry.size;
  }
  if (current.length > 0) output.push(current);
  return output;
}

export function auditRepositoryHistory(root, manifest) {
  if (manifest.classification.historyValidation !== 'full')
    throw new Error('repository history audit requires full history validation mode');
  if (manifest.classification.historyScope !== 'head-and-tags')
    throw new Error('repository history audit requires head-and-tags publication scope');
  const shallow = git(root, ['rev-parse', '--is-shallow-repository']).trim();
  if (shallow !== 'false') throw new Error('repository history audit requires complete ancestry');
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=all']) !== '')
    throw new Error('repository history audit requires a clean worktree');

  const refs = publicationRefs(root);
  const scopeObjectIds = [...new Set(refs.map(({ objectId }) => objectId))];
  const raw = git(root, [
    'log',
    ...scopeObjectIds,
    '--root',
    '--raw',
    '--diff-merges=separate',
    '--no-abbrev',
    '--no-renames',
    '--format=',
    '-z',
  ]);
  const blobPaths = parseRawHistory(raw);
  const objectIds = [...blobPaths.keys()].sort();
  const metadata = blobMetadata(root, objectIds);
  const findings = [];
  const classificationCounts = {};
  let scannedBytes = 0;

  for (const batch of batches(metadata)) {
    const contents = readBlobBatch(root, batch);
    for (const entry of batch) {
      const content = contents.get(entry.objectId);
      scannedBytes += content.length;
      const classifications = [
        ...new Set(
          [...blobPaths.get(entry.objectId)].map((path) => classifyHistoricalPath(manifest, path)),
        ),
      ].sort();
      for (const classification of classifications)
        classificationCounts[classification ?? 'unclassified'] =
          (classificationCounts[classification ?? 'unclassified'] ?? 0) + 1;
      const secretKinds = highConfidenceSecretKinds(content);
      if (classifications.includes(undefined) || secretKinds.length > 0)
        findings.push({
          objectId: entry.objectId,
          classifications: classifications.map((value) => value ?? 'unclassified'),
          secretKinds,
          pathCount: blobPaths.get(entry.objectId).size,
        });
    }
  }

  const commitCount = Number.parseInt(
    git(root, ['rev-list', ...scopeObjectIds, '--count']).trim(),
    10,
  );
  const result = {
    schemaVersion: 1,
    auditKind: 'classified-history-and-high-confidence-credentials',
    scopeLimitations: [
      'Customer-data and proprietary-content review requires separate rewritten-public-history proof.',
    ],
    status: findings.length === 0 ? 'pass' : 'fail',
    historyValidation: 'full',
    historyScope: 'head-and-tags',
    sourceCommit: refs[0].objectId,
    sourceTree: git(root, ['rev-parse', `${refs[0].objectId}^{tree}`]).trim(),
    publicationRefs: refs,
    publicationRefDigest: sha256(JSON.stringify(canonical(refs))),
    commitCount,
    uniqueBlobCount: metadata.length,
    scannedBytes,
    classificationCounts: canonical(classificationCounts),
    findings,
  };
  return { ...result, auditDigest: sha256(JSON.stringify(canonical(result))) };
}

export function safeHistoryAuditOutput(path) {
  const output = resolve(path);
  if (lstatSync(output, { throwIfNoEntry: false }))
    throw new Error('history audit output must not already exist');
  let ancestor = dirname(output);
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = dirname(ancestor);
  const canonicalOutput = resolve(realpathSync(ancestor), relative(ancestor, output));
  const allowedRoots = [realpathSync(tmpdir()), realpathSync('/tmp')];
  if (!allowedRoots.some((allowed) => canonicalOutput.startsWith(`${allowed}${sep}`)))
    throw new Error('history audit output must be a child of the system temporary directory');
  return canonicalOutput;
}

export function secureHistoryAuditReport(path) {
  chmodSync(path, 0o600);
}

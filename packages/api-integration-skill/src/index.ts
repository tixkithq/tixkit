import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

const API_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CHECKSUM_LINE_PATTERN = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u;
const GENERATED_CHECKSUM_LINE_PATTERN =
  /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*)$/u;
const GENERATOR_MARKER = '@tixkit/api-integration-skill:local-evaluation:v1';
const REQUIRED_RELEASE_ARTIFACTS = [
  'openapi.json',
  'examples.json',
  'webhook-events.json',
] as const;
const SECRET_PATTERNS = [
  /\bsk_(?:live|test)_[A-Za-z0-9]{12,}\b/u,
  /\bwhsec_[A-Za-z0-9]{12,}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\b(?:Basic|Bearer)\s+(?!<(?:token|redacted)>)(?=[A-Za-z0-9+/._~=-]{20,}\b)(?=[A-Za-z0-9+/._~=-]*[0-9+/._~=-])[A-Za-z0-9+/._~=-]+\b/iu,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/iu,
] as const;
const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|private[_-]?key|authorization|credential|secret)$/iu;
const SAFE_PLACEHOLDER_PATTERN =
  /^(?:<[^>]+>|\$\{?[A-Z][A-Z0-9_]*\}?|(?:[A-Za-z0-9_-]+\s+)?example|placeholder|redacted|test|none)$/iu;

type JsonObject = Record<string, unknown>;

type PermissionClause = Readonly<{
  discriminator?: string;
  kind: 'all-of' | 'any-of' | 'base' | 'conditional';
  permissions: string[];
  value?: string;
}>;

type ReleaseArtifact = {
  name: string;
  sha256: string;
  size: number;
};

type ReleaseManifest = {
  apiVersion: string;
  releaseVersion: string;
  publication: string;
  provenance?: { publishable?: boolean; worktreeState?: string };
  artifacts: ReleaseArtifact[];
};

export type GenerateTixkitApiSkillInput = {
  releaseRoot: string;
  apiVersion: string;
  outputRoot: string;
  allowLocalEvaluation?: boolean;
  expectedReleaseManifestSha256: string;
};

export type GeneratedTixkitApiSkill = {
  apiVersion: string;
  directory: string;
  localEvaluation: boolean;
  releaseManifestSha256: string;
  openApiSha256: string;
};

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseJsonObject(contents: string, name: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return parsed as JsonObject;
}

function assertSafeVersion(version: string): void {
  if (!API_VERSION_PATTERN.test(version)) {
    throw new Error('API version must use the YYYY-MM-DD format');
  }
  const parsed = new Date(`${version}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== version) {
    throw new Error('API version must be a real calendar date');
  }
}

function childPath(root: string, ...segments: string[]): string {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, ...segments);
  const child = relative(absoluteRoot, candidate);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error('Generated or release path escapes its configured root');
  }
  return candidate;
}

function parseChecksums(
  contents: string,
  pattern: RegExp = CHECKSUM_LINE_PATTERN,
): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of contents.trim().split('\n')) {
    const match = pattern.exec(line);
    if (!match) throw new Error('CHECKSUMS.sha256 contains an invalid entry');
    const [, digest, name] = match;
    if (!digest || !name || checksums.has(name)) {
      throw new Error('CHECKSUMS.sha256 contains a missing or duplicate entry');
    }
    checksums.set(name, digest);
  }
  return checksums;
}

function assertNoSecrets(name: string, contents: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(contents))) {
    throw new Error(`${name} contains secret-like material and cannot enter an integration skill`);
  }
}

function assertNoJsonSecrets(name: string, value: unknown, key = ''): void {
  if (typeof value === 'string') {
    assertNoSecrets(name, value);
    for (const match of value.matchAll(/\btk_([A-Za-z0-9_-]{16,})\b/gu)) {
      const material = match[1] ?? '';
      if (!/^(?:agent_)?(.)\1+$/u.test(material)) {
        throw new Error(
          `${name} contains secret-like material and cannot enter an integration skill`,
        );
      }
    }
    if (
      SENSITIVE_KEY_PATTERN.test(key) &&
      value.length >= 12 &&
      !SAFE_PLACEHOLDER_PATTERN.test(value)
    ) {
      throw new Error(
        `${name} contains secret-like material and cannot enter an integration skill`,
      );
    }
    try {
      const url = new URL(value);
      if (url.username || url.password) {
        throw new Error(
          `${name} contains secret-like material and cannot enter an integration skill`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('secret-like material')) throw error;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoJsonSecrets(name, item, key);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      assertNoJsonSecrets(name, childValue, childKey);
    }
  }
}

async function assertRegularFileWithin(root: string, path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error(`${label} escapes its configured root`);
  }
}

async function assertDirectoryNotSymlink(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  return realpath(path);
}

async function assertTreeHasNoSymlinks(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Generated skill tree cannot contain symlinks');
    if (entry.isDirectory()) await assertTreeHasNoSymlinks(path);
    else if (!entry.isFile())
      throw new Error('Generated skill tree may contain only regular files');
  }
}

async function treeFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Generated skill tree cannot contain symlinks');
    if (entry.isDirectory()) files.push(...(await treeFiles(path, relativePath)));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error('Generated skill tree may contain only regular files');
  }
  return files.sort();
}

async function validateOwnedGeneratedOutput(
  directory: string,
  apiVersion: string,
  sourceReleaseManifestSha256: string,
): Promise<void> {
  const manifestPath = resolve(directory, 'artifact-manifest.json');
  const checksumsPath = resolve(directory, 'CHECKSUMS.sha256');
  await assertRegularFileWithin(directory, manifestPath, 'artifact-manifest.json');
  await assertRegularFileWithin(directory, checksumsPath, 'CHECKSUMS.sha256');
  const manifestBytes = await readFile(manifestPath, 'utf8');
  const manifest = parseJsonObject(manifestBytes, 'artifact-manifest.json');
  if (
    manifest.schemaVersion !== 1 ||
    manifest.generator !== GENERATOR_MARKER ||
    manifest.apiVersion !== apiVersion ||
    manifest.generationMode !== 'local-evaluation' ||
    manifest.sourceReleaseManifestSha256 !== sourceReleaseManifestSha256 ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error('Existing generated skill output is not owned by this generator');
  }
  const checksums = parseChecksums(
    await readFile(checksumsPath, 'utf8'),
    GENERATED_CHECKSUM_LINE_PATTERN,
  );
  const names = new Set<string>();
  for (const candidate of manifest.artifacts) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Existing generated skill artifact manifest is invalid');
    }
    const artifact = candidate as JsonObject;
    const name = stringProperty(artifact, 'name', 'artifact');
    const digest = stringProperty(artifact, 'sha256', 'artifact');
    const size = artifact.size;
    if (
      !GENERATED_CHECKSUM_LINE_PATTERN.test(`${digest}  ${name}`) ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      names.has(name)
    ) {
      throw new Error('Existing generated skill artifact manifest is invalid');
    }
    names.add(name);
    const artifactPath = childPath(directory, ...name.split('/'));
    await assertRegularFileWithin(directory, artifactPath, name);
    const bytes = await readFile(artifactPath);
    if (bytes.byteLength !== size || sha256(bytes) !== digest || checksums.get(name) !== digest) {
      throw new Error(`Existing generated skill artifact ${name} failed integrity validation`);
    }
  }
  if (checksums.get('artifact-manifest.json') !== sha256(manifestBytes)) {
    throw new Error('Existing generated skill artifact manifest checksum does not match');
  }
  const expectedFiles = [...names, 'artifact-manifest.json', 'CHECKSUMS.sha256'].sort();
  const expectedChecksums = [...names, 'artifact-manifest.json'].sort();
  if (
    JSON.stringify(await treeFiles(directory)) !== JSON.stringify(expectedFiles) ||
    JSON.stringify([...checksums.keys()].sort()) !== JSON.stringify(expectedChecksums)
  ) {
    throw new Error('Existing generated skill output inventory is incomplete or contains extras');
  }
}

function stringProperty(value: JsonObject, key: string, name: string): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || !candidate) throw new Error(`${name}.${key} is required`);
  return candidate;
}

function releaseArtifacts(value: JsonObject): ReleaseArtifact[] {
  if (!Array.isArray(value.artifacts))
    throw new Error('release-manifest.json.artifacts is required');
  const names = new Set<string>();
  return value.artifacts.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('release-manifest.json contains an invalid artifact');
    }
    const artifact = candidate as JsonObject;
    const name = stringProperty(artifact, 'name', 'artifact');
    const digest = stringProperty(artifact, 'sha256', 'artifact');
    const size = artifact.size;
    if (!CHECKSUM_LINE_PATTERN.test(`${digest}  ${name}`) || typeof size !== 'number' || size < 0) {
      throw new Error(`release-manifest.json contains invalid metadata for ${name}`);
    }
    if (names.has(name))
      throw new Error(`release-manifest.json contains duplicate artifact ${name}`);
    names.add(name);
    return { name, sha256: digest, size };
  });
}

function normalizeManifest(value: JsonObject): ReleaseManifest {
  const provenance = value.provenance;
  return {
    apiVersion: stringProperty(value, 'apiVersion', 'release-manifest.json'),
    releaseVersion: stringProperty(value, 'releaseVersion', 'release-manifest.json'),
    publication: stringProperty(value, 'publication', 'release-manifest.json'),
    provenance:
      provenance && typeof provenance === 'object' && !Array.isArray(provenance)
        ? {
            publishable:
              typeof (provenance as JsonObject).publishable === 'boolean'
                ? ((provenance as JsonObject).publishable as boolean)
                : undefined,
            worktreeState:
              typeof (provenance as JsonObject).worktreeState === 'string'
                ? ((provenance as JsonObject).worktreeState as string)
                : undefined,
          }
        : undefined,
    artifacts: releaseArtifacts(value),
  };
}

function parsePermissionMetadata(
  value: unknown,
  declared: boolean,
): Readonly<{
  permissionClauses: PermissionClause[];
  permissions: string[];
  valid: boolean;
}> {
  if (!declared) return { permissionClauses: [], permissions: [], valid: true };

  const validPermissions = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.every((permission) => typeof permission === 'string' && permission.length > 0) &&
    new Set(candidate).size === candidate.length;
  const result = (permissionClauses: PermissionClause[]) => ({
    permissionClauses,
    permissions: [...new Set(permissionClauses.flatMap((clause) => clause.permissions))],
    valid: true,
  });

  if (Array.isArray(value)) {
    return validPermissions(value)
      ? result(value.length > 0 ? [{ kind: 'all-of', permissions: [...value] }] : [])
      : { permissionClauses: [], permissions: [], valid: false };
  }
  if (!value || typeof value !== 'object') {
    return { permissionClauses: [], permissions: [], valid: false };
  }

  const record = value as JsonObject;
  const allowedKeys = new Set(['allOf', 'anyOf', 'base', 'byType']);
  if (
    Object.keys(record).length === 0 ||
    Object.keys(record).some((key) => !allowedKeys.has(key))
  ) {
    return { permissionClauses: [], permissions: [], valid: false };
  }

  const clauses: PermissionClause[] = [];
  for (const [key, kind] of [
    ['allOf', 'all-of'],
    ['anyOf', 'any-of'],
    ['base', 'base'],
  ] as const) {
    if (!Object.hasOwn(record, key)) continue;
    if (!validPermissions(record[key]) || record[key].length === 0) {
      return { permissionClauses: [], permissions: [], valid: false };
    }
    clauses.push({ kind, permissions: [...record[key]] });
  }

  if (Object.hasOwn(record, 'byType')) {
    const byType = record.byType;
    if (!byType || typeof byType !== 'object' || Array.isArray(byType)) {
      return { permissionClauses: [], permissions: [], valid: false };
    }
    const entries = Object.entries(byType as JsonObject);
    if (entries.length === 0) {
      return { permissionClauses: [], permissions: [], valid: false };
    }
    for (const [value, permissions] of entries.sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (!value || !validPermissions(permissions) || permissions.length === 0) {
        return { permissionClauses: [], permissions: [], valid: false };
      }
      clauses.push({
        discriminator: 'type',
        kind: 'conditional',
        permissions: [...permissions],
        value,
      });
    }
  }

  return clauses.length > 0
    ? result(clauses)
    : { permissionClauses: [], permissions: [], valid: false };
}

function operationReference(openApi: JsonObject, apiVersion: string): JsonObject {
  const paths = openApi.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    throw new Error('openapi.json.paths is required');
  }
  const operations: JsonObject[] = [];
  const resolveLocalReference = (value: unknown): JsonObject | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as JsonObject;
    if (typeof record.$ref !== 'string') return record;
    if (!record.$ref.startsWith('#/')) return undefined;
    let resolved: unknown = openApi;
    for (const segment of record.$ref
      .slice(2)
      .split('/')
      .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) return undefined;
      resolved = (resolved as JsonObject)[segment];
    }
    return resolved && typeof resolved === 'object' && !Array.isArray(resolved)
      ? (resolved as JsonObject)
      : undefined;
  };
  for (const [path, pathValue] of Object.entries(paths as JsonObject).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!pathValue || typeof pathValue !== 'object' || Array.isArray(pathValue)) continue;
    for (const method of ['delete', 'get', 'patch', 'post', 'put'] as const) {
      const operation = (pathValue as JsonObject)[method];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) continue;
      const record = operation as JsonObject;
      const pathRecord = pathValue as JsonObject;
      const parameters = [
        ...(Array.isArray(pathRecord.parameters) ? pathRecord.parameters : []),
        ...(Array.isArray(record.parameters) ? record.parameters : []),
      ];
      const idempotencyRequired = parameters.some((parameter) => {
        const resolved = resolveLocalReference(parameter);
        return (
          String(resolved?.name).toLowerCase() === 'idempotency-key' && resolved?.required === true
        );
      });
      const principalRestrictionsDeclared = Object.hasOwn(record, 'x-principal-type-restrictions');
      const principalRestrictionRecord = principalRestrictionsDeclared
        ? resolveLocalReference(record['x-principal-type-restrictions'])
        : undefined;
      const principalTypes = Array.isArray(principalRestrictionRecord?.allowed)
        ? principalRestrictionRecord.allowed.filter(
            (principalType): principalType is string =>
              typeof principalType === 'string' && principalType.length > 0,
          )
        : [];
      const principalRestrictionsMetadataValid =
        !principalRestrictionsDeclared ||
        (Boolean(principalRestrictionRecord) &&
          Array.isArray(principalRestrictionRecord?.allowed) &&
          principalTypes.length === principalRestrictionRecord.allowed.length &&
          new Set(principalTypes).size === principalTypes.length);
      const permissionsDeclared = Object.hasOwn(record, 'x-required-permissions');
      const permissionMetadata = parsePermissionMetadata(
        record['x-required-permissions'],
        permissionsDeclared,
      );
      const permissionsMetadataValid = permissionMetadata.valid;
      const { permissionClauses, permissions } = permissionMetadata;
      const securityMetadata = Object.hasOwn(record, 'security')
        ? record.security
        : Object.hasOwn(pathRecord, 'security')
          ? pathRecord.security
          : Object.hasOwn(openApi, 'security')
            ? openApi.security
            : undefined;
      const securityMetadataValid =
        securityMetadata === undefined ||
        (Array.isArray(securityMetadata) &&
          securityMetadata.every(
            (requirement) =>
              Boolean(requirement) &&
              typeof requirement === 'object' &&
              !Array.isArray(requirement),
          ));
      const effectiveSecurity = securityMetadataValid
        ? (securityMetadata as unknown[] | undefined)
        : undefined;
      if (effectiveSecurity?.length === 0 && permissions.length > 0) {
        throw new Error(
          `${method.toUpperCase()} ${path} declares public security and required permissions`,
        );
      }
      const authorizationClassification =
        !permissionsMetadataValid || !securityMetadataValid
          ? 'unknown'
          : effectiveSecurity?.length === 0
            ? 'public'
            : permissionsDeclared
              ? permissions.length > 0
                ? 'permissioned'
                : 'authenticated'
              : 'unknown';
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: typeof record.operationId === 'string' ? record.operationId : null,
        summary: typeof record.summary === 'string' ? record.summary : null,
        permissions,
        permissionClauses,
        permissionsDeclared,
        permissionsMetadataValid,
        principalTypes,
        principalRestrictionsDeclared,
        principalRestrictionsMetadataValid,
        securityMetadataValid,
        authorizationClassification,
        security: effectiveSecurity ?? [],
        idempotencyRequired,
      });
    }
  }
  return { apiVersion, operationCount: operations.length, operations };
}

function skillMarkdown(apiVersion: string): string {
  const skillName = `tixkit-api-${apiVersion}`;
  return `---
name: ${skillName}
description: Implement and review Tixkit Platform API integrations against immutable API ${apiVersion}. Use for authentication, scoped principals, endpoint selection, idempotent mutations, cursor pagination, webhook handling, retries, and agent-safe action or approval flows that must remain contract-version accurate.
---

# Tixkit API ${apiVersion}

Use only the bundled, checksummed ${apiVersion} references for endpoint and contract decisions.

## Workflow

1. Read \`references/contract.json\` and reject a server, SDK, example, or requested contract with a different API version.
2. Search \`references/operations.json\` by method, path, or operation ID. Respect its permission and idempotency metadata.
3. Keep credentials in server-side environment or secret storage. Never paste secrets into source, URLs, browser storage, logs, traces, examples, or agent memory.
4. Use the least-authority principal and scopes. An agent principal never receives or impersonates its human sponsor's token.
5. Reuse one \`Idempotency-Key\` for retries of one logical mutation. Generate a new key when the intent or payload changes.
6. Follow cursor fields returned by the API. Do not invent offsets or infer another tenant's resource existence from denial responses.
7. Verify webhook signatures over the exact raw body before parsing. Treat delivery as at-least-once and ordering as not guaranteed.
8. Retry only failures declared retryable by the contract or a bounded \`Retry-After\`; never retry an ambiguous side effect with a new idempotency key.
9. For agent actions, bind approval to the immutable action digest and current resource version. Material changes require fresh approval.
10. Prefer a supported public Tixkit SDK when it covers the operation. This skill does not replace SDK or contract-test evidence.

## References

- \`references/contract.json\`: source release identity, checksums, auth schemes, and generation mode.
- \`references/operations.json\`: bounded endpoint metadata generated from OpenAPI.
- \`references/openapi.json\`: exact checksummed request, response, parameter, server, and error schemas; load only the operation and referenced schemas needed for the task.
- \`references/examples.json\`: sanitized release examples.
- \`references/webhook-events.json\`: versioned webhook catalog.

> Local evaluation artifact: this generator does not verify publication provenance. Do not represent this skill as a published, hosted, or production-certified contract.
`;
}

function openAiYaml(apiVersion: string): string {
  const skillName = `tixkit-api-${apiVersion}`;
  return `interface:
  display_name: "Tixkit API ${apiVersion}"
  short_description: "Build against the pinned Tixkit API contract"
  default_prompt: "Use $${skillName} to implement a safe Tixkit API integration."
`;
}

export async function generateTixkitApiIntegrationSkill(
  input: GenerateTixkitApiSkillInput,
): Promise<GeneratedTixkitApiSkill> {
  assertSafeVersion(input.apiVersion);
  if (!/^[a-f0-9]{64}$/u.test(input.expectedReleaseManifestSha256)) {
    throw new Error('Expected release-manifest SHA-256 is required');
  }
  await assertDirectoryNotSymlink(input.releaseRoot, 'Release root');
  const releaseDirectory = childPath(input.releaseRoot, input.apiVersion);
  await assertDirectoryNotSymlink(releaseDirectory, 'Release directory');
  const manifestPath = resolve(releaseDirectory, 'release-manifest.json');
  const checksumsPath = resolve(releaseDirectory, 'CHECKSUMS.sha256');
  await assertRegularFileWithin(input.releaseRoot, manifestPath, 'release-manifest.json');
  await assertRegularFileWithin(input.releaseRoot, checksumsPath, 'CHECKSUMS.sha256');
  const manifestContents = await readFile(manifestPath, 'utf8');
  const checksumContents = await readFile(checksumsPath, 'utf8');
  if (sha256(manifestContents) !== input.expectedReleaseManifestSha256) {
    throw new Error('release-manifest.json does not match the externally supplied digest');
  }
  const checksums = parseChecksums(checksumContents);
  if (checksums.get('release-manifest.json') !== sha256(manifestContents)) {
    throw new Error('release-manifest.json checksum does not match CHECKSUMS.sha256');
  }
  const manifest = normalizeManifest(parseJsonObject(manifestContents, 'release-manifest.json'));
  if (manifest.apiVersion !== input.apiVersion || manifest.releaseVersion !== input.apiVersion) {
    throw new Error('Requested API version does not match the immutable release manifest');
  }
  const localEvaluation = true;
  if (!input.allowLocalEvaluation) {
    throw new Error(
      'API integration skill generation is local-evaluation-only and must be explicit',
    );
  }

  const artifacts = new Map(manifest.artifacts.map((artifact) => [artifact.name, artifact]));
  const contents = new Map<string, string>();
  for (const name of REQUIRED_RELEASE_ARTIFACTS) {
    const artifact = artifacts.get(name);
    if (!artifact) throw new Error(`release-manifest.json does not declare ${name}`);
    const artifactPath = resolve(releaseDirectory, name);
    await assertRegularFileWithin(input.releaseRoot, artifactPath, name);
    const value = await readFile(artifactPath, 'utf8');
    if (
      Buffer.byteLength(value) !== artifact.size ||
      sha256(value) !== artifact.sha256 ||
      checksums.get(name) !== artifact.sha256
    ) {
      throw new Error(`${name} does not match its immutable release metadata`);
    }
    assertNoSecrets(name, value);
    contents.set(name, value);
  }

  const openApi = parseJsonObject(contents.get('openapi.json')!, 'openapi.json');
  const info = openApi.info;
  if (
    !info ||
    typeof info !== 'object' ||
    Array.isArray(info) ||
    (info as JsonObject).version !== input.apiVersion
  ) {
    throw new Error('openapi.json version does not match the requested API release');
  }
  const examples = parseJsonObject(contents.get('examples.json')!, 'examples.json');
  const webhooks = parseJsonObject(contents.get('webhook-events.json')!, 'webhook-events.json');
  assertNoJsonSecrets('openapi.json', openApi);
  assertNoJsonSecrets('examples.json', examples);
  assertNoJsonSecrets('webhook-events.json', webhooks);
  if (examples.apiVersion !== input.apiVersion || webhooks.apiVersion !== input.apiVersion) {
    throw new Error('Release examples or webhook catalog version does not match OpenAPI');
  }

  const securitySchemes =
    openApi.components &&
    typeof openApi.components === 'object' &&
    !Array.isArray(openApi.components) &&
    (openApi.components as JsonObject).securitySchemes &&
    typeof (openApi.components as JsonObject).securitySchemes === 'object'
      ? (openApi.components as JsonObject).securitySchemes
      : {};
  const contract = {
    apiVersion: input.apiVersion,
    skillName: `tixkit-api-${input.apiVersion}`,
    source: {
      publication: manifest.publication,
      generationMode: 'local-evaluation',
      publishable: manifest.provenance?.publishable === true,
      worktreeState: manifest.provenance?.worktreeState ?? null,
      releaseManifestSha256: sha256(manifestContents),
      openApiSha256: artifacts.get('openapi.json')!.sha256,
      examplesSha256: artifacts.get('examples.json')!.sha256,
      webhookEventsSha256: artifacts.get('webhook-events.json')!.sha256,
    },
    securitySchemes,
  };
  await mkdir(input.outputRoot, { recursive: true });
  const canonicalOutputRoot = await assertDirectoryNotSymlink(input.outputRoot, 'Output root');
  const outputDirectory = childPath(canonicalOutputRoot, `tixkit-api-${input.apiVersion}`);
  const temporaryDirectory = await mkdtemp(join(canonicalOutputRoot, '.tixkit-api-skill-'));
  const referencesDirectory = resolve(temporaryDirectory, 'references');
  const agentsDirectory = resolve(temporaryDirectory, 'agents');
  await mkdir(referencesDirectory, { recursive: true });
  await mkdir(agentsDirectory, { recursive: true });
  const generatedFiles = new Map<string, string>([
    ['SKILL.md', skillMarkdown(input.apiVersion)],
    ['agents/openai.yaml', openAiYaml(input.apiVersion)],
    ['references/contract.json', `${JSON.stringify(contract, null, 2)}\n`],
    ['references/openapi.json', contents.get('openapi.json')!],
    [
      'references/operations.json',
      `${JSON.stringify(operationReference(openApi, input.apiVersion), null, 2)}\n`,
    ],
    ['references/examples.json', `${JSON.stringify(examples, null, 2)}\n`],
    ['references/webhook-events.json', `${JSON.stringify(webhooks, null, 2)}\n`],
  ]);
  const artifactEntries: ReleaseArtifact[] = [];
  for (const [path, value] of generatedFiles) {
    assertNoSecrets(path, value);
    const destination = resolve(temporaryDirectory, path);
    await writeFile(destination, value, { flag: 'wx' });
    artifactEntries.push({ name: path, sha256: sha256(value), size: Buffer.byteLength(value) });
  }
  artifactEntries.sort((left, right) => left.name.localeCompare(right.name));
  const artifactManifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      generator: GENERATOR_MARKER,
      apiVersion: input.apiVersion,
      generationMode: 'local-evaluation',
      sourceReleaseManifestSha256: input.expectedReleaseManifestSha256,
      artifacts: artifactEntries,
    },
    null,
    2,
  )}\n`;
  await writeFile(resolve(temporaryDirectory, 'artifact-manifest.json'), artifactManifest, {
    flag: 'wx',
  });
  const checksumLines = [
    ...artifactEntries.map((entry) => `${entry.sha256}  ${entry.name}`),
    `${sha256(artifactManifest)}  artifact-manifest.json`,
  ];
  await writeFile(
    resolve(temporaryDirectory, 'CHECKSUMS.sha256'),
    `${checksumLines.join('\n')}\n`,
    {
      flag: 'wx',
    },
  );
  await assertTreeHasNoSymlinks(temporaryDirectory);

  let backupDirectory: string | undefined;
  try {
    const existing = await lstat(outputDirectory).catch(() => undefined);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error('Existing generated skill output must be an owned non-symlink directory');
      }
      await assertTreeHasNoSymlinks(outputDirectory);
      await validateOwnedGeneratedOutput(
        outputDirectory,
        input.apiVersion,
        input.expectedReleaseManifestSha256,
      );
      backupDirectory = `${outputDirectory}.backup-${basename(temporaryDirectory)}`;
      await rename(outputDirectory, backupDirectory);
    }
    await rename(temporaryDirectory, outputDirectory);
    if (backupDirectory) await rm(backupDirectory, { recursive: true });
  } catch (error) {
    if (backupDirectory) {
      const current = await lstat(outputDirectory).catch(() => undefined);
      if (!current) await rename(backupDirectory, outputDirectory);
    }
    await rm(temporaryDirectory, { recursive: true }).catch(() => undefined);
    throw error;
  }
  return {
    apiVersion: input.apiVersion,
    directory: outputDirectory,
    localEvaluation,
    releaseManifestSha256: sha256(manifestContents),
    openApiSha256: artifacts.get('openapi.json')!.sha256,
  };
}

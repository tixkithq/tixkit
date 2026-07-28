import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateTixkitApiIntegrationSkill } from '../index.js';

const API_VERSION = '2026-08-24';
const temporaryDirectories: string[] = [];
const secretFixture = (...parts: string[]): string => parts.join('');

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fixture(
  input: {
    manifestVersion?: string;
    openApiVersion?: string;
    examplesVersion?: string;
    omit?: string;
    secretExample?: boolean;
    secretValue?: string;
    publishable?: boolean;
    publicWithPermissions?: boolean;
    malformedPermissions?: boolean;
    compoundPermissions?: boolean;
    malformedSecurity?: boolean;
  } = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), 'tixkit-api-skill-'));
  temporaryDirectories.push(root);
  const releaseRoot = resolve(root, 'releases');
  const releaseDirectory = resolve(releaseRoot, API_VERSION);
  const outputRoot = resolve(root, 'output');
  await mkdir(releaseDirectory, { recursive: true });
  const files = new Map<string, string>([
    [
      'openapi.json',
      `${JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Tixkit', version: input.openApiVersion ?? API_VERSION },
        components: {
          securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } },
          parameters: {
            RequiredIdempotencyKey: {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          },
        },
        paths: {
          '/events': {
            get: {
              operationId: 'listEvents',
              summary: 'List events',
              security: input.malformedSecurity
                ? 'public'
                : input.publicWithPermissions || input.malformedPermissions
                  ? []
                  : [{ BearerAuth: [] }],
              'x-required-permissions': input.malformedPermissions
                ? 'events.read'
                : input.compoundPermissions
                  ? { anyOf: ['settings.write', 'messages.write'] }
                  : ['events.read'],
              'x-principal-type-restrictions': { allowed: ['user', 'system'] },
            },
          },
          '/events/{eventId}/publish': {
            post: {
              operationId: 'publishEvent',
              parameters: [{ $ref: '#/components/parameters/RequiredIdempotencyKey' }],
            },
          },
        },
      })}\n`,
    ],
    [
      'examples.json',
      `${JSON.stringify({
        apiVersion: input.examplesVersion ?? API_VERSION,
        examples:
          input.secretValue || input.secretExample
            ? {
                credential: input.secretValue ?? secretFixture('sk_', 'live_', 'abcdefghijklmnop'),
              }
            : {},
      })}\n`,
    ],
    ['webhook-events.json', `${JSON.stringify({ apiVersion: API_VERSION, events: [] })}\n`],
  ]);
  if (input.omit) files.delete(input.omit);
  const artifacts = [...files].map(([name, contents]) => ({
    name,
    sha256: digest(contents),
    size: Buffer.byteLength(contents),
  }));
  const manifest = `${JSON.stringify({
    apiVersion: input.manifestVersion ?? API_VERSION,
    releaseVersion: input.manifestVersion ?? API_VERSION,
    publication: 'approval-required',
    provenance: {
      publishable: input.publishable ?? false,
      worktreeState: input.publishable ? 'clean' : 'modified',
    },
    artifacts,
  })}\n`;
  for (const [name, contents] of files) await writeFile(resolve(releaseDirectory, name), contents);
  await writeFile(resolve(releaseDirectory, 'release-manifest.json'), manifest);
  await writeFile(
    resolve(releaseDirectory, 'CHECKSUMS.sha256'),
    `${[
      ...artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`),
      `${digest(manifest)}  release-manifest.json`,
    ].join('\n')}\n`,
  );
  return { root, releaseRoot, releaseDirectory, outputRoot, manifestDigest: digest(manifest) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('generateTixkitApiIntegrationSkill', () => {
  it('generates a version-bound local-evaluation skill with bounded contract references', async () => {
    const paths = await fixture();
    const generated = await generateTixkitApiIntegrationSkill({
      releaseRoot: paths.releaseRoot,
      apiVersion: API_VERSION,
      outputRoot: paths.outputRoot,
      allowLocalEvaluation: true,
      expectedReleaseManifestSha256: paths.manifestDigest,
    });

    expect(generated).toMatchObject({ apiVersion: API_VERSION, localEvaluation: true });
    const skill = await readFile(resolve(generated.directory, 'SKILL.md'), 'utf8');
    expect(skill).toContain(`name: tixkit-api-${API_VERSION}`);
    expect(skill).toContain('Local evaluation artifact');
    expect(skill).not.toMatch(/sk_live|whsec_|BEGIN PRIVATE KEY/u);
    const operations = JSON.parse(
      await readFile(resolve(generated.directory, 'references/operations.json'), 'utf8'),
    );
    expect(operations).toMatchObject({ apiVersion: API_VERSION, operationCount: 2 });
    expect(operations.operations).toContainEqual(
      expect.objectContaining({
        operationId: 'publishEvent',
        idempotencyRequired: true,
      }),
    );
    expect(operations.operations).toContainEqual(
      expect.objectContaining({
        operationId: 'listEvents',
        permissionsDeclared: true,
        authorizationClassification: 'permissioned',
        principalTypes: ['user', 'system'],
        principalRestrictionsDeclared: true,
        principalRestrictionsMetadataValid: true,
      }),
    );
    expect(operations.operations).toContainEqual(
      expect.objectContaining({
        operationId: 'publishEvent',
        permissionsDeclared: false,
        authorizationClassification: 'unknown',
      }),
    );
    const generatedOpenApi = JSON.parse(
      await readFile(resolve(generated.directory, 'references/openapi.json'), 'utf8'),
    );
    expect(generatedOpenApi.info.version).toBe(API_VERSION);
    expect(generatedOpenApi.paths['/events']).toBeDefined();
    const interfaceMetadata = await readFile(
      resolve(generated.directory, 'agents/openai.yaml'),
      'utf8',
    );
    expect(interfaceMetadata).toContain(`$tixkit-api-${API_VERSION}`);
    const artifactManifest = JSON.parse(
      await readFile(resolve(generated.directory, 'artifact-manifest.json'), 'utf8'),
    );
    expect(artifactManifest).toMatchObject({
      schemaVersion: 1,
      generator: '@tixkit/api-integration-skill:local-evaluation:v1',
      apiVersion: API_VERSION,
      generationMode: 'local-evaluation',
      sourceReleaseManifestSha256: paths.manifestDigest,
    });
    expect(await readFile(resolve(generated.directory, 'CHECKSUMS.sha256'), 'utf8')).toContain(
      '  artifact-manifest.json',
    );
  });

  it('requires an explicit mode for a non-publishable source release', async () => {
    const paths = await fixture();
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        expectedReleaseManifestSha256: paths.manifestDigest,
      }),
    ).rejects.toThrow('local-evaluation-only and must be explicit');
  });

  it('preserves compound any-of permissions in agent-facing operation evidence', async () => {
    const paths = await fixture({ compoundPermissions: true });
    const generated = await generateTixkitApiIntegrationSkill({
      releaseRoot: paths.releaseRoot,
      apiVersion: API_VERSION,
      outputRoot: paths.outputRoot,
      allowLocalEvaluation: true,
      expectedReleaseManifestSha256: paths.manifestDigest,
    });

    const operations = JSON.parse(
      await readFile(resolve(generated.directory, 'references/operations.json'), 'utf8'),
    );
    expect(operations.operations).toContainEqual(
      expect.objectContaining({
        operationId: 'listEvents',
        permissions: ['settings.write', 'messages.write'],
        permissionClauses: [
          {
            kind: 'any-of',
            permissions: ['settings.write', 'messages.write'],
          },
        ],
        permissionsDeclared: true,
        permissionsMetadataValid: true,
        authorizationClassification: 'permissioned',
      }),
    );
  });

  it('requires the externally supplied release-manifest digest', async () => {
    const paths = await fixture();
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: '0'.repeat(64),
      }),
    ).rejects.toThrow('externally supplied digest');
  });

  it('never labels a publishable build as published without separate evidence', async () => {
    const paths = await fixture({ publishable: true });
    const generated = await generateTixkitApiIntegrationSkill({
      releaseRoot: paths.releaseRoot,
      apiVersion: API_VERSION,
      outputRoot: paths.outputRoot,
      allowLocalEvaluation: true,
      expectedReleaseManifestSha256: paths.manifestDigest,
    });
    expect(generated.localEvaluation).toBe(true);
    expect(await readFile(resolve(generated.directory, 'SKILL.md'), 'utf8')).toContain(
      'Local evaluation artifact',
    );
  });

  it('rejects a checksum mutation before writing a skill', async () => {
    const paths = await fixture();
    await writeFile(resolve(paths.releaseDirectory, 'examples.json'), '{"apiVersion":"changed"}\n');
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: paths.manifestDigest,
      }),
    ).rejects.toThrow('immutable release metadata');
  });

  it.each([
    [{ manifestVersion: '2026-08-19' }, 'immutable release manifest'],
    [{ openApiVersion: '2026-08-19' }, 'openapi.json version'],
    [{ examplesVersion: '2026-08-19' }, 'examples or webhook catalog'],
  ] as const)('rejects contract-version drift', async (fixtureInput, message) => {
    const paths = await fixture(fixtureInput);
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: paths.manifestDigest,
      }),
    ).rejects.toThrow(message);
  });

  it('rejects a missing required artifact', async () => {
    const paths = await fixture({ omit: 'webhook-events.json' });
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: paths.manifestDigest,
      }),
    ).rejects.toThrow('does not declare webhook-events.json');
  });

  it('rejects version path traversal and secret-like release examples', async () => {
    const paths = await fixture({ secretExample: true });
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: '../2026-08-24',
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: paths.manifestDigest,
      }),
    ).rejects.toThrow('YYYY-MM-DD');
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: paths.manifestDigest,
      }),
    ).rejects.toThrow('secret-like material');
  });

  it.each([
    secretFixture('tk_', 'live_', '1234567890abcdefghijklmnop'),
    secretFixture('AKIA', '1234567890ABCDEF'),
    secretFixture('ghp_', '1234567890abcdefghijklmnopqrstuv'),
    'https://user:password@example.test/path',
    'Basic YWxpY2U6c2VjcmV0MTIzNDU2',
  ])('rejects broad credential class %s', async (secretValue) => {
    const paths = await fixture({ secretValue });
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: paths.manifestDigest,
      }),
    ).rejects.toThrow('secret-like material');
  });

  it('rejects source and output symlinks without overwriting their targets', async () => {
    const paths = await fixture();
    const symlinkRoot = resolve(paths.root, 'symlink-root');
    await mkdir(symlinkRoot);
    await symlink(paths.releaseDirectory, resolve(symlinkRoot, API_VERSION), 'dir');
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: symlinkRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: paths.manifestDigest,
      }),
    ).rejects.toThrow('non-symlink directory');

    await generateTixkitApiIntegrationSkill({
      releaseRoot: paths.releaseRoot,
      apiVersion: API_VERSION,
      outputRoot: paths.outputRoot,
      allowLocalEvaluation: true,
      expectedReleaseManifestSha256: paths.manifestDigest,
    });

    const victim = resolve(paths.root, 'victim.txt');
    await writeFile(victim, 'sentinel');
    const openApiOutput = resolve(
      paths.outputRoot,
      `tixkit-api-${API_VERSION}`,
      'references/openapi.json',
    );
    await rm(openApiOutput);
    await symlink(victim, openApiOutput);
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: paths.manifestDigest,
      }),
    ).rejects.toThrow('symlink');
    expect(await readFile(victim, 'utf8')).toBe('sentinel');
  });

  it('replaces only fully validated owned output and preserves it on any validation failure', async () => {
    const paths = await fixture();
    const input = {
      releaseRoot: paths.releaseRoot,
      apiVersion: API_VERSION,
      outputRoot: paths.outputRoot,
      allowLocalEvaluation: true,
      expectedReleaseManifestSha256: paths.manifestDigest,
    };
    const generated = await generateTixkitApiIntegrationSkill(input);
    const skillBefore = await readFile(resolve(generated.directory, 'SKILL.md'), 'utf8');
    await writeFile(resolve(generated.directory, 'stale.txt'), 'must disappear');
    await expect(generateTixkitApiIntegrationSkill(input)).rejects.toThrow('inventory');
    expect(await readFile(resolve(generated.directory, 'stale.txt'), 'utf8')).toBe(
      'must disappear',
    );
    await rm(resolve(generated.directory, 'stale.txt'));
    await generateTixkitApiIntegrationSkill(input);
    await writeFile(resolve(paths.releaseDirectory, 'examples.json'), '{"changed":true}\n');
    await expect(generateTixkitApiIntegrationSkill(input)).rejects.toThrow(
      'immutable release metadata',
    );
    expect(await readFile(resolve(generated.directory, 'SKILL.md'), 'utf8')).toBe(skillBefore);
  });

  it('refuses to replace checksummed output bound to a different release manifest', async () => {
    const paths = await fixture();
    const input = {
      releaseRoot: paths.releaseRoot,
      apiVersion: API_VERSION,
      outputRoot: paths.outputRoot,
      allowLocalEvaluation: true,
      expectedReleaseManifestSha256: paths.manifestDigest,
    };
    const generated = await generateTixkitApiIntegrationSkill(input);
    const skillBefore = await readFile(resolve(generated.directory, 'SKILL.md'), 'utf8');
    const artifactManifestPath = resolve(generated.directory, 'artifact-manifest.json');
    const artifactManifest = JSON.parse(await readFile(artifactManifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    artifactManifest.sourceReleaseManifestSha256 = '0'.repeat(64);
    const mismatchedManifest = `${JSON.stringify(artifactManifest, null, 2)}\n`;
    await writeFile(artifactManifestPath, mismatchedManifest);
    const checksumsPath = resolve(generated.directory, 'CHECKSUMS.sha256');
    const checksums = await readFile(checksumsPath, 'utf8');
    await writeFile(
      checksumsPath,
      checksums.replace(
        /^[a-f0-9]{64}  artifact-manifest\.json$/m,
        `${digest(mismatchedManifest)}  artifact-manifest.json`,
      ),
    );

    await expect(generateTixkitApiIntegrationSkill(input)).rejects.toThrow(
      'not owned by this generator',
    );
    expect(await readFile(resolve(generated.directory, 'SKILL.md'), 'utf8')).toBe(skillBefore);
  });

  it('rejects public-security and required-permission contradictions', async () => {
    const paths = await fixture({ publicWithPermissions: true });
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: paths.manifestDigest,
      }),
    ).rejects.toThrow('declares public security and required permissions');
  });

  it('never classifies malformed authorization metadata as public', async () => {
    for (const fixtureInput of [{ malformedPermissions: true }, { malformedSecurity: true }]) {
      const paths = await fixture(fixtureInput);
      const generated = await generateTixkitApiIntegrationSkill({
        releaseRoot: paths.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: paths.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: paths.manifestDigest,
      });
      const operations = JSON.parse(
        await readFile(resolve(generated.directory, 'references/operations.json'), 'utf8'),
      );
      expect(operations.operations[0].authorizationClassification).toBe('unknown');
      expect(
        operations.operations[0].permissionsMetadataValid === false ||
          operations.operations[0].securityMetadataValid === false,
      ).toBe(true);
    }
  });

  it('rejects duplicate checksums and unsafe or duplicate source artifact names before reading', async () => {
    const duplicateChecksums = await fixture();
    const checksumPath = resolve(duplicateChecksums.releaseDirectory, 'CHECKSUMS.sha256');
    const checksumContents = await readFile(checksumPath, 'utf8');
    await writeFile(checksumPath, `${checksumContents}${checksumContents.split('\n')[0]}\n`);
    await expect(
      generateTixkitApiIntegrationSkill({
        releaseRoot: duplicateChecksums.releaseRoot,
        apiVersion: API_VERSION,
        outputRoot: duplicateChecksums.outputRoot,
        allowLocalEvaluation: true,
        expectedReleaseManifestSha256: duplicateChecksums.manifestDigest,
      }),
    ).rejects.toThrow('duplicate entry');

    for (const name of ['../openapi.json', 'openapi.json']) {
      const paths = await fixture();
      const manifestPath = resolve(paths.releaseDirectory, 'release-manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.artifacts.push({ ...manifest.artifacts[0], name });
      const contents = `${JSON.stringify(manifest)}\n`;
      await writeFile(manifestPath, contents);
      const currentChecksums = (
        await readFile(resolve(paths.releaseDirectory, 'CHECKSUMS.sha256'), 'utf8')
      )
        .split('\n')
        .filter((line) => line && !line.endsWith('  release-manifest.json'));
      await writeFile(
        resolve(paths.releaseDirectory, 'CHECKSUMS.sha256'),
        `${[...currentChecksums, `${digest(contents)}  release-manifest.json`].join('\n')}\n`,
      );
      await expect(
        generateTixkitApiIntegrationSkill({
          releaseRoot: paths.releaseRoot,
          apiVersion: API_VERSION,
          outputRoot: paths.outputRoot,
          allowLocalEvaluation: true,
          expectedReleaseManifestSha256: digest(contents),
        }),
      ).rejects.toThrow(name.startsWith('..') ? 'invalid metadata' : 'duplicate artifact');
    }
  });

  it('rejects legacy or marker-forged existing output without deleting it', async () => {
    const paths = await fixture();
    const input = {
      releaseRoot: paths.releaseRoot,
      apiVersion: API_VERSION,
      outputRoot: paths.outputRoot,
      allowLocalEvaluation: true,
      expectedReleaseManifestSha256: paths.manifestDigest,
    };
    const generated = await generateTixkitApiIntegrationSkill(input);
    const manifestPath = resolve(generated.directory, 'artifact-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.generator;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await expect(generateTixkitApiIntegrationSkill(input)).rejects.toThrow('not owned');
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).generator).toBeUndefined();
  });
});

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  publicContractPins,
  stageAgentIntegrationSkillArtifacts,
} from '../build-public-release-manifest.mjs';
import {
  agentIntegrationSkillViolations,
  loadPublicDistribution,
} from '../lib/public-distribution.mjs';

const root = resolve(import.meta.dirname, '../..');

test('validates and stages the API integration skill independently from API contracts', () => {
  const distribution = loadPublicDistribution(root);
  assert.equal(agentIntegrationSkillViolations(distribution, root).length, 0);
  const activeApiContract = distribution.release.contracts.find((path) =>
    path.startsWith('artifacts/api/'),
  );
  assert.ok(activeApiContract);
  assert.doesNotThrow(() => publicContractPins(distribution, activeApiContract, root));

  const output = mkdtempSync(resolve(tmpdir(), 'tixkit-agent-skill-stage-'));
  try {
    const staged = stageAgentIntegrationSkillArtifacts(distribution, output, root);
    assert.equal(staged.length, 8);
    assert.equal(
      staged.some((name) => /^contract-agent-skill-2026-08-27-[a-f0-9]{64}\.json$/u.test(name)),
      true,
    );
    const envelope = JSON.parse(readFileSync(resolve(output, staged[0]), 'utf8'));
    assert.match(envelope.apiVersion, /^2026-08-(?:20|21|22|23|24|25|26|27)$/u);
    assert.equal(
      envelope.files.some(({ name }) => name === 'SKILL.md'),
      true,
    );
    assert.equal(
      envelope.files.some(({ name }) => name === 'CHECKSUMS.sha256'),
      true,
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

function isolatedActiveSkill() {
  const directory = mkdtempSync(resolve(tmpdir(), 'tixkit-agent-skill-hostile-'));
  const distribution = loadPublicDistribution(root);
  const entry = distribution.release.agentIntegrationSkills[0];
  mkdirSync(resolve(directory, 'artifacts/api'), { recursive: true });
  mkdirSync(resolve(directory, 'artifacts/api-integration-skills'), { recursive: true });
  mkdirSync(resolve(directory, 'apps/docs/public'), { recursive: true });
  cpSync(
    resolve(root, 'apps/docs/public/openapi.json'),
    resolve(directory, 'apps/docs/public/openapi.json'),
  );
  cpSync(
    resolve(root, `artifacts/api/${entry.apiVersion}`),
    resolve(directory, `artifacts/api/${entry.apiVersion}`),
    {
      recursive: true,
    },
  );
  cpSync(resolve(root, entry.path), resolve(directory, entry.path), { recursive: true });
  distribution.release.agentIntegrationSkills = [structuredClone(entry)];
  return { directory, distribution, entry };
}

test('fails closed on generator-marker, unsafe-name, and duplicate-checksum forgery', () => {
  for (const mutation of ['marker', 'unsafe-name', 'duplicate-checksum']) {
    const context = isolatedActiveSkill();
    try {
      const skillDirectory = resolve(context.directory, context.entry.path);
      if (mutation === 'duplicate-checksum') {
        const checksumPath = resolve(skillDirectory, 'CHECKSUMS.sha256');
        const checksums = readFileSync(checksumPath, 'utf8');
        writeFileSync(checksumPath, `${checksums}${checksums.split('\n')[0]}\n`);
      } else {
        const manifestPath = resolve(skillDirectory, 'artifact-manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (mutation === 'marker') manifest.generator = 'forged-generator';
        else manifest.artifacts[0].name = '../escape';
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const violations = agentIntegrationSkillViolations(context.distribution, context.directory);
      assert.notEqual(violations.length, 0);
      assert.throws(
        () =>
          stageAgentIntegrationSkillArtifacts(
            context.distribution,
            resolve(context.directory, 'stage'),
            context.directory,
          ),
        /validation failed/u,
      );
    } finally {
      rmSync(context.directory, { recursive: true, force: true });
    }
  }
});

test('fails closed on source pin and generated inventory drift', () => {
  const distribution = loadPublicDistribution(root);
  const wrongPin = structuredClone(distribution);
  wrongPin.release.agentIntegrationSkills[0].releaseManifestSha256 = '0'.repeat(64);
  assert.match(
    agentIntegrationSkillViolations(wrongPin, root).join('\n'),
    /digest does not match/u,
  );

  const extra = structuredClone(distribution);
  extra.release.agentIntegrationSkills[0].path =
    'artifacts/api-integration-skills/tixkit-api-2026-08-19';
  assert.match(agentIntegrationSkillViolations(extra, root).join('\n'), /path must be/u);
});

test('OMITTED_HISTORICAL_SKILL_ACCEPTED bypass is rejected with ordering and active-version drift', () => {
  const distribution = loadPublicDistribution(root);
  const omitted = structuredClone(distribution);
  omitted.release.agentIntegrationSkills.pop();
  assert.match(
    agentIntegrationSkillViolations(omitted, root).join('\n'),
    /exactly match retained directories/u,
  );

  const reordered = structuredClone(distribution);
  reordered.release.agentIntegrationSkills.reverse();
  assert.match(agentIntegrationSkillViolations(reordered, root).join('\n'), /newest-first order/u);
  assert.match(
    agentIntegrationSkillViolations(reordered, root).join('\n'),
    /active OpenAPI version/u,
  );

  const duplicated = structuredClone(distribution);
  duplicated.release.agentIntegrationSkills.push(
    structuredClone(duplicated.release.agentIntegrationSkills[0]),
  );
  assert.match(agentIntegrationSkillViolations(duplicated, root).join('\n'), /exactly once/u);
});

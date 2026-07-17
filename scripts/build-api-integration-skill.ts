import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { openApiSpec } from '../packages/openapi/src/index.js';
import { generateTixkitApiIntegrationSkill } from '../packages/api-integration-skill/src/index.js';

const root = resolve(import.meta.dirname, '..');
const distribution = JSON.parse(
  await readFile(resolve(root, 'distribution/public-distribution.json'), 'utf8'),
) as {
  release: {
    agentIntegrationSkills: Array<{
      apiVersion: string;
      releaseManifestSha256: string;
    }>;
  };
};
const skill = distribution.release.agentIntegrationSkills.find(
  (entry) => entry.apiVersion === openApiSpec.info.version,
);
if (!skill) throw new Error('Public distribution does not pin the active API integration skill');
const result = await generateTixkitApiIntegrationSkill({
  releaseRoot: resolve(root, 'artifacts/api'),
  apiVersion: openApiSpec.info.version,
  outputRoot: resolve(root, 'artifacts/api-integration-skills'),
  allowLocalEvaluation: process.env.ALLOW_LOCAL_API_SKILL_EVALUATION === '1',
  expectedReleaseManifestSha256: skill.releaseManifestSha256,
});

process.stdout.write(`Built local-evaluation Tixkit API integration skill ${result.apiVersion}.\n`);

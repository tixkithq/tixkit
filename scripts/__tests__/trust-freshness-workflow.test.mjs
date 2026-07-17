import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = resolve(root, '.github/workflows/trust-freshness.yml');
const workflow = parseYaml(readFileSync(workflowPath, 'utf8'));

function workflowViolations(candidate) {
  const violations = [];
  const triggers = candidate?.on;
  if (
    !triggers ||
    Object.keys(triggers).sort().join(',') !== 'schedule,workflow_dispatch' ||
    !Array.isArray(triggers.schedule) ||
    triggers.schedule.length !== 1 ||
    typeof triggers.schedule[0]?.cron !== 'string' ||
    !/^\d{1,2} \d{1,2} \* \* [0-6]$/u.test(triggers.schedule[0].cron.trim())
  ) {
    violations.push('workflow must have exactly one weekly schedule and manual dispatch');
  }

  if (
    !candidate.permissions ||
    Object.keys(candidate.permissions).join(',') !== 'contents' ||
    candidate.permissions.contents !== 'read'
  ) {
    violations.push('workflow permissions must be exactly contents: read');
  }

  const jobs = Object.entries(candidate.jobs ?? {});
  if (jobs.length !== 1 || jobs[0]?.[0] !== 'validate') {
    violations.push('workflow must contain only the validate job');
    return violations;
  }

  const job = jobs[0][1];
  if (job['runs-on'] !== 'ubuntu-latest') {
    violations.push('validate job must use the GitHub-hosted Ubuntu runner');
  }
  if (job['timeout-minutes'] !== 20) {
    violations.push('validate job must retain its bounded timeout');
  }

  const steps = job.steps ?? [];
  const uses = steps.flatMap((step) => (typeof step.uses === 'string' ? [step.uses] : []));
  for (const action of uses) {
    if (action.startsWith('./')) continue;
    if (!/@[a-f0-9]{40}$/u.test(action)) {
      violations.push(`remote action must be pinned to a full commit SHA: ${action}`);
    }
  }
  if (!uses.some((action) => action.startsWith('actions/checkout@'))) {
    violations.push('workflow must check out the repository');
  }
  if (!uses.includes('./.github/actions/setup-js')) {
    violations.push('workflow must use the repository JavaScript setup action');
  }

  const commands = steps.flatMap((step) => (typeof step.run === 'string' ? [step.run] : []));
  for (const command of [
    'bun install --frozen-lockfile',
    'bun run validate:trust-program',
    'bun run validate:trust-evidence',
    'bun run validate:public-distribution',
  ]) {
    if (commands.filter((candidateCommand) => candidateCommand === command).length !== 1) {
      violations.push(`workflow must run exactly once: ${command}`);
    }
  }

  return violations;
}

test('scheduled trust freshness workflow is bounded and complete', () => {
  assert.deepEqual(workflowViolations(workflow), []);
});

test('scheduled trust freshness workflow rejects weakened controls', () => {
  const mutations = [
    (candidate) => delete candidate.on.schedule,
    (candidate) => (candidate.permissions.contents = 'write'),
    (candidate) => (candidate.jobs.validate.steps[0].uses = 'actions/checkout@v7'),
    (candidate) =>
      (candidate.jobs.validate.steps = candidate.jobs.validate.steps.filter(
        ({ run }) => run !== 'bun run validate:trust-program',
      )),
    (candidate) =>
      (candidate.jobs.validate.steps = candidate.jobs.validate.steps.filter(
        ({ run }) => run !== 'bun run validate:trust-evidence',
      )),
    (candidate) =>
      (candidate.jobs.validate.steps = candidate.jobs.validate.steps.filter(
        ({ run }) => run !== 'bun run validate:public-distribution',
      )),
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(workflow);
    mutate(candidate);
    assert.notDeepEqual(workflowViolations(candidate), []);
  }
});

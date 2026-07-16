import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRuleset,
  buildPublicRemoteRuleset,
  extractWorkflowCheckNames,
  selectRulesetForUpdate,
  validatePublicRemoteRuleset,
  validateRequiredStatusChecksAgainstWorkflows,
} from '../public-remote-guardrails.mjs';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('buildPublicRemoteRuleset creates an export-app-only main branch ruleset', () => {
  const ruleset = buildPublicRemoteRuleset({ exportAppIntegrationId: 12345 });

  assert.equal(ruleset.enforcement, 'active');
  assert.deepEqual(ruleset.conditions.ref_name.include, ['refs/heads/main']);
  assert.deepEqual(ruleset.bypass_actors, [
    {
      actor_id: 12345,
      actor_type: 'Integration',
      bypass_mode: 'always',
    },
  ]);
  assert.deepEqual(
    ruleset.rules.map((rule) => rule.type),
    [
      'deletion',
      'non_fast_forward',
      'update',
      'pull_request',
      'required_status_checks',
      'code_scanning',
    ],
  );
  assert.deepEqual(
    ruleset.rules
      .find((rule) => rule.type === 'required_status_checks')
      .parameters.required_status_checks.map((check) => check.context),
    [
      'Lint & Typecheck',
      'Build',
      'OSS Export',
      'Unit Tests',
      'Flutter SDK',
      'iOS SDK',
      'Android SDK',
      'React Native Demo',
      'Integration Tests (PostgreSQL)',
      'Integration Tests (MySQL)',
      'E2E Browser Matrix (chromium)',
      'E2E Browser Matrix (firefox)',
      'E2E Browser Matrix (webkit)',
      'Provider Tests (Stripe)',
      'SDK Parity Matrix',
      'Public NPM Package Dry Run',
      'Flutter SDK Dry Run',
      'iOS SDK Dry Run',
      'Android SDK Dry Run',
      'Go SDK Dry Run',
      'Rust SDK Dry Run',
      'Build, Migrate, Render, Smoke',
      'Dependency Review',
      'Bun Dependency Audit',
      'Static Security Analysis (javascript-typescript)',
    ],
  );
  assert.deepEqual(validatePublicRemoteRuleset(ruleset, { exportAppIntegrationId: 12345 }), []);
});

test('buildPublicRemoteRuleset creates an authoritative reviewed-PR ruleset without bypass', () => {
  const ruleset = buildPublicRemoteRuleset({
    topology: 'authoritative',
    statusCheckIntegrationId: 15368,
  });

  assert.equal(ruleset.name, 'authoritative-public-main');
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.deepEqual(
    ruleset.rules.map((rule) => rule.type),
    [
      'deletion',
      'non_fast_forward',
      'required_linear_history',
      'pull_request',
      'required_status_checks',
      'code_scanning',
    ],
  );
  assert.deepEqual(
    new Set(
      ruleset.rules
        .find((rule) => rule.type === 'required_status_checks')
        .parameters.required_status_checks.map((check) => check.integration_id),
    ),
    new Set([15368]),
  );
  assert.equal(
    ruleset.rules.find((rule) => rule.type === 'required_status_checks').parameters
      .required_status_checks[2].context,
    'Public Repository Independence',
  );
  assert.deepEqual(
    validatePublicRemoteRuleset(ruleset, {
      topology: 'authoritative',
      statusCheckIntegrationId: 15368,
    }),
    [],
  );
});

test('validatePublicRemoteRuleset rejects human bypass actors and missing update rule', () => {
  const ruleset = buildPublicRemoteRuleset({ exportAppIntegrationId: 12345 });
  ruleset.bypass_actors.push({
    actor_id: 1,
    actor_type: 'RepositoryRole',
    bypass_mode: 'always',
  });
  ruleset.rules = ruleset.rules.filter((rule) => rule.type !== 'update');

  assert.deepEqual(validatePublicRemoteRuleset(ruleset, { exportAppIntegrationId: 12345 }), [
    'Human bypass actor type is not allowed: RepositoryRole',
    'Ruleset rules must exactly match deletion, non_fast_forward, update, pull_request, required_status_checks, code_scanning',
    'Transitional ruleset must include update rule',
  ]);
});

test('validatePublicRemoteRuleset rejects authoritative bypass and merge deadlock rules', () => {
  const ruleset = buildPublicRemoteRuleset({
    topology: 'authoritative',
    statusCheckIntegrationId: 15368,
  });
  ruleset.bypass_actors.push({
    actor_id: 12345,
    actor_type: 'Integration',
    bypass_mode: 'always',
  });
  ruleset.rules.push({ type: 'update' });
  ruleset.rules = ruleset.rules.filter((rule) => rule.type !== 'required_linear_history');

  assert.deepEqual(
    validatePublicRemoteRuleset(ruleset, {
      topology: 'authoritative',
      statusCheckIntegrationId: 15368,
    }),
    [
      'Authoritative ruleset must not have bypass actors',
      'Ruleset rules must exactly match deletion, non_fast_forward, required_linear_history, pull_request, required_status_checks, code_scanning',
      'Authoritative ruleset must not deadlock pull-request merges with an update rule',
      'Authoritative ruleset must require linear history',
    ],
  );
});

test('validatePublicRemoteRuleset rejects ineffective targeting and a reduced check contract', () => {
  const ruleset = buildPublicRemoteRuleset({
    topology: 'authoritative',
    statusCheckIntegrationId: 15368,
  });
  ruleset.target = 'tag';
  ruleset.conditions.ref_name.include.push('~ALL');
  ruleset.conditions.ref_name.exclude.push('refs/heads/main');
  ruleset.rules
    .find((rule) => rule.type === 'required_status_checks')
    .parameters.required_status_checks.pop();

  assert.deepEqual(
    validatePublicRemoteRuleset(ruleset, {
      topology: 'authoritative',
      statusCheckIntegrationId: 15368,
    }),
    [
      'Ruleset target must be branch',
      'Ruleset must target only refs/heads/main',
      'Ruleset must not exclude refs/heads/main',
      'Required status checks must exactly match the committed public CI contract',
    ],
  );
});

test('validatePublicRemoteRuleset requires the expected authoritative CI integration', () => {
  const ruleset = buildPublicRemoteRuleset({
    topology: 'authoritative',
    statusCheckIntegrationId: 15368,
  });

  assert.deepEqual(validatePublicRemoteRuleset(ruleset, { topology: 'authoritative' }), [
    'Authoritative ruleset validation requires the expected CI GitHub App integration',
  ]);
  const mismatchedIntegrationErrors = validatePublicRemoteRuleset(ruleset, {
    topology: 'authoritative',
    statusCheckIntegrationId: 99999,
  });
  assert.equal(mismatchedIntegrationErrors.length, 25);
  assert.ok(
    mismatchedIntegrationErrors.every((error) =>
      error.endsWith('does not match the required CI GitHub App integration'),
    ),
  );
});

test('validatePublicRemoteRuleset rejects weakened review and latest-code policy', () => {
  const ruleset = buildPublicRemoteRuleset({
    topology: 'authoritative',
    statusCheckIntegrationId: 15368,
  });
  const pullRequest = ruleset.rules.find((rule) => rule.type === 'pull_request');
  pullRequest.parameters.dismiss_stale_reviews_on_push = false;
  pullRequest.parameters.require_last_push_approval = false;
  pullRequest.parameters.allowed_merge_methods = ['merge'];
  const statuses = ruleset.rules.find((rule) => rule.type === 'required_status_checks');
  statuses.parameters.strict_required_status_checks_policy = false;

  assert.deepEqual(
    validatePublicRemoteRuleset(ruleset, {
      topology: 'authoritative',
      statusCheckIntegrationId: 15368,
    }),
    [
      'Pull request rule parameters must exactly match the reviewed public contract',
      'Required status checks must use strict latest-code policy',
    ],
  );
});

test('validatePublicRemoteRuleset rejects missing or weakened CodeQL enforcement', () => {
  const missing = buildPublicRemoteRuleset({ exportAppIntegrationId: 12345 });
  missing.rules = missing.rules.filter((rule) => rule.type !== 'code_scanning');
  assert.match(
    validatePublicRemoteRuleset(missing, { exportAppIntegrationId: 12345 }).join('\n'),
    /code_scanning/u,
  );

  for (const mutation of [
    (tool) => {
      tool.security_alerts_threshold = 'critical';
    },
    (tool) => {
      tool.tool = 'Other';
    },
    (tool) => {
      tool.alerts_threshold = 'none';
    },
  ]) {
    const weakened = buildPublicRemoteRuleset({ exportAppIntegrationId: 12345 });
    mutation(
      weakened.rules.find((rule) => rule.type === 'code_scanning').parameters
        .code_scanning_tools[0],
    );
    assert.deepEqual(validatePublicRemoteRuleset(weakened, { exportAppIntegrationId: 12345 }), [
      'Code scanning rule must require CodeQL high-or-higher security alerts',
    ]);
  }
});

test('validatePublicRemoteRuleset requires the expected transitional export integration', () => {
  const ruleset = buildPublicRemoteRuleset({ exportAppIntegrationId: 12345 });

  assert.deepEqual(validatePublicRemoteRuleset(ruleset), [
    'Transitional ruleset validation requires the expected export GitHub App integration',
  ]);
  assert.deepEqual(validatePublicRemoteRuleset(ruleset, { exportAppIntegrationId: 98765 }), [
    'Transitional Integration bypass actor does not match the export GitHub App',
  ]);
});

test('buildPublicRemoteRuleset rejects missing export app integration IDs', () => {
  assert.throws(() => buildPublicRemoteRuleset(), {
    message: 'exportAppIntegrationId must be a positive GitHub App integration ID',
  });
  assert.throws(() => buildPublicRemoteRuleset({ exportAppIntegrationId: 'not-a-number' }), {
    message: 'exportAppIntegrationId must be a positive GitHub App integration ID',
  });
  assert.throws(() => buildPublicRemoteRuleset({ topology: 'authoritative' }), {
    message: 'statusCheckIntegrationId must be a positive GitHub App integration ID',
  });
});

test('selectRulesetForUpdate replaces transition in place and forbids downgrade or ambiguity', () => {
  const transitional = { id: 1, name: 'public-export-only-main', source_type: 'Repository' };
  const authoritative = { id: 2, name: 'authoritative-public-main', source_type: 'Repository' };

  assert.equal(selectRulesetForUpdate([transitional], 'authoritative'), transitional);
  assert.equal(selectRulesetForUpdate([authoritative], 'authoritative'), authoritative);
  assert.equal(selectRulesetForUpdate([], 'authoritative'), undefined);
  assert.throws(() => selectRulesetForUpdate([authoritative], 'transitional'), {
    message: 'Refusing to downgrade an authoritative public ruleset to transitional',
  });
  assert.throws(() => selectRulesetForUpdate([transitional, authoritative], 'authoritative'), {
    message: 'Both transitional and authoritative public rulesets exist; reconcile manually',
  });
  assert.throws(
    () => selectRulesetForUpdate([transitional, { ...transitional, id: 3 }], 'authoritative'),
    { message: 'Duplicate public rulesets exist; reconcile manually' },
  );
  assert.throws(
    () =>
      selectRulesetForUpdate([{ ...transitional, source_type: 'Organization' }], 'authoritative'),
    {
      message: 'Matching public ruleset is inherited and cannot be replaced at repository scope',
    },
  );
});

test('applyRuleset paginates and replaces the transitional ruleset in place', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const ruleset = buildPublicRemoteRuleset({
    topology: 'authoritative',
    statusCheckIntegrationId: 15368,
  });
  const transitional = {
    id: 4242,
    name: 'public-export-only-main',
    source_type: 'Repository',
  };
  globalThis.fetch = async (url, request) => {
    requests.push({ url: String(url), request });
    if (String(url).endsWith('per_page=100&page=1')) {
      return jsonResponse(
        Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          name: `unrelated-${index}`,
          source_type: 'Repository',
        })),
      );
    }
    if (String(url).endsWith('per_page=100&page=2')) return jsonResponse([transitional]);
    if (request.method === 'PUT') return jsonResponse({ ...ruleset, id: transitional.id });
    if (request.method === 'GET' && String(url).endsWith(`/rulesets/${transitional.id}`)) {
      return jsonResponse({ ...ruleset, id: transitional.id });
    }
    throw new Error(`Unexpected request: ${request.method} ${url}`);
  };

  try {
    assert.deepEqual(
      await applyRuleset({
        owner: 'tixkit',
        repo: 'tixkit',
        ruleset,
        token: 'test-token',
        topology: 'authoritative',
      }),
      { ...ruleset, id: transitional.id },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests.length, 4);
  assert.equal(requests[2].request.method, 'PUT');
  assert.match(requests[2].url, /rulesets\/4242$/u);
  assert.equal(JSON.parse(requests[2].request.body).name, 'authoritative-public-main');
});

test('applyRuleset creates once and fails closed on API errors', async () => {
  const originalFetch = globalThis.fetch;
  const ruleset = buildPublicRemoteRuleset({
    topology: 'authoritative',
    statusCheckIntegrationId: 15368,
  });
  let requestCount = 0;
  globalThis.fetch = async (url, request) => {
    requestCount += 1;
    if (String(url).includes('per_page=100')) return jsonResponse([]);
    if (request.method === 'POST') return jsonResponse({ ...ruleset, id: 55 });
    return jsonResponse({ ...ruleset, id: 55 });
  };
  try {
    assert.equal(
      (
        await applyRuleset({
          owner: 'tixkit',
          repo: 'tixkit',
          ruleset,
          token: 'test-token',
          topology: 'authoritative',
        })
      ).id,
      55,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestCount, 3);

  globalThis.fetch = async () => jsonResponse({ message: 'forbidden' }, 403);
  try {
    await assert.rejects(
      applyRuleset({
        owner: 'tixkit',
        repo: 'tixkit',
        ruleset,
        token: 'test-token',
        topology: 'authoritative',
      }),
      /failed with 403/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('extractWorkflowCheckNames expands matrix job names', () => {
  const workflow = `name: CI

jobs:
  lint:
    name: Lint & Typecheck
    runs-on: ubuntu-latest

  e2e:
    name: E2E Browser Matrix (\${{ matrix.browser }})
    strategy:
      matrix:
        browser: [chromium, firefox, webkit]
    runs-on: ubuntu-latest
`;

  assert.deepEqual(extractWorkflowCheckNames(workflow), [
    'E2E Browser Matrix (chromium)',
    'E2E Browser Matrix (firefox)',
    'E2E Browser Matrix (webkit)',
    'Lint & Typecheck',
  ]);
});

test('validateRequiredStatusChecksAgainstWorkflows rejects drifted check names', () => {
  const ruleset = buildPublicRemoteRuleset({
    exportAppIntegrationId: 12345,
    requiredStatusChecks: ['Lint & Typecheck', 'Browser E2E'],
  });
  const workflow = `name: CI

on:
  pull_request:
    branches: [main]

jobs:
  lint:
    name: Lint & Typecheck
    runs-on: ubuntu-latest
`;

  assert.deepEqual(validateRequiredStatusChecksAgainstWorkflows(ruleset, [workflow]), [
    'Required status check is not emitted by committed workflows: Browser E2E',
  ]);
});

test('validateRequiredStatusChecksAgainstWorkflows rejects filtered and ambiguous emitters', () => {
  const ruleset = buildPublicRemoteRuleset({
    exportAppIntegrationId: 12345,
    requiredStatusChecks: ['Lint & Typecheck'],
  });
  const filteredWorkflow = `name: Filtered CI

on:
  pull_request:
    paths: [packages/**]

jobs:
  lint:
    name: Lint & Typecheck
    runs-on: ubuntu-latest
`;
  const secondWorkflow = `name: Duplicate CI

on:
  pull_request:
    branches: [develop]

jobs:
  lint:
    name: Lint & Typecheck
    runs-on: ubuntu-latest
`;

  assert.deepEqual(
    validateRequiredStatusChecksAgainstWorkflows(ruleset, [filteredWorkflow, secondWorkflow]),
    [
      'Required status check has ambiguous workflow emitters: Lint & Typecheck',
      'Workflow emitting required checks has a pull_request path filter: Lint & Typecheck',
      'Workflow emitting required checks does not target main: Lint & Typecheck',
    ],
  );
});

test('validateRequiredStatusChecksAgainstWorkflows rejects unsafe branch filter shapes', () => {
  const ruleset = buildPublicRemoteRuleset({
    exportAppIntegrationId: 12345,
    requiredStatusChecks: ['Lint & Typecheck'],
  });
  const workflow = (pullRequestTrigger) => `name: Filtered CI

on:
  pull_request:
${pullRequestTrigger}

jobs:
  lint:
    name: Lint & Typecheck
    runs-on: ubuntu-latest
`;

  assert.deepEqual(
    validateRequiredStatusChecksAgainstWorkflows(ruleset, [
      workflow('    branches-ignore: [main]'),
    ]),
    [
      'Workflow emitting required checks has a pull_request branch exclusion filter: Lint & Typecheck',
    ],
  );
  assert.deepEqual(
    validateRequiredStatusChecksAgainstWorkflows(ruleset, [workflow('    branches: main')]),
    ['Workflow emitting required checks does not target main: Lint & Typecheck'],
  );
});

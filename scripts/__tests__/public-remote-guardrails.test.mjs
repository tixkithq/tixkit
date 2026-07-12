import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPublicRemoteRuleset,
  extractWorkflowCheckNames,
  validatePublicRemoteRuleset,
  validateRequiredStatusChecksAgainstWorkflows,
} from '../public-remote-guardrails.mjs';

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
    ['deletion', 'non_fast_forward', 'update', 'pull_request', 'required_status_checks'],
  );
  assert.deepEqual(
    ruleset.rules
      .find((rule) => rule.type === 'required_status_checks')
      .parameters.required_status_checks.map((check) => check.context),
    [
      'Lint & Typecheck',
      'Build',
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
    ],
  );
  assert.deepEqual(validatePublicRemoteRuleset(ruleset), []);
});

test('validatePublicRemoteRuleset rejects human bypass actors and missing update rule', () => {
  const ruleset = buildPublicRemoteRuleset({ exportAppIntegrationId: 12345 });
  ruleset.bypass_actors.push({
    actor_id: 1,
    actor_type: 'RepositoryRole',
    bypass_mode: 'always',
  });
  ruleset.rules = ruleset.rules.filter((rule) => rule.type !== 'update');

  assert.deepEqual(validatePublicRemoteRuleset(ruleset), [
    'Human bypass actor type is not allowed: RepositoryRole',
    'Ruleset must include update rule',
  ]);
});

test('buildPublicRemoteRuleset rejects missing export app integration IDs', () => {
  assert.throws(() => buildPublicRemoteRuleset(), {
    message: 'exportAppIntegrationId must be a positive GitHub App integration ID',
  });
  assert.throws(() => buildPublicRemoteRuleset({ exportAppIntegrationId: 'not-a-number' }), {
    message: 'exportAppIntegrationId must be a positive GitHub App integration ID',
  });
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

jobs:
  lint:
    name: Lint & Typecheck
    runs-on: ubuntu-latest
`;

  assert.deepEqual(validateRequiredStatusChecksAgainstWorkflows(ruleset, [workflow]), [
    'Required status check is not emitted by committed workflows: Browser E2E',
  ]);
});

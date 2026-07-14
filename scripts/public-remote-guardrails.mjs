#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';

const SHARED_REQUIRED_STATUS_CHECKS = [
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
];
const TOPOLOGY_REQUIRED_STATUS_CHECKS = {
  transitional: [
    ...SHARED_REQUIRED_STATUS_CHECKS.slice(0, 2),
    'OSS Export',
    ...SHARED_REQUIRED_STATUS_CHECKS.slice(2),
  ],
  authoritative: [
    ...SHARED_REQUIRED_STATUS_CHECKS.slice(0, 2),
    'Public Repository Independence',
    ...SHARED_REQUIRED_STATUS_CHECKS.slice(2),
  ],
};

const HUMAN_BYPASS_ACTOR_TYPES = new Set(['OrganizationAdmin', 'RepositoryRole', 'Team', 'User']);
const RULESET_NAMES = {
  transitional: 'public-export-only-main',
  authoritative: 'authoritative-public-main',
};

function assertTopology(topology) {
  if (!Object.hasOwn(RULESET_NAMES, topology)) {
    throw new Error('topology must be transitional or authoritative');
  }
}

function positiveIntegrationId(value, name) {
  const integrationId = Number(value);
  if (!Number.isInteger(integrationId) || integrationId <= 0) {
    throw new Error(`${name} must be a positive GitHub App integration ID`);
  }
  return integrationId;
}

function requiredChecksFor(topology, requiredStatusChecks) {
  return requiredStatusChecks ?? TOPOLOGY_REQUIRED_STATUS_CHECKS[topology];
}

function pullRequestParameters() {
  return {
    required_approving_review_count: 1,
    dismiss_stale_reviews_on_push: true,
    require_code_owner_review: true,
    require_last_push_approval: true,
    required_review_thread_resolution: true,
    automatic_copilot_code_review_enabled: false,
    allowed_merge_methods: ['squash'],
  };
}

function parseInlineArray(value) {
  const match = /^\[(.*)\]$/.exec(value.trim());
  if (!match) {
    return null;
  }
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function expandMatrixName(name, matrixValues) {
  const placeholders = [...name.matchAll(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g)];
  if (placeholders.length === 0) {
    return [name];
  }

  let names = [name];
  for (const placeholder of placeholders) {
    const key = placeholder[1];
    const values = matrixValues.get(key) ?? [];
    if (values.length === 0) {
      return [name];
    }
    names = names.flatMap((candidate) =>
      values.map((value) => candidate.replace(placeholder[0], value)),
    );
  }
  return names;
}

export function extractWorkflowCheckNames(workflowText) {
  const lines = workflowText.split(/\r?\n/);
  const checkNames = new Set();
  let currentJob = null;

  for (const line of lines) {
    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = { name: jobMatch[1], matrixValues: new Map() };
      continue;
    }
    if (!currentJob) continue;

    const nextTopLevel = /^[A-Za-z0-9_-]+:\s*$/.test(line);
    if (nextTopLevel) {
      currentJob = null;
      continue;
    }

    const nameMatch = /^    name:\s*(.+?)\s*$/.exec(line);
    if (nameMatch) {
      currentJob.name = nameMatch[1].replace(/^['"]|['"]$/g, '');
      continue;
    }

    const matrixMatch = /^        ([A-Za-z0-9_-]+):\s*(\[[^\]]+\])\s*$/.exec(line);
    if (matrixMatch) {
      const values = parseInlineArray(matrixMatch[2]);
      if (values) {
        currentJob.matrixValues.set(matrixMatch[1], values);
      }
      continue;
    }

    const nextJob = /^  [A-Za-z0-9_-]+:\s*$/.test(line);
    if (nextJob || line.trim() === '') {
      for (const expandedName of expandMatrixName(currentJob.name, currentJob.matrixValues)) {
        checkNames.add(expandedName);
      }
    }
  }

  if (currentJob) {
    for (const expandedName of expandMatrixName(currentJob.name, currentJob.matrixValues)) {
      checkNames.add(expandedName);
    }
  }

  return [...checkNames].sort();
}

export function validateRequiredStatusChecksAgainstWorkflows(ruleset, workflowTexts) {
  const checks =
    ruleset.rules?.find((rule) => rule.type === 'required_status_checks')?.parameters
      ?.required_status_checks ?? [];
  const requiredContexts = new Set(checks.map((check) => check.context));
  const workflowStates = workflowTexts.map((workflowText) => ({
    checks: extractWorkflowCheckNames(workflowText).filter((check) => requiredContexts.has(check)),
    document: parseYaml(workflowText),
  }));
  const errors = [];

  for (const context of requiredContexts) {
    const emitters = workflowStates.filter(({ checks: emitted }) => emitted.includes(context));
    if (emitters.length === 0) {
      errors.push(`Required status check is not emitted by committed workflows: ${context}`);
    } else if (emitters.length > 1) {
      errors.push(`Required status check has ambiguous workflow emitters: ${context}`);
    }
  }

  for (const { checks: emitted, document } of workflowStates) {
    if (emitted.length === 0) continue;
    const triggers = document?.on;
    if (!triggers || typeof triggers !== 'object' || !Object.hasOwn(triggers, 'pull_request')) {
      errors.push(
        `Workflow emitting required checks does not run on pull_request: ${emitted.join(', ')}`,
      );
      continue;
    }
    const pullRequest = triggers.pull_request;
    if (
      pullRequest &&
      typeof pullRequest === 'object' &&
      (Object.hasOwn(pullRequest, 'paths') || Object.hasOwn(pullRequest, 'paths-ignore'))
    ) {
      errors.push(
        `Workflow emitting required checks has a pull_request path filter: ${emitted.join(', ')}`,
      );
    }
    const branches =
      pullRequest && typeof pullRequest === 'object' ? pullRequest.branches : undefined;
    const branchesIgnore =
      pullRequest && typeof pullRequest === 'object' ? pullRequest['branches-ignore'] : undefined;
    if (branches !== undefined && (!Array.isArray(branches) || !branches.includes('main'))) {
      errors.push(`Workflow emitting required checks does not target main: ${emitted.join(', ')}`);
    }
    if (branchesIgnore !== undefined) {
      errors.push(
        `Workflow emitting required checks has a pull_request branch exclusion filter: ${emitted.join(', ')}`,
      );
    }
  }

  return errors;
}

export function buildPublicRemoteRuleset({
  exportAppIntegrationId,
  statusCheckIntegrationId,
  requiredStatusChecks,
  topology = 'transitional',
} = {}) {
  assertTopology(topology);
  const exportIntegrationId =
    topology === 'transitional'
      ? positiveIntegrationId(exportAppIntegrationId, 'exportAppIntegrationId')
      : undefined;
  const checkIntegrationId = positiveIntegrationId(
    statusCheckIntegrationId ?? exportIntegrationId,
    'statusCheckIntegrationId',
  );
  const authoritative = topology === 'authoritative';
  const requiredChecks = requiredChecksFor(topology, requiredStatusChecks);

  return {
    name: RULESET_NAMES[topology],
    target: 'branch',
    enforcement: 'active',
    bypass_actors: authoritative
      ? []
      : [
          {
            actor_id: exportIntegrationId,
            actor_type: 'Integration',
            bypass_mode: 'always',
          },
        ],
    conditions: {
      ref_name: {
        include: ['refs/heads/main'],
        exclude: [],
      },
    },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      ...(authoritative ? [{ type: 'required_linear_history' }] : [{ type: 'update' }]),
      {
        type: 'pull_request',
        parameters: pullRequestParameters(),
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: requiredChecks.map((context) => ({
            context,
            integration_id: checkIntegrationId,
          })),
        },
      },
    ],
  };
}

export function validatePublicRemoteRuleset(
  ruleset,
  {
    exportAppIntegrationId,
    requiredStatusChecks,
    statusCheckIntegrationId,
    topology = 'transitional',
  } = {},
) {
  assertTopology(topology);
  const requiredChecks = requiredChecksFor(topology, requiredStatusChecks);
  const errors = [];
  if (!ruleset || typeof ruleset !== 'object' || Array.isArray(ruleset)) {
    return ['Ruleset must be an object'];
  }

  if (ruleset.enforcement !== 'active') {
    errors.push('Ruleset enforcement must be active');
  }
  if (ruleset.name !== RULESET_NAMES[topology]) {
    errors.push(`Ruleset name must be ${RULESET_NAMES[topology]}`);
  }
  if (ruleset.target !== 'branch') {
    errors.push('Ruleset target must be branch');
  }

  const includedRefs = ruleset.conditions?.ref_name?.include;
  const excludedRefs = ruleset.conditions?.ref_name?.exclude;
  if (JSON.stringify(includedRefs) !== JSON.stringify(['refs/heads/main'])) {
    errors.push('Ruleset must target only refs/heads/main');
  }
  if (!Array.isArray(excludedRefs) || excludedRefs.length !== 0) {
    errors.push('Ruleset must not exclude refs/heads/main');
  }

  const bypassActors = Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [];
  const integrationBypassActors = bypassActors.filter(
    (actor) => actor.actor_type === 'Integration',
  );
  if (topology === 'transitional' && integrationBypassActors.length !== 1) {
    errors.push('Transitional ruleset must have exactly one Integration bypass actor');
  }
  if (topology === 'authoritative' && bypassActors.length !== 0) {
    errors.push('Authoritative ruleset must not have bypass actors');
  }
  for (const actor of bypassActors) {
    if (HUMAN_BYPASS_ACTOR_TYPES.has(actor.actor_type)) {
      errors.push(`Human bypass actor type is not allowed: ${actor.actor_type}`);
    }
    if (actor.bypass_mode !== 'always') {
      errors.push(`Bypass actor ${actor.actor_type ?? 'unknown'} must use bypass_mode=always`);
    }
  }
  if (topology === 'transitional' && exportAppIntegrationId === undefined) {
    errors.push(
      'Transitional ruleset validation requires the expected export GitHub App integration',
    );
  } else if (topology === 'transitional') {
    const expectedExportId = positiveIntegrationId(
      exportAppIntegrationId,
      'exportAppIntegrationId',
    );
    if (integrationBypassActors[0]?.actor_id !== expectedExportId) {
      errors.push('Transitional Integration bypass actor does not match the export GitHub App');
    }
  }

  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const ruleTypes = new Set(rules.map((rule) => rule.type));
  const expectedRuleTypes = [
    'deletion',
    'non_fast_forward',
    ...(topology === 'authoritative' ? ['required_linear_history'] : ['update']),
    'pull_request',
    'required_status_checks',
  ];
  if (JSON.stringify(rules.map((rule) => rule.type)) !== JSON.stringify(expectedRuleTypes)) {
    errors.push(`Ruleset rules must exactly match ${expectedRuleTypes.join(', ')}`);
  }
  for (const requiredType of [
    'deletion',
    'non_fast_forward',
    'pull_request',
    'required_status_checks',
  ]) {
    if (!ruleTypes.has(requiredType)) {
      errors.push(`Ruleset must include ${requiredType} rule`);
    }
  }
  if (topology === 'transitional' && !ruleTypes.has('update')) {
    errors.push('Transitional ruleset must include update rule');
  }
  if (topology === 'authoritative') {
    if (ruleTypes.has('update')) {
      errors.push(
        'Authoritative ruleset must not deadlock pull-request merges with an update rule',
      );
    }
    if (!ruleTypes.has('required_linear_history')) {
      errors.push('Authoritative ruleset must require linear history');
    }
  }

  const pullRequestRule = rules.find((rule) => rule.type === 'pull_request');
  if (pullRequestRule) {
    const params = pullRequestRule.parameters ?? {};
    if (JSON.stringify(params) !== JSON.stringify(pullRequestParameters())) {
      errors.push('Pull request rule parameters must exactly match the reviewed public contract');
    }
  }

  const statusRule = rules.find((rule) => rule.type === 'required_status_checks');
  const checks = statusRule?.parameters?.required_status_checks;
  if (topology === 'authoritative' && statusCheckIntegrationId === undefined) {
    errors.push('Authoritative ruleset validation requires the expected CI GitHub App integration');
  }
  const expectedCheckIntegrationId =
    statusCheckIntegrationId === undefined
      ? undefined
      : positiveIntegrationId(statusCheckIntegrationId, 'statusCheckIntegrationId');
  if (!Array.isArray(checks) || checks.length === 0) {
    errors.push('Required status checks rule must list CI checks');
  } else {
    if (statusRule.parameters?.strict_required_status_checks_policy !== true) {
      errors.push('Required status checks must use strict latest-code policy');
    }
    if (JSON.stringify(checks.map((check) => check.context)) !== JSON.stringify(requiredChecks)) {
      errors.push('Required status checks must exactly match the committed public CI contract');
    }
    for (const check of checks) {
      if (!check.context || typeof check.context !== 'string') {
        errors.push('Each required status check must have a context');
      }
      if (!Number.isInteger(check.integration_id) || check.integration_id <= 0) {
        errors.push(
          `Status check ${check.context ?? '<missing>'} must be scoped to a GitHub App integration`,
        );
      } else if (
        expectedCheckIntegrationId !== undefined &&
        check.integration_id !== expectedCheckIntegrationId
      ) {
        errors.push(
          `Status check ${check.context ?? '<missing>'} does not match the required CI GitHub App integration`,
        );
      }
    }
  }

  return errors;
}

export function selectRulesetForUpdate(existingRulesets, topology) {
  assertTopology(topology);
  const transitionalMatches = existingRulesets.filter(
    (candidate) => candidate.name === RULESET_NAMES.transitional,
  );
  const authoritativeMatches = existingRulesets.filter(
    (candidate) => candidate.name === RULESET_NAMES.authoritative,
  );
  if (transitionalMatches.length > 1 || authoritativeMatches.length > 1) {
    throw new Error('Duplicate public rulesets exist; reconcile manually');
  }
  const transitional = transitionalMatches[0];
  const authoritative = authoritativeMatches[0];
  for (const ruleset of [transitional, authoritative].filter(Boolean)) {
    if (ruleset.source_type !== undefined && ruleset.source_type !== 'Repository') {
      throw new Error(
        'Matching public ruleset is inherited and cannot be replaced at repository scope',
      );
    }
  }
  if (transitional && authoritative) {
    throw new Error(
      'Both transitional and authoritative public rulesets exist; reconcile manually',
    );
  }
  if (topology === 'transitional' && authoritative) {
    throw new Error('Refusing to downgrade an authoritative public ruleset to transitional');
  }
  return topology === 'authoritative' ? (authoritative ?? transitional) : transitional;
}

async function githubRequest(path, { method = 'GET', token, body } = {}) {
  if (!token) {
    throw new Error('GITHUB_TOKEN is required for GitHub API requests');
  }

  const request = {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
  if (body !== undefined) request.body = JSON.stringify(body);
  const response = await fetch(`https://api.github.com${path}`, request);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed with ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return undefined;
  }

  return response.json();
}

async function githubRequestAll(path, token) {
  const results = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const batch = await githubRequest(`${path}${separator}per_page=100&page=${page}`, { token });
    if (!Array.isArray(batch)) {
      throw new Error(`GitHub API GET ${path} did not return an array`);
    }
    results.push(...batch);
    if (batch.length < 100) return results;
  }
  throw new Error(`GitHub API GET ${path} exceeded 100 pages`);
}

export async function applyRuleset({ owner, repo, ruleset, token, topology }) {
  const existingRulesets = await githubRequestAll(`/repos/${owner}/${repo}/rulesets`, token);
  const existing = selectRulesetForUpdate(existingRulesets, topology);
  let result;
  if (existing) {
    result = await githubRequest(`/repos/${owner}/${repo}/rulesets/${existing.id}`, {
      method: 'PUT',
      token,
      body: ruleset,
    });
  } else {
    result = await githubRequest(`/repos/${owner}/${repo}/rulesets`, {
      method: 'POST',
      token,
      body: ruleset,
    });
  }
  if (!Number.isInteger(result?.id) || result.id <= 0) {
    throw new Error('GitHub ruleset mutation response lacks a valid ruleset ID');
  }
  return githubRequest(`/repos/${owner}/${repo}/rulesets/${result.id}`, { token });
}

function parseArgs(argv) {
  const args = {
    topology: 'transitional',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${arg} requires a value`);
      }
      return argv[index];
    };

    if (arg === '--print') {
      args.mode = 'print';
    } else if (arg === '--check') {
      args.mode = 'check';
      args.path = next();
    } else if (arg === '--write') {
      args.mode = 'write';
      args.path = next();
    } else if (arg === '--apply') {
      args.mode = 'apply';
      const repository = next();
      const [owner, repo] = repository.split('/');
      if (!owner || !repo) {
        throw new Error('--apply expects owner/repo');
      }
      args.owner = owner;
      args.repo = repo;
    } else if (arg === '--workflow') {
      args.workflowPaths ??= [];
      args.workflowPaths.push(next());
    } else if (arg === '--app-id') {
      args.exportAppIntegrationId = next();
    } else if (arg === '--status-check-app-id') {
      args.statusCheckIntegrationId = next();
    } else if (arg === '--topology') {
      args.topology = next();
    } else if (arg === '--status-check') {
      args.requiredStatusChecks ??= [];
      args.requiredStatusChecks.push(next());
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.mode ??= 'print';
  args.exportAppIntegrationId ??= process.env.PUBLIC_EXPORT_GITHUB_APP_ID;
  args.statusCheckIntegrationId ??= process.env.PUBLIC_CI_GITHUB_APP_ID;
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let ruleset;

  if (args.mode === 'check') {
    ruleset = JSON.parse(await readFile(args.path, 'utf8'));
  } else {
    ruleset = buildPublicRemoteRuleset({
      exportAppIntegrationId: args.exportAppIntegrationId,
      statusCheckIntegrationId: args.statusCheckIntegrationId,
      requiredStatusChecks: args.requiredStatusChecks,
      topology: args.topology,
    });
  }

  const errors = validatePublicRemoteRuleset(ruleset, {
    exportAppIntegrationId: args.exportAppIntegrationId,
    requiredStatusChecks: args.requiredStatusChecks,
    statusCheckIntegrationId: args.statusCheckIntegrationId,
    topology: args.topology,
  });
  if (args.workflowPaths?.length) {
    const workflowTexts = await Promise.all(
      args.workflowPaths.map((workflowPath) => readFile(workflowPath, 'utf8')),
    );
    errors.push(...validateRequiredStatusChecksAgainstWorkflows(ruleset, workflowTexts));
  }
  if (errors.length > 0) {
    throw new Error(
      `Public remote guardrail validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
  }

  if (args.mode === 'write') {
    await writeFile(args.path, `${JSON.stringify(ruleset, null, 2)}\n`);
    console.log(`Wrote public remote ruleset to ${args.path}`);
  } else if (args.mode === 'apply') {
    const result = await applyRuleset({
      owner: args.owner,
      repo: args.repo,
      ruleset,
      token: process.env.GITHUB_TOKEN,
      topology: args.topology,
    });
    const appliedErrors = validatePublicRemoteRuleset(result, {
      exportAppIntegrationId: args.exportAppIntegrationId,
      requiredStatusChecks: args.requiredStatusChecks,
      statusCheckIntegrationId: args.statusCheckIntegrationId,
      topology: args.topology,
    });
    if (appliedErrors.length > 0) {
      throw new Error(
        `Applied public remote ruleset verification failed:\n${appliedErrors.map((error) => `- ${error}`).join('\n')}`,
      );
    }
    console.log(
      `Applied public remote ruleset ${result.name} (${result.id}) to ${args.owner}/${args.repo}`,
    );
  } else if (args.mode === 'print') {
    console.log(JSON.stringify(ruleset, null, 2));
  } else {
    console.log(`Validated public remote ruleset ${args.path}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

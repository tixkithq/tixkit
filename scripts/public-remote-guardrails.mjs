#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_REQUIRED_STATUS_CHECKS = [
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

const HUMAN_BYPASS_ACTOR_TYPES = new Set(['OrganizationAdmin', 'RepositoryRole', 'Team', 'User']);

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
  const availableChecks = new Set(
    workflowTexts.flatMap((workflowText) => extractWorkflowCheckNames(workflowText)),
  );
  const checks =
    ruleset.rules?.find((rule) => rule.type === 'required_status_checks')?.parameters
      ?.required_status_checks ?? [];

  return checks
    .map((check) => check.context)
    .filter((context) => !availableChecks.has(context))
    .map((context) => `Required status check is not emitted by committed workflows: ${context}`);
}

export function buildPublicRemoteRuleset({
  exportAppIntegrationId,
  requiredStatusChecks = DEFAULT_REQUIRED_STATUS_CHECKS,
} = {}) {
  const integrationId = Number(exportAppIntegrationId);
  if (!Number.isInteger(integrationId) || integrationId <= 0) {
    throw new Error('exportAppIntegrationId must be a positive GitHub App integration ID');
  }

  return {
    name: 'public-export-only-main',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [
      {
        actor_id: integrationId,
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
      { type: 'update' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          require_last_push_approval: true,
          required_review_thread_resolution: true,
          automatic_copilot_code_review_enabled: false,
          allowed_merge_methods: ['squash'],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: requiredStatusChecks.map((context) => ({
            context,
            integration_id: integrationId,
          })),
        },
      },
    ],
  };
}

export function validatePublicRemoteRuleset(ruleset) {
  const errors = [];
  if (!ruleset || typeof ruleset !== 'object' || Array.isArray(ruleset)) {
    return ['Ruleset must be an object'];
  }

  if (ruleset.enforcement !== 'active') {
    errors.push('Ruleset enforcement must be active');
  }

  const includedRefs = ruleset.conditions?.ref_name?.include;
  if (!Array.isArray(includedRefs) || !includedRefs.includes('refs/heads/main')) {
    errors.push('Ruleset must include refs/heads/main');
  }

  const bypassActors = Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [];
  const integrationBypassActors = bypassActors.filter(
    (actor) => actor.actor_type === 'Integration',
  );
  if (integrationBypassActors.length !== 1) {
    errors.push('Ruleset must have exactly one Integration bypass actor for export automation');
  }
  for (const actor of bypassActors) {
    if (HUMAN_BYPASS_ACTOR_TYPES.has(actor.actor_type)) {
      errors.push(`Human bypass actor type is not allowed: ${actor.actor_type}`);
    }
    if (actor.bypass_mode !== 'always') {
      errors.push(`Bypass actor ${actor.actor_type ?? 'unknown'} must use bypass_mode=always`);
    }
  }

  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const ruleTypes = new Set(rules.map((rule) => rule.type));
  for (const requiredType of [
    'deletion',
    'non_fast_forward',
    'update',
    'pull_request',
    'required_status_checks',
  ]) {
    if (!ruleTypes.has(requiredType)) {
      errors.push(`Ruleset must include ${requiredType} rule`);
    }
  }

  const pullRequestRule = rules.find((rule) => rule.type === 'pull_request');
  if (pullRequestRule) {
    const params = pullRequestRule.parameters ?? {};
    if (params.required_approving_review_count < 1) {
      errors.push('Pull request rule must require at least one approving review');
    }
    if (params.require_code_owner_review !== true) {
      errors.push('Pull request rule must require CODEOWNERS review');
    }
    if (params.required_review_thread_resolution !== true) {
      errors.push('Pull request rule must require review thread resolution');
    }
  }

  const statusRule = rules.find((rule) => rule.type === 'required_status_checks');
  const checks = statusRule?.parameters?.required_status_checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    errors.push('Required status checks rule must list CI checks');
  } else {
    for (const check of checks) {
      if (!check.context || typeof check.context !== 'string') {
        errors.push('Each required status check must have a context');
      }
      if (!Number.isInteger(check.integration_id) || check.integration_id <= 0) {
        errors.push(
          `Status check ${check.context ?? '<missing>'} must be scoped to the export GitHub App integration`,
        );
      }
    }
  }

  return errors;
}

async function githubRequest(path, { method = 'GET', token, body } = {}) {
  if (!token) {
    throw new Error('GITHUB_TOKEN is required for GitHub API requests');
  }

  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${path} failed with ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return undefined;
  }

  return response.json();
}

async function applyRuleset({ owner, repo, ruleset, token }) {
  const existingRulesets = await githubRequest(`/repos/${owner}/${repo}/rulesets`, { token });
  const existing = existingRulesets.find((candidate) => candidate.name === ruleset.name);
  if (existing) {
    return githubRequest(`/repos/${owner}/${repo}/rulesets/${existing.id}`, {
      method: 'PUT',
      token,
      body: ruleset,
    });
  }

  return githubRequest(`/repos/${owner}/${repo}/rulesets`, {
    method: 'POST',
    token,
    body: ruleset,
  });
}

function parseArgs(argv) {
  const args = {
    requiredStatusChecks: DEFAULT_REQUIRED_STATUS_CHECKS,
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
    } else if (arg === '--status-check') {
      if (args.requiredStatusChecks === DEFAULT_REQUIRED_STATUS_CHECKS) {
        args.requiredStatusChecks = [];
      }
      args.requiredStatusChecks.push(next());
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.mode ??= 'print';
  args.exportAppIntegrationId ??= process.env.PUBLIC_EXPORT_GITHUB_APP_ID;
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
      requiredStatusChecks: args.requiredStatusChecks,
    });
  }

  const errors = validatePublicRemoteRuleset(ruleset);
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
    });
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

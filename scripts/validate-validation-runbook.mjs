#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import process from 'node:process';

const DEFAULT_RUNBOOK_PATH = 'docs/completion/validation-runbook.md';

const REQUIRED_SECTIONS = [
  '# Tixkit Validation Runbook',
  '## Prerequisites',
  '## Baseline Safety Checks',
  '## Core Validation Matrix',
  '## Open-Core Export Validation Gates (C-061..C-070)',
  '## Final Completion Evidence',
];

const REQUIRED_FINAL_EVIDENCE_ITEMS = [
  'Validation that `docs/completion/final-evidence-checklist.md` passes `bun run validate:final-evidence-checklist`.',
  'Git status summary.',
  'Infrastructure status.',
  'Migration status for Postgres and MySQL.',
  'Full command list run and pass/fail results.',
  'Any skipped tests and why they are acceptable or still blocking.',
  'Browser artifacts summary: screenshots, axe, no-console.',
  'Remaining risks or explicit deferrals.',
  'Confirmation that an anchored Graphify query was used for navigation and `graphify update .` was run after code changes.',
];

const REQUIRED_COMMAND_SNIPPETS = [
  'git status --short',
  'graphify query',
  'bun run export:oss -- --out /tmp/tixkit-oss-export',
  'bun run build',
  'bun run format:check',
  'bun run typecheck',
  'bun run lint',
  'bun run test',
  'git diff --check',
  'bun run validate:public-remote-guardrails',
  'bun run guardrails:public-remote -- --print',
  'bun run guardrails:public-remote -- --apply <owner>/<public-repo>',
];

const REQUIRED_EXTERNAL_GATES = [
  [
    'hosted GitHub Actions run is green',
    /hosted GitHub Actions run is green|\.github\/workflows\/trusted-ci\.yml` is green/i,
  ],
  [
    'branch protection',
    /Branch protection for `refs\/heads\/main` requires pull-request and required-status-check rules/,
  ],
  [
    'non-skipped Stripe provider gate',
    /Provider Tests \(Stripe\).*does not skip|Trusted Stripe provider jobs did not skip/is,
  ],
  ['Stripe secret key name', /STRIPE_SECRET_KEY/],
  ['Stripe webhook secret name', /STRIPE_WEBHOOK_SECRET/],
  ['Stripe publishable key name', /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY/],
  ['Stripe Connect client id name', /STRIPE_CONNECT_CLIENT_ID/],
  [
    'green release dry run',
    /\.github\/workflows\/(?:release-dry-run|trusted-release-dry-run)\.yml` runs green/i,
  ],
  ['Postgres backup', /(?:Managed )?Postgres backup/i],
  ['Postgres restore', /(?:managed )?Postgres restore|Postgres backup\/restore/i],
  ['MySQL backup', /(?:managed )?MySQL backup/i],
  ['MySQL restore', /(?:managed )?MySQL restore|MySQL backup\/restore/i],
  ['restore-based rollback', /restore-based rollback/i],
  ['RPO/RTO', /RPO\/RTO/],
  ['production deployment guide', /docs\/public\/self-hosting\/deployment\.mdx/],
  ['incident runbooks', /docs\/public\/operations\/incidents\.mdx/],
  ['Deferred 2026-06-30 PayPal', /Deferred 2026-06-30 PayPal/],
  [
    'fresh uncached user-story proof',
    /fresh (?:hosted CI|uncached Trusted CI).*user-story-test-matrix\.md.*Validated 146 user-story rows.*(?:78|133) evidence paths.*without cached Turbo-only proof/is,
  ],
  ['public export bypass actor', /export GitHub App as the only bypass actor/],
];

const REQUIRED_PATHS = [
  '.github/workflows/ci.yml',
  '.github/workflows/release-dry-run.yml',
  '.github/workflows/sdk-release-dry-run.yml',
  'docs/completion/backlog.md',
  'docs/completion/final-evidence-checklist.md',
  'docs/graphify-usage.md',
  'docs/public/operations/incidents.mdx',
  'docs/public/self-hosting/deployment.mdx',
  'docs/production-validation-harness.md',
  'scripts/export-oss.mjs',
  'scripts/validate-final-evidence-checklist.mjs',
  'scripts/public-remote-guardrails.mjs',
];

const REQUIRED_PACKAGE_SCRIPTS = [
  'build',
  'export:oss',
  'guardrails:public-remote',
  'validate:public-remote-guardrails',
  'validate:final-evidence-checklist',
  'validate:user-story-matrix',
  'test:unit',
  'test:scripts',
];

const REQUIRED_PACKAGE_SCRIPT_SNIPPETS = new Map([
  ['test:scripts', ['validate:user-story-matrix', 'validate:final-evidence-checklist']],
  ['test:unit', ['test:scripts']],
]);

const PATH_PREFIXES = ['.github/', 'apps/', 'docs/', 'e2e/', 'infra/', 'packages/', 'scripts/'];

const PATH_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sh',
  '.ts',
  '.tsx',
  '.yml',
]);

function unique(values) {
  return [...new Set(values)];
}

function normalizePath(path) {
  return normalize(path).replaceAll(sep, '/');
}

function getSection(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start === -1) {
    return null;
  }

  const afterHeading = start + heading.length;
  const nextHeading = markdown.slice(afterHeading).search(/\n## /);
  if (nextHeading === -1) {
    return markdown.slice(afterHeading);
  }

  return markdown.slice(afterHeading, afterHeading + nextHeading);
}

function collectBacktickedLocalPaths(markdown) {
  const paths = [];
  const matches = markdown.matchAll(/`([^`\n]+)`/g);

  for (const match of matches) {
    const token = match[1].trim();
    if (
      token.includes(' ') ||
      token.includes('*') ||
      token.includes(':') ||
      token.startsWith('/') ||
      token.startsWith('http://') ||
      token.startsWith('https://') ||
      token.startsWith('${')
    ) {
      continue;
    }

    const normalized = normalizePath(token);
    if (normalized.startsWith('../') || normalized === '..') {
      continue;
    }

    if (
      PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
      PATH_EXTENSIONS.has(extname(normalized))
    ) {
      paths.push(normalized);
    }
  }

  return unique(paths);
}

async function pathExists(rootDir, relativePath) {
  try {
    await stat(join(rootDir, relativePath));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readPackageScripts(rootDir) {
  const packageJson = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  return packageJson.scripts ?? {};
}

function extractWorkflowJobBlocks(workflowText) {
  const blocks = [];
  const lines = workflowText.split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      if (current) {
        blocks.push(current);
      }
      current = { id: jobMatch[1], text: `${line}\n` };
      continue;
    }

    if (current) {
      if (/^\S/.test(line) && line.trim() !== '') {
        blocks.push(current);
        current = null;
      } else {
        current.text += `${line}\n`;
      }
    }
  }

  if (current) {
    blocks.push(current);
  }

  return blocks;
}

function validateCiWorkflowCoverageGate(workflowText) {
  const errors = [];
  if (workflowText === null) {
    return errors;
  }

  const unitTestJob = extractWorkflowJobBlocks(workflowText).find((block) =>
    /^\s+name:\s+Unit Tests\s*$/m.test(block.text),
  );
  if (!unitTestJob) {
    errors.push('CI workflow must emit the Unit Tests status check');
    return errors;
  }

  if (!/\brun:\s+bun run test:(?:unit|scripts)\b/.test(unitTestJob.text)) {
    errors.push(
      'CI workflow Unit Tests job must run the root test:unit or test:scripts coverage gate',
    );
  }

  return errors;
}

export function validateValidationRunbookContent(
  markdown,
  packageScripts = {},
  { ciWorkflowText = null } = {},
) {
  const errors = [];

  for (const section of REQUIRED_SECTIONS) {
    if (!markdown.includes(section)) {
      errors.push(`Missing required section: ${section}`);
    }
  }

  const finalEvidence = getSection(markdown, '## Final Completion Evidence');
  if (!finalEvidence) {
    errors.push('Missing Final Completion Evidence section');
  } else {
    for (const item of REQUIRED_FINAL_EVIDENCE_ITEMS) {
      if (!finalEvidence.includes(`- ${item}`)) {
        errors.push(`Final Completion Evidence is missing: ${item}`);
      }
    }
  }

  for (const snippet of REQUIRED_COMMAND_SNIPPETS) {
    if (!markdown.includes(snippet)) {
      errors.push(`Missing required command snippet: ${snippet}`);
    }
  }

  for (const [label, pattern] of REQUIRED_EXTERNAL_GATES) {
    if (!pattern.test(markdown)) {
      errors.push(`Missing required external gate evidence: ${label}`);
    }
  }

  for (const script of REQUIRED_PACKAGE_SCRIPTS) {
    if (typeof packageScripts[script] !== 'string' || packageScripts[script].length === 0) {
      errors.push(`package.json is missing required script: ${script}`);
    }
  }
  for (const [script, snippets] of REQUIRED_PACKAGE_SCRIPT_SNIPPETS) {
    const command = packageScripts[script];
    if (typeof command !== 'string') {
      continue;
    }
    for (const snippet of snippets) {
      if (!command.includes(snippet)) {
        errors.push(`package.json script ${script} must include ${snippet}`);
      }
    }
  }

  errors.push(...validateCiWorkflowCoverageGate(ciWorkflowText));

  if (!markdown.includes('PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id>')) {
    errors.push(
      'Public remote guardrail commands must document PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id>',
    );
  }
  if (!markdown.includes('GITHUB_TOKEN=<admin-token>')) {
    errors.push('Public remote guardrail apply command must document GITHUB_TOKEN=<admin-token>');
  }

  return {
    errors,
    referencedPaths: unique([...REQUIRED_PATHS, ...collectBacktickedLocalPaths(markdown)]),
  };
}

export async function validateValidationRunbookFiles({
  rootDir = process.cwd(),
  runbookPath = DEFAULT_RUNBOOK_PATH,
} = {}) {
  const absoluteRoot = resolve(rootDir);
  const markdown = await readFile(join(absoluteRoot, runbookPath), 'utf8');
  const packageScripts = await readPackageScripts(absoluteRoot);
  const ciWorkflowText = await readFile(join(absoluteRoot, '.github/workflows/ci.yml'), 'utf8');
  const result = validateValidationRunbookContent(markdown, packageScripts, { ciWorkflowText });
  const errors = [...result.errors];

  for (const relativePath of result.referencedPaths) {
    if (!(await pathExists(absoluteRoot, relativePath))) {
      errors.push(`Referenced path does not exist: ${relativePath}`);
    }
  }

  return { errors, referencedPaths: result.referencedPaths };
}

function parseArgs(argv) {
  const args = { path: DEFAULT_RUNBOOK_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--path') {
      index += 1;
      if (index >= argv.length) throw new Error('--path requires a value');
      args.path = argv[index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const { path } = parseArgs(argv);
  const { errors, referencedPaths } = await validateValidationRunbookFiles({ runbookPath: path });
  if (errors.length > 0) {
    throw new Error(
      `Validation runbook check failed:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
  }
  console.log(`Validated ${path} with ${referencedPaths.length} local path references`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

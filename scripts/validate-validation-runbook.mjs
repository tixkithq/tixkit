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

const REQUIRED_PATHS = [
  '.github/workflows/ci.yml',
  '.github/workflows/release-dry-run.yml',
  '.github/workflows/sdk-release-dry-run.yml',
  'docs/completion/backlog.md',
  'docs/graphify-usage.md',
  'docs/incident-runbooks.md',
  'docs/production-deployment-guide.md',
  'docs/production-validation-harness.md',
  'scripts/export-oss.mjs',
  'scripts/public-remote-guardrails.mjs',
];

const REQUIRED_PACKAGE_SCRIPTS = [
  'build',
  'export:oss',
  'guardrails:public-remote',
  'validate:public-remote-guardrails',
  'test:scripts',
];

const PATH_PREFIXES = [
  '.github/',
  'apps/',
  'docs/',
  'e2e/',
  'infra/',
  'packages/',
  'scripts/',
];

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

export function validateValidationRunbookContent(markdown, packageScripts = {}) {
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

  for (const script of REQUIRED_PACKAGE_SCRIPTS) {
    if (typeof packageScripts[script] !== 'string' || packageScripts[script].length === 0) {
      errors.push(`package.json is missing required script: ${script}`);
    }
  }

  if (!markdown.includes('PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id>')) {
    errors.push('Public remote guardrail commands must document PUBLIC_EXPORT_GITHUB_APP_ID=<integration-id>');
  }
  if (!markdown.includes('GITHUB_TOKEN=<admin-token>')) {
    errors.push('Public remote guardrail apply command must document GITHUB_TOKEN=<admin-token>');
  }

  return { errors, referencedPaths: unique([...REQUIRED_PATHS, ...collectBacktickedLocalPaths(markdown)]) };
}

export async function validateValidationRunbookFiles({
  rootDir = process.cwd(),
  runbookPath = DEFAULT_RUNBOOK_PATH,
} = {}) {
  const absoluteRoot = resolve(rootDir);
  const markdown = await readFile(join(absoluteRoot, runbookPath), 'utf8');
  const packageScripts = await readPackageScripts(absoluteRoot);
  const result = validateValidationRunbookContent(markdown, packageScripts);
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
    throw new Error(`Validation runbook check failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  }
  console.log(`Validated ${path} with ${referencedPaths.length} local path references`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

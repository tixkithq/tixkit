#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { parseCompletionBacklog } from './validate-completion-backlog.mjs';

const DEFAULT_CHECKLIST_PATH = 'docs/completion/final-evidence-checklist.md';
const DEFAULT_BACKLOG_PATH = 'docs/completion/backlog.md';
const DEFAULT_RUNBOOK_PATH = 'docs/completion/validation-runbook.md';
const REQUIRED_ROWS = new Map([
  [
    'C-035',
    {
      status: 'Blocking',
      required: [
        /Hosted GitHub Actions run URL|Trusted CI.*run URL/i,
        /required check names|check names/i,
        /branch protection/i,
      ],
      completeProof: [
        /https:\/\/github\.com\/\S+\/actions\/runs\/\d+/i,
        /branch protection API|rulesets?\/\d+/i,
        /refs\/heads\/main|main branch/i,
        /pull-request/i,
        /required-status-check|required status checks/i,
        /Lint & Typecheck/i,
        /Build/i,
        /Unit Tests/i,
        /Integration Tests \(PostgreSQL\)/i,
        /Integration Tests \(MySQL\)/i,
        /E2E Browser Matrix \(chromium\)/i,
        /E2E Browser Matrix \(firefox\)/i,
        /E2E Browser Matrix \(webkit\)/i,
      ],
      blocker: [
        /GitHub Actions billing|hosted runners|fresh green Trusted CI run URL|fresh green run URL|private runner/i,
      ],
      backlogTerms: [/hosted CI|GitHub Actions|Trusted CI|EPYC/i, /branch protection/i],
    },
  ],
  [
    'C-036',
    {
      status: 'Blocking',
      required: [
        /Provider Tests \(Stripe\)/i,
        /Step Summary/i,
        /STRIPE_SECRET_KEY/i,
        /STRIPE_WEBHOOK_SECRET/i,
        /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY/i,
        /STRIPE_CONNECT_CLIENT_ID/i,
        /did not skip|without skips/i,
        /secret values.*redacted|redacted.*secret values/i,
      ],
      completeProof: [
        /https:\/\/github\.com\/\S+\/actions\/runs\/\d+/i,
        /Provider Tests \(Stripe\)/i,
        /provider-secrets available=true|all CI-managed test-mode secrets configured|no missing CI-managed test-mode secrets/i,
        /STRIPE_SECRET_KEY/i,
        /STRIPE_WEBHOOK_SECRET/i,
        /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY/i,
        /STRIPE_CONNECT_CLIENT_ID/i,
        /Stripe provider tests passed/i,
        /Run direct Stripe provider workflow test|Direct Stripe create\/confirm\/refund activity validation ran/i,
        /Run hosted Stripe Elements browser test|Hosted Stripe Elements checkout\/refund browser validation ran/i,
        /Run Stripe Connect provider test|Stripe Connect account creation\/status refresh validation ran/i,
        /did not skip|non-skipped/i,
        /secret values redacted|masked secret values|no secret values/i,
      ],
      blocker: [/hosted Stripe test-mode secrets|trusted-runner Stripe secrets/i],
      backlogTerms: [
        /Stripe/i,
        /provider gates/i,
        /hosted CI|GitHub Actions|Trusted CI|trusted-runner/i,
      ],
    },
  ],
  [
    'C-037',
    {
      status: 'Blocking',
      required: [
        /release-dry-run\.yml/i,
        /managed Postgres backup\/restore|EPYC-lab Postgres backup\/restore/i,
        /managed MySQL backup\/restore|MySQL backup\/restore/i,
        /migration rollback/i,
      ],
      completeProof: [
        /https:\/\/github\.com\/\S+\/actions\/runs\/\d+/i,
        /release-dry-run\.yml/i,
        /managed Postgres/i,
        /managed MySQL/i,
        /managed Postgres[^,.;|]*backup|Postgres backup/i,
        /managed Postgres[^,.;|]*restore|Postgres restore/i,
        /managed MySQL[^,.;|]*backup|MySQL backup/i,
        /managed MySQL[^,.;|]*restore|MySQL restore/i,
        /restore-based rollback|restore based rollback/i,
        /migration rollback|rollback rehearsal/i,
        /RPO\/RTO/i,
        /docs\/production-deployment-guide\.md/i,
        /docs\/incident-runbooks\.md/i,
      ],
      blocker: [
        /hosted release dry-run|trusted release run/i,
        /managed database rehearsal|database rehearsal/i,
      ],
      backlogTerms: [
        /hosted release dry-run|trusted release/i,
        /managed .*backup|managed Postgres\/MySQL|managed database|lab backup|backup\/restore/i,
        /migration rollback|rollback rehearsal/i,
      ],
    },
  ],
  [
    'C-069',
    {
      status: 'Blocking',
      required: [
        /public remote ruleset|ruleset\/API proof/i,
        /export GitHub App as the only bypass actor/i,
      ],
      completeProof: [
        /rulesets?\/\d+|ruleset id[:=]\s*\d+|ruleset\/API proof/i,
        /refs\/heads\/main/i,
        /active update/i,
        /deletion/i,
        /non-fast-forward/i,
        /pull-request/i,
        /required-status-check/i,
        /export GitHub App as the only bypass actor/i,
        /no human bypass actors|without human bypass actors/i,
      ],
      blocker: [/not been applied to the public remote/i],
      backlogTerms: [/direct human pushes|human-push|public remote/i, /export GitHub App/i],
    },
  ],
  [
    'C-071',
    {
      status: 'Deferred',
      required: [/2026-06-30/i, /PayPal|payment-provider abstraction/i],
      completeProof: [/2026-06-30/i, /PayPal|payment-provider abstraction/i],
      blocker: [/Deferred 2026-06-30/i],
      backlogTerms: [/PayPal/i, /payment-provider abstraction|payment provider abstraction/i],
    },
  ],
  [
    'C-082',
    {
      status: 'Blocking',
      required: [
        /Fresh hosted CI run URL|Fresh Trusted CI run URL/i,
        /test:scripts/i,
        /user-story-test-matrix\.md/i,
        /Validated 146 user-story rows/i,
        /133 evidence paths/i,
        /without cached Turbo-only proof|no cached Turbo-only proof|cache disabled|turbo --force/i,
      ],
      completeProof: [
        /https:\/\/github\.com\/\S+\/actions\/runs\/\d+/i,
        /Unit Tests/i,
        /100% user-story test coverage|traceability matrix/i,
        /Validated 146 user-story rows/i,
        /133 evidence paths/i,
        /test:scripts/i,
        /user-story-test-matrix\.md/i,
        /fresh hosted CI/i,
        /without cached Turbo-only proof|no cached Turbo-only proof|cache disabled|turbo --force/i,
      ],
      blocker: [/fresh hosted CI proof depends on C-035|fresh uncached Trusted CI artifact/i],
      backlogTerms: [
        /100% user-story test coverage|user-story matrix|traceability matrix/i,
        /fresh hosted CI|fresh uncached Trusted CI|Trusted CI/i,
      ],
    },
  ],
]);

const REQUIRED_RUNBOOK_TERMS = new Map([
  [
    'C-035',
    [
      /Hosted CI proof \(C-035, C-036\)|Trusted CI proof \(C-035, C-036\)/i,
      /hosted GitHub Actions run|trusted-ci\.yml.*tixkit-epyc-trusted/i,
      /Lint & Typecheck/,
      /Build/,
      /Unit Tests/,
      /Integration Tests \(PostgreSQL\)/,
      /Integration Tests \(MySQL\)/,
      /E2E Browser Matrix \(chromium\)|browser\/performance gates/,
      /E2E Browser Matrix \(firefox\)|browser\/performance gates/,
      /E2E Browser Matrix \(webkit\)|browser\/performance gates/,
      /Branch protection/i,
      /refs\/heads\/main/i,
      /pull-request/i,
      /required-status-check/i,
    ],
  ],
  [
    'C-036',
    [
      /Hosted CI proof \(C-035, C-036\)|Trusted CI proof \(C-035, C-036\)/i,
      /Provider Tests \(Stripe\)|Trusted Stripe provider jobs/i,
      /STRIPE_SECRET_KEY/i,
      /STRIPE_WEBHOOK_SECRET/i,
      /NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY/i,
      /STRIPE_CONNECT_CLIENT_ID/i,
      /GitHub Step Summary|Step Summary/i,
      /provider secret gate was available|redacted test-mode secrets/i,
      /Stripe provider tests passed|prove direct Stripe/i,
      /secret values were redacted/i,
      /does not skip|did not skip/i,
    ],
  ],
  [
    'C-037',
    [
      /Release and DR truth-up \(C-037\)/i,
      /release-dry-run\.yml/i,
      /managed Postgres backup|Postgres backup\/restore/i,
      /managed Postgres restore|Postgres backup\/restore/i,
      /managed MySQL backup|MySQL backup\/restore/i,
      /managed MySQL restore|MySQL backup\/restore/i,
      /restore-based rollback/i,
      /RPO\/RTO/i,
      /docs\/production-deployment-guide\.md|EPYC lab databases/i,
      /docs\/incident-runbooks\.md|RPO\/RTO evidence/i,
    ],
  ],
  [
    'C-069',
    [
      /Before creating or updating any public OSS remote/i,
      /export GitHub App as the only bypass actor/i,
    ],
  ],
  [
    'C-071',
    [/Final coverage and deferred provider gates \(C-071, C-082\)/i, /Deferred 2026-06-30 PayPal/i],
  ],
  [
    'C-082',
    [
      /Final coverage and deferred provider gates \(C-071, C-082\)/i,
      /fresh hosted CI|fresh uncached Trusted CI/i,
      /user-story-test-matrix\.md/i,
      /Validated 146 user-story rows/i,
      /133 evidence paths/i,
      /without cached Turbo-only proof|no cached Turbo-only proof|cache disabled|turbo --force/i,
    ],
  ],
]);

const ALLOWED_STATUSES = new Set(['Blocking', 'Complete', 'Deferred']);
const PROOF_PATTERN =
  /\b(?:https:\/\/github\.com\/\S+\/actions\/runs\/\d+|rulesets?\/\d+|run id[:=]\s*\d+|branch protection API|Stripe dashboard event|RPO\/RTO)\b/i;
const PLACEHOLDER_PROOF_PATTERNS = [
  [
    'placeholder GitHub owner',
    /https:\/\/github\.com\/(?:acme|example|owner|your-org|your-repo)\//i,
  ],
  ['placeholder GitHub path', /<owner>\/<repo>|owner\/repo|your-org\/your-repo/i],
  ['example URL', /https?:\/\/(?:www\.)?example\.(?:com|org|net)\b/i],
];
const RAW_SECRET_PATTERNS = [
  ['Stripe secret key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9_]{16,}\b/],
  ['Stripe client secret', /\bpi_[A-Za-z0-9_]+_secret_[A-Za-z0-9_]+\b/],
  ['GitHub token', /\b(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
];
const BACKLOG_TO_CHECKLIST_STATUS = new Map([
  ['Done', 'Complete'],
  ['In progress', 'Blocking'],
  ['Open', 'Blocking'],
  ['Partial', 'Blocking'],
  ['Deferred', 'Deferred'],
]);

function splitMarkdownRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;

  const cells = [];
  let current = '';
  let inCode = false;
  for (let index = 1; index < trimmed.length - 1; index += 1) {
    const char = trimmed[index];
    if (char === '`') {
      inCode = !inCode;
      current += char;
    } else if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isSeparatorRow(cells) {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function isMalformedCompletionId(value) {
  return /^C-?\d+$/i.test(value) && !/^C-\d{3}$/.test(value);
}

export function parseFinalEvidenceChecklist(markdown) {
  const malformedRows = [];
  const rows = [];
  const lines = markdown.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const cells = splitMarkdownRow(line);
    if (!cells || isSeparatorRow(cells) || cells[0] === 'ID') {
      continue;
    }
    if (!/^C-\d{3}$/.test(cells[0])) {
      if (isMalformedCompletionId(cells[0])) {
        malformedRows.push(
          `line ${index + 1}: final evidence row id must use C-### format: ${cells[0]}`,
        );
      }
      continue;
    }
    if (cells.length !== 5) {
      malformedRows.push(`line ${index + 1}: final evidence row ${cells[0]} must have 5 columns`);
      continue;
    }
    rows.push({
      id: cells[0],
      gate: cells[1],
      status: cells[2],
      requiredEvidence: cells[3],
      currentEvidence: cells[4],
    });
  }
  return { malformedRows, rows };
}

function collectBacklogRows(backlogMarkdown) {
  if (!backlogMarkdown) {
    return null;
  }

  const { ledgerRows } = parseCompletionBacklog(backlogMarkdown);
  return new Map(ledgerRows.map((row) => [row.id, row]));
}

export function validateFinalEvidenceChecklist(
  markdown,
  { backlogMarkdown = null, validationRunbookMarkdown = null } = {},
) {
  const { malformedRows, rows } = parseFinalEvidenceChecklist(markdown);
  const errors = [];
  const rowsById = new Map();
  const backlogRows = collectBacklogRows(backlogMarkdown);
  for (const malformedRow of malformedRows) {
    errors.push(`Malformed final evidence row: ${malformedRow}`);
  }

  for (const row of rows) {
    if (rowsById.has(row.id)) {
      errors.push(`${row.id}: duplicate final evidence row`);
    }
    rowsById.set(row.id, row);

    if (!ALLOWED_STATUSES.has(row.status)) {
      errors.push(`${row.id}: invalid status ${row.status}`);
    }
    if (!row.gate.trim()) {
      errors.push(`${row.id}: gate must not be empty`);
    }
    if (!row.requiredEvidence.trim()) {
      errors.push(`${row.id}: required evidence must not be empty`);
    }
    if (!row.currentEvidence.trim()) {
      errors.push(`${row.id}: current evidence must not be empty`);
    }

    if (backlogRows && !REQUIRED_ROWS.has(row.id)) {
      const backlogRow = backlogRows.get(row.id);
      if (!backlogRow) {
        errors.push(`${row.id}: final evidence row has no matching completion backlog item`);
      } else if (backlogRow.status === 'Done') {
        errors.push(
          `${row.id}: Done completion backlog rows do not belong in final evidence checklist`,
        );
      }
    }
  }

  for (const [id, rule] of REQUIRED_ROWS) {
    const row = rowsById.get(id);
    if (!row) {
      errors.push(`${id}: missing final evidence row`);
      continue;
    }

    if (row.status !== rule.status && row.status !== 'Complete') {
      errors.push(`${id}: expected status ${rule.status} until concrete proof is attached`);
    }

    if (backlogRows) {
      const backlogRow = backlogRows.get(id);
      const expectedChecklistStatus = BACKLOG_TO_CHECKLIST_STATUS.get(backlogRow?.status);
      if (!backlogRow) {
        errors.push(`${id}: final evidence row has no matching completion backlog item`);
      } else if (expectedChecklistStatus && row.status !== expectedChecklistStatus) {
        errors.push(
          `${id}: checklist status ${row.status} does not match completion backlog status ${backlogRow.status}`,
        );
      }
    }

    const combinedRowText = `${row.gate} ${row.requiredEvidence} ${row.currentEvidence}`;
    for (const pattern of rule.backlogTerms ?? []) {
      if (!pattern.test(combinedRowText)) {
        errors.push(`${id}: final evidence row does not preserve backlog scope ${pattern.source}`);
      }
    }

    for (const pattern of rule.required) {
      if (!pattern.test(row.requiredEvidence)) {
        errors.push(`${id}: required evidence does not name ${pattern.source}`);
      }
    }

    for (const [label, pattern] of RAW_SECRET_PATTERNS) {
      if (pattern.test(row.currentEvidence)) {
        errors.push(`${id}: current evidence must not include raw secret value (${label})`);
      }
    }

    for (const [label, pattern] of PLACEHOLDER_PROOF_PATTERNS) {
      if (pattern.test(row.currentEvidence)) {
        errors.push(`${id}: current evidence must not use placeholder proof (${label})`);
      }
    }

    if (row.status === 'Complete') {
      if (!PROOF_PATTERN.test(row.currentEvidence)) {
        errors.push(`${id}: Complete rows must cite concrete external proof`);
      }
      for (const pattern of rule.completeProof ?? []) {
        if (!pattern.test(row.currentEvidence)) {
          errors.push(`${id}: Complete evidence does not prove ${pattern.source}`);
        }
      }
      if (
        /\b(?:Blocking|blocked|not available|not configured|depends on)\b/i.test(
          row.currentEvidence,
        )
      ) {
        errors.push(`${id}: Complete rows must not retain blocking language`);
      }
    } else {
      if (PROOF_PATTERN.test(row.currentEvidence)) {
        errors.push(`${id}: non-complete rows must not contain concrete external proof`);
      }
      for (const pattern of rule.blocker) {
        if (!pattern.test(row.currentEvidence)) {
          errors.push(`${id}: non-complete rows must document the current blocker or deferral`);
        }
      }
    }
  }

  if (validationRunbookMarkdown !== null) {
    for (const [id, patterns] of REQUIRED_RUNBOOK_TERMS) {
      for (const pattern of patterns) {
        if (!pattern.test(validationRunbookMarkdown)) {
          errors.push(
            `${id}: validation runbook is missing final evidence proof term ${pattern.source}`,
          );
        }
      }
    }
  }

  if (backlogRows) {
    for (const [id, backlogRow] of backlogRows) {
      if (backlogRow.status !== 'Done' && !rowsById.has(id)) {
        errors.push(
          `${id}: non-Done completion backlog row is missing from final evidence checklist`,
        );
      }
    }
  }

  if (!markdown.includes('Do not mark the active goal complete')) {
    errors.push(
      'Closeout rule must explicitly block goal completion before checklist proof exists',
    );
  }

  return { errors, rows };
}

function parseArgs(argv) {
  const args = {
    path: DEFAULT_CHECKLIST_PATH,
    backlogPath: DEFAULT_BACKLOG_PATH,
    validationRunbookPath: DEFAULT_RUNBOOK_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--path') {
      index += 1;
      if (index >= argv.length) throw new Error('--path requires a value');
      args.path = argv[index];
    } else if (arg === '--backlog') {
      index += 1;
      if (index >= argv.length) throw new Error('--backlog requires a value');
      args.backlogPath = argv[index];
    } else if (arg === '--validation-runbook') {
      index += 1;
      if (index >= argv.length) throw new Error('--validation-runbook requires a value');
      args.validationRunbookPath = argv[index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const { path, backlogPath, validationRunbookPath } = parseArgs(argv);
  const markdown = await readFile(path, 'utf8');
  const backlogMarkdown = await readFile(backlogPath, 'utf8');
  const validationRunbookMarkdown = await readFile(validationRunbookPath, 'utf8');
  const { errors, rows } = validateFinalEvidenceChecklist(markdown, {
    backlogMarkdown,
    validationRunbookMarkdown,
  });
  if (errors.length > 0) {
    throw new Error(
      `Final evidence checklist validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
  }
  console.log(`Validated ${rows.length} final evidence rows in ${path}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

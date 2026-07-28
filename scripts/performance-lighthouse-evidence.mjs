#!/usr/bin/env node
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import evidenceSchema from './performance-lighthouse-evidence.schema.json' with { type: 'json' };
import {
  assertValidPerformanceBudgetConfig,
  evaluateBudgets,
} from './check-performance-budgets.mjs';
import { canonicalHostedTrustJson as canonicalJson, sha256 } from './lib/hosted-trust-receipt.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 20 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const DENIALS = Object.freeze([
  'representative real-user monitoring',
  'Production capacity',
  'Compact capacity',
  'Cloud capacity',
  'soak stability',
  'fault tolerance',
  'SLA or SLO attainment',
]);
const validateEvidenceSchema = new Ajv2020({
  allErrors: true,
  strict: true,
  formats: { 'date-time': true },
}).compile(evidenceSchema);

function schemaError(value, label) {
  if (validateEvidenceSchema(value)) return;
  const details = validateEvidenceSchema.errors
    ?.map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
  throw new Error(`${label} violates Lighthouse evidence schema: ${details ?? 'unknown error'}`);
}

function assertGitSha(gitSha) {
  if (typeof gitSha !== 'string' || !/^[a-f0-9]{40}$/u.test(gitSha)) {
    throw new Error('Lighthouse evidence git SHA must be exactly 40 lowercase hexadecimal digits');
  }
  return gitSha;
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function resolveContainedPath(root, input, label) {
  const unresolved = resolve(root, input);
  const candidate = resolve(realpathSync(dirname(unresolved)), basename(unresolved));
  if (!isWithin(root, candidate)) throw new Error(`${label} escapes the evidence root`);
  return candidate;
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function readBoundedRegularSnapshot(path, maximumBytes, label) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a direct regular file`);
  }
  if (before.size < 1 || before.size > maximumBytes) {
    throw new Error(`${label} exceeds its bounded size`);
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (bytes.length !== before.size || !sameFileIdentity(before, after)) {
    throw new Error(`${label} changed while being read`);
  }
  return { bytes, metadata: after };
}

function readBoundedRegularFile(path, maximumBytes, label) {
  return readBoundedRegularSnapshot(path, maximumBytes, label).bytes;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function normalizedRelativePath(root, path, label) {
  const value = relative(root, path).split(sep).join('/');
  if (!value || value.startsWith('../') || isAbsolute(value)) {
    throw new Error(`${label} is outside the evidence root`);
  }
  return value;
}

function finiteMetric(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`);
  }
  return value;
}

function validFetchTime(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid date-time`);
  }
  return value;
}

export function createLighthouseEvidence({
  root = repositoryRoot,
  configPath = 'performance-budgets.lighthouse.json',
  gitSha,
  onReportsLoaded,
} = {}) {
  const canonicalRoot = realpathSync(resolve(root));
  const resolvedConfigPath = resolveContainedPath(canonicalRoot, configPath, 'budget config');
  const configBytes = readBoundedRegularFile(
    resolvedConfigPath,
    MAX_CONFIG_BYTES,
    'Lighthouse budget config',
  );
  const config = assertValidPerformanceBudgetConfig(
    parseJson(configBytes, 'Lighthouse budget config'),
  );
  if (!Array.isArray(config.lighthouseReports) || config.lighthouseReports.length === 0) {
    throw new Error('Lighthouse budget config must contain reports');
  }
  const paths = config.lighthouseReports.map((report) => report.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error('Lighthouse budget config contains duplicate report paths');
  }
  const loadedReports = config.lighthouseReports.map((budget) => {
    const reportPath = resolveContainedPath(canonicalRoot, budget.path, `${budget.label} report`);
    const snapshot = readBoundedRegularSnapshot(
      reportPath,
      MAX_REPORT_BYTES,
      `${budget.label} report`,
    );
    return {
      budget,
      reportPath,
      snapshot,
      report: parseJson(snapshot.bytes, `${budget.label} report`),
    };
  });
  const canonicalReportPaths = loadedReports.map(({ reportPath }) => reportPath);
  if (new Set(canonicalReportPaths).size !== canonicalReportPaths.length) {
    throw new Error('Lighthouse budget config contains duplicate canonical report identities');
  }
  if (onReportsLoaded !== undefined) {
    if (typeof onReportsLoaded !== 'function') {
      throw new TypeError('Lighthouse evidence report-read hook must be a function');
    }
    onReportsLoaded();
  }
  const budgetResults = evaluateBudgets(config, { root: canonicalRoot });
  const failures = budgetResults.filter((result) => !result.ok);
  if (failures.length > 0) {
    throw new Error(`Lighthouse budgets failed: ${failures.map(({ line }) => line).join('; ')}`);
  }
  for (const { budget, reportPath, snapshot } of loadedReports) {
    const confirmed = readBoundedRegularSnapshot(
      reportPath,
      MAX_REPORT_BYTES,
      `${budget.label} report`,
    );
    if (
      !sameFileIdentity(snapshot.metadata, confirmed.metadata) ||
      !snapshot.bytes.equals(confirmed.bytes)
    ) {
      throw new Error(`${budget.label} report changed during budget evaluation`);
    }
  }

  const reports = loadedReports.map(({ budget, reportPath, snapshot, report }) => {
    const reportBytes = snapshot.bytes;
    const performanceScore =
      budget.minPerformanceScore === undefined
        ? null
        : finiteMetric(report?.categories?.performance?.score, `${budget.label} performance score`);
    return {
      label: budget.label,
      path: normalizedRelativePath(canonicalRoot, reportPath, `${budget.label} report`),
      sha256: sha256(reportBytes),
      bytes: reportBytes.length,
      requestedUrl: report.requestedUrl,
      finalDisplayedUrl: report.finalDisplayedUrl,
      lighthouseVersion: report.lighthouseVersion,
      fetchTime: validFetchTime(report.fetchTime, `${budget.label} fetchTime`),
      performanceScore,
      audits: (budget.audits ?? []).map((audit) => ({
        id: audit.id,
        label: audit.label ?? audit.id,
        numericValue: finiteMetric(
          report?.audits?.[audit.id]?.numericValue,
          `${budget.label} ${audit.id}`,
        ),
        unit: audit.unit ?? null,
      })),
    };
  });
  const payload = {
    schemaVersion: 'tixkit-performance-lighthouse-evidence-v1',
    claimScope: 'browser-lighthouse-budget-regression',
    denials: [...DENIALS],
    integrityModel: 'checksums-not-signatures',
    gitSha: assertGitSha(gitSha),
    config: {
      path: normalizedRelativePath(canonicalRoot, resolvedConfigPath, 'budget config'),
      sha256: sha256(configBytes),
    },
    reports,
  };
  const evidence = { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
  schemaError(evidence, 'generated evidence');
  return evidence;
}

function safeEvidenceOutput(root, outputPath) {
  const canonicalRoot = realpathSync(resolve(root));
  const unresolvedOutput = resolve(canonicalRoot, outputPath);
  if (!isWithin(canonicalRoot, unresolvedOutput)) {
    throw new Error('evidence output escapes the evidence root');
  }
  const parentParts = relative(canonicalRoot, dirname(unresolvedOutput)).split(sep).filter(Boolean);
  let canonicalParent = canonicalRoot;
  for (const part of parentParts) {
    const next = resolve(canonicalParent, part);
    try {
      const metadata = lstatSync(next);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('evidence output parent must contain only direct directories');
      }
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      mkdirSync(next, { mode: 0o700 });
    }
    canonicalParent = realpathSync(next);
    if (!isWithin(canonicalRoot, canonicalParent)) {
      throw new Error('evidence output parent escapes the evidence root');
    }
  }
  return resolve(canonicalParent, basename(unresolvedOutput));
}

export function writeLighthouseEvidence({ root = repositoryRoot, outputPath, ...input }) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new Error('Lighthouse evidence output path is required');
  }
  const evidence = createLighthouseEvidence({ root, ...input });
  const resolvedOutput = safeEvidenceOutput(root, outputPath);
  writeFileSync(resolvedOutput, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  const metadata = statSync(resolvedOutput);
  if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error('Lighthouse evidence output is not a private regular file');
  }
  return evidence;
}

export function verifyLighthouseEvidence({
  root = repositoryRoot,
  configPath = 'performance-budgets.lighthouse.json',
  evidencePath,
  gitSha,
} = {}) {
  if (typeof evidencePath !== 'string' || evidencePath.length === 0) {
    throw new Error('Lighthouse evidence path is required');
  }
  const canonicalRoot = realpathSync(resolve(root));
  const resolvedEvidencePath = resolveContainedPath(canonicalRoot, evidencePath, 'evidence file');
  const evidence = parseJson(
    readBoundedRegularFile(resolvedEvidencePath, MAX_EVIDENCE_BYTES, 'Lighthouse evidence'),
    'Lighthouse evidence',
  );
  schemaError(evidence, 'retained evidence');
  const expected = createLighthouseEvidence({ root: canonicalRoot, configPath, gitSha });
  if (canonicalJson(evidence) !== canonicalJson(expected)) {
    throw new Error(
      'Lighthouse evidence does not match its config, reports, revision, or checksums',
    );
  }
  return evidence;
}

function parseOptions(argv) {
  const [command, ...args] = argv;
  if (command !== 'generate' && command !== 'verify') {
    throw new Error('usage: performance-lighthouse-evidence.mjs <generate|verify> [options]');
  }
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!['--root', '--config', '--output', '--evidence', '--git-sha'].includes(option)) {
      throw new Error(`unknown Lighthouse evidence option ${option ?? '<missing>'}`);
    }
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for Lighthouse evidence option ${option}`);
    }
    const key = option.slice(2);
    if (values[key] !== undefined)
      throw new Error(`duplicate Lighthouse evidence option ${option}`);
    values[key] = value;
  }
  return { command, values };
}

export function main(argv = process.argv.slice(2)) {
  const { command, values } = parseOptions(argv);
  const root = values.root ?? repositoryRoot;
  const configPath = values.config ?? 'performance-budgets.lighthouse.json';
  if (command === 'generate') {
    writeLighthouseEvidence({
      root,
      configPath,
      outputPath: values.output,
      gitSha: values['git-sha'],
    });
  } else {
    verifyLighthouseEvidence({
      root,
      configPath,
      evidencePath: values.evidence,
      gitSha: values['git-sha'],
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

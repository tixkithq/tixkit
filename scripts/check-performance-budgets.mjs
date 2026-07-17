#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import performanceBudgetSchema from './performance-budgets.schema.json' with { type: 'json' };

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultConfigPath = path.join(repoRoot, 'performance-budgets.json');
const validatePerformanceBudgetSchema = new Ajv2020({ allErrors: true, strict: true }).compile(
  performanceBudgetSchema,
);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

export function assertValidPerformanceBudgetConfig(config) {
  if (!validatePerformanceBudgetSchema(config)) {
    const details = validatePerformanceBudgetSchema.errors
      ?.map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`Invalid performance budget config: ${details ?? 'unknown schema error'}`);
  }
  for (const report of config.lighthouseReports ?? []) {
    try {
      RegExp(report.expectedUrlPattern, 'u');
    } catch (error) {
      throw new Error(
        `Invalid performance budget config: ${report.label} expectedUrlPattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return config;
}

function bytesLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function normalizeRoute(route) {
  if (route === '/') return '/';
  return `/${route.replace(/^\/+|\/+$/g, '')}`;
}

function routeCandidates(route) {
  const normalized = normalizeRoute(route);
  if (normalized === '/') {
    return new Set(['/', '/page', 'app/page', 'app/(app)/page']);
  }
  const withoutSlash = normalized.slice(1);
  return new Set([
    normalized,
    `${normalized}/page`,
    `app/${withoutSlash}/page`,
    `app/${withoutSlash}/layout`,
  ]);
}

function readNextDiagnostics(root, appDir, route) {
  const statsPath = path.join(root, appDir, '.next', 'diagnostics', 'route-bundle-stats.json');
  if (!existsSync(statsPath)) return undefined;
  const stats = readJson(statsPath);
  if (!Array.isArray(stats)) return undefined;
  const normalized = normalizeRoute(route);
  const match = stats.find((entry) => entry?.route === normalized);
  if (!match || typeof match.firstLoadUncompressedJsBytes !== 'number') return undefined;
  return {
    bytes: match.firstLoadUncompressedJsBytes,
    files: Array.isArray(match.firstLoadChunkPaths) ? match.firstLoadChunkPaths : [],
    source: 'next diagnostics',
  };
}

function manifestRouteEntries(manifest) {
  const entries = [];
  const roots = [manifest.pages, manifest.app, manifest];
  for (const root of roots) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
    for (const [key, value] of Object.entries(root)) {
      if (Array.isArray(value)) entries.push([key, value]);
      else if (value && typeof value === 'object' && Array.isArray(value.files)) {
        entries.push([key, value.files]);
      }
    }
  }
  return entries;
}

function findRouteFiles(root, appDir, route) {
  const nextDir = path.join(root, appDir, '.next');
  const manifests = [
    path.join(nextDir, 'app-build-manifest.json'),
    path.join(nextDir, 'build-manifest.json'),
  ].filter(existsSync);
  if (manifests.length === 0) {
    throw new Error(`${appDir}: missing .next build manifests. Run next build first.`);
  }

  const candidates = routeCandidates(route);
  const files = new Set();
  for (const manifestPath of manifests) {
    const manifest = readJson(manifestPath);
    for (const [key, routeFiles] of manifestRouteEntries(manifest)) {
      if (!candidates.has(key)) continue;
      for (const file of routeFiles) {
        if (typeof file === 'string' && file.endsWith('.js')) files.add(file);
      }
    }
  }

  return [...files];
}

function resolveNextAsset(root, appDir, file) {
  const nextDir = path.join(root, appDir, '.next');
  const relative = file.replace(/^\/+/, '');
  const candidates = [
    path.join(nextDir, relative),
    path.join(nextDir, 'static', relative.replace(/^static\//, '')),
    path.join(root, appDir, relative),
  ];
  return candidates.find(existsSync);
}

function sizeNextRoute(root, appDir, route) {
  const diagnostics = readNextDiagnostics(root, appDir, route);
  if (diagnostics) return diagnostics;

  const files = findRouteFiles(root, appDir, route);
  if (files.length === 0) {
    throw new Error(`${appDir}: no JavaScript files found for route ${route}`);
  }

  let total = 0;
  const missing = [];
  for (const file of files) {
    const assetPath = resolveNextAsset(root, appDir, file);
    if (!assetPath) {
      missing.push(file);
      continue;
    }
    total += statSync(assetPath).size;
  }
  if (missing.length > 0) {
    throw new Error(`${appDir}: missing route assets for ${route}: ${missing.join(', ')}`);
  }
  return { bytes: total, files, source: 'manifest assets' };
}

function checkBudget(label, bytes, maxBytes) {
  const ok = bytes <= maxBytes;
  const status = ok ? 'PASS' : 'FAIL';
  return {
    ok,
    line: `${status} ${label}: ${bytesLabel(bytes)} / ${bytesLabel(maxBytes)}`,
  };
}

function numberLabel(value, unit) {
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return unit ? `${formatted} ${unit}` : formatted;
}

function readMetricValue(source, metricPath) {
  let current = source;
  for (const part of metricPath.split('.')) {
    if (!part) continue;
    if (current === null || typeof current !== 'object' || !(part in current)) return undefined;
    current = current[part];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
}

function checkMetricBudget(label, actual, budget) {
  const unit = budget.unit ?? '';
  if (typeof budget.max === 'number' && actual > budget.max) {
    return {
      ok: false,
      line: `FAIL ${label}: ${numberLabel(actual, unit)} > ${numberLabel(budget.max, unit)}`,
    };
  }
  if (typeof budget.min === 'number' && actual < budget.min) {
    return {
      ok: false,
      line: `FAIL ${label}: ${numberLabel(actual, unit)} < ${numberLabel(budget.min, unit)}`,
    };
  }

  const target =
    typeof budget.max === 'number'
      ? `<= ${numberLabel(budget.max, unit)}`
      : `>= ${numberLabel(budget.min, unit)}`;
  return {
    ok: true,
    line: `PASS ${label}: ${numberLabel(actual, unit)} ${target}`,
  };
}

function readLighthousePerformanceScore(report) {
  const score = report?.categories?.performance?.score;
  return typeof score === 'number' && Number.isFinite(score) ? score : undefined;
}

function readLighthouseAuditNumericValue(report, auditId) {
  const value = report?.audits?.[auditId]?.numericValue;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function checkLighthouseIdentity(report, budget) {
  const results = [];
  const requestedUrl = report?.requestedUrl;
  const finalDisplayedUrl = report?.finalDisplayedUrl;
  if (typeof budget.expectedUrlPattern !== 'string' || budget.expectedUrlPattern.length === 0) {
    return [{ ok: false, line: `FAIL ${budget.label}: missing expectedUrlPattern` }];
  }
  if (
    typeof budget.lighthouseVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(budget.lighthouseVersion)
  ) {
    return [{ ok: false, line: `FAIL ${budget.label}: invalid lighthouseVersion` }];
  }
  let expectedUrl;
  try {
    expectedUrl = new RegExp(budget.expectedUrlPattern, 'u');
  } catch (error) {
    return [
      {
        ok: false,
        line: `FAIL ${budget.label}: invalid expectedUrlPattern: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  for (const [field, value] of [
    ['requestedUrl', requestedUrl],
    ['finalDisplayedUrl', finalDisplayedUrl],
  ]) {
    if (typeof value !== 'string' || !expectedUrl.test(value)) {
      results.push({
        ok: false,
        line: `FAIL ${budget.label} identity: ${field} does not match ${budget.expectedUrlPattern}`,
      });
    }
    expectedUrl.lastIndex = 0;
  }
  if (report?.lighthouseVersion !== budget.lighthouseVersion) {
    results.push({
      ok: false,
      line: `FAIL ${budget.label} identity: Lighthouse version ${String(report?.lighthouseVersion)} does not equal ${budget.lighthouseVersion}`,
    });
  }
  if (results.length === 0) {
    results.push({
      ok: true,
      line: `PASS ${budget.label} identity: ${requestedUrl} (Lighthouse ${budget.lighthouseVersion})`,
    });
  }
  return results;
}

export function evaluateBudgets(config, { root = repoRoot } = {}) {
  assertValidPerformanceBudgetConfig(config);
  const results = [];
  const nextRouteIdentities = new Set();
  for (const budget of config.files ?? []) {
    const filePath = path.join(root, budget.path);
    if (!existsSync(filePath)) {
      results.push({ ok: false, line: `FAIL ${budget.label}: missing ${budget.path}` });
      continue;
    }
    results.push(checkBudget(budget.label, statSync(filePath).size, budget.maxBytes));
  }

  for (const budget of config.nextRoutes ?? []) {
    const normalizedAppDir = path
      .normalize(budget.appDir)
      .split(path.sep)
      .join('/')
      .replace(/\/+$/u, '');
    const identity = `${normalizedAppDir}:${normalizeRoute(budget.route)}`;
    if (nextRouteIdentities.has(identity)) {
      results.push({
        ok: false,
        line: `FAIL ${budget.label}: duplicate Next.js route budget ${identity}`,
      });
      continue;
    }
    nextRouteIdentities.add(identity);
    try {
      const { bytes, files, source } = sizeNextRoute(root, budget.appDir, budget.route);
      const result = checkBudget(budget.label, bytes, budget.maxBytes);
      results.push({
        ...result,
        line: `${result.line} (${files.length} JS files, ${source})`,
      });
    } catch (error) {
      results.push({
        ok: false,
        line: `FAIL ${budget.label}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  for (const budget of config.metrics ?? []) {
    const metricsPath = path.join(root, budget.path);
    if (!existsSync(metricsPath)) {
      results.push({ ok: false, line: `FAIL ${budget.label}: missing ${budget.path}` });
      continue;
    }
    try {
      const value = readMetricValue(readJson(metricsPath), budget.metric);
      if (value === undefined) {
        results.push({
          ok: false,
          line: `FAIL ${budget.label}: missing numeric metric ${budget.metric} in ${budget.path}`,
        });
        continue;
      }
      results.push(checkMetricBudget(budget.label, value, budget));
    } catch (error) {
      results.push({
        ok: false,
        line: `FAIL ${budget.label}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  for (const budget of config.lighthouseReports ?? []) {
    const reportPath = path.join(root, budget.path);
    if (!existsSync(reportPath)) {
      results.push({ ok: false, line: `FAIL ${budget.label}: missing ${budget.path}` });
      continue;
    }

    try {
      const report = readJson(reportPath);
      results.push(...checkLighthouseIdentity(report, budget));
      if (typeof budget.minPerformanceScore === 'number') {
        const score = readLighthousePerformanceScore(report);
        if (score === undefined) {
          results.push({
            ok: false,
            line: `FAIL ${budget.label} performance score: missing Lighthouse performance score in ${budget.path}`,
          });
        } else {
          results.push(
            checkMetricBudget(`${budget.label} performance score`, score, {
              min: budget.minPerformanceScore,
              unit: 'score',
            }),
          );
        }
      }

      for (const auditBudget of budget.audits ?? []) {
        const value = readLighthouseAuditNumericValue(report, auditBudget.id);
        const auditLabel = `${budget.label} ${auditBudget.label ?? auditBudget.id}`;
        if (value === undefined) {
          results.push({
            ok: false,
            line: `FAIL ${auditLabel}: missing Lighthouse audit ${auditBudget.id}.numericValue in ${budget.path}`,
          });
          continue;
        }

        results.push(
          checkMetricBudget(auditLabel, value, {
            max: auditBudget.maxNumericValue,
            min: auditBudget.minNumericValue,
            unit: auditBudget.unit,
          }),
        );
      }
    } catch (error) {
      results.push({
        ok: false,
        line: `FAIL ${budget.label}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return results;
}

export function main(argv = process.argv.slice(2)) {
  const configArgIndex = argv.findIndex((arg) => arg === '--config');
  const configPath =
    configArgIndex >= 0 && argv[configArgIndex + 1]
      ? path.resolve(argv[configArgIndex + 1])
      : defaultConfigPath;
  const config = readJson(configPath);
  const results = evaluateBudgets(config);
  for (const result of results) {
    console.log(result.line);
  }
  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

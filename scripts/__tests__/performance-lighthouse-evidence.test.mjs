import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import schema from '../performance-lighthouse-evidence.schema.json' with { type: 'json' };
import {
  createLighthouseEvidence,
  main,
  verifyLighthouseEvidence,
  writeLighthouseEvidence,
} from '../performance-lighthouse-evidence.mjs';
import { canonicalHostedTrustJson as canonicalJson, sha256 } from '../lib/hosted-trust-receipt.mjs';

const gitSha = 'a'.repeat(40);
const reports = [
  {
    label: 'checkout Lighthouse',
    path: 'artifacts/checkout.json',
    expectedUrlPattern: '^http://localhost:3201/checkout\\?eventId=[a-z0-9_]+$',
    lighthouseVersion: '12.8.2',
    minPerformanceScore: 0.8,
    audits: [
      {
        label: 'largest contentful paint',
        id: 'largest-contentful-paint',
        maxNumericValue: 2_500,
        unit: 'ms',
      },
    ],
  },
  {
    label: 'admin Lighthouse',
    path: 'artifacts/admin.json',
    expectedUrlPattern: '^http://localhost:3202/dashboard$',
    lighthouseVersion: '12.8.2',
    minPerformanceScore: 0.75,
    audits: [
      {
        label: 'total blocking time',
        id: 'total-blocking-time',
        maxNumericValue: 500,
        unit: 'ms',
      },
    ],
  },
];

function lighthouseReport(url, auditId, numericValue) {
  return {
    requestedUrl: url,
    finalDisplayedUrl: url,
    lighthouseVersion: '12.8.2',
    fetchTime: '2026-07-17T12:00:00.000Z',
    categories: { performance: { score: 0.9 } },
    audits: { [auditId]: { numericValue } },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tixkit-lighthouse-evidence-'));
  mkdirSync(join(root, 'artifacts'));
  writeFileSync(
    join(root, 'performance-budgets.lighthouse.json'),
    `${JSON.stringify({ lighthouseReports: reports }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, 'artifacts/checkout.json'),
    `${JSON.stringify(
      lighthouseReport(
        'http://localhost:3201/checkout?eventId=evt_1',
        'largest-contentful-paint',
        2_000,
      ),
    )}\n`,
  );
  writeFileSync(
    join(root, 'artifacts/admin.json'),
    `${JSON.stringify(
      lighthouseReport('http://localhost:3202/dashboard', 'total-blocking-time', 200),
    )}\n`,
  );
  return root;
}

function rechecksum(evidence) {
  const payload = structuredClone(evidence);
  delete payload.evidenceSha256;
  return { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
}

function writeEvidence(path, evidence) {
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
}

function writeConfig(root, lighthouseReports = reports) {
  writeFileSync(
    join(root, 'performance-budgets.lighthouse.json'),
    `${JSON.stringify({ lighthouseReports }, null, 2)}\n`,
  );
}

test('creates private checksum-bound evidence and independently verifies every report', (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const output = 'artifacts/performance/lighthouse/evidence.json';
  const evidence = writeLighthouseEvidence({
    root,
    configPath: 'performance-budgets.lighthouse.json',
    outputPath: output,
    gitSha,
  });

  const validate = new Ajv2020({
    allErrors: true,
    strict: true,
    formats: { 'date-time': true },
  }).compile(schema);
  assert.equal(validate(evidence), true, JSON.stringify(validate.errors));
  assert.equal(evidence.schemaVersion, 'tixkit-performance-lighthouse-evidence-v1');
  assert.equal(evidence.claimScope, 'browser-lighthouse-budget-regression');
  assert.deepEqual(evidence.denials, [
    'representative real-user monitoring',
    'Production capacity',
    'Compact capacity',
    'Cloud capacity',
    'soak stability',
    'fault tolerance',
    'SLA or SLO attainment',
  ]);
  assert.equal(evidence.reports.length, 2);
  assert.deepEqual(
    evidence.reports.map(({ path }) => path),
    reports.map(({ path }) => path),
  );
  assert.equal(evidence.reports[0].performanceScore, 0.9);
  assert.equal(evidence.reports[0].audits[0].numericValue, 2_000);
  const { evidenceSha256, ...payload } = evidence;
  assert.equal(evidenceSha256, sha256(canonicalJson(payload)));
  assert.equal(lstatSync(join(root, output)).mode & 0o777, 0o600);
  assert.deepEqual(
    verifyLighthouseEvidence({
      root,
      configPath: 'performance-budgets.lighthouse.json',
      evidencePath: output,
      gitSha,
    }),
    evidence,
  );
});

test('verification rejects raw, config, ordering, summary, revision, and checksum forgery', (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const outputPath = join(root, 'artifacts/evidence.json');
  const evidence = writeLighthouseEvidence({
    root,
    configPath: 'performance-budgets.lighthouse.json',
    outputPath: 'artifacts/evidence.json',
    gitSha,
  });
  const checkoutPath = join(root, 'artifacts/checkout.json');
  const checkoutBytes = readFileSync(checkoutPath);
  const configPath = join(root, 'performance-budgets.lighthouse.json');
  const configBytes = readFileSync(configPath);

  const verify = () =>
    verifyLighthouseEvidence({
      root,
      configPath: 'performance-budgets.lighthouse.json',
      evidencePath: 'artifacts/evidence.json',
      gitSha,
    });

  const changedRaw = JSON.parse(checkoutBytes);
  changedRaw.categories.performance.score = 0.85;
  writeFileSync(checkoutPath, JSON.stringify(changedRaw));
  assert.throws(verify, /does not match/u);
  writeFileSync(checkoutPath, checkoutBytes);

  const changedConfig = JSON.parse(configBytes);
  changedConfig.lighthouseReports[0].minPerformanceScore = 0.81;
  writeFileSync(configPath, JSON.stringify(changedConfig));
  assert.throws(verify, /does not match/u);
  writeFileSync(configPath, configBytes);

  for (const forged of [
    rechecksum({ ...evidence, reports: evidence.reports.toReversed() }),
    rechecksum({
      ...evidence,
      reports: evidence.reports.map((report, index) =>
        index === 0 ? { ...report, performanceScore: 1 } : report,
      ),
    }),
    rechecksum({ ...evidence, reports: evidence.reports.slice(0, 1) }),
    rechecksum({ ...evidence, reports: [...evidence.reports, evidence.reports[0]] }),
  ]) {
    writeEvidence(outputPath, forged);
    assert.throws(verify, /does not match/u);
  }
  writeEvidence(outputPath, evidence);
  assert.throws(
    () =>
      verifyLighthouseEvidence({
        root,
        configPath: 'performance-budgets.lighthouse.json',
        evidencePath: 'artifacts/evidence.json',
        gitSha: 'b'.repeat(40),
      }),
    /does not match/u,
  );
  const badChecksum = { ...evidence, evidenceSha256: '0'.repeat(64) };
  writeEvidence(outputPath, badChecksum);
  assert.throws(verify, /does not match/u);
});

test('generation fails closed on wrong identity, missing metrics, malformed time, and non-finite values', (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const checkoutPath = join(root, 'artifacts/checkout.json');
  const original = JSON.parse(readFileSync(checkoutPath));
  const create = () =>
    createLighthouseEvidence({
      root,
      configPath: 'performance-budgets.lighthouse.json',
      gitSha,
    });
  const mutations = [
    (report) => delete report.requestedUrl,
    (report) => (report.finalDisplayedUrl = 'http://localhost:3202/dashboard'),
    (report) => (report.lighthouseVersion = '13.0.0'),
    (report) => (report.fetchTime = 'not-a-time'),
    (report) => delete report.audits['largest-contentful-paint'],
  ];
  for (const mutate of mutations) {
    const report = structuredClone(original);
    mutate(report);
    writeFileSync(checkoutPath, JSON.stringify(report));
    assert.throws(create);
  }
  writeFileSync(checkoutPath, JSON.stringify(original).replace('2000', '1e999'));
  assert.throws(create, /budgets failed|finite|valid JSON/u);
});

test('rejects canonical report aliases and report mutation during budget evaluation', (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const create = (input = {}) =>
    createLighthouseEvidence({
      root,
      configPath: 'performance-budgets.lighthouse.json',
      gitSha,
      ...input,
    });

  writeConfig(root, [
    reports[0],
    { ...reports[0], label: 'lexical alias', path: 'artifacts/./checkout.json' },
  ]);
  assert.throws(create, /duplicate canonical report identities/u);

  symlinkSync(join(root, 'artifacts'), join(root, 'report-alias'));
  writeConfig(root, [
    reports[0],
    { ...reports[0], label: 'parent symlink alias', path: 'report-alias/checkout.json' },
  ]);
  assert.throws(create, /duplicate canonical report identities/u);

  writeConfig(root);
  const checkoutPath = join(root, 'artifacts/checkout.json');
  const changedReport = JSON.parse(readFileSync(checkoutPath));
  changedReport.categories.performance.score = 0.95;
  assert.throws(
    () =>
      create({
        onReportsLoaded: () => writeFileSync(checkoutPath, JSON.stringify(changedReport)),
      }),
    /changed during budget evaluation/u,
  );
});

test('rejects unsafe config and report paths and bounded inputs', (context) => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'tixkit-lighthouse-outside-'));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const configPath = join(root, 'performance-budgets.lighthouse.json');
  const configBytes = readFileSync(configPath);
  const configTarget = join(root, 'config-target.json');
  writeFileSync(configTarget, configBytes);
  rmSync(configPath);
  symlinkSync(configTarget, configPath);
  assert.throws(
    () => createLighthouseEvidence({ root, configPath, gitSha }),
    /direct regular file/u,
  );

  rmSync(configPath);
  writeFileSync(configPath, 'x');
  truncateSync(configPath, 1024 * 1024 + 1);
  assert.throws(() => createLighthouseEvidence({ root, configPath, gitSha }), /bounded size/u);

  const outsideConfig = join(outside, 'config.json');
  writeFileSync(outsideConfig, configBytes);
  assert.throws(
    () => createLighthouseEvidence({ root, configPath: outsideConfig, gitSha }),
    /escapes/u,
  );

  writeFileSync(configPath, configBytes);
  const outsideReport = join(outside, 'outside-report.json');
  writeFileSync(outsideReport, readFileSync(join(root, 'artifacts/checkout.json')));
  const lexicalEscape = relative(root, outsideReport);
  assert.equal(lexicalEscape.startsWith('..'), true);
  writeConfig(root, [{ ...reports[0], path: lexicalEscape }]);
  assert.throws(() => createLighthouseEvidence({ root, configPath, gitSha }), /escapes/u);

  writeConfig(root, [{ ...reports[0], path: outsideReport }]);
  assert.throws(() => createLighthouseEvidence({ root, configPath, gitSha }), /escapes/u);

  symlinkSync(outside, join(root, 'outside-parent'));
  writeConfig(root, [{ ...reports[0], path: `outside-parent/${basename(outsideReport)}` }]);
  assert.throws(() => createLighthouseEvidence({ root, configPath, gitSha }), /escapes/u);
});

test('rejects unsafe retained evidence and output paths', (context) => {
  const root = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'tixkit-lighthouse-output-outside-'));
  context.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const evidencePath = join(root, 'artifacts/evidence.json');
  writeLighthouseEvidence({
    root,
    configPath: 'performance-budgets.lighthouse.json',
    outputPath: 'artifacts/evidence.json',
    gitSha,
  });
  symlinkSync(evidencePath, join(root, 'artifacts/evidence-link.json'));
  assert.throws(
    () =>
      verifyLighthouseEvidence({
        root,
        configPath: 'performance-budgets.lighthouse.json',
        evidencePath: 'artifacts/evidence-link.json',
        gitSha,
      }),
    /direct regular file/u,
  );

  const oversizedEvidence = join(root, 'artifacts/oversized-evidence.json');
  writeFileSync(oversizedEvidence, 'x');
  truncateSync(oversizedEvidence, 1024 * 1024 + 1);
  assert.throws(
    () =>
      verifyLighthouseEvidence({
        root,
        configPath: 'performance-budgets.lighthouse.json',
        evidencePath: oversizedEvidence,
        gitSha,
      }),
    /bounded size/u,
  );

  const outsideEvidence = join(outside, 'evidence.json');
  writeFileSync(outsideEvidence, readFileSync(evidencePath));
  assert.throws(
    () =>
      verifyLighthouseEvidence({
        root,
        configPath: 'performance-budgets.lighthouse.json',
        evidencePath: outsideEvidence,
        gitSha,
      }),
    /escapes/u,
  );

  symlinkSync(outside, join(root, 'output-parent'));
  assert.throws(
    () =>
      writeLighthouseEvidence({
        root,
        configPath: 'performance-budgets.lighthouse.json',
        outputPath: 'output-parent/evidence.json',
        gitSha,
      }),
    /direct directories/u,
  );

  const outsideLeaf = join(outside, 'outside-leaf.json');
  writeFileSync(outsideLeaf, 'do not replace');
  symlinkSync(outsideLeaf, join(root, 'artifacts/output-leaf.json'));
  assert.throws(
    () =>
      writeLighthouseEvidence({
        root,
        configPath: 'performance-budgets.lighthouse.json',
        outputPath: 'artifacts/output-leaf.json',
        gitSha,
      }),
    /EEXIST/u,
  );
  assert.equal(readFileSync(outsideLeaf, 'utf8'), 'do not replace');
});

test('refuses duplicate paths, unsafe files, path escape, overwrite, and malformed CLI options', (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'performance-budgets.lighthouse.json');
  const duplicate = { lighthouseReports: [reports[0], { ...reports[0] }] };
  writeFileSync(configPath, JSON.stringify(duplicate));
  assert.throws(
    () => createLighthouseEvidence({ root, configPath, gitSha }),
    /duplicate report paths/u,
  );

  writeFileSync(configPath, JSON.stringify({ lighthouseReports: reports }));
  writeLighthouseEvidence({
    root,
    configPath,
    outputPath: 'artifacts/evidence.json',
    gitSha,
  });
  assert.throws(
    () =>
      writeLighthouseEvidence({
        root,
        configPath,
        outputPath: 'artifacts/evidence.json',
        gitSha,
      }),
    /EEXIST/u,
  );
  assert.throws(
    () =>
      writeLighthouseEvidence({
        root,
        configPath,
        outputPath: '../escaped.json',
        gitSha,
      }),
    /escapes/u,
  );

  const checkoutPath = join(root, 'artifacts/checkout.json');
  rmSync(checkoutPath);
  symlinkSync(join(root, 'artifacts/admin.json'), checkoutPath);
  assert.throws(
    () => createLighthouseEvidence({ root, configPath, gitSha }),
    /direct regular file/u,
  );
  rmSync(checkoutPath);
  writeFileSync(checkoutPath, 'x');
  truncateSync(checkoutPath, 20 * 1024 * 1024 + 1);
  assert.throws(() => createLighthouseEvidence({ root, configPath, gitSha }), /bounded size/u);

  assert.throws(() => main(['generate', '--root', root, '--unknown', 'x']), /unknown/u);
  assert.throws(() => main(['verify', '--root']), /missing value/u);
  assert.throws(() => main(['generate', '--root', root, '--root', root]), /duplicate/u);
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { parseAllDocuments } from 'yaml';

const root = resolve(import.meta.dirname, '../..');
const chart = resolve(root, 'infra/helm/tixkit');
const evaluation = resolve(chart, 'values-evaluation.yaml');
const production = resolve(chart, 'values-production.yaml');
const productionImages = [
  'api.imageDigest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'worker.imageDigest=sha256:123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0',
  'checkout.imageDigest=sha256:23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01',
  'admin.imageDigest=sha256:3456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef012',
  'migrations.imageDigest=sha256:456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123',
];
const productionNetwork = [
  'networkPolicy.externalEgressCidrs[0]=192.0.2.0/24',
  'networkPolicy.externalEgressCidrs[1]=2001:db8::/32',
];
const productionRuntime = [...productionImages, ...productionNetwork];

function render(values, set = []) {
  const effectiveSet = values === production ? [...productionRuntime, ...set] : set;
  return execFileSync(
    'helm',
    [
      'template',
      'tixkit',
      chart,
      '--values',
      values,
      ...effectiveSet.flatMap((value) => ['--set', value]),
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

function resources(output) {
  return parseAllDocuments(output)
    .map((document) => document.toJSON())
    .filter(Boolean);
}

test('Production Helm render excludes evaluation services and plaintext secrets', () => {
  const output = render(production, [
    'global.imageRegistry=ghcr.io/tixkit/tixkit',
    'secrets.name=tixkit-production-secrets',
  ]);
  const rendered = resources(output);
  assert.equal(
    rendered.some((resource) => resource.kind === 'Secret'),
    false,
  );
  for (const component of ['postgres', 'redis', 'temporal', 'minio'])
    assert.equal(
      rendered.some(
        (resource) => resource.metadata?.labels?.['app.kubernetes.io/component'] === component,
      ),
      false,
    );
  assert.equal(rendered.filter((resource) => resource.kind === 'PodDisruptionBudget').length, 4);
  assert.equal(
    rendered.filter((resource) => resource.kind === 'HorizontalPodAutoscaler').length,
    4,
  );
  assert.equal(rendered.filter((resource) => resource.kind === 'NetworkPolicy').length, 4);
  const worker = rendered.find(
    (resource) =>
      resource.kind === 'Deployment' &&
      resource.metadata?.labels?.['app.kubernetes.io/component'] === 'worker',
  );
  assert.equal(worker.spec.template.spec.containers[0].volumeMounts[0].mountPath, '/tmp');
  const ingress = rendered.find(
    (resource) =>
      resource.kind === 'NetworkPolicy' && resource.metadata.name.endsWith('public-ingress'),
  );
  assert.deepEqual(
    ingress.spec.ingress[0].ports.map((port) => port.port),
    [4000, 3000, 3001],
  );
  assert.equal(
    ingress.spec.ingress[0].from[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name'],
    'ingress-nginx',
  );
  assert.equal(ingress.spec.podSelector.matchLabels['app.kubernetes.io/instance'], 'tixkit');
  const serviceEgress = rendered.find(
    (resource) =>
      resource.kind === 'NetworkPolicy' && resource.metadata.name.endsWith('service-egress'),
  );
  assert.deepEqual(
    serviceEgress.spec.egress.slice(-2).map((rule) => rule.to[0].ipBlock.cidr),
    ['192.0.2.0/24', '2001:db8::/32'],
  );
});

test('Production Helm render rejects bundled services and chart-created secrets', () => {
  for (const override of ['postgres.enabled=true', 'secrets.mode=create']) {
    const result = spawnSync(
      'helm',
      [
        'template',
        'tixkit',
        chart,
        '--values',
        production,
        '--set',
        'global.imageRegistry=ghcr.io/tixkit/tixkit',
        '--set',
        'secrets.name=tixkit-production-secrets',
        ...productionRuntime.flatMap((value) => ['--set', value]),
        '--set',
        override,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
  }
});

test('Production Helm render requires release-provided image digests', () => {
  const result = spawnSync(
    'helm',
    [
      'template',
      'tixkit',
      chart,
      '--values',
      production,
      '--set',
      'global.imageRegistry=ghcr.io/tixkit/tixkit',
      '--set',
      'secrets.name=tixkit-production-secrets',
      ...productionNetwork.flatMap((value) => ['--set', value]),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must set imageDigest/);
});

test('Production Helm render requires bounded operator-selected egress CIDRs', () => {
  for (const cidr of [undefined, '0.0.0.0/0', '::/0']) {
    const result = spawnSync(
      'helm',
      [
        'template',
        'tixkit',
        chart,
        '--values',
        production,
        '--set',
        'global.imageRegistry=ghcr.io/tixkit/tixkit',
        '--set',
        'secrets.name=tixkit-production-secrets',
        ...productionImages.flatMap((value) => ['--set', value]),
        ...(cidr ? ['--set', `networkPolicy.externalEgressCidrs[0]=${cidr}`] : []),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /external egress CIDRs|externalEgressCidrs/);
  }
});

test('External Secrets mode renders a provider-neutral SecretStore reference', () => {
  const rendered = resources(
    render(production, [
      'global.imageRegistry=ghcr.io/tixkit/tixkit',
      'secrets.mode=external',
      'migrations.enabled=false',
      'secrets.name=tixkit-production-secrets',
      'secrets.externalSecret.secretStoreName=production-store',
      'secrets.externalSecret.data[0].secretKey=DATABASE_URL',
      'secrets.externalSecret.data[0].remoteRef.key=tixkit/database-url',
    ]),
  );
  const externalSecret = rendered.find((resource) => resource.kind === 'ExternalSecret');
  assert.equal(externalSecret.spec.secretStoreRef.name, 'production-store');
  assert.equal(externalSecret.spec.target.name, 'tixkit-production-secrets');
});

test('External Secrets mode rejects an unsafe pre-install migration race', () => {
  const result = spawnSync(
    'helm',
    [
      'template',
      'tixkit',
      chart,
      '--values',
      production,
      '--set',
      'global.imageRegistry=ghcr.io/tixkit/tixkit',
      '--set',
      'secrets.mode=external',
      '--set',
      'secrets.name=tixkit-production-secrets',
      '--set',
      'secrets.externalSecret.secretStoreName=production-store',
      ...productionRuntime.flatMap((value) => ['--set', value]),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot satisfy a pre-install migration hook/);
});

test('Evaluation Helm render remains explicitly bundled and separate', () => {
  const rendered = resources(render(evaluation));
  assert.ok(rendered.some((resource) => resource.kind === 'Secret'));
  assert.ok(
    rendered.some(
      (resource) => resource.metadata?.labels?.['app.kubernetes.io/component'] === 'postgres',
    ),
  );
});

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
  'networkPolicy.databaseEgressCidrs[0]=198.51.100.0/24',
];
const productionRuntime = [...productionImages, ...productionNetwork];
const externalSecretKeys = [
  'DATABASE_URL',
  'REDIS_URL',
  'TEMPORAL_ADDRESS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'METRICS_BEARER_TOKEN',
  'DASHBOARD_CURSOR_SIGNING_KEY',
  'CLERK_SECRET_KEY',
  'CLERK_PUBLISHABLE_KEY',
  'CLERK_WEBHOOK_SECRET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'PROMETHEUS_PUSHGATEWAY_URL',
];

function externalSecretDataOverrides(keys = externalSecretKeys) {
  return keys.flatMap((key, index) => [
    `secrets.externalSecret.data[${index}].secretKey=${key}`,
    `secrets.externalSecret.data[${index}].remoteRef.key=tixkit/${key.toLowerCase()}`,
  ]);
}

function render(values, set = [], release = 'tixkit') {
  const effectiveSet = values === production ? [...productionRuntime, ...set] : set;
  return execFileSync(
    'helm',
    [
      'template',
      release,
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
  assert.equal(rendered.filter((resource) => resource.kind === 'NetworkPolicy').length, 6);
  const deployments = rendered.filter((resource) => resource.kind === 'Deployment');
  assert.equal(deployments.length, 4);
  for (const deployment of deployments) {
    assert.equal(deployment.metadata.labels['helm.sh/chart'], 'tixkit-0.2.0');
    assert.equal(deployment.metadata.labels['app.kubernetes.io/version'], '0.1.0');
    assert.equal(deployment.spec.minReadySeconds, 10);
    assert.equal(deployment.spec.progressDeadlineSeconds, 600);
    assert.deepEqual(deployment.spec.strategy, {
      type: 'RollingUpdate',
      rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
    });
    assert.deepEqual(deployment.spec.template.spec.topologySpreadConstraints, [
      {
        maxSkew: 1,
        minDomains: 2,
        topologyKey: 'topology.kubernetes.io/zone',
        whenUnsatisfiable: 'DoNotSchedule',
        labelSelector: {
          matchLabels: {
            'app.kubernetes.io/name': 'tixkit',
            'app.kubernetes.io/instance': 'tixkit',
            'app.kubernetes.io/component':
              deployment.metadata.labels['app.kubernetes.io/component'],
          },
        },
      },
    ]);
    assert.match(
      deployment.spec.template.metadata.annotations['checksum/config'],
      /^[a-f0-9]{64}$/u,
    );
  }
  const serviceMonitor = rendered.find((resource) => resource.kind === 'ServiceMonitor');
  assert.equal(serviceMonitor.spec.endpoints[0].path, '/metrics');
  assert.deepEqual(serviceMonitor.spec.endpoints[0].bearerTokenSecret, {
    name: 'tixkit-production-secrets',
    key: 'METRICS_BEARER_TOKEN',
  });
  const alerts = rendered.find((resource) => resource.kind === 'PrometheusRule');
  assert.deepEqual(
    alerts.spec.groups[0].rules.map((rule) => rule.alert),
    ['TixkitApiHighErrorRate', 'TixkitApiHighP95Latency', 'TixkitMigrationProgressStalled'],
  );
  const errorRateExpression = alerts.spec.groups[0].rules[0].expr;
  assert.doesNotMatch(errorRateExpression, /clamp_min/);
  assert.match(errorRateExpression, /and \(sum\(rate\(.+\)\) > 0\)/);
  const migrationStallExpression = alerts.spec.groups[0].rules[2].expr;
  assert.match(migrationStallExpression, /push_time_seconds\{job="tixkit-worker"\}/);
  assert.match(migrationStallExpression, /< 120/);
  const metricsIngress = rendered.find(
    (resource) =>
      resource.kind === 'NetworkPolicy' && resource.metadata.name.endsWith('metrics-ingress'),
  );
  assert.equal(
    metricsIngress.spec.ingress[0].from[0].namespaceSelector.matchLabels[
      'kubernetes.io/metadata.name'
    ],
    'monitoring',
  );
  assert.deepEqual(metricsIngress.spec.ingress[0].ports, [{ protocol: 'TCP', port: 4000 }]);
  const worker = rendered.find(
    (resource) =>
      resource.kind === 'Deployment' &&
      resource.metadata?.labels?.['app.kubernetes.io/component'] === 'worker',
  );
  assert.equal(worker.spec.template.spec.containers[0].volumeMounts[0].mountPath, '/tmp');
  assert.deepEqual(worker.spec.template.spec.containers[0].env[0], {
    name: 'POD_NAME',
    valueFrom: { fieldRef: { fieldPath: 'metadata.name' } },
  });
  const ingress = rendered.find(
    (resource) =>
      resource.kind === 'NetworkPolicy' && resource.metadata.name.endsWith('public-ingress'),
  );
  assert.deepEqual(
    ingress.spec.ingress[0].ports.map((port) => port.port),
    [4000, 3000, 3001],
  );
  const migrationEgress = rendered.find(
    (resource) =>
      resource.kind === 'NetworkPolicy' && resource.metadata.name.endsWith('migration-egress'),
  );
  assert.equal(
    migrationEgress.spec.podSelector.matchLabels['app.kubernetes.io/component'],
    'migrate',
  );
  assert.deepEqual(migrationEgress.spec.egress[1], {
    to: [{ ipBlock: { cidr: '198.51.100.0/24' } }],
    ports: [{ protocol: 'TCP', port: 5432 }],
  });
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

test('Chart refuses Kubernetes versions without stable minDomains scheduling', () => {
  const unsupported = spawnSync('helm', ['template', 'tixkit', chart, '--kube-version', '1.29.9'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /requires kubeVersion: >=1\.30\.0-0/u);

  const supported = spawnSync(
    'helm',
    ['template', 'tixkit', chart, '--kube-version', '1.30.0', '--values', evaluation],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(supported.status, 0, supported.stderr);
});

test('Production config changes deterministically roll every workload', () => {
  const base = resources(
    render(production, [
      'global.imageRegistry=ghcr.io/tixkit/tixkit',
      'secrets.name=tixkit-production-secrets',
    ]),
  );
  const changed = resources(
    render(production, [
      'global.imageRegistry=ghcr.io/tixkit/tixkit',
      'secrets.name=tixkit-production-secrets',
      'global.apiBaseUrl=https://api.changed.example',
    ]),
  );
  const checksums = (rendered) =>
    Object.fromEntries(
      rendered
        .filter((resource) => resource.kind === 'Deployment')
        .map((deployment) => [
          deployment.metadata.labels['app.kubernetes.io/component'],
          deployment.spec.template.metadata.annotations['checksum/config'],
        ]),
    );
  const baseChecksums = checksums(base);
  const changedChecksums = checksums(changed);
  assert.deepEqual(Object.keys(baseChecksums).sort(), ['admin', 'api', 'checkout', 'worker']);
  for (const component of Object.keys(baseChecksums))
    assert.notEqual(baseChecksums[component], changedChecksums[component]);
});

test('Production rejects availability settings that permit a single-instance outage', () => {
  for (const [overrides, message] of [
    [['api.autoscaling.enabled=false', 'api.replicas=1'], 'requires at least two api replicas'],
    [['api.autoscaling.minReplicas=1'], 'requires at least two api replicas'],
    [['worker.autoscaling.maxReplicas=1'], 'worker autoscaling.maxReplicas >= minReplicas'],
    [
      ['availability.podDisruptionBudget.minAvailable=2'],
      'pod disruption minAvailable below the api minimum replicas',
    ],
    [
      ['availability.rollingUpdate.maxUnavailable=1'],
      'availability.rollingUpdate.maxUnavailable=0',
    ],
    [
      ['availability.rollingUpdate.maxSurge=0'],
      'availability.rollingUpdate.maxSurge of at least 1',
    ],
    [
      ['availability.rollingUpdate.minReadySeconds=0'],
      'availability.rollingUpdate.minReadySeconds of at least 1',
    ],
    [
      ['availability.rollingUpdate.progressDeadlineSeconds=59'],
      'availability.rollingUpdate.progressDeadlineSeconds of at least 60',
    ],
    [
      ['availability.topologySpread.minDomains=1'],
      'availability.topologySpread.minDomains of at least 2',
    ],
  ]) {
    assert.throws(
      () =>
        render(production, [
          'global.imageRegistry=ghcr.io/tixkit/tixkit',
          'secrets.name=tixkit-production-secrets',
          ...overrides,
        ]),
      new RegExp(message),
    );
  }
});

test('Evaluation render declares its runtime profile and MinIO-compatible encryption policy', () => {
  const config = resources(render(evaluation)).find((resource) => resource.kind === 'ConfigMap');
  assert.equal(config.data.NODE_ENV, 'production');
  assert.equal(config.data.TIXKIT_DEPLOYMENT_PROFILE, 'evaluation');
  assert.equal(config.data.S3_SERVER_SIDE_ENCRYPTION, 'none');
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

test('Production Helm render requires AES256 object encryption', () => {
  for (const encryption of ['none', 'kms']) {
    const result = spawnSync(
      'helm',
      [
        'template',
        'tixkit',
        chart,
        '--values',
        production,
        ...productionRuntime.flatMap((value) => ['--set', value]),
        '--set',
        `secrets.s3ServerSideEncryption=${encryption}`,
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
        '--set',
        'networkPolicy.databaseEgressCidrs[0]=198.51.100.0/24',
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
      'migrations.strategy=manual',
      'secrets.name=tixkit-production-secrets',
      'secrets.externalSecret.secretStoreName=production-store',
      ...externalSecretDataOverrides(),
    ]),
  );
  const externalSecret = rendered.find((resource) => resource.kind === 'ExternalSecret');
  assert.equal(externalSecret.spec.secretStoreRef.name, 'production-store');
  assert.equal(externalSecret.spec.target.name, 'tixkit-production-secrets');
  assert.equal(
    rendered.some((resource) => resource.kind === 'Job'),
    false,
  );
});

test('External Secrets mode rejects an incomplete required-key inventory', () => {
  assert.throws(
    () =>
      render(production, [
        'global.imageRegistry=ghcr.io/tixkit/tixkit',
        'secrets.mode=external',
        'migrations.strategy=manual',
        'secrets.name=tixkit-production-secrets',
        'secrets.externalSecret.secretStoreName=production-store',
        ...externalSecretDataOverrides(externalSecretKeys.slice(0, -1)),
      ]),
    /ExternalSecret data must map required key PROMETHEUS_PUSHGATEWAY_URL/,
  );
});

test('External Secret inventory follows MySQL, OIDC, workload identity, and Temporal Cloud modes', () => {
  const keys = [
    'DATABASE_URL_MYSQL',
    'REDIS_URL',
    'TEMPORAL_ADDRESS',
    'TEMPORAL_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'METRICS_BEARER_TOKEN',
    'DASHBOARD_CURSOR_SIGNING_KEY',
    'OIDC_ISSUER_URL',
    'OIDC_AUDIENCE',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'PROMETHEUS_PUSHGATEWAY_URL',
  ];
  const rendered = resources(
    render(production, [
      'global.imageRegistry=ghcr.io/tixkit/tixkit',
      'database.driver=mysql',
      'auth.provider=oidc',
      'temporalConnection.mode=cloud',
      'secrets.temporalTlsEnabled=true',
      'secrets.s3AuthMode=workload-identity',
      'secrets.mode=external',
      'migrations.strategy=manual',
      'secrets.name=tixkit-production-secrets',
      'secrets.externalSecret.secretStoreName=production-store',
      ...externalSecretDataOverrides(keys),
    ]),
  );
  const mappedKeys = rendered
    .find((resource) => resource.kind === 'ExternalSecret')
    .spec.data.map((entry) => entry.secretKey);
  assert.deepEqual(mappedKeys, keys);
});

test('Temporal Cloud mode fails closed without TLS', () => {
  assert.throws(
    () =>
      render(production, [
        'global.imageRegistry=ghcr.io/tixkit/tixkit',
        'secrets.name=tixkit-production-secrets',
        'temporalConnection.mode=cloud',
      ]),
    /Temporal Cloud requires secrets.temporalTlsEnabled=true/,
  );
});

test('manual migration execution renders one non-hook Job after secret reconciliation', () => {
  const rendered = resources(
    render(production, [
      'global.imageRegistry=ghcr.io/tixkit/tixkit',
      'secrets.name=tixkit-production-secrets',
      'migrations.strategy=manual',
      'migrations.execution=manual-run',
      'migrations.invocation=test-run',
    ]),
  );
  const jobs = rendered.filter((resource) => resource.kind === 'Job');
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].metadata.name, /^tixkit-tixkit-migrate-[0-9a-f]{8}-test-run$/);
  assert.equal(jobs[0].metadata.annotations?.['helm.sh/hook'], undefined);
  assert.equal(jobs[0].spec.activeDeadlineSeconds, 900);
});

test('manual migration names remain unique and Kubernetes-safe at boundaries', () => {
  const longRelease = 'r'.repeat(53);
  const rendered = resources(
    render(
      production,
      [
        'global.imageRegistry=ghcr.io/tixkit/tixkit',
        'secrets.name=tixkit-production-secrets',
        'migrations.execution=manual-run',
        'migrations.invocation=abcdefghijklmnop',
      ],
      longRelease,
    ),
  );
  const name = rendered.find((resource) => resource.kind === 'Job').metadata.name;
  assert.ok(name.length <= 63);
  assert.match(name, /-migrate-[0-9a-f]{8}-abcdefghijklmnop$/);
  assert.throws(
    () =>
      render(production, [
        'global.imageRegistry=ghcr.io/tixkit/tixkit',
        'secrets.name=tixkit-production-secrets',
        'migrations.execution=manual-run',
        'migrations.invocation=abcdefghijklmnopq',
      ]),
    /at most 16 characters/,
  );
});

test('Production rejects unrestricted database egress CIDRs', () => {
  for (const cidr of ['0.0.0.0/0', '::/0']) {
    assert.throws(
      () =>
        render(production, [
          'global.imageRegistry=ghcr.io/tixkit/tixkit',
          'secrets.name=tixkit-production-secrets',
          `networkPolicy.databaseEgressCidrs[0]=${cidr}`,
        ]),
      /forbids unrestricted networkPolicy database egress CIDRs/,
    );
  }
});

test('Production rejects observability thresholds that disable meaningful alerts', () => {
  for (const [override, message] of [
    ['observability.alerts.apiErrorRateThreshold=0', 'apiErrorRateThreshold'],
    ['observability.alerts.apiErrorRateThreshold=1', 'apiErrorRateThreshold'],
    ['observability.alerts.apiP95LatencySeconds=0', 'apiP95LatencySeconds'],
    ['observability.alerts.migrationProgressAgeSeconds=0', 'migrationProgressAgeSeconds'],
    ['observability.alerts.workerPushFreshnessSeconds=60', 'workerPushFreshnessSeconds'],
  ]) {
    assert.throws(
      () =>
        render(production, [
          'global.imageRegistry=ghcr.io/tixkit/tixkit',
          'secrets.name=tixkit-production-secrets',
          override,
        ]),
      new RegExp(message),
    );
  }
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
      'migrations.strategy=hook',
      '--set',
      'secrets.name=tixkit-production-secrets',
      '--set',
      'secrets.externalSecret.secretStoreName=production-store',
      ...productionRuntime.flatMap((value) => ['--set', value]),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires migrations.strategy=manual/);
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

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
const productionBuildRevision = 'global.buildRevision=release-2026.08.10';
const productionScanner = 'uploads.malwareScanner.host=clamav.internal.example';
const productionRuntime = [
  ...productionImages,
  ...productionNetwork,
  productionBuildRevision,
  productionScanner,
];
const externalSecretKeys = [
  'DATABASE_URL',
  'REDIS_URL',
  'TEMPORAL_ADDRESS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PUBLISHABLE_KEY',
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
  assert.equal(rendered.filter((resource) => resource.kind === 'NetworkPolicy').length, 7);
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
  const config = rendered.find((resource) => resource.kind === 'ConfigMap');
  assert.equal(config.data.TIXKIT_DEPLOYMENT_PROFILE, 'production');
  assert.equal(config.data.API_BASE_URL, 'https://api.tixkit.com');
  assert.equal(config.data.INTERNAL_API_BASE_URL, 'http://tixkit-tixkit-api:4000');
  assert.equal(config.data.TIXKIT_CHECKOUT_URL, 'https://checkout.tixkit.com');
  assert.equal(config.data.TIXKIT_DOCS_URL, 'https://docs.tixkit.com');
  assert.equal(config.data.S3_PUBLIC_ENDPOINT, 'https://uploads.tixkit.com');
  assert.equal(config.data.AUTH_PROVIDER, 'clerk');
  assert.equal(config.data.ALLOW_INSECURE_LOCAL_ORIGINS, '0');
  assert.equal(config.data.TIXKIT_BUILD_REVISION, 'release-2026.08.10');
  for (const scannerSetting of ['UPLOAD_MALWARE_SCANNER', 'CLAMAV_HOST', 'CLAMAV_PORT'])
    assert.equal(config.data[scannerSetting], undefined);
  const checkout = deployments.find(
    (deployment) => deployment.metadata.labels['app.kubernetes.io/component'] === 'checkout',
  );
  const api = deployments.find(
    (deployment) => deployment.metadata.labels['app.kubernetes.io/component'] === 'api',
  );
  assert.deepEqual(api.spec.template.spec.containers[0].env, [
    { name: 'PORT', value: '4000' },
    { name: 'UPLOAD_MALWARE_SCANNER', value: 'clamav' },
    { name: 'CLAMAV_HOST', value: 'clamav.internal.example' },
    { name: 'CLAMAV_PORT', value: '3310' },
  ]);
  assert.equal(checkout.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/ready');
  assert.equal(checkout.spec.template.spec.containers[0].livenessProbe.httpGet.path, '/health');
  const checkoutContainer = checkout.spec.template.spec.containers[0];
  assert.equal(checkoutContainer.envFrom, undefined);
  assert.deepEqual(
    checkoutContainer.env.map((entry) => entry.name),
    [
      'NODE_ENV',
      'TIXKIT_DEPLOYMENT_PROFILE',
      'API_BASE_URL',
      'INTERNAL_API_BASE_URL',
      'TIXKIT_CHECKOUT_URL',
      'S3_PUBLIC_ENDPOINT',
      'ALLOW_INSECURE_LOCAL_ORIGINS',
      'TIXKIT_BUILD_REVISION',
      'STRIPE_PUBLISHABLE_KEY',
    ],
  );
  for (const privateKey of [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'DATABASE_URL',
    'QR_SIGNING_SECRET',
    'OFFLINE_MANIFEST_SIGNING_KEY',
  ]) {
    assert.equal(
      checkoutContainer.env.some((entry) => entry.name === privateKey),
      false,
    );
  }
  const admin = deployments.find(
    (deployment) => deployment.metadata.labels['app.kubernetes.io/component'] === 'admin',
  );
  assert.equal(admin.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/ready');
  assert.equal(admin.spec.template.spec.containers[0].livenessProbe.httpGet.path, '/health');
  const adminEnvironment = admin.spec.template.spec.containers[0].env;
  assert.deepEqual(
    adminEnvironment.slice(0, -2).map((entry) => entry.name),
    [
      'NODE_ENV',
      'TIXKIT_DEPLOYMENT_PROFILE',
      'API_BASE_URL',
      'INTERNAL_API_BASE_URL',
      'TIXKIT_CHECKOUT_URL',
      'S3_PUBLIC_ENDPOINT',
      'AUTH_PROVIDER',
      'ALLOW_INSECURE_LOCAL_ORIGINS',
      'TIXKIT_DOCS_URL',
      'TIXKIT_BUILD_REVISION',
    ],
  );
  assert.deepEqual(adminEnvironment.slice(-2), [
    {
      name: 'CLERK_PUBLISHABLE_KEY',
      valueFrom: {
        secretKeyRef: {
          name: 'tixkit-production-secrets',
          key: 'CLERK_PUBLISHABLE_KEY',
        },
      },
    },
    {
      name: 'CLERK_SECRET_KEY',
      valueFrom: {
        secretKeyRef: {
          name: 'tixkit-production-secrets',
          key: 'CLERK_SECRET_KEY',
        },
      },
    },
  ]);
  assert.equal(admin.spec.template.spec.containers[0].envFrom, undefined);
  assert.equal(
    adminEnvironment.some((entry) => entry.name.startsWith('NEXT_PUBLIC_')),
    false,
  );
  const serviceMonitor = rendered.find((resource) => resource.kind === 'ServiceMonitor');
  assert.equal(serviceMonitor.spec.endpoints[0].path, '/metrics');
  assert.deepEqual(serviceMonitor.spec.endpoints[0].bearerTokenSecret, {
    name: 'tixkit-production-secrets',
    key: 'METRICS_BEARER_TOKEN',
  });
  const alerts = rendered.find((resource) => resource.kind === 'PrometheusRule');
  assert.deepEqual(
    alerts.spec.groups[0].rules.map((rule) => rule.alert),
    [
      'TixkitApiHighErrorRate',
      'TixkitApiHighP95Latency',
      'TixkitRumLcpP75BudgetExceeded',
      'TixkitRumInpP75BudgetExceeded',
      'TixkitRumClsP75BudgetExceeded',
      'TixkitPaymentProviderPlatformFailureRateHigh',
      'TixkitPaymentProviderDeclineRateHigh',
      'TixkitMigrationProgressStalled',
    ],
  );
  const errorRateExpression = alerts.spec.groups[0].rules[0].expr;
  assert.doesNotMatch(errorRateExpression, /clamp_min/);
  assert.match(errorRateExpression, /and \(sum\(rate\(.+\)\) > 0\)/);
  const rumRules = alerts.spec.groups[0].rules.slice(2, 5);
  for (const [rule, metric, threshold] of [
    [rumRules[0], 'tixkit_rum_lcp_seconds', 2.5],
    [rumRules[1], 'tixkit_rum_inp_seconds', 0.2],
    [rumRules[2], 'tixkit_rum_cls_score', 0.1],
  ]) {
    assert.match(rule.expr, /histogram_quantile\(0\.75,/u);
    assert.match(rule.expr, new RegExp(`${metric}_bucket\\{service="tixkit-api"\\}\\[15m\\]`, 'u'));
    assert.match(rule.expr, new RegExp(`> ${threshold}\\)`, 'u'));
    assert.match(rule.expr, /and on\(surface\)/u);
    assert.match(rule.expr, new RegExp(`${metric}_count\\{service="tixkit-api"\\}\\[15m\\]`, 'u'));
    assert.match(rule.expr, />= 100\)/u);
    assert.doesNotMatch(rule.expr, /tenant|event_id|session|user|route|url/iu);
  }
  const providerFailureExpression = alerts.spec.groups[0].rules[5].expr;
  assert.match(providerFailureExpression, /outcome="platform_failure"/u);
  assert.match(providerFailureExpression, /outcome=~"success\|platform_failure"/u);
  assert.match(providerFailureExpression, /> 0\.02\)/u);
  assert.match(providerFailureExpression, />= 100\)/u);
  assert.doesNotMatch(providerFailureExpression, /decline|caller_cancelled/u);
  const providerDeclineExpression = alerts.spec.groups[0].rules[6].expr;
  assert.match(providerDeclineExpression, /outcome="decline"/u);
  assert.match(providerDeclineExpression, /outcome=~"success\|decline"/u);
  assert.match(providerDeclineExpression, /> 0\.15\)/u);
  assert.match(providerDeclineExpression, />= 100\)/u);
  assert.doesNotMatch(providerDeclineExpression, /platform_failure|caller_cancelled/u);
  const migrationStallExpression = alerts.spec.groups[0].rules[7].expr;
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
  assert.equal(
    worker.spec.template.spec.containers[0].env.some((entry) =>
      ['UPLOAD_MALWARE_SCANNER', 'CLAMAV_HOST', 'CLAMAV_PORT'].includes(entry.name),
    ),
    false,
  );
  for (const frontend of [checkout, admin]) {
    assert.equal(
      frontend.spec.template.spec.containers[0].env.some((entry) =>
        ['UPLOAD_MALWARE_SCANNER', 'CLAMAV_HOST', 'CLAMAV_PORT'].includes(entry.name),
      ),
      false,
    );
  }
  assert.equal(
    rendered.some(
      (resource) =>
        resource.kind === 'Secret' &&
        JSON.stringify(resource).match(/UPLOAD_MALWARE_SCANNER|CLAMAV_HOST|CLAMAV_PORT/u),
    ),
    false,
  );
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
  assert.equal(
    serviceEgress.spec.egress.some((rule) => rule.ports?.some((port) => port.port === 3310)),
    false,
  );
  const scannerEgress = rendered.find(
    (resource) =>
      resource.kind === 'NetworkPolicy' &&
      resource.metadata.name.endsWith('malware-scanner-egress'),
  );
  assert.deepEqual(scannerEgress.spec.podSelector.matchLabels, {
    'app.kubernetes.io/name': 'tixkit',
    'app.kubernetes.io/instance': 'tixkit',
    'app.kubernetes.io/component': 'api',
  });
  assert.deepEqual(
    scannerEgress.spec.egress.map((rule) => rule.to[0].ipBlock.cidr),
    ['192.0.2.0/24', '2001:db8::/32'],
  );
  assert.deepEqual(
    scannerEgress.spec.egress.map((rule) => rule.ports),
    [[{ protocol: 'TCP', port: 3310 }], [{ protocol: 'TCP', port: 3310 }]],
  );
});

test('Production requires a bounded external ClamAV scanner contract', () => {
  for (const [override, message] of [
    ['uploads.malwareScanner.host=', /requires uploads\.malwareScanner\.host/u],
    [
      'uploads.malwareScanner.host=https://clamav.example.test',
      /must be a bounded hostname or IP address/u,
    ],
    ['uploads.malwareScanner.host=user@clamav.example.test', /must be a bounded hostname/u],
    ['uploads.malwareScanner.host=clamav internal.example', /must be a bounded hostname/u],
    ['uploads.malwareScanner.host=localhost', /must not be localhost/u],
    ['uploads.malwareScanner.host=foo.localhost', /must not be localhost/u],
    ['uploads.malwareScanner.host=127.0.0.1', /must not be localhost/u],
    ['uploads.malwareScanner.host=::1', /must not be localhost/u],
    ['uploads.malwareScanner.host=::0001', /must not be localhost/u],
    ['uploads.malwareScanner.host=0:0:0:0:0:0:0:1', /must not be localhost/u],
    ['uploads.malwareScanner.host=0:0:0:0:0::0:1', /must not be localhost/u],
    ['uploads.malwareScanner.host=0:0:0::0:0:0:1', /must not be localhost/u],
    ['uploads.malwareScanner.host=::0:0:0:0:0:1', /must not be localhost/u],
    ['uploads.malwareScanner.host=::0:1', /must not be localhost/u],
    ['uploads.malwareScanner.host=0:0:0:0:0:0:0:0', /must not be localhost/u],
    ['uploads.malwareScanner.host=2130706433', /must be a bounded hostname/u],
    ['uploads.malwareScanner.host=0x7f000001', /must not be localhost/u],
    ['uploads.malwareScanner.host=0X7F000001', /must not be localhost/u],
    ['uploads.malwareScanner.host=0x7f.0.0.1', /must not be localhost/u],
    ['uploads.malwareScanner.host=0X7F.1', /must not be localhost/u],
    ['uploads.malwareScanner.host=999.999.999.999', /must be a bounded hostname/u],
    ['uploads.malwareScanner.host=1:::2', /must be a bounded hostname/u],
  ]) {
    assert.throws(() => render(production, [override]), message);
  }

  for (const host of ['192.0.2.10', '2001:db8::10'])
    assert.doesNotThrow(() =>
      render(production, [
        'global.imageRegistry=ghcr.io/tixkit/tixkit',
        'secrets.name=tixkit-production-secrets',
        `uploads.malwareScanner.host=${host}`,
      ]),
    );

  for (const mode of ['', 'eicar', 'unknown']) {
    assert.throws(
      () => render(production, [`uploads.malwareScanner.mode=${mode}`]),
      /requires uploads\.malwareScanner\.mode=clamav/u,
    );
  }

  for (const port of ['0', '65536', '3310.5', 'not-a-number']) {
    assert.throws(
      () => render(production, [`uploads.malwareScanner.port=${port}`]),
      /uploads\.malwareScanner\.port must be an integer from 1 through 65535/u,
    );
  }
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
  const adminDeployment = (rendered) =>
    rendered.find(
      (resource) =>
        resource.kind === 'Deployment' &&
        resource.metadata.labels['app.kubernetes.io/component'] === 'admin',
    );
  assert.equal(
    adminDeployment(base).spec.template.spec.containers[0].image,
    adminDeployment(changed).spec.template.spec.containers[0].image,
  );
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
  const rendered = resources(render(evaluation));
  const config = rendered.find((resource) => resource.kind === 'ConfigMap');
  assert.equal(config.data.NODE_ENV, 'production');
  assert.equal(config.data.TIXKIT_DEPLOYMENT_PROFILE, 'evaluation');
  assert.equal(config.data.S3_SERVER_SIDE_ENCRYPTION, 'none');
  assert.equal(config.data.TIXKIT_BUILD_REVISION, '0.1.0');
  const api = rendered.find(
    (resource) =>
      resource.kind === 'Deployment' &&
      resource.metadata.labels['app.kubernetes.io/component'] === 'api',
  );
  assert.deepEqual(api.spec.template.spec.containers[0].env, [
    { name: 'PORT', value: '4000' },
    { name: 'UPLOAD_MALWARE_SCANNER', value: '' },
    { name: 'CLAMAV_HOST', value: '' },
    { name: 'CLAMAV_PORT', value: '3310' },
  ]);
  assert.equal(
    rendered.some(
      (resource) =>
        resource.kind === 'NetworkPolicy' &&
        resource.metadata.name.endsWith('malware-scanner-egress'),
    ),
    false,
  );
});

test('Evaluation networking keeps core policies while its scanner remains disabled', () => {
  const rendered = resources(
    render(evaluation, [
      'networkPolicy.enabled=true',
      'networkPolicy.externalEgressCidrs[0]=192.0.2.0/24',
    ]),
  );
  const policyNames = rendered
    .filter((resource) => resource.kind === 'NetworkPolicy')
    .map((resource) => resource.metadata.name);
  assert.ok(policyNames.some((name) => name.endsWith('public-ingress')));
  assert.ok(policyNames.some((name) => name.endsWith('service-egress')));
  assert.equal(
    policyNames.some((name) => name.endsWith('malware-scanner-egress')),
    false,
  );
});

test('Production-like Helm profiles reject missing or placeholder build revisions', () => {
  for (const revision of ['', 'local', 'development', 'latest', 'unknown', 'placeholder']) {
    assert.throws(
      () => render(production, [`global.buildRevision=${revision}`]),
      /global\.buildRevision to be an immutable source commit or release tag/u,
    );
  }
  assert.throws(
    () => render(evaluation, ['global.buildRevision=']),
    /global\.buildRevision to be an immutable source commit or release tag/u,
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
      '--set',
      productionBuildRevision,
      '--set',
      productionScanner,
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
        productionBuildRevision,
        '--set',
        'networkPolicy.databaseEgressCidrs[0]=198.51.100.0/24',
        '--set',
        productionScanner,
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

test('Provider incident evidence stays disabled by default and validates secret-only key material', () => {
  const disabled = resources(render(evaluation));
  const disabledConfig = disabled.find((resource) => resource.kind === 'ConfigMap');
  assert.equal(disabledConfig.data.PROVIDER_INCIDENT_SINK_ENABLED, 'false');

  assert.throws(
    () =>
      render(evaluation, [
        'providerIncidentEvidence.enabled=true',
        'providerIncidentEvidence.captureUntil=2026-07-17T00:00:00.000Z',
        'providerIncidentEvidence.activeKeyId=incident-v1',
      ]),
    /provider incident evidence requires secrets\.providerIncidentKeyringJson/,
  );
  const enabled = resources(
    render(evaluation, [
      'providerIncidentEvidence.enabled=true',
      'providerIncidentEvidence.captureUntil=2026-07-17T00:00:00.000Z',
      'providerIncidentEvidence.activeKeyId=incident-v1',
      'secrets.providerIncidentKeyringJson=encrypted-keyring-reference',
    ]),
  );
  const config = enabled.find((resource) => resource.kind === 'ConfigMap');
  const secret = enabled.find((resource) => resource.kind === 'Secret');
  assert.equal(config.data.PROVIDER_INCIDENT_SINK_ENABLED, 'true');
  assert.equal(config.data.PROVIDER_INCIDENT_ACTIVE_KEY_ID, 'incident-v1');
  assert.equal(secret.stringData.PROVIDER_INCIDENT_KEYRING_JSON, 'encrypted-keyring-reference');
  assert.equal(config.data.PROVIDER_INCIDENT_KEYRING_JSON, undefined);
});

test('External Secrets requires the provider incident keyring only when capture is enabled', () => {
  assert.throws(
    () =>
      render(production, [
        'global.imageRegistry=ghcr.io/tixkit/tixkit',
        'secrets.mode=external',
        'migrations.strategy=manual',
        'secrets.name=tixkit-production-secrets',
        'secrets.externalSecret.secretStoreName=production-store',
        'providerIncidentEvidence.enabled=true',
        'providerIncidentEvidence.captureUntil=2026-07-17T00:00:00.000Z',
        'providerIncidentEvidence.activeKeyId=incident-v1',
        ...externalSecretDataOverrides(),
      ]),
    /ExternalSecret data must map required key PROVIDER_INCIDENT_KEYRING_JSON/,
  );
});

test('External Secret inventory follows MySQL, workload identity, and Temporal Cloud modes', () => {
  const keys = [
    'DATABASE_URL_MYSQL',
    'REDIS_URL',
    'TEMPORAL_ADDRESS',
    'TEMPORAL_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PUBLISHABLE_KEY',
    'METRICS_BEARER_TOKEN',
    'DASHBOARD_CURSOR_SIGNING_KEY',
    'CLERK_SECRET_KEY',
    'CLERK_PUBLISHABLE_KEY',
    'CLERK_WEBHOOK_SECRET',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'PROMETHEUS_PUSHGATEWAY_URL',
  ];
  const rendered = resources(
    render(production, [
      'global.imageRegistry=ghcr.io/tixkit/tixkit',
      'database.driver=mysql',
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

test('Helm rejects OIDC until the admin dashboard has an OIDC browser client', () => {
  assert.throws(
    () => render(evaluation, ['auth.provider=oidc']),
    /auth\.provider=oidc is not supported by the admin dashboard until an OIDC browser client is implemented/u,
  );
});

test('Helm rejects insecure, missing, or inexact public admin runtime origins', () => {
  for (const [setting, value] of [
    ['global.apiBaseUrl', 'http://api.example.test'],
    ['global.checkoutUrl', ''],
    ['global.apiBaseUrl', 'https://api.example.test/v1'],
    ['global.s3PublicEndpoint', 'http://uploads.example.test'],
    ['global.s3PublicEndpoint', 'https://uploads.example.test/bucket'],
  ]) {
    assert.throws(
      () => render(evaluation, [`${setting}=${value}`]),
      new RegExp(`${setting} must be an exact HTTPS origin`, 'u'),
    );
  }
  assert.throws(
    () => render(evaluation, ['global.docsUrl=docs.example.test']),
    /global\.docsUrl must be empty or an exact HTTPS origin/u,
  );
  const withoutDocs = resources(render(evaluation, ['global.docsUrl=']));
  const config = withoutDocs.find((resource) => resource.kind === 'ConfigMap');
  const admin = withoutDocs.find(
    (resource) =>
      resource.kind === 'Deployment' &&
      resource.metadata.labels['app.kubernetes.io/component'] === 'admin',
  );
  assert.equal(config.data.TIXKIT_DOCS_URL, undefined);
  assert.equal(
    admin.spec.template.spec.containers[0].env.some((entry) => entry.name === 'TIXKIT_DOCS_URL'),
    false,
  );
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
    ['observability.alerts.rumWindow=0m', 'rumWindow'],
    ['observability.alerts.rumWindow=15m]', 'rumWindow'],
    ['observability.alerts.rumMinimumSamples=0', 'rumMinimumSamples'],
    ['observability.alerts.rumMinimumSamples=100001', 'rumMinimumSamples'],
    ['observability.alerts.rumLcpP75Seconds=0', 'rumLcpP75Seconds'],
    ['observability.alerts.rumLcpP75Seconds=60.1', 'rumLcpP75Seconds'],
    ['observability.alerts.rumInpP75Seconds=0', 'rumInpP75Seconds'],
    ['observability.alerts.rumInpP75Seconds=10.1', 'rumInpP75Seconds'],
    ['observability.alerts.rumClsP75Score=0', 'rumClsP75Score'],
    ['observability.alerts.rumClsP75Score=1.1', 'rumClsP75Score'],
    ['observability.alerts.paymentProviderWindow=0m', 'paymentProviderWindow'],
    ['observability.alerts.paymentProviderWindow=15m]', 'paymentProviderWindow'],
    ['observability.alerts.paymentProviderMinimumSamples=0', 'paymentProviderMinimumSamples'],
    ['observability.alerts.paymentProviderMinimumSamples=100001', 'paymentProviderMinimumSamples'],
    [
      'observability.alerts.paymentProviderPlatformFailureRateThreshold=0',
      'paymentProviderPlatformFailureRateThreshold',
    ],
    [
      'observability.alerts.paymentProviderPlatformFailureRateThreshold=1',
      'paymentProviderPlatformFailureRateThreshold',
    ],
    [
      'observability.alerts.paymentProviderDeclineRateThreshold=0',
      'paymentProviderDeclineRateThreshold',
    ],
    [
      'observability.alerts.paymentProviderDeclineRateThreshold=1',
      'paymentProviderDeclineRateThreshold',
    ],
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

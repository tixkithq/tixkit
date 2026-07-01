type WorkflowConfig = {
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  databaseUrl: string;
  redisUrl: string;
};

function envValue(name: string): string | undefined {
  return process.env[name]?.trim();
}

function requireEnvValues(names: readonly string[]): string[] {
  return names.filter((name) => !envValue(name));
}

function hostnameFromUrlLike(value: string): string {
  const candidate = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  const endpoint = candidate.toLowerCase().split('/')[0];
  return endpoint.startsWith('[') && endpoint.includes(']')
    ? endpoint.slice(1, endpoint.indexOf(']'))
    : (endpoint.split(':')[0] ?? '');
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('127.')
  );
}

function isLocalEndpoint(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  return isLocalHostname(hostnameFromUrlLike(value));
}

function isLocalTemporalAddress(value: string): boolean {
  return isLocalEndpoint(value);
}

function requireProductionTemporalConfig(): void {
  const missing = requireEnvValues([
    'TEMPORAL_ADDRESS',
    'TEMPORAL_NAMESPACE',
    'TEMPORAL_TASK_QUEUE',
  ]);

  if (missing.length > 0) {
    throw new Error(`Production Temporal config requires ${missing.join(', ')}`);
  }

  if (isLocalTemporalAddress(process.env.TEMPORAL_ADDRESS ?? '')) {
    throw new Error(
      'TEMPORAL_ADDRESS must not point to localhost in production. Set it to the managed Temporal endpoint.',
    );
  }
}

function requireProductionConfig(): void {
  requireProductionTemporalConfig();

  const missing = requireEnvValues(['DATABASE_URL', 'REDIS_URL']);
  if (missing.length > 0) {
    throw new Error(`Production worker config requires ${missing.join(', ')}`);
  }

  const localEndpoints = [
    ['DATABASE_URL', process.env.DATABASE_URL],
    ['REDIS_URL', process.env.REDIS_URL],
  ]
    .filter(([, value]) => isLocalEndpoint(value))
    .map(([name]) => name);
  if (localEndpoints.length > 0) {
    throw new Error(
      `Production worker config must not point to localhost for ${localEndpoints.join(', ')}`,
    );
  }
}

export function loadConfig(): WorkflowConfig {
  if (process.env.NODE_ENV === 'production') {
    requireProductionConfig();
  }

  return {
    temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    temporalTaskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'tixkit',
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? '',
  };
}

export const config = loadConfig();

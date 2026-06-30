type WorkflowConfig = {
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  databaseUrl: string;
  redisUrl: string;
};

function isLocalTemporalAddress(value: string): boolean {
  const endpoint = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split('/')[0];
  const host =
    endpoint?.startsWith('[') && endpoint.includes(']')
      ? endpoint.slice(1, endpoint.indexOf(']'))
      : endpoint?.split(':')[0];

  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host?.startsWith('127.');
}

function requireProductionTemporalConfig(): void {
  const missing = [
    ['TEMPORAL_ADDRESS', process.env.TEMPORAL_ADDRESS],
    ['TEMPORAL_NAMESPACE', process.env.TEMPORAL_NAMESPACE],
    ['TEMPORAL_TASK_QUEUE', process.env.TEMPORAL_TASK_QUEUE],
  ]
    .filter(([, value]) => value === undefined || value.trim().length === 0)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Production Temporal config requires ${missing.join(', ')}`);
  }

  if (isLocalTemporalAddress(process.env.TEMPORAL_ADDRESS ?? '')) {
    throw new Error(
      'TEMPORAL_ADDRESS must not point to localhost in production. Set it to the managed Temporal endpoint.',
    );
  }
}

export function loadConfig(): WorkflowConfig {
  if (process.env.NODE_ENV === 'production') {
    requireProductionTemporalConfig();
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

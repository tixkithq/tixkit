export const config = {
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? '',
};

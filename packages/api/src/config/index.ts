export type AppConfig = {
  port: number;
  nodeEnv: string;
  logLevel: string;
  databaseUrl: string;
  databaseUrlMysql?: string;
  redisUrl: string;
  temporalAddress: string;
  temporalNamespace: string;
  clerkSecretKey: string;
  clerkPublishableKey: string;
  clerkWebhookSecret: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
  s3Endpoint: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3Region: string;
  apiBaseUrl: string;
};

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT ?? '4000', 10),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://gatekit:gatekit@localhost:5432/gatekit',
    databaseUrlMysql: process.env.DATABASE_URL_MYSQL,
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    temporalAddress: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    clerkSecretKey: process.env.CLERK_SECRET_KEY ?? '',
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY ?? '',
    clerkWebhookSecret: process.env.CLERK_WEBHOOK_SECRET ?? '',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    s3Endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    s3Bucket: process.env.S3_BUCKET ?? 'gatekit',
    s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'minioadmin',
    s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin',
    s3Region: process.env.S3_REGION ?? 'us-east-1',
    apiBaseUrl: process.env.API_BASE_URL ?? 'http://localhost:4000',
  };
}

export const config = loadConfig();

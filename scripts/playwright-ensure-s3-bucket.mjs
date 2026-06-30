import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} = require('../packages/api/node_modules/@aws-sdk/client-s3');

const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
const bucket = process.env.S3_BUCKET ?? 'tixkit';
const exportBucket = process.env.S3_EXPORT_BUCKET ?? 'tixkit-exports';
const region = process.env.S3_REGION ?? 'us-east-1';
const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? 'minioadmin';
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? 'minioadmin';

const client = new S3Client({
  endpoint,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  region,
  credentials: { accessKeyId, secretAccessKey },
});

async function ensureBucket() {
  const buckets = [...new Set([bucket, exportBucket].filter(Boolean))];
  await Promise.all(buckets.map((name) => ensureOneBucket(name)));
}

async function ensureOneBucket(name) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: name }));
    return;
  } catch {
    // Create below. If object storage is not reachable, keep non-storage E2E suites runnable.
  }

  try {
    await client.send(new CreateBucketCommand({ Bucket: name }));
  } catch (error) {
    console.warn(
      `Playwright S3 bucket setup skipped for ${name} at ${endpoint}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

await ensureBucket();

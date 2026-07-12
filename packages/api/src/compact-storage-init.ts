import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { pathToFileURL } from 'node:url';

export async function ensureCompactStorageBucket(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const endpoint = env.S3_ENDPOINT?.trim();
  const bucket = env.S3_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey)
    throw new Error('Compact storage initialization requires S3 endpoint, bucket and credentials.');
  const client = new S3Client({
    endpoint,
    region: env.S3_REGION?.trim() || 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status !== 404 && status !== 400) throw error;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  } finally {
    client.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureCompactStorageBucket()
    .then(() => console.log(`Compact object-storage bucket ${process.env.S3_BUCKET} is ready.`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}

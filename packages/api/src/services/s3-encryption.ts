import type { PutObjectCommandInput } from '@aws-sdk/client-s3';

export function s3PutEncryption(
  environment: NodeJS.ProcessEnv = process.env,
): Pick<PutObjectCommandInput, 'ServerSideEncryption'> {
  const configured = environment.S3_SERVER_SIDE_ENCRYPTION?.trim().toLowerCase();
  if (configured === 'none') {
    if (
      environment.NODE_ENV === 'production' &&
      environment.TIXKIT_DEPLOYMENT_PROFILE !== 'evaluation'
    ) {
      throw new Error('S3_SERVER_SIDE_ENCRYPTION must be AES256 in production');
    }
    return {};
  }
  if (configured === 'aes256') return { ServerSideEncryption: 'AES256' };
  if (configured) {
    throw new Error('S3_SERVER_SIDE_ENCRYPTION must be AES256 or none');
  }
  return environment.NODE_ENV === 'production' ? { ServerSideEncryption: 'AES256' } : {};
}

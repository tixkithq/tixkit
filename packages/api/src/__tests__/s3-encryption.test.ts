import { describe, expect, it } from 'vitest';
import { s3PutEncryption } from '../services/s3-encryption.js';
import { parseUploadArtifactMetadata } from '../services/uploads.js';

describe('s3PutEncryption', () => {
  it('uses provider-side AES256 encryption by default in production', () => {
    expect(s3PutEncryption({ NODE_ENV: 'production' })).toEqual({
      ServerSideEncryption: 'AES256',
    });
  });

  it('allows local S3-compatible stores to rely on deployment-level encryption', () => {
    expect(s3PutEncryption({ NODE_ENV: 'development' })).toEqual({});
    expect(s3PutEncryption({ NODE_ENV: 'development', S3_SERVER_SIDE_ENCRYPTION: 'none' })).toEqual(
      {},
    );
  });

  it('rejects unknown encryption modes', () => {
    expect(() =>
      s3PutEncryption({ NODE_ENV: 'production', S3_SERVER_SIDE_ENCRYPTION: 'kms' }),
    ).toThrow('S3_SERVER_SIDE_ENCRYPTION must be AES256 or none');
  });

  it('rejects disabled provider-side encryption in production', () => {
    expect(() =>
      s3PutEncryption({ NODE_ENV: 'production', S3_SERVER_SIDE_ENCRYPTION: 'none' }),
    ).toThrow('S3_SERVER_SIDE_ENCRYPTION must be AES256 in production');
  });

  it('supports the explicit evaluation profile with bundled MinIO', () => {
    expect(
      s3PutEncryption({
        NODE_ENV: 'production',
        TIXKIT_DEPLOYMENT_PROFILE: 'evaluation',
        S3_SERVER_SIDE_ENCRYPTION: 'none',
      }),
    ).toEqual({});
  });
});

describe('parseUploadArtifactMetadata', () => {
  it('normalizes JSON text and native PostgreSQL/MySQL JSON objects', () => {
    expect(parseUploadArtifactMetadata('{"image":{"width":1200}}')).toEqual({
      image: { width: 1200 },
    });
    expect(parseUploadArtifactMetadata({ image: { width: 1200 } })).toEqual({
      image: { width: 1200 },
    });
  });

  it('fails closed for malformed metadata', () => {
    expect(() => parseUploadArtifactMetadata('[1]')).toThrow('Upload artifact metadata is invalid');
    expect(() => parseUploadArtifactMetadata('not-json')).toThrow(
      'Upload artifact metadata is invalid',
    );
  });
});

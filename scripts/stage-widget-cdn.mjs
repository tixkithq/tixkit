import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'artifacts/widget');
const verifyOnly = process.argv.includes('--verify-only');
const bucket = process.env.WIDGET_CDN_STAGING_BUCKET;
const baseUrl = process.env.WIDGET_CDN_STAGING_BASE_URL?.replace(/\/$/, '');
const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
const prefix =
  process.env.WIDGET_CDN_STAGING_PREFIX?.replace(/^\/+|\/+$/g, '') ??
  `widget/v${manifest.widgetVersion}`;
if ((!verifyOnly && !bucket) || !baseUrl)
  throw new Error('Staging bucket and HTTPS base URL are required.');
const parsedBaseUrl = new URL(baseUrl);
if (
  parsedBaseUrl.protocol !== 'https:' &&
  !['127.0.0.1', 'localhost'].includes(parsedBaseUrl.hostname)
)
  throw new Error('Staging CDN base URL must use HTTPS.');
if (prefix !== `widget/v${manifest.widgetVersion}`)
  throw new Error('Staging prefix must exactly match the manifest widget version.');
const files = [manifest.files.widget, manifest.files.sourceMap];

function aws(args) {
  return execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function existingObject(key) {
  const result = spawnSync('aws', ['s3api', 'head-object', '--bucket', bucket, '--key', key], {
    encoding: 'utf8',
  });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/not found|404|nosuchkey/i.test(result.stderr)) return null;
  throw new Error(`Unable to inspect s3://${bucket}/${key}: ${result.stderr.trim()}`);
}

function verifyExistingObject(existing, file) {
  if (
    existing.ContentLength !== file.bytes ||
    existing.CacheControl !== file.cacheControl ||
    existing.ContentType !== file.contentType ||
    existing.Metadata?.sha256 !== file.sha256
  )
    throw new Error(`${file.path} already exists with different immutable content.`);
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return response;
      lastError = new Error(`${url} returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250 * 2 ** attempt));
  }
  throw lastError ?? new Error(`${url} was not readable.`);
}

if (!verifyOnly) {
  const cors = JSON.parse(aws(['s3api', 'get-bucket-cors', '--bucket', bucket]));
  const permitsPublicGet = cors.CORSRules?.some(
    (rule) => rule.AllowedOrigins?.includes('*') && rule.AllowedMethods?.includes('GET'),
  );
  if (!permitsPublicGet)
    throw new Error('Staging bucket CORS must allow public cross-origin GET before upload.');
}

if (!verifyOnly)
  for (const file of files) {
    const localPath = join(directory, file.path);
    if (statSync(localPath).size !== file.bytes)
      throw new Error(`${file.path} size changed after build.`);
    const key = `${prefix}/${file.path}`;
    const existing = existingObject(key);
    if (existing) {
      verifyExistingObject(existing, file);
      continue;
    }
    aws([
      's3api',
      'put-object',
      '--bucket',
      bucket,
      '--key',
      key,
      '--body',
      localPath,
      '--if-none-match',
      '*',
      '--content-type',
      file.contentType,
      '--cache-control',
      file.cacheControl,
      '--metadata',
      `sha256=${file.sha256}`,
    ]);
  }

if (!verifyOnly)
  for (const name of ['manifest.json', 'checksums.txt']) {
    const localPath = join(directory, name);
    const bytes = readFileSync(localPath);
    const file = {
      path: name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('base64'),
      contentType: name.endsWith('.json')
        ? 'application/json; charset=utf-8'
        : 'text/plain; charset=utf-8',
      cacheControl: 'public, max-age=31536000, immutable',
    };
    const key = `${prefix}/${name}`;
    const existing = existingObject(key);
    if (existing) {
      verifyExistingObject(existing, file);
      continue;
    }
    aws([
      's3api',
      'put-object',
      '--bucket',
      bucket,
      '--key',
      key,
      '--body',
      localPath,
      '--if-none-match',
      '*',
      '--content-type',
      file.contentType,
      '--cache-control',
      file.cacheControl,
      '--metadata',
      `sha256=${file.sha256}`,
    ]);
  }

for (const name of ['manifest.json', 'checksums.txt']) {
  const response = await fetchWithRetry(`${baseUrl}/${prefix}/${name}`);
  if (response.headers.get('access-control-allow-origin') !== '*')
    throw new Error(`${name} is missing wildcard CORS.`);
  if (response.headers.get('cache-control') !== 'public, max-age=31536000, immutable')
    throw new Error(`${name} has incorrect cache metadata.`);
  const remote = Buffer.from(await response.arrayBuffer());
  const local = readFileSync(join(directory, name));
  if (!remote.equals(local)) throw new Error(`${name} failed CDN content verification.`);
}

for (const file of files) {
  const response = await fetchWithRetry(`${baseUrl}/${prefix}/${file.path}`);
  if (response.headers.get('access-control-allow-origin') !== '*')
    throw new Error(`${file.path} is missing wildcard CORS.`);
  if (response.headers.get('cache-control') !== file.cacheControl)
    throw new Error(`${file.path} has incorrect cache metadata.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sha256 = createHash('sha256').update(bytes).digest('base64');
  if (bytes.length !== file.bytes || sha256 !== file.sha256)
    throw new Error(`${file.path} failed CDN content verification.`);
}

if (!verifyOnly)
  for (const file of files) {
    const head = JSON.parse(
      aws(['s3api', 'head-object', '--bucket', bucket, '--key', `${prefix}/${file.path}`]),
    );
    if (head.ContentLength !== file.bytes || head.CacheControl !== file.cacheControl)
      throw new Error(`${file.path} failed post-upload verification.`);
  }

process.stdout.write(
  `${verifyOnly ? 'Verified' : 'Staged and verified'} ${files.length + 2} immutable objects at ${baseUrl}/${prefix}/\n`,
);

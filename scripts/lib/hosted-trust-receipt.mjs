import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export const HOSTED_TRUST_RECEIPT_MAX_BYTES = 64 * 1024;
export const HOSTED_TRUST_KEYRING_MAX_BYTES = 256 * 1024;
export const HOSTED_TRUST_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const HOSTED_TRUST_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
export const HOSTED_TRUST_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function canonicalValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError('Canonical JSON accepts only plain JSON values');
    }
    return `[${value.map((item) => canonicalValue(item)).join(',')}]`;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('Canonical JSON accepts only plain JSON values');
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new TypeError('Canonical JSON accepts only enumerable own data properties');
      }
      return `${JSON.stringify(key)}:${canonicalValue(descriptor.value)}`;
    })
    .join(',')}}`;
}

export function canonicalHostedTrustJson(value) {
  return canonicalValue(value);
}

export function hostedTrustReceiptSigningBytes(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new TypeError('Hosted trust receipt must be an object');
  }
  const signatureDescriptor = Object.getOwnPropertyDescriptor(receipt, 'signature');
  const signature =
    signatureDescriptor && 'value' in signatureDescriptor ? signatureDescriptor.value : undefined;
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) {
    throw new TypeError('Hosted trust receipt signature metadata is required');
  }
  const valueDescriptor = Object.getOwnPropertyDescriptor(signature, 'value');
  if (!valueDescriptor || !('value' in valueDescriptor) || !valueDescriptor.enumerable) {
    throw new TypeError('Hosted trust receipt signature value must be an enumerable own property');
  }
  const { value: _value, ...unsignedSignature } = signature;
  return Buffer.from(
    canonicalHostedTrustJson({ ...receipt, signature: unsignedSignature }),
    'utf8',
  );
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

export function readBoundedRegularFile(path, label, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError('Hosted trust input byte limit must be a positive safe integer');
  }
  const absolute = resolve(path);
  const before = lstatSync(absolute, { throwIfNoEntry: false });
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink regular file`);
  }
  if (before.size < 1 || before.size > maxBytes) {
    throw new Error(`${label} must contain 1-${maxBytes} bytes`);
  }
  const canonicalPath = realpathSync(absolute);
  if (canonicalPath !== absolute) {
    throw new Error(`${label} path must be canonical and contain no symbolic-link indirection`);
  }
  const bytes = readFileSync(absolute);
  const after = lstatSync(absolute);
  if (
    bytes.byteLength !== before.size ||
    !sameFile(before, after) ||
    realpathSync(absolute) !== canonicalPath
  ) {
    throw new Error(`${label} changed while it was being read`);
  }
  return bytes;
}

export function parseCanonicalHostedTrustJson(bytes, label) {
  const text = bytes.toString('utf8');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  let canonical;
  try {
    canonical = canonicalHostedTrustJson(value);
  } catch {
    throw new Error(`${label} must contain only plain JSON values`);
  }
  if (text !== canonical && text !== `${canonical}\n`) {
    throw new Error(`${label} must use canonical JSON with unique fields`);
  }
  return value;
}

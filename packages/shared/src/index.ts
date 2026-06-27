import { createHash, createHmac, randomBytes } from 'node:crypto';

export function generateId(prefix: string): string {
  const ts = BigInt(Date.now()).toString(36).toUpperCase().padStart(10, '0');
  const rand = randomBytes(8).toString('hex').toUpperCase();
  return `${prefix}_${ts}${rand}`;
}

export function hashString(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = signPayload(payload, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return a.equals(b);
}

export function generateApiKey(): { key: string; hashedKey: string; keyPrefix: string } {
  const rawKey = `tk_${randomBytes(32).toString('hex')}`;
  return {
    key: rawKey,
    hashedKey: hashString(rawKey),
    keyPrefix: rawKey.substring(0, 12),
  };
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

export function signWebhookPayload(
  payload: Record<string, unknown>,
  secret: string,
): { signature: string; timestamp: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify(payload);
  const signedContent = `${timestamp}.${body}`;
  const signature = createHmac('sha256', secret).update(signedContent).digest('hex');
  return { signature, timestamp };
}

export function verifyWebhookSignature(
  body: string,
  signature: string,
  timestamp: string,
  secret: string,
  maxAgeSeconds = 300,
): boolean {
  // Check timestamp freshness
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > maxAgeSeconds) return false;

  const signedContent = `${timestamp}.${body}`;
  const expected = createHmac('sha256', secret).update(signedContent).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return a.equals(b);
}

export function paginate<T>(items: T[], limit: number, cursor?: string): {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
} {
  let startIdx = 0;
  if (cursor) {
    startIdx = parseInt(Buffer.from(cursor, 'base64').toString('utf-8'), 10);
  }
  const endIdx = startIdx + limit;
  const pageItems = items.slice(startIdx, endIdx);
  const hasMore = endIdx < items.length;
  const nextCursor = hasMore ? Buffer.from(endIdx.toString()).toString('base64') : null;

  return { items: pageItems, nextCursor, hasMore };
}

export function maskApiKey(key: string): string {
  if (key.length <= 12) return key;
  return `${key.substring(0, 12)}${'*'.repeat(key.length - 16)}${key.substring(key.length - 4)}`;
}

export * from './observability.js';

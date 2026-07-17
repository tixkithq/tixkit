/**
 * Link-shortening and privacy-safe click-tracking primitive (C-078).
 *
 * Design goals:
 * - Tenant-scoped short links with stable, collision-resistant slugs.
 * - Privacy-safe click counting: no PII is stored per click; only an
 *   aggregate count and a coarse time bucket are recorded.
 * - Optional UTM passthrough with a strict allowlist (no arbitrary query
 *   params forwarded to protect against injection / open-redirect abuse).
 * - Open-redirect guard: destination URLs must use http(s) and must not
 *   target loopback/private hosts unless explicitly allowed in dev.
 *
 * This module is pure (no DB, no network). Persistence lives in the
 * ShortLinkRepository; the redirect route calls into the repository.
 */

import { randomBytes } from 'node:crypto';

export type ShortLink = {
  id: string;
  tenantId: string;
  slug: string;
  destinationUrl: string;
  utmParams?: Record<string, string>;
  clicks: number;
  createdAt: string;
  expiresAt?: string;
};

export type ShortLinkClickAggregate = {
  slug: string;
  totalClicks: number;
  byDay: Record<string, number>;
};

const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const DEFAULT_SLUG_LENGTH = 7;

export function generateShortLinkSlug(
  length = DEFAULT_SLUG_LENGTH,
  randomBytesFn: (n: number) => Uint8Array = (n: number) => randomBytes(n),
): string {
  const bytes = randomBytesFn(length);
  let slug = '';
  for (let i = 0; i < length; i += 1) {
    slug += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  }
  return slug;
}

/** Generate candidate slugs and retry on collision (caller provides exists check). */
export async function generateUniqueSlug(
  exists: (slug: string) => Promise<boolean>,
  attempts = 8,
  length = DEFAULT_SLUG_LENGTH,
): Promise<string> {
  for (let i = 0; i < attempts; i += 1) {
    const slug = generateShortLinkSlug(length);
    // eslint-disable-next-line no-await-in-loop -- retry loop must await each collision check serially
    if (!(await exists(slug))) return slug;
  }
  throw new Error(`Unable to generate a unique short-link slug after ${attempts} attempts`);
}

const UTM_ALLOWLIST = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
]);

export function sanitizeUtmParams(params: Record<string, unknown>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (UTM_ALLOWLIST.has(key) && typeof value === 'string') {
      // UTM values are forwarded as query params; strip control chars only.
      // eslint-disable-next-line no-control-regex -- intentionally stripping control chars for URL safety
      clean[key] = value.replace(/[\x00-\x1F\x7F]/g, '');
    }
  }
  return clean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '::', '::1']);

function isNonPublicIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [first, second, third] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

/**
 * Validates URL syntax and literal host ranges for redirect-only destinations.
 * DNS names are intentionally not resolved; callers must never use this result to authorize a
 * server-side fetch or other network access.
 */
export function isAllowedDestination(url: string, allowPrivate = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (allowPrivate) return true;
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (LOOPBACK_HOSTS.has(host)) return false;
  if (host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isNonPublicIpv4(host)) return false;
  if (/^(?:fc|fd)[0-9a-f]{2}:/i.test(host)) return false;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return false;
  if (/^ff[0-9a-f]{2}:/i.test(host)) return false;
  if (host.startsWith('100:')) return false;
  if (/^2001:(?:0*2|0*10|0*20|db8):/i.test(host)) return false;
  if (/^3fff:/i.test(host)) return false;
  if (/^5f[0-9a-f]{2}:/i.test(host)) return false;
  if (host.startsWith('::ffff:')) return false;
  return true;
}

export function composeRedirectUrl(
  destinationUrl: string,
  utmParams?: Record<string, string>,
): string {
  if (!utmParams || Object.keys(utmParams).length === 0) return destinationUrl;
  const url = new URL(destinationUrl);
  for (const [key, value] of Object.entries(utmParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Coarse day bucket (YYYY-MM-DD) in UTC for privacy-safe aggregate counting. */
export function dayBucket(timestamp: Date = new Date()): string {
  return timestamp.toISOString().slice(0, 10);
}

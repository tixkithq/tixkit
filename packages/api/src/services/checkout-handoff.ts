import { createHmac, timingSafeEqual } from 'node:crypto';
import { CheckoutExpiredError, ValidationError } from '@tixkit/domain';

const HANDOFF_TTL_MS = 5 * 60 * 1000;

export type CheckoutHandoffSession = {
  id: string;
  client_token: string;
  expires_at: Date | string;
};

export function createCheckoutHandoffToken(
  session: CheckoutHandoffSession,
  now = Date.now(),
): { token: string; expiresAt: string } {
  const expiresAt = Math.min(now + HANDOFF_TTL_MS, new Date(session.expires_at).getTime());
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new CheckoutExpiredError(session.id);
  const expires = Math.floor(expiresAt / 1000);
  const signature = createHmac('sha256', session.client_token)
    .update(`tixkit-checkout-handoff-v1:${session.id}:${expires}`)
    .digest('base64url');
  return { token: `${expires}.${signature}`, expiresAt: new Date(expires * 1000).toISOString() };
}

export function validCheckoutHandoffToken(
  session: Pick<CheckoutHandoffSession, 'id' | 'client_token'>,
  token: string,
  now = Date.now(),
): boolean {
  const [expiresValue, signature, ...extra] = token.split('.');
  if (!expiresValue || !signature || extra.length || !/^\d{10}$/u.test(expiresValue)) return false;
  const expires = Number(expiresValue);
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now) return false;
  const expected = createHmac('sha256', session.client_token)
    .update(`tixkit-checkout-handoff-v1:${session.id}:${expires}`)
    .digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validCheckoutHandoffSession(
  session: CheckoutHandoffSession & { status: string },
  token: string,
  now = Date.now(),
): boolean {
  return (
    ['open', 'pending_payment'].includes(session.status) &&
    new Date(session.expires_at).getTime() > now &&
    validCheckoutHandoffToken(session, token, now)
  );
}

export function checkoutPublicOrigin(environment: NodeJS.ProcessEnv = process.env): string {
  const configured =
    environment.PUBLIC_CHECKOUT_URL?.trim() || environment.CHECKOUT_PUBLIC_URL?.trim();
  if (!configured) throw new ValidationError('Hosted checkout URL is not configured');
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new ValidationError('Hosted checkout URL is invalid');
  }
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new ValidationError('Hosted checkout URL must use HTTPS');
  }
  return url.origin;
}

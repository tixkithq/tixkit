import { describe, expect, it } from 'vitest';
import { CheckoutExpiredError, ValidationError } from '@tixkit/domain';
import {
  checkoutPublicOrigin,
  createCheckoutHandoffToken,
  validCheckoutHandoffSession,
  validCheckoutHandoffToken,
} from '../services/checkout-handoff.js';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');
const session = {
  id: 'cs_1',
  client_token: 'session_secret_never_in_handoff',
  expires_at: new Date(NOW + 10 * 60_000),
};

describe('checkout hosted handoff', () => {
  it('issues a short-lived opaque capability without embedding the session credential', () => {
    const handoff = createCheckoutHandoffToken(session, NOW);
    expect(handoff.expiresAt).toBe('2026-07-10T12:05:00.000Z');
    expect(handoff.token).not.toContain(session.client_token);
    expect(validCheckoutHandoffToken(session, handoff.token, NOW)).toBe(true);
  });

  it('fails closed for expiry, tampering, another session, and another credential', () => {
    const handoff = createCheckoutHandoffToken(session, NOW);
    expect(validCheckoutHandoffToken(session, handoff.token, NOW + 5 * 60_000)).toBe(false);
    expect(validCheckoutHandoffToken(session, `${handoff.token}x`, NOW)).toBe(false);
    expect(validCheckoutHandoffToken({ ...session, id: 'cs_2' }, handoff.token, NOW)).toBe(false);
    expect(
      validCheckoutHandoffToken({ ...session, client_token: 'different' }, handoff.token, NOW),
    ).toBe(false);
  });

  it('refuses exchange after cancellation, completion, or a shortened session expiry', () => {
    const handoff = createCheckoutHandoffToken(session, NOW);
    expect(validCheckoutHandoffSession({ ...session, status: 'open' }, handoff.token, NOW)).toBe(
      true,
    );
    expect(
      validCheckoutHandoffSession({ ...session, status: 'cancelled' }, handoff.token, NOW),
    ).toBe(false);
    expect(
      validCheckoutHandoffSession({ ...session, status: 'completed' }, handoff.token, NOW),
    ).toBe(false);
    expect(
      validCheckoutHandoffSession(
        { ...session, status: 'pending_payment', expires_at: new Date(NOW) },
        handoff.token,
        NOW,
      ),
    ).toBe(false);
  });

  it('does not issue capabilities after the checkout hold expires', () => {
    expect(() =>
      createCheckoutHandoffToken({ ...session, expires_at: new Date(NOW) }, NOW),
    ).toThrow(CheckoutExpiredError);
  });

  it('requires HTTPS except for loopback development and strips configured paths', () => {
    expect(checkoutPublicOrigin({ PUBLIC_CHECKOUT_URL: 'https://checkout.example/pay' })).toBe(
      'https://checkout.example',
    );
    expect(checkoutPublicOrigin({ CHECKOUT_PUBLIC_URL: 'http://localhost:3000/pay' })).toBe(
      'http://localhost:3000',
    );
    expect(() => checkoutPublicOrigin({ PUBLIC_CHECKOUT_URL: 'http://checkout.example' })).toThrow(
      ValidationError,
    );
    expect(() =>
      checkoutPublicOrigin({ PUBLIC_CHECKOUT_URL: 'https://user@checkout.example' }),
    ).toThrow(ValidationError);
  });
});

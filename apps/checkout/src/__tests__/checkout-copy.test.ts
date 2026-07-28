import { describe, expect, it } from 'vitest';
import { getCheckoutCopy, resolveCheckoutLocale } from '@/lib/checkout-copy';

describe('checkout copy', () => {
  it('resolves regional locales to the supported language catalog', () => {
    expect(resolveCheckoutLocale('es-MX')).toBe('es');
    expect(getCheckoutCopy('es-MX').networkOfflineTitle).toBe('No tienes conexión');
  });

  it('fails safely to English for missing and invalid locales', () => {
    expect(resolveCheckoutLocale(undefined)).toBe('en');
    expect(resolveCheckoutLocale('invalid_locale')).toBe('en');
    expect(getCheckoutCopy('invalid_locale').continue).toBe('Continue');
  });

  it('keeps recovery actions translated in every supported catalog', () => {
    for (const locale of ['en', 'es', 'fr', 'de', 'pt']) {
      const copy = getCheckoutCopy(locale);
      expect(copy.networkOfflineTitle).not.toBe('');
      expect(copy.networkRetry).not.toBe('');
      expect(copy.startNewOrder).not.toBe('');
      expect(copy.retryReservationCheck).not.toBe('');
      expect(copy.checkoutExpiredBody).not.toBe('');
    }
  });
});

import { describe, it, expect } from 'vitest';
import {
  Translator,
  CHECKOUT_MESSAGES,
  formatCurrency,
  formatDate,
  formatNumber,
  interpolate,
  resolveTemplateLocale,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
} from '../i18n/index.js';

describe('Translator', () => {
  const t = new Translator(CHECKOUT_MESSAGES, 'en');

  it('translates a key in the requested locale', () => {
    expect(t.translate('checkout.title', 'es')).toBe('Completa tu pedido');
    expect(t.translate('checkout.title', 'fr')).toBe('Finalisez votre commande');
  });

  it('interpolates placeholders', () => {
    expect(t.translate('checkout.payNow', 'en', { amount: '$45.00' })).toBe('Pay $45.00');
    expect(t.translate('checkout.payNow', 'de', { amount: '45,00 €' })).toBe('45,00 € bezahlen');
  });

  it('falls back to the default locale when a key is missing in the requested locale', () => {
    expect(t.translate('checkout.title', 'ja')).toBe('Complete your order');
  });

  it('returns the key when no translation exists anywhere', () => {
    expect(t.translate('nonexistent.key', 'es')).toBe('nonexistent.key');
  });

  it('resolveLocale picks the first available catalog with language-only fallback', () => {
    expect(t.resolveLocale('es-ES')).toBe('es');
    expect(t.resolveLocale(['de-AT', 'en'])).toBe('de');
    expect(t.resolveLocale('ja')).toBe('en');
    expect(t.resolveLocale(undefined)).toBe('en');
  });
});

describe('interpolate', () => {
  it('leaves missing placeholders intact', () => {
    expect(interpolate('Hi {name}', {})).toBe('Hi {name}');
  });
  it('substitutes numeric and string values', () => {
    expect(interpolate('{count} items', { count: 3 })).toBe('3 items');
  });
});

describe('formatCurrency', () => {
  it('formats cents into a locale-specific currency string', () => {
    expect(formatCurrency(4599, 'USD', 'en')).toBe('$45.99');
    expect(formatCurrency(4599, 'EUR', 'de')).toMatch(/45,99/);
    expect(formatCurrency(4599, 'EUR', 'fr')).toMatch(/45,99/);
  });
});

describe('formatDate', () => {
  it('formats a date in a locale-specific way', () => {
    const date = new Date('2026-07-04T19:00:00Z');
    const en = formatDate(date, 'en');
    const es = formatDate(date, 'es');
    expect(en).toBeTruthy();
    expect(es).toBeTruthy();
    expect(en).not.toEqual(es);
  });
});

describe('formatNumber', () => {
  it('formats numbers with locale separators', () => {
    expect(formatNumber(1234567.89, 'en')).toBe('1,234,567.89');
    expect(formatNumber(1234567.89, 'de')).toBe('1.234.567,89');
  });
});

describe('resolveTemplateLocale', () => {
  const variants = {
    en: 'Hello',
    es: 'Hola',
    fr: 'Bonjour',
  };

  it('picks the preferred locale when available', () => {
    expect(resolveTemplateLocale(variants, 'es').content).toBe('Hola');
  });

  it('falls back to the language-only match for region tags', () => {
    expect(resolveTemplateLocale(variants, 'es-MX').locale).toBe('es');
  });

  it('falls back to the default locale', () => {
    expect(resolveTemplateLocale(variants, 'de', 'en').content).toBe('Hello');
  });

  it('falls back to the first available variant when default is missing', () => {
    const onlyEs = { es: 'Hola' };
    expect(resolveTemplateLocale(onlyEs, 'de', 'en').content).toBe('Hola');
  });

  it('returns empty content when no variants exist', () => {
    expect(resolveTemplateLocale({}, 'es')).toEqual({ locale: 'en', content: '' });
  });
});

describe('catalog constants', () => {
  it('exports a non-empty supported-locales list with a default', () => {
    expect(SUPPORTED_LOCALES.length).toBeGreaterThan(3);
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });

  it('every supported locale has a checkout catalog with the title key', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(CHECKOUT_MESSAGES[locale]?.['checkout.title']).toBeTruthy();
    }
  });
});

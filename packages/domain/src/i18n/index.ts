/**
 * Internationalization / localization framework (C-074).
 *
 * Provides:
 * - A translation function with per-locale message catalogs and graceful
 *   fallback to a default locale, with ICU-style {placeholder} interpolation.
 * - Locale-aware currency / date / number formatting via the platform Intl API.
 * - Template-locale resolution: pick the best available template variant for a
 *   buyer's preferred locale, falling back to the event default.
 *
 * Pure (no DB, no network): callers load catalogs and call translate/format.
 */

export const DEFAULT_LOCALE = 'en';

export const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'de', 'pt'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export type MessageCatalog = Record<string, string>;
export type Catalogs = Partial<Record<string, MessageCatalog>>;

export type TranslateParams = Record<string, string | number>;

const CATALOG_TAG_RE = /\{(\w+)\}/g;

export class Translator {
  constructor(
    private readonly catalogs: Catalogs,
    private readonly defaultLocale: string = DEFAULT_LOCALE,
  ) {}

  translate(key: string, locale: string, params?: TranslateParams): string {
    const template =
      this.catalogs[locale]?.[key] ??
      this.catalogs[this.defaultLocale]?.[key] ??
      this.catalogs[DEFAULT_LOCALE]?.[key] ??
      key;
    return interpolate(template, params);
  }

  /** Resolve the best available locale for a buyer given a preference list. */
  resolveLocale(preferred: string | string[] | undefined): string {
    const candidates = Array.isArray(preferred) ? preferred : preferred ? [preferred] : [];
    for (const candidate of candidates) {
      if (this.hasCatalog(candidate)) return candidate;
      // Try language-only fallback (e.g. "es-ES" -> "es").
      const lang = candidate.split('-')[0];
      if (lang !== candidate && this.hasCatalog(lang)) return lang;
    }
    return this.defaultLocale;
  }

  hasCatalog(locale: string): boolean {
    return Boolean(this.catalogs[locale]);
  }
}

export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(CATALOG_TAG_RE, (_match, key: string) => {
    const value = params[key];
    return value === undefined ? `{${key}}` : String(value);
  });
}

export function formatCurrency(
  amountCents: number,
  currency: string,
  locale: string = DEFAULT_LOCALE,
): string {
  return new Intl.NumberFormat(toBcp47(locale), {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amountCents / 100);
}

export function formatDate(
  date: Date | string,
  locale: string = DEFAULT_LOCALE,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(toBcp47(locale), options).format(d);
}

export function formatNumber(value: number, locale: string = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(toBcp47(locale)).format(value);
}

/**
 * Pick the best template variant for a buyer's preferred locale. Variants is a
 * map of locale -> template content. Falls back to the default locale, then to
 * the first available variant.
 */
export function resolveTemplateLocale(
  variants: Record<string, string>,
  preferredLocale: string | string[] | undefined,
  defaultLocale: string = DEFAULT_LOCALE,
): { locale: string; content: string } {
  const candidates = Array.isArray(preferredLocale)
    ? preferredLocale
    : preferredLocale
      ? [preferredLocale]
      : [];
  for (const candidate of candidates) {
    if (variants[candidate]) return { locale: candidate, content: variants[candidate] };
    const lang = candidate.split('-')[0];
    if (lang !== candidate && variants[lang]) return { locale: lang, content: variants[lang] };
  }
  if (variants[defaultLocale]) return { locale: defaultLocale, content: variants[defaultLocale] };
  const firstAvailable = Object.keys(variants)[0];
  if (firstAvailable) return { locale: firstAvailable, content: variants[firstAvailable] };
  return { locale: defaultLocale, content: '' };
}

/** Normalize a Tixkit locale tag to a BCP 47 tag for Intl (e.g. "pt" -> "pt-PT"). */
function toBcp47(locale: string): string {
  const map: Record<string, string> = {
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    pt: 'pt-PT',
  };
  if (map[locale]) return map[locale];
  // Already a region tag like "es-MX" passes through.
  return locale;
}

// ---- Default checkout message catalogs (OSS-core) ----

export const CHECKOUT_MESSAGES: Catalogs = {
  en: {
    'checkout.title': 'Complete your order',
    'checkout.email': 'Email address',
    'checkout.payment': 'Payment',
    'checkout.payNow': 'Pay {amount}',
    'checkout.success': 'Order confirmed',
    'checkout.errors.required': 'This field is required',
    'checkout.errors.cardDeclined': 'Your card was declined',
    'checkout.languageLabel': 'Language',
  },
  es: {
    'checkout.title': 'Completa tu pedido',
    'checkout.email': 'Correo electrónico',
    'checkout.payment': 'Pago',
    'checkout.payNow': 'Pagar {amount}',
    'checkout.success': 'Pedido confirmado',
    'checkout.errors.required': 'Este campo es obligatorio',
    'checkout.errors.cardDeclined': 'Tu tarjeta fue rechazada',
    'checkout.languageLabel': 'Idioma',
  },
  fr: {
    'checkout.title': 'Finalisez votre commande',
    'checkout.email': 'Adresse e-mail',
    'checkout.payment': 'Paiement',
    'checkout.payNow': 'Payer {amount}',
    'checkout.success': 'Commande confirmée',
    'checkout.errors.required': 'Ce champ est obligatoire',
    'checkout.errors.cardDeclined': 'Votre carte a été refusée',
    'checkout.languageLabel': 'Langue',
  },
  de: {
    'checkout.title': 'Bestellung abschließen',
    'checkout.email': 'E-Mail-Adresse',
    'checkout.payment': 'Zahlung',
    'checkout.payNow': '{amount} bezahlen',
    'checkout.success': 'Bestellung bestätigt',
    'checkout.errors.required': 'Dieses Feld ist erforderlich',
    'checkout.errors.cardDeclined': 'Ihre Karte wurde abgelehnt',
    'checkout.languageLabel': 'Sprache',
  },
  pt: {
    'checkout.title': 'Conclua o seu pedido',
    'checkout.email': 'Endereço de e-mail',
    'checkout.payment': 'Pagamento',
    'checkout.payNow': 'Pagar {amount}',
    'checkout.success': 'Pedido confirmado',
    'checkout.errors.required': 'Este campo é obrigatório',
    'checkout.errors.cardDeclined': 'O seu cartão foi recusado',
    'checkout.languageLabel': 'Idioma',
  },
};

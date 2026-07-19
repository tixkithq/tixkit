const DEFAULT_EVENT_PAGE_LOCALE = 'en';
const MAX_LOCALE_LENGTH = 64;

const RTL_LANGUAGES = new Set([
  'ar',
  'ckb',
  'dv',
  'fa',
  'he',
  'ku',
  'nqo',
  'ps',
  'sd',
  'syr',
  'ug',
  'ur',
  'yi',
]);

export function resolveEventPageLocale(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate || candidate.length > MAX_LOCALE_LENGTH) return DEFAULT_EVENT_PAGE_LOCALE;
  try {
    return Intl.getCanonicalLocales(candidate)[0] ?? DEFAULT_EVENT_PAGE_LOCALE;
  } catch {
    return DEFAULT_EVENT_PAGE_LOCALE;
  }
}

export function eventPageLocaleDirection(locale: string): 'ltr' | 'rtl' {
  try {
    const parsed = new Intl.Locale(locale);
    const localeWithTextInfo = parsed as Intl.Locale & {
      getTextInfo?: () => { direction?: string };
    };
    if (localeWithTextInfo.getTextInfo?.().direction === 'rtl') return 'rtl';
    if (parsed.script === 'Arab' || parsed.script === 'Hebr') return 'rtl';
    return RTL_LANGUAGES.has(parsed.language) ? 'rtl' : 'ltr';
  } catch {
    return RTL_LANGUAGES.has(locale.toLowerCase().split(/[-_]/, 1)[0] ?? '') ? 'rtl' : 'ltr';
  }
}

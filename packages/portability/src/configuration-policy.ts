import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateEventPageDocument } from '@tixkit/content-event-page';
import {
  canonicalPortableJson,
  isPortableProtocolId,
  type PortableLogicalRecord,
  type PortablePayloadSafetyPolicy,
  type PortableSection,
} from './manifest.js';

type FieldType = 'string' | 'nullable-string' | 'number' | 'nullable-number' | 'boolean' | 'json';
type SectionSchema = Readonly<{
  required: readonly string[];
  attributes: Readonly<Record<string, FieldType>>;
}>;

const goldenPolicy = JSON.parse(
  readFileSync(
    new URL('../schemas/portable-configuration-policy-v2.json', import.meta.url),
    'utf8',
  ),
) as {
  policyVersion: string;
  validatorVersion: string;
  secretPolicyVersion: string;
  sections: Record<string, { schemaSha256: string; policySha256: string }>;
};

export const PORTABLE_CONFIGURATION_POLICY_VERSION = goldenPolicy.policyVersion;

const schemas = {
  organizations: {
    required: ['name', 'slug', 'status', 'boxOfficeSettings', 'eventDefaults'],
    attributes: {
      name: 'string',
      slug: 'string',
      status: 'string',
      boxOfficeSettings: 'json',
      eventDefaults: 'json',
    },
  },
  brands: {
    required: ['name', 'slug', 'status', 'theme', 'legalUrls', 'whiteLabel'],
    attributes: {
      name: 'string',
      slug: 'string',
      status: 'string',
      theme: 'json',
      supportUrl: 'nullable-string',
      legalUrls: 'json',
      whiteLabel: 'boolean',
    },
  },
  venues: {
    required: ['name'],
    attributes: { name: 'string', address: 'nullable-string', timezone: 'nullable-string' },
  },
  events: {
    required: ['title', 'slug', 'status', 'currency', 'timezone', 'startsAt', 'visibility'],
    attributes: {
      title: 'string',
      slug: 'string',
      description: 'nullable-string',
      status: 'string',
      currency: 'string',
      timezone: 'string',
      startsAt: 'string',
      endsAt: 'nullable-string',
      visibility: 'string',
      capacity: 'nullable-number',
      minimumAge: 'nullable-number',
      codeFormat: 'json',
      mediaAssets: 'json',
    },
  },
  occurrences: {
    required: ['title', 'startsAt', 'endsAt', 'timezone', 'status', 'sortOrder'],
    attributes: {
      title: 'string',
      startsAt: 'string',
      endsAt: 'string',
      timezone: 'string',
      capacity: 'nullable-number',
      status: 'string',
      sortOrder: 'number',
    },
  },
  inventory: {
    required: ['name', 'totalCapacity', 'holdTtlSeconds'],
    attributes: { name: 'string', totalCapacity: 'number', holdTtlSeconds: 'number' },
  },
  ticket_types: {
    required: [
      'name',
      'kind',
      'status',
      'visibility',
      'currency',
      'priceMinor',
      'minPerOrder',
      'maxPerOrder',
      'sortOrder',
      'requiresAccessCode',
    ],
    attributes: {
      name: 'string',
      description: 'nullable-string',
      kind: 'string',
      status: 'string',
      visibility: 'string',
      currency: 'string',
      priceMinor: 'number',
      minimumPriceMinor: 'nullable-number',
      salesStartAt: 'nullable-string',
      salesEndAt: 'nullable-string',
      minPerOrder: 'number',
      maxPerOrder: 'number',
      sortOrder: 'number',
      requiresAccessCode: 'boolean',
    },
  },
  products: {
    required: ['name', 'currency', 'priceMinor', 'maxPerOrder', 'status', 'sortOrder'],
    attributes: {
      name: 'string',
      description: 'nullable-string',
      currency: 'string',
      priceMinor: 'number',
      maxPerOrder: 'number',
      availableFrom: 'nullable-string',
      availableUntil: 'nullable-string',
      status: 'string',
      sortOrder: 'number',
    },
  },
  checkout_questions: {
    required: ['label', 'type', 'required', 'appliesTo', 'sortOrder', 'isConsentField'],
    attributes: {
      label: 'string',
      type: 'string',
      description: 'nullable-string',
      required: 'boolean',
      appliesTo: 'string',
      options: 'json',
      placeholder: 'nullable-string',
      sortOrder: 'number',
      isConsentField: 'boolean',
      consentText: 'nullable-string',
      consentVersion: 'nullable-string',
    },
  },
  discounts: {
    required: ['code', 'type', 'value', 'currency', 'maxUses', 'status'],
    attributes: {
      code: 'string',
      type: 'string',
      value: 'number',
      currency: 'string',
      maxUses: 'number',
      validFrom: 'nullable-string',
      validUntil: 'nullable-string',
      minOrderMinor: 'nullable-number',
      maxDiscountMinor: 'nullable-number',
      status: 'string',
    },
  },
  access_codes: {
    required: ['code', 'type'],
    attributes: {
      code: 'string',
      type: 'string',
      maxUses: 'nullable-number',
      expiresAt: 'nullable-string',
    },
  },
  content: {
    required: ['channel', 'key', 'name', 'locale', 'versions'],
    attributes: {
      channel: 'string',
      key: 'string',
      name: 'string',
      locale: 'string',
      versions: 'json',
    },
  },
} as const satisfies Partial<Record<PortableSection, SectionSchema>>;

const domainConstraints = {
  enums: {
    'organizations.status': ['active', 'inactive', 'suspended'],
    'brands.status': ['draft', 'active', 'suspended'],
    'events.status': ['draft', 'published', 'paused', 'archived'],
    'events.visibility': ['public', 'unlisted', 'private'],
    'occurrences.status': ['scheduled', 'active', 'cancelled', 'completed'],
    'ticket_types.kind': ['free', 'paid', 'donation'],
    'ticket_types.status': ['draft', 'active', 'paused', 'sold_out', 'ended'],
    'ticket_types.visibility': ['public', 'hidden', 'locked'],
    'products.status': ['active', 'inactive'],
    'checkout_questions.type': [
      'text',
      'textarea',
      'email',
      'phone',
      'select',
      'multiselect',
      'checkbox',
      'date',
      'file',
      'waiver',
    ],
    'checkout_questions.appliesTo': ['buyer', 'attendee', 'both'],
    'discounts.type': ['percentage', 'fixed_amount', 'free_ticket'],
    'discounts.status': ['active', 'inactive'],
    'access_codes.type': ['code', 'email_domain'],
  },
  currencies: [
    'events.currency',
    'ticket_types.currency',
    'products.currency',
    'discounts.currency',
  ],
  timezones: ['events.timezone', 'occurrences.timezone'],
  dates: [
    'events.startsAt',
    'events.endsAt',
    'occurrences.startsAt',
    'occurrences.endsAt',
    'ticket_types.salesStartAt',
    'ticket_types.salesEndAt',
    'products.availableFrom',
    'products.availableUntil',
    'discounts.validFrom',
    'discounts.validUntil',
    'access_codes.expiresAt',
  ],
  urls: ['brands.supportUrl'],
  nonnegativeIntegers: [
    'events.capacity',
    'events.minimumAge',
    'occurrences.capacity',
    'occurrences.sortOrder',
    'ticket_types.priceMinor',
    'ticket_types.minimumPriceMinor',
    'ticket_types.sortOrder',
    'products.priceMinor',
    'products.sortOrder',
    'checkout_questions.sortOrder',
    'discounts.value',
    'discounts.maxUses',
    'discounts.minOrderMinor',
    'discounts.maxDiscountMinor',
    'access_codes.maxUses',
  ],
  positiveIntegers: [
    'inventory.totalCapacity',
    'inventory.holdTtlSeconds',
    'ticket_types.minPerOrder',
    'ticket_types.maxPerOrder',
    'products.maxPerOrder',
  ],
  nestedSchemas: {
    'organizations.boxOfficeSettings': 'strict-box-office-v1',
    'organizations.eventDefaults': 'strict-event-defaults-v1',
    'brands.theme':
      'strict-brand-theme-portable-subset-v2:primaryColor,secondaryColor,accentColor,backgroundColor,textColor,fontFamily-safe180,borderRadius-number0-100',
    'brands.legalUrls': 'strict-legal-urls-v1',
    'events.codeFormat': 'strict-code-format-v1',
    'checkout_questions.options': 'strict-question-options-v1',
    'content.versions': 'strict-channel-content-versions-v1',
  },
  urlPolicy: 'https-no-userinfo-no-credential-query-v1',
  validator: 'tixkit-portable-configuration-validator-v2',
} as const;

export type PortableConfigurationSection = keyof typeof schemas;
export const PORTABLE_CONFIGURATION_SECTIONS = Object.freeze(
  Object.keys(schemas) as PortableConfigurationSection[],
);

function matchesType(value: unknown, type: FieldType): boolean {
  if (type === 'nullable-string') return value === null || typeof value === 'string';
  if (type === 'nullable-number')
    return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isSafeInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return value === null || typeof value === 'object';
}

function validIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validPublicUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      [...url.searchParams.keys()].every(
        (key) => !/(?:api.?key|token|secret|password|signature|credential)/iu.test(key),
      )
    );
  } catch {
    return false;
  }
}

function validPortableImageSource(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  if (/^tixkit:event-media:(?:poster|cover|social)$/u.test(value.trim())) return true;
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !privatePortableHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

function privatePortableHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:') ||
    // Direct IPv6 literals are rejected fail-closed. Besides avoiding private,
    // link-local, and IPv4-mapped spelling bypasses, portable content should use
    // a stable public hostname whose ownership can be rebound at the destination.
    normalized.includes(':')
  )
    return true;
  const octets = normalized.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false;
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function decodePortableSource(source: string): string {
  const codePoint = (raw: string, radix: number, match: string): string => {
    const value = Number.parseInt(raw, radix);
    return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff
      ? String.fromCodePoint(value)
      : match;
  };
  const decodedEntities = source
    .replace(/&#x([0-9a-f]+);?/giu, (match, value: string) => codePoint(value, 16, match))
    .replace(/&#([0-9]+);?/gu, (match, value: string) => codePoint(value, 10, match))
    .replace(
      /&(amp|apos|bsol|colon|commat|equals|lbrack|lpar|newline|num|percnt|period|quest|quot|rbrack|rpar|semi|sol|tab);/giu,
      (_match, name: string) => {
        const entities: Record<string, string> = {
          amp: '&',
          apos: "'",
          bsol: '\\',
          colon: ':',
          commat: '@',
          equals: '=',
          lbrack: '[',
          lpar: '(',
          newline: '\n',
          num: '#',
          percnt: '%',
          period: '.',
          quest: '?',
          quot: '"',
          rbrack: ']',
          rpar: ')',
          semi: ';',
          sol: '/',
          tab: '\t',
        };
        return entities[name.toLowerCase()] ?? _match;
      },
    )
    .replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded.replace(/%([0-9a-f]{2})/giu, (_match, byte: string) =>
          String.fromCodePoint(Number.parseInt(byte, 16)),
        );
      }
    });
  return decodedEntities;
}

function portableSourceVariants(source: string): string[] {
  const variants = [source];
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const decoded = decodePortableSource(variants.at(-1)!);
    if (decoded !== variants.at(-1)) variants.push(decoded);
    const browserRecovered = decoded.replace(/[\t\n\r]/gu, '').replaceAll('\\', '/');
    if (browserRecovered !== variants.at(-1)) variants.push(browserRecovered);
    if (decoded === variants.at(-1) && browserRecovered === variants.at(-1)) break;
  }
  return variants;
}

function containsForbiddenPortableSource(candidate: unknown, references?: string[]): boolean {
  if (typeof candidate === 'string') {
    for (const source of portableSourceVariants(candidate.trim())) {
      if (source.startsWith('tixkit:event-media:')) references?.push(source);
      if (/(?:^|["'(=\s])(?:blob:|data:)/iu.test(source)) return true;
      // Portable content must not rely on an ambient origin or browser/CSS
      // recovery rules. Reject obfuscated URL syntax before extracting normal
      // absolute URLs so backslashes and CSS escapes cannot become private
      // requests only after DOM/style parsing.
      if (
        /(?:^|["'(=\s])\/\/[^/]/u.test(source) ||
        /https?:\\/iu.test(source) ||
        /\\[0-9a-f]{1,6}(?:\s|\\)?/iu.test(source) ||
        /(?:https?|(?:src|href)\s*=|url\s*\()[^"'<>\n\r]{0,64}\\/iu.test(source)
      )
        return true;
      if (
        /(?:^|["'(=\s])\/v1\/(?:events|upload-artifacts)(?:\/|$)/u.test(source) ||
        /(?:^|["'(=\s])\/v1\/public\/content-event-page-images(?:\/|$)/u.test(source)
      )
        return true;
      const urls: string[] = source.match(/https?:\/\/[^\s<>"')]+/giu) ?? [];
      if (/^https?:\/\//iu.test(source) && !urls.includes(source)) urls.push(source);
      for (const urlSource of urls) {
        try {
          const url = new URL(urlSource);
          if (url.username || url.password || privatePortableHostname(url.hostname)) return true;
          if (
            [...url.searchParams.keys()].some((key) =>
              /(?:api.?key|token|secret|password|signature|credential)/iu.test(key),
            )
          )
            return true;
        } catch {
          // Merge-tag URL templates are validated by their channel runtime before delivery.
        }
      }
    }
    return false;
  }
  if (Array.isArray(candidate))
    return candidate.some((value) => containsForbiddenPortableSource(value, references));
  return (
    plainObject(candidate) &&
    Object.values(candidate).some((value) => containsForbiddenPortableSource(value, references))
  );
}

function validEventPagePortableContent(value: unknown): boolean {
  if (!validateEventPageDocument(value).valid) return false;
  if (!plainObject(value) || value.schemaVersion !== 2) return false;
  if (!plainObject(value.editor) || value.editor.provider !== '@puckeditor/core') return false;
  if (!plainObject(value.editor.data) || !plainObject(value.editor.data.root)) return false;
  if (!plainObject(value.editor.data.root.props) || !Array.isArray(value.editor.data.content))
    return false;
  if (!plainObject(value.settings) || !plainObject(value.settings.discovery)) return false;
  if (
    typeof value.settings.locale !== 'string' ||
    typeof value.settings.discovery.summary !== 'string' ||
    !Array.isArray(value.settings.discovery.tags) ||
    value.settings.discovery.tags.some((tag) => typeof tag !== 'string')
  )
    return false;

  const componentTypes = new Set([
    'EventHeader',
    'EventDescription',
    'RichText',
    'Media',
    'EventDetails',
    'Schedule',
    'Venue',
    'FAQ',
    'Sponsors',
    'Speakers',
    'Button',
    'Divider',
    'SocialLinks',
    'CustomEmbed',
    'Tickets',
    'ProductAddOns',
    'ResaleTickets',
    'CheckoutCta',
    'BrandFooter',
  ]);
  const requiredStrings: Readonly<Record<string, readonly string[]>> = {
    EventHeader: ['title'],
    RichText: ['body'],
    Media: ['imageUrl', 'imageAlt'],
    EventDetails: ['title'],
    Schedule: ['title'],
    Venue: ['title', 'venueName'],
    FAQ: ['title'],
    Sponsors: ['title'],
    Speakers: ['title'],
    Button: ['label', 'url'],
    CustomEmbed: ['html'],
  };
  const requiredArrays: Readonly<Record<string, readonly string[]>> = {
    EventDetails: ['items'],
    Schedule: ['items'],
    FAQ: ['items'],
    Sponsors: ['items'],
    Speakers: ['items'],
    SocialLinks: ['links'],
  };

  const allowedReferences: string[] = [];
  const registerImageSource = (source: unknown): boolean => {
    if (!validPortableImageSource(source)) return false;
    if (typeof source === 'string' && source.startsWith('tixkit:event-media:'))
      allowedReferences.push(source);
    return true;
  };
  const validateComponent = (candidate: unknown): boolean => {
    if (
      !plainObject(candidate) ||
      typeof candidate.type !== 'string' ||
      !plainObject(candidate.props)
    )
      return false;
    const props = candidate.props;
    if (!componentTypes.has(candidate.type)) return false;
    if (typeof props.id !== 'string' || props.id.trim() === '') return false;
    if (
      (requiredStrings[candidate.type] ?? []).some(
        (field) => typeof props[field] !== 'string' || String(props[field]).trim() === '',
      ) ||
      (requiredArrays[candidate.type] ?? []).some((field) => !Array.isArray(props[field]))
    )
      return false;
    const imageSource = props.imageUrl;
    if (imageSource !== undefined && !registerImageSource(imageSource)) return false;
    const roleReference =
      typeof imageSource === 'string' && imageSource.startsWith('tixkit:event-media:');
    if (roleReference && !['EventHeader', 'EventDescription', 'Media'].includes(candidate.type))
      return false;
    return true;
  };

  const root = value.editor.data.root.props;
  if (
    !registerImageSource(root.coverImageUrl) ||
    !registerImageSource(root.socialImageUrl) ||
    !registerImageSource(value.settings.discovery.coverImageUrl) ||
    !registerImageSource(value.settings.discovery.socialImageUrl) ||
    !value.editor.data.content.every(validateComponent)
  )
    return false;
  const zones = value.editor.data.zones;
  if (zones !== undefined) {
    if (!plainObject(zones)) return false;
    if (
      Object.values(zones).some((items) => !Array.isArray(items) || !items.every(validateComponent))
    )
      return false;
  }
  const allReferences: string[] = [];
  if (containsForbiddenPortableSource(value, allReferences)) return false;
  return allReferences.sort().join('\n') === allowedReferences.sort().join('\n');
}

function validEmailPortableContent(value: unknown): boolean {
  if (!plainObject(value) || value.schemaVersion !== 1) return false;
  if (
    !plainObject(value.editor) ||
    value.editor.provider !== '@react-email/editor' ||
    typeof value.editor.contentHtml !== 'string'
  )
    return false;
  if (
    (value.editor.contentText !== undefined && typeof value.editor.contentText !== 'string') ||
    (value.editor.globalCss !== undefined && typeof value.editor.globalCss !== 'string') ||
    (value.editor.contentJson !== undefined && !plainObject(value.editor.contentJson))
  )
    return false;
  if (!plainObject(value.settings) || !plainObject(value.settings.sender)) return false;
  if (
    typeof value.settings.templateKey !== 'string' ||
    typeof value.settings.subject !== 'string' ||
    typeof value.settings.locale !== 'string' ||
    !['transactional', 'bulk', 'staff', 'system'].includes(String(value.settings.category))
  )
    return false;
  if (
    !Array.isArray(value.blocks) ||
    value.blocks.some((block) => !plainObject(block) || typeof block.type !== 'string')
  )
    return false;
  return !containsForbiddenPortableSource(value);
}

function validSmsPortableContent(value: unknown): boolean {
  if (!plainObject(value) || value.schemaVersion !== 1) return false;
  if (
    !plainObject(value.editor) ||
    value.editor.provider !== '@tixkit/content-message/sms-composer' ||
    typeof value.editor.body !== 'string'
  )
    return false;
  if (!plainObject(value.settings)) return false;
  if (
    typeof value.settings.templateKey !== 'string' ||
    typeof value.settings.locale !== 'string' ||
    !['transactional', 'bulk', 'staff', 'system'].includes(String(value.settings.category)) ||
    !['transactional', 'marketing', 'staff', 'system'].includes(
      String(value.settings.consentCategory),
    ) ||
    !Number.isSafeInteger(value.settings.segmentLimit) ||
    Number(value.settings.segmentLimit) < 1 ||
    !Number.isSafeInteger(value.settings.estimatedCostPerSegmentCents) ||
    Number(value.settings.estimatedCostPerSegmentCents) < 0 ||
    !Array.isArray(value.shortLinks)
  )
    return false;
  return !containsForbiddenPortableSource(value);
}

export function validatePortableContentDocument(channel: unknown, value: unknown): boolean {
  if (channel === 'event_page') return validEventPagePortableContent(value);
  if (channel === 'email') return validEmailPortableContent(value);
  if (channel === 'sms') return validSmsPortableContent(value);
  // These channels have no public authoring/runtime contract yet and cannot be imported safely.
  return false;
}

function validJsonField(
  section: PortableConfigurationSection,
  key: string,
  value: unknown,
): boolean {
  if (section === 'organizations' && key === 'boxOfficeSettings') {
    if (
      !plainObject(value) ||
      !exactKeys(value, ['enabled', 'allowedTenderTypes', 'requireBuyerEmail', 'receiptMode'])
    )
      return false;
    const tenders = value.allowedTenderTypes;
    return (
      typeof value.enabled === 'boolean' &&
      typeof value.requireBuyerEmail === 'boolean' &&
      ['print', 'email', 'both'].includes(String(value.receiptMode)) &&
      Array.isArray(tenders) &&
      tenders.length > 0 &&
      tenders.length <= 3 &&
      new Set(tenders).size === tenders.length &&
      tenders.every((item) => ['cash', 'manual_card', 'comp'].includes(String(item)))
    );
  }
  if (section === 'organizations' && key === 'eventDefaults') {
    if (
      !plainObject(value) ||
      !exactKeys(value, ['timezone', 'currency', 'country', 'defaultVenueId', 'eventDescription'])
    )
      return false;
    return (
      (value.timezone === undefined ||
        (typeof value.timezone === 'string' && validTimezone(value.timezone))) &&
      (value.currency === undefined ||
        (typeof value.currency === 'string' && /^[A-Z]{3}$/u.test(value.currency))) &&
      (value.country === undefined ||
        (typeof value.country === 'string' && /^[A-Z]{2}$/u.test(value.country))) &&
      (value.defaultVenueId === undefined ||
        value.defaultVenueId === null ||
        isPortableProtocolId(value.defaultVenueId)) &&
      (value.eventDescription === undefined ||
        (typeof value.eventDescription === 'string' && value.eventDescription.length <= 10_000))
    );
  }
  if (section === 'brands' && key === 'theme') {
    if (
      !plainObject(value) ||
      !exactKeys(value, [
        'primaryColor',
        'secondaryColor',
        'accentColor',
        'backgroundColor',
        'textColor',
        'fontFamily',
        'borderRadius',
      ])
    )
      return false;
    return Object.entries(value).every(([themeKey, item]) => {
      if (themeKey === 'borderRadius')
        return typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 100;
      if (themeKey === 'fontFamily')
        return (
          typeof item === 'string' &&
          item.length > 0 &&
          item.length <= 180 &&
          !/[;{}<>]/u.test(item)
        );
      return (
        typeof item === 'string' &&
        item.length > 0 &&
        item.length <= 128 &&
        /^[#(),.% A-Za-z0-9-]+$/u.test(item)
      );
    });
  }
  if (section === 'brands' && key === 'legalUrls') {
    return (
      plainObject(value) &&
      exactKeys(value, ['terms', 'privacy', 'refundPolicy']) &&
      Object.values(value).every(validPublicUrl)
    );
  }
  if (section === 'events' && key === 'codeFormat') {
    if (value === null) return true;
    if (!plainObject(value) || !exactKeys(value, ['symbology', 'payloadFormat', 'rotating']))
      return false;
    if (
      !['qr', 'code128', 'pdf417', 'aztec', 'data_matrix'].includes(String(value.symbology)) ||
      !['signed_v1', 'compact_v2'].includes(String(value.payloadFormat))
    )
      return false;
    if (value.rotating === undefined) return true;
    const rotating = value.rotating;
    return (
      plainObject(rotating) &&
      exactKeys(rotating, ['timeStepSeconds', 'toleranceWindows', 'digits']) &&
      Number.isSafeInteger(rotating.timeStepSeconds) &&
      Number(rotating.timeStepSeconds) >= 15 &&
      Number(rotating.timeStepSeconds) <= 300 &&
      Number.isSafeInteger(rotating.toleranceWindows) &&
      Number(rotating.toleranceWindows) >= 0 &&
      Number(rotating.toleranceWindows) <= 5 &&
      (rotating.digits === undefined ||
        (Number.isSafeInteger(rotating.digits) &&
          Number(rotating.digits) >= 6 &&
          Number(rotating.digits) <= 10))
    );
  }
  if (section === 'events' && key === 'mediaAssets') {
    return (
      Array.isArray(value) &&
      value.length <= 3 &&
      value.every(
        (item) =>
          plainObject(item) &&
          exactKeys(item, ['portableId', 'role', 'altText', 'focalPoint']) &&
          typeof item.portableId === 'string' &&
          isPortableProtocolId(item.portableId) &&
          ['poster', 'cover', 'social'].includes(String(item.role)) &&
          typeof item.altText === 'string' &&
          item.altText.length >= 1 &&
          item.altText.length <= 500 &&
          plainObject(item.focalPoint) &&
          exactKeys(item.focalPoint, ['x', 'y']) &&
          typeof item.focalPoint.x === 'number' &&
          item.focalPoint.x >= 0 &&
          item.focalPoint.x <= 1 &&
          typeof item.focalPoint.y === 'number' &&
          item.focalPoint.y >= 0 &&
          item.focalPoint.y <= 1,
      )
    );
  }
  if (section === 'checkout_questions' && key === 'options') {
    return (
      value === null ||
      (Array.isArray(value) &&
        value.length <= 100 &&
        value.every(
          (item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 500,
        ))
    );
  }
  if (section === 'content' && key === 'versions') {
    const seenIds = new Set<string>();
    const seenNumbers = new Set<number>();
    return (
      Array.isArray(value) &&
      value.length <= 10_000 &&
      value.every((item) => {
        if (
          !plainObject(item) ||
          !exactKeys(item, [
            'portableId',
            'versionNumber',
            'schemaVersion',
            'subject',
            'previewText',
            'contentJson',
            'variables',
            'validation',
            'createdAt',
          ]) ||
          !isPortableProtocolId(item.portableId) ||
          seenIds.has(String(item.portableId)) ||
          !Number.isSafeInteger(item.versionNumber) ||
          Number(item.versionNumber) < 1 ||
          seenNumbers.has(Number(item.versionNumber)) ||
          !Number.isSafeInteger(item.schemaVersion) ||
          Number(item.schemaVersion) < 1 ||
          (item.subject !== null &&
            (typeof item.subject !== 'string' || item.subject.length > 256)) ||
          (item.previewText !== null &&
            (typeof item.previewText !== 'string' || item.previewText.length > 512)) ||
          !Array.isArray(item.variables) ||
          !plainObject(item.validation) ||
          typeof item.createdAt !== 'string' ||
          !validIsoTimestamp(item.createdAt)
        )
          return false;
        seenIds.add(String(item.portableId));
        seenNumbers.add(Number(item.versionNumber));
        return true;
      })
    );
  }
  return false;
}

function validDomainField(
  section: PortableConfigurationSection,
  key: string,
  value: unknown,
): boolean {
  if (value === null) return true;
  if (section === 'content' && key === 'channel')
    return (
      typeof value === 'string' &&
      ['event_page', 'email', 'sms', 'imessage', 'social_invite'].includes(value)
    );
  const path = `${section}.${key}`;
  const enumValues = (domainConstraints.enums as Readonly<Record<string, readonly string[]>>)[path];
  if (enumValues && (typeof value !== 'string' || !enumValues.includes(value))) return false;
  if (domainConstraints.currencies.includes(path as never))
    return typeof value === 'string' && /^[A-Z]{3}$/u.test(value);
  if (domainConstraints.timezones.includes(path as never))
    return typeof value === 'string' && validTimezone(value);
  if (domainConstraints.dates.includes(path as never))
    return typeof value === 'string' && validIsoTimestamp(value);
  if (domainConstraints.urls.includes(path as never)) {
    return validPublicUrl(value);
  }
  if (domainConstraints.nonnegativeIntegers.includes(path as never))
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (domainConstraints.positiveIntegers.includes(path as never))
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  return typeof value !== 'string' || (value.length > 0 && value.length <= 10_000);
}

function orderedDates(attributes: Record<string, unknown>, start: string, end: string): boolean {
  const left = attributes[start];
  const right = attributes[end];
  return (
    left === null ||
    left === undefined ||
    right === null ||
    right === undefined ||
    Date.parse(String(left)) <= Date.parse(String(right))
  );
}

function validCrossFields(
  section: PortableConfigurationSection,
  attributes: Record<string, unknown>,
): boolean {
  if (section === 'events' && !orderedDates(attributes, 'startsAt', 'endsAt')) return false;
  if (section === 'occurrences' && !orderedDates(attributes, 'startsAt', 'endsAt')) return false;
  if (section === 'ticket_types') {
    if (Number(attributes.minPerOrder) > Number(attributes.maxPerOrder)) return false;
    if (!orderedDates(attributes, 'salesStartAt', 'salesEndAt')) return false;
  }
  if (section === 'products' && !orderedDates(attributes, 'availableFrom', 'availableUntil'))
    return false;
  if (section === 'discounts') {
    if (!orderedDates(attributes, 'validFrom', 'validUntil')) return false;
    if (attributes.type === 'percentage' && Number(attributes.value) > 100) return false;
  }
  if (section === 'checkout_questions') {
    const options = attributes.options;
    if (
      options !== null &&
      options !== undefined &&
      (!Array.isArray(options) ||
        options.length > 100 ||
        options.some((item) => typeof item !== 'string' || !item.trim()))
    )
      return false;
    if (
      attributes.isConsentField === true &&
      (typeof attributes.consentText !== 'string' ||
        !attributes.consentText.trim() ||
        typeof attributes.consentVersion !== 'string' ||
        !attributes.consentVersion.trim())
    )
      return false;
  }
  if (section === 'content') {
    const versions = attributes.versions;
    if (!Array.isArray(versions)) return false;
    if (
      versions.some(
        (version) =>
          !plainObject(version) ||
          !Object.hasOwn(version, 'contentJson') ||
          !validatePortableContentDocument(attributes.channel, version.contentJson),
      )
    )
      return false;
  }
  return true;
}

function validate(section: PortableConfigurationSection, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<PortableLogicalRecord> & Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !['portableId', 'attributes', 'dependencies'].includes(key),
    ) ||
    !isPortableProtocolId(record.portableId) ||
    !record.attributes ||
    typeof record.attributes !== 'object' ||
    Array.isArray(record.attributes)
  )
    return false;
  const schema = schemas[section];
  const attributes = record.attributes as Record<string, unknown>;
  if (schema.required.some((key) => !(key in attributes))) return false;
  return (
    Object.entries(attributes).every(([key, fieldValue]) => {
      const type = (schema.attributes as Record<string, FieldType>)[key];
      return (
        type !== undefined &&
        matchesType(fieldValue, type) &&
        (type !== 'json' || validJsonField(section, key, fieldValue)) &&
        validDomainField(section, key, fieldValue)
      );
    }) && validCrossFields(section, attributes)
  );
}

export function createPortableConfigurationPayloadPolicies(): ReadonlyMap<
  PortableConfigurationSection,
  PortablePayloadSafetyPolicy
> {
  return new Map(
    PORTABLE_CONFIGURATION_SECTIONS.map((section) => {
      const schema = schemas[section];
      const schemaSha256 = createHash('sha256')
        .update(canonicalPortableJson({ schema, domainConstraints }))
        .digest('hex');
      const policySha256 = createHash('sha256')
        .update(
          canonicalPortableJson({
            schemaSha256,
            secretPolicy: 'tixkit-portable-secret-policy-v1',
            validator: domainConstraints.validator,
            crossFieldRules: [
              'date-order',
              'order-quantity',
              'percentage-upper-bound',
              'consent-completeness',
            ],
          }),
        )
        .digest('hex');
      const golden = goldenPolicy.sections[section];
      if (
        goldenPolicy.validatorVersion !== domainConstraints.validator ||
        goldenPolicy.secretPolicyVersion !== 'tixkit-portable-secret-policy-v1' ||
        !golden ||
        golden.schemaSha256 !== schemaSha256 ||
        golden.policySha256 !== policySha256
      ) {
        throw new Error(
          'portable configuration policy semantics changed without a versioned golden artifact',
        );
      }
      return [
        section,
        {
          schemaId: `tixkit_${section}_v1`,
          schemaSha256,
          policySha256,
          scannerId: 'tixkit_portable_scanner_v1',
          validateRecord: (candidateSection: PortableSection, record: unknown) =>
            candidateSection === section && validate(section, record),
        },
      ];
    }),
  );
}

export function portableConfigurationPolicyDigests(): Record<
  PortableConfigurationSection,
  { schemaSha256: string; policySha256: string }
> {
  return Object.fromEntries(
    PORTABLE_CONFIGURATION_SECTIONS.map((section) => {
      const schemaSha256 = createHash('sha256')
        .update(canonicalPortableJson({ schema: schemas[section], domainConstraints }))
        .digest('hex');
      const policySha256 = createHash('sha256')
        .update(
          canonicalPortableJson({
            schemaSha256,
            secretPolicy: 'tixkit-portable-secret-policy-v1',
            validator: domainConstraints.validator,
            crossFieldRules: [
              'date-order',
              'order-quantity',
              'percentage-upper-bound',
              'consent-completeness',
            ],
          }),
        )
        .digest('hex');
      return [section, { schemaSha256, policySha256 }];
    }),
  ) as Record<PortableConfigurationSection, { schemaSha256: string; policySha256: string }>;
}

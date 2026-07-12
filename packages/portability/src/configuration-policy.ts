import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
    new URL('../schemas/portable-configuration-policy-v1.json', import.meta.url),
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
  },
  urlPolicy: 'https-no-userinfo-no-credential-query-v1',
  validator: 'tixkit-portable-configuration-validator-v1',
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
  return false;
}

function validDomainField(
  section: PortableConfigurationSection,
  key: string,
  value: unknown,
): boolean {
  if (value === null) return true;
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

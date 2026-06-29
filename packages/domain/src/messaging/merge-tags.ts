/**
 * Safe merge-tag engine for email and SMS personalization (C-076 / C-077).
 *
 * Design goals:
 * - Whitelisted variable vocabulary only; unknown tags never render raw user data.
 * - Channel-aware escaping: HTML-escape for email, plain-text escape for SMS.
 * - Missing-variable fallbacks (never silently inject `undefined`/`null`).
 * - SMS-aware: GSM/Unicode segment counting, length guardrails, opt-out token injection.
 * - Deterministic: preview equals send when the same context is provided.
 * - Validation: unknown tags are reported so publish can block on them.
 *
 * This module is pure (no DB, no network) so it can run in the API preview path,
 * the notification workflow render activity, and the admin live preview.
 */

export type MergeTagVariable = {
  key: string;
  description: string;
  required?: boolean;
  example?: string;
};

export type MergeTagEventContext = {
  title?: string;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  venueName?: string;
  venueCity?: string;
  publicUrl?: string;
  checkoutUrl?: string;
};

export type MergeTagBrandContext = {
  name?: string;
  supportUrl?: string;
};

export type MergeTagRecipientContext = {
  name?: string;
  email?: string;
  phone?: string;
};

export type MergeTagAttendeeContext = {
  name?: string;
  checkedIn?: boolean;
};

export type MergeTagTicketContext = {
  type?: string;
  code?: string;
};

export type MergeTagOrderContext = {
  id?: string;
  total?: string;
};

export type MergeTagContext = {
  event?: MergeTagEventContext;
  brand?: MergeTagBrandContext;
  recipient?: MergeTagRecipientContext;
  attendee?: MergeTagAttendeeContext;
  ticket?: MergeTagTicketContext;
  order?: MergeTagOrderContext;
  refund?: { amount?: string };
  review?: { platform?: string };
  customAnswers?: Record<string, string>;
};

export type MergeTagChannel = 'email' | 'sms';

export type MergeTagRenderOptions = {
  channel: MergeTagChannel;
  /** Value substituted for missing optional variables. Defaults to ''. */
  fallback?: string;
  /** Behavior when a tag is not in the registry. Defaults to 'fallback'. */
  unknownTagBehavior?: 'fallback' | 'preserve' | 'error';
  /** SMS opt-out token/link appended for bulk/marketing messages. */
  optOutToken?: string;
  /**
   * Output escaping. Defaults to 'html' for email and 'plain' for SMS.
   * Use 'plain' for email subject/text parts that must not contain HTML entities.
   */
  escape?: 'html' | 'plain';
};

export type MergeTagValidationResult = {
  valid: boolean;
  unknownTags: string[];
  missingRequired: string[];
};

export const MERGE_TAG_REGISTRY: readonly MergeTagVariable[] = [
  { key: 'event.title', description: 'Event title', example: 'Summer Showcase' },
  { key: 'event.startsAt', description: 'Event start date/time', example: '2026-07-04 19:00' },
  { key: 'event.endsAt', description: 'Event end date/time', example: '2026-07-04 23:00' },
  { key: 'event.timezone', description: 'Event timezone', example: 'America/New_York' },
  { key: 'event.venueName', description: 'Venue name', example: 'The Grand Hall' },
  { key: 'event.venueCity', description: 'Venue city', example: 'Brooklyn' },
  {
    key: 'event.publicUrl',
    description: 'Public event page URL',
    example: 'https://example.test/e/evt_1',
  },
  {
    key: 'event.checkoutUrl',
    description: 'Hosted checkout URL',
    example: 'https://checkout.example.test/checkout?eventId=evt_1',
  },
  { key: 'brand.name', description: 'Brand/organizer name', example: 'Acme Events' },
  {
    key: 'brand.supportUrl',
    description: 'Brand support URL',
    example: 'https://help.example.test',
  },
  {
    key: 'recipient.name',
    description: 'Recipient display name',
    example: 'Jordan Lee',
    required: true,
  },
  {
    key: 'recipient.email',
    description: 'Recipient email address',
    example: 'jordan@example.test',
  },
  { key: 'recipient.phone', description: 'Recipient phone number', example: '+15551234567' },
  { key: 'attendee.name', description: 'Attendee name', example: 'Jordan Lee' },
  { key: 'attendee.checkedIn', description: 'Attendee check-in status', example: 'checked in' },
  { key: 'ticket.type', description: 'Ticket type name', example: 'General Admission' },
  { key: 'ticket.code', description: 'Ticket code', example: 'TKT-ABC123' },
  { key: 'order.id', description: 'Order reference', example: 'ORD-123' },
  { key: 'order.total', description: 'Order total (formatted)', example: '$45.00' },
  { key: 'refund.amount', description: 'Refund amount (formatted)', example: '$20.00' },
  { key: 'review.platform', description: 'Review platform name', example: 'Google' },
];

const REGISTRY_KEYS = new Set(MERGE_TAG_REGISTRY.map((v) => v.key));
const REQUIRED_KEYS = new Set(MERGE_TAG_REGISTRY.filter((v) => v.required).map((v) => v.key));

const TAG_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const CUSTOM_ANSWER_PATTERN = /^customAnswers\.([a-zA-Z0-9_-]+)$/;

export function htmlEscape(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function plainTextEscape(input: string): string {
  // SMS/plain text: strip control characters except common whitespace; keep it readable.
  // eslint-disable-next-line no-control-regex -- intentionally stripping control chars for SMS safety
  return input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function resolveTag(key: string, context: MergeTagContext): string | undefined {
  const customMatch = key.match(CUSTOM_ANSWER_PATTERN);
  if (customMatch) {
    return context.customAnswers?.[customMatch[1]];
  }
  switch (key) {
    case 'event.title':
      return context.event?.title;
    case 'event.startsAt':
      return context.event?.startsAt;
    case 'event.endsAt':
      return context.event?.endsAt;
    case 'event.timezone':
      return context.event?.timezone;
    case 'event.venueName':
      return context.event?.venueName;
    case 'event.venueCity':
      return context.event?.venueCity;
    case 'event.publicUrl':
      return context.event?.publicUrl;
    case 'event.checkoutUrl':
      return context.event?.checkoutUrl;
    case 'brand.name':
      return context.brand?.name;
    case 'brand.supportUrl':
      return context.brand?.supportUrl;
    case 'recipient.name':
      return context.recipient?.name;
    case 'recipient.email':
      return context.recipient?.email;
    case 'recipient.phone':
      return context.recipient?.phone;
    case 'attendee.name':
      return context.attendee?.name;
    case 'attendee.checkedIn':
      return context.attendee?.checkedIn === undefined
        ? undefined
        : context.attendee.checkedIn
          ? 'checked in'
          : 'not checked in';
    case 'ticket.type':
      return context.ticket?.type;
    case 'ticket.code':
      return context.ticket?.code;
    case 'order.id':
      return context.order?.id;
    case 'order.total':
      return context.order?.total;
    case 'refund.amount':
      return context.refund?.amount;
    case 'review.platform':
      return context.review?.platform;
    default:
      return undefined;
  }
}

export function listTemplateTags(template: string): string[] {
  const tags: string[] = [];
  for (const match of template.matchAll(TAG_PATTERN)) {
    tags.push(match[1]);
  }
  return [...new Set(tags)];
}

export function validateMergeTags(template: string): MergeTagValidationResult {
  const tags = listTemplateTags(template);
  const unknownTags: string[] = [];
  const missingRequired: string[] = [];
  for (const tag of tags) {
    const isCustom = CUSTOM_ANSWER_PATTERN.test(tag);
    if (!isCustom && !REGISTRY_KEYS.has(tag)) {
      unknownTags.push(tag);
    }
  }
  for (const required of REQUIRED_KEYS) {
    if (!tags.includes(required)) {
      missingRequired.push(required);
    }
  }
  return { valid: unknownTags.length === 0, unknownTags, missingRequired };
}

export function renderMergeTags(
  template: string,
  context: MergeTagContext,
  options: MergeTagRenderOptions,
): string {
  const fallback = options.fallback ?? '';
  const unknownBehavior = options.unknownTagBehavior ?? 'fallback';
  const escapeMode = options.escape ?? (options.channel === 'email' ? 'html' : 'plain');
  const escape = escapeMode === 'html' ? htmlEscape : plainTextEscape;

  const rendered = template.replace(TAG_PATTERN, (match, rawKey: string) => {
    const key = rawKey.trim();
    const isKnown = REGISTRY_KEYS.has(key) || CUSTOM_ANSWER_PATTERN.test(key);
    if (!isKnown) {
      if (unknownBehavior === 'preserve') return match;
      if (unknownBehavior === 'error') {
        throw new MergeTagError(`Unknown merge tag: {{${key}}}`, key);
      }
      return fallback;
    }
    const value = resolveTag(key, context);
    if (value === undefined || value === null) return fallback;
    return escape(String(value));
  });

  if (options.channel === 'sms' && options.optOutToken) {
    return injectOptOutToken(rendered, options.optOutToken);
  }
  return rendered;
}

export class MergeTagError extends Error {
  readonly tag: string;
  constructor(message: string, tag: string) {
    super(message);
    this.name = 'MergeTagError';
    this.tag = tag;
  }
}

/**
 * Append or inject an opt-out token for SMS marketing/bulk messages.
 * If the body already contains the token, it is not duplicated.
 */
export function injectOptOutToken(body: string, token: string): string {
  const trimmed = body.trimEnd();
  if (trimmed.includes(token)) return body;
  const separator = trimmed.endsWith('.') || trimmed.endsWith('!') ? ' ' : '. ';
  return `${trimmed}${separator}${token}`;
}

// ---- SMS segment accounting (GSM 7-bit vs UCS-2) ----

// Basic GSM 7-bit character set (without extension table).
const GSM_BASIC_CHARS = new Set(
  '@£$¥èéùìòÇ\nØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'.split(
    '',
  ),
);
// GSM extension table characters count as 2 code units.
const GSM_EXTENSION_CHARS = new Set('^{}\\[~]|€'.split(''));

export function detectEncoding(body: string): 'gsm' | 'unicode' {
  for (const char of body) {
    if (!GSM_BASIC_CHARS.has(char) && !GSM_EXTENSION_CHARS.has(char)) {
      return 'unicode';
    }
  }
  return 'gsm';
}

export function gsmCharUnits(char: string): number {
  if (GSM_EXTENSION_CHARS.has(char)) return 2;
  return 1;
}

export type SmsSegmentResult = {
  segments: number;
  encoding: 'gsm' | 'unicode';
  charsPerSegment: number;
  unitsUsed: number;
  remaining: number;
};

export function countSmsSegments(body: string): SmsSegmentResult {
  const encoding = detectEncoding(body);
  if (encoding === 'unicode') {
    // UCS-2 counts 16-bit code units; surrogate pairs (e.g. emoji) count as 2.
    const units = body.length;
    const singleLimit = 70;
    const multiLimit = 67;
    if (units <= singleLimit) {
      return {
        segments: 1,
        encoding,
        charsPerSegment: singleLimit,
        unitsUsed: units,
        remaining: singleLimit - units,
      };
    }
    const segments = Math.ceil(units / multiLimit);
    return {
      segments,
      encoding,
      charsPerSegment: multiLimit,
      unitsUsed: units,
      remaining: segments * multiLimit - units,
    };
  }
  let units = 0;
  for (const char of body) units += gsmCharUnits(char);
  const singleLimit = 160;
  const multiLimit = 153;
  if (units <= singleLimit) {
    return {
      segments: 1,
      encoding,
      charsPerSegment: singleLimit,
      unitsUsed: units,
      remaining: singleLimit - units,
    };
  }
  const segments = Math.ceil(units / multiLimit);
  return {
    segments,
    encoding,
    charsPerSegment: multiLimit,
    unitsUsed: units,
    remaining: segments * multiLimit - units,
  };
}

/** Estimated cost for a body given a per-segment cost. */
export function estimateSmsCost(body: string, costPerSegment: number): number {
  return countSmsSegments(body).segments * costPerSegment;
}

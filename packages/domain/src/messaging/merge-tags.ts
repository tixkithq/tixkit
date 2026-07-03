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
  doorTime?: string;
  mapUrl?: string;
  refundPolicyUrl?: string;
  changeSummary?: string;
  cancellationReason?: string;
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
  qrCodeUrl?: string;
  pdfUrl?: string;
  walletAppleUrl?: string;
  walletGoogleUrl?: string;
  transferUrl?: string;
};

export type MergeTagOrderContext = {
  id?: string;
  total?: string;
  manageUrl?: string;
  receiptUrl?: string;
  retryUrl?: string;
  cancellationReason?: string;
  creditStatus?: string;
  buyerName?: string;
  buyerEmail?: string;
};

export type MergeTagRefundContext = {
  amount?: string;
  processingEta?: string;
  processedAt?: string;
};

export type MergeTagDeviceContext = {
  inviteUrl?: string;
  permissionScope?: string;
  expiresAt?: string;
};

export type MergeTagDashboardContext = {
  url?: string;
};

export type MergeTagWaitlistContext = {
  position?: string;
  inviteUrl?: string;
  expiresAt?: string;
};

export type MergeTagChargebackContext = {
  id?: string;
  amount?: string;
  dueAt?: string;
  evidenceUrl?: string;
};

export type MergeTagPayoutContext = {
  amount?: string;
  eta?: string;
  account?: string;
  period?: string;
};

export type MergeTagWebhookContext = {
  endpointUrl?: string;
  attempts?: string;
};

export type MergeTagIntegrationContext = {
  name?: string;
  reconnectUrl?: string;
};

export type MergeTagSalesDigestContext = {
  revenue?: string;
  orders?: string;
  topTicketType?: string;
};

export type MergeTagContext = {
  event?: MergeTagEventContext;
  brand?: MergeTagBrandContext;
  recipient?: MergeTagRecipientContext;
  attendee?: MergeTagAttendeeContext;
  ticket?: MergeTagTicketContext;
  order?: MergeTagOrderContext;
  refund?: MergeTagRefundContext;
  review?: { platform?: string };
  device?: MergeTagDeviceContext;
  dashboard?: MergeTagDashboardContext;
  waitlist?: MergeTagWaitlistContext;
  chargeback?: MergeTagChargebackContext;
  payout?: MergeTagPayoutContext;
  webhook?: MergeTagWebhookContext;
  integration?: MergeTagIntegrationContext;
  salesDigest?: MergeTagSalesDigestContext;
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
  {
    key: 'ticket.qrCodeUrl',
    description: 'Ticket QR code image URL',
    example: 'https://tickets.example.test/qr/TKT-ABC123.png',
  },
  { key: 'order.id', description: 'Order reference', example: 'ORD-123' },
  { key: 'order.total', description: 'Order total (formatted)', example: '$45.00' },
  { key: 'refund.amount', description: 'Refund amount (formatted)', example: '$20.00' },
  { key: 'review.platform', description: 'Review platform name', example: 'Google' },
  // Event lifecycle (P0 template gaps closed)
  { key: 'event.doorTime', description: 'Event door/opening time', example: '2026-07-04 18:00' },
  {
    key: 'event.mapUrl',
    description: 'Venue map URL',
    example: 'https://maps.example.test/venue',
  },
  {
    key: 'event.refundPolicyUrl',
    description: 'Event refund policy URL',
    example: 'https://help.example.test/refunds',
  },
  {
    key: 'event.changeSummary',
    description: 'Summary of what changed for an event update',
    example: 'Venue moved from The Grand Hall to The Forum',
  },
  {
    key: 'event.cancellationReason',
    description: 'Reason an event was cancelled',
    example: 'Unforeseen weather conditions',
  },
  // Order lifecycle (P0 template gaps closed)
  {
    key: 'order.manageUrl',
    description: 'Buyer order management URL',
    example: 'https://checkout.example.test/orders/ord_123',
  },
  {
    key: 'order.receiptUrl',
    description: 'Order receipt URL',
    example: 'https://checkout.example.test/receipts/ord_123',
  },
  {
    key: 'order.retryUrl',
    description: 'Checkout retry URL after a failed payment',
    example: 'https://checkout.example.test/checkout?eventId=evt_1&retry=ord_123',
  },
  {
    key: 'order.cancellationReason',
    description: 'Reason an order was cancelled',
    example: 'Cancelled by organizer before event',
  },
  {
    key: 'order.creditStatus',
    description: 'Credit/refund status after a cancellation',
    example: 'Full credit issued',
  },
  { key: 'order.buyerName', description: 'Buyer display name', example: 'Jordan Lee' },
  { key: 'order.buyerEmail', description: 'Buyer email address', example: 'jordan@example.test' },
  // Ticket lifecycle (P0 template gaps closed)
  {
    key: 'ticket.pdfUrl',
    description: 'Ticket PDF download URL',
    example: 'https://tickets.example.test/pdf/TKT-ABC123.pdf',
  },
  {
    key: 'ticket.walletAppleUrl',
    description: 'Apple Wallet pass add URL',
    example: 'https://tickets.example.test/pass/apple/TKT-ABC123.pkpass',
  },
  {
    key: 'ticket.walletGoogleUrl',
    description: 'Google Wallet pass save URL',
    example: 'https://pay.google.com/gp/v/save/abc123',
  },
  // Refund lifecycle (P0 template gaps closed)
  {
    key: 'refund.processingEta',
    description: 'Refund processing estimate',
    example: '5-10 business days',
  },
  {
    key: 'refund.processedAt',
    description: 'Refund processed date/time',
    example: '2026-07-10 12:00',
  },
  // Staff / device lifecycle (P0 template gaps closed)
  {
    key: 'device.inviteUrl',
    description: 'Check-in device invite URL',
    example: 'https://scan.example.test/invite/dev_123',
  },
  { key: 'device.permissionScope', description: 'Scanner permission scope', example: 'checkins.write' },
  {
    key: 'device.expiresAt',
    description: 'Device invite expiration',
    example: '2026-07-04 19:00',
  },
  {
    key: 'dashboard.url',
    description: 'Admin dashboard URL',
    example: 'https://admin.example.test/events/evt_1',
  },
  // P1/P2 lifecycle variables (C-104)
  {
    key: 'ticket.transferUrl',
    description: 'Ticket transfer claim URL',
    example: 'https://checkout.example.test/transfer/tkt_1/claim',
  },
  { key: 'waitlist.position', description: 'Waitlist queue position', example: '12' },
  {
    key: 'waitlist.inviteUrl',
    description: 'Private waitlist purchase URL',
    example: 'https://checkout.example.test/waitlist/claim/abc',
  },
  {
    key: 'waitlist.expiresAt',
    description: 'Waitlist hold expiration',
    example: '2026-07-04 19:00',
  },
  { key: 'chargeback.id', description: 'Chargeback dispute reference', example: 'dp_1' },
  {
    key: 'chargeback.amount',
    description: 'Disputed amount (formatted)',
    example: '$45.00',
  },
  {
    key: 'chargeback.dueAt',
    description: 'Chargeback evidence due date',
    example: '2026-07-18',
  },
  {
    key: 'chargeback.evidenceUrl',
    description: 'Chargeback evidence submission URL',
    example: 'https://admin.example.test/disputes/dp_1',
  },
  { key: 'payout.amount', description: 'Payout amount (formatted)', example: '$1,250.00' },
  { key: 'payout.eta', description: 'Payout arrival estimate', example: '2-3 business days' },
  { key: 'payout.account', description: 'Payout account label', example: 'Bank ••••4242' },
  {
    key: 'payout.period',
    description: 'Payout reporting period',
    example: 'June 2026',
  },
  {
    key: 'webhook.endpointUrl',
    description: 'Failing webhook endpoint URL',
    example: 'https://hooks.example.test/integrations/stripe',
  },
  { key: 'webhook.attempts', description: 'Webhook delivery attempts', example: '5' },
  { key: 'integration.name', description: 'Integration name', example: 'Stripe' },
  {
    key: 'integration.reconnectUrl',
    description: 'Integration reconnect URL',
    example: 'https://admin.example.test/integrations/stripe/reconnect',
  },
  { key: 'salesDigest.revenue', description: 'Daily sales revenue (formatted)', example: '$4,320.00' },
  { key: 'salesDigest.orders', description: 'Daily order count', example: '38' },
  {
    key: 'salesDigest.topTicketType',
    description: 'Top-selling ticket type',
    example: 'General Admission',
  },
];

const REGISTRY_KEYS = new Set(MERGE_TAG_REGISTRY.map((v) => v.key));
const REQUIRED_KEYS = new Set(MERGE_TAG_REGISTRY.filter((v) => v.required).map((v) => v.key));

const TAG_PATTERN =
  /\{\{\s*((?:customAnswers\.[a-zA-Z0-9_-]+)|(?:[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*))\s*\}\}/g;
const CUSTOM_ANSWER_PATTERN = /^customAnswers\.([a-zA-Z0-9_-]+)$/;
const URL_TAG_KEYS = new Set([
  'event.publicUrl',
  'event.checkoutUrl',
  'event.mapUrl',
  'event.refundPolicyUrl',
  'brand.supportUrl',
  'ticket.qrCodeUrl',
  'ticket.pdfUrl',
  'ticket.walletAppleUrl',
  'ticket.walletGoogleUrl',
  'order.manageUrl',
  'order.receiptUrl',
  'order.retryUrl',
  'device.inviteUrl',
  'dashboard.url',
  'ticket.transferUrl',
  'waitlist.inviteUrl',
  'chargeback.evidenceUrl',
  'webhook.endpointUrl',
  'integration.reconnectUrl',
]);

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

function isSafeUrlValue(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
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
    case 'ticket.qrCodeUrl':
      return context.ticket?.qrCodeUrl;
    case 'order.id':
      return context.order?.id;
    case 'order.total':
      return context.order?.total;
    case 'refund.amount':
      return context.refund?.amount;
    case 'refund.processingEta':
      return context.refund?.processingEta;
    case 'refund.processedAt':
      return context.refund?.processedAt;
    case 'review.platform':
      return context.review?.platform;
    case 'event.doorTime':
      return context.event?.doorTime;
    case 'event.mapUrl':
      return context.event?.mapUrl;
    case 'event.refundPolicyUrl':
      return context.event?.refundPolicyUrl;
    case 'event.changeSummary':
      return context.event?.changeSummary;
    case 'event.cancellationReason':
      return context.event?.cancellationReason;
    case 'order.manageUrl':
      return context.order?.manageUrl;
    case 'order.receiptUrl':
      return context.order?.receiptUrl;
    case 'order.retryUrl':
      return context.order?.retryUrl;
    case 'order.cancellationReason':
      return context.order?.cancellationReason;
    case 'order.creditStatus':
      return context.order?.creditStatus;
    case 'order.buyerName':
      return context.order?.buyerName;
    case 'order.buyerEmail':
      return context.order?.buyerEmail;
    case 'ticket.pdfUrl':
      return context.ticket?.pdfUrl;
    case 'ticket.walletAppleUrl':
      return context.ticket?.walletAppleUrl;
    case 'ticket.walletGoogleUrl':
      return context.ticket?.walletGoogleUrl;
    case 'device.inviteUrl':
      return context.device?.inviteUrl;
    case 'device.permissionScope':
      return context.device?.permissionScope;
    case 'device.expiresAt':
      return context.device?.expiresAt;
    case 'dashboard.url':
      return context.dashboard?.url;
    case 'ticket.transferUrl':
      return context.ticket?.transferUrl;
    case 'waitlist.position':
      return context.waitlist?.position;
    case 'waitlist.inviteUrl':
      return context.waitlist?.inviteUrl;
    case 'waitlist.expiresAt':
      return context.waitlist?.expiresAt;
    case 'chargeback.id':
      return context.chargeback?.id;
    case 'chargeback.amount':
      return context.chargeback?.amount;
    case 'chargeback.dueAt':
      return context.chargeback?.dueAt;
    case 'chargeback.evidenceUrl':
      return context.chargeback?.evidenceUrl;
    case 'payout.amount':
      return context.payout?.amount;
    case 'payout.eta':
      return context.payout?.eta;
    case 'payout.account':
      return context.payout?.account;
    case 'payout.period':
      return context.payout?.period;
    case 'webhook.endpointUrl':
      return context.webhook?.endpointUrl;
    case 'webhook.attempts':
      return context.webhook?.attempts;
    case 'integration.name':
      return context.integration?.name;
    case 'integration.reconnectUrl':
      return context.integration?.reconnectUrl;
    case 'salesDigest.revenue':
      return context.salesDigest?.revenue;
    case 'salesDigest.orders':
      return context.salesDigest?.orders;
    case 'salesDigest.topTicketType':
      return context.salesDigest?.topTicketType;
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
  return {
    valid: unknownTags.length === 0 && missingRequired.length === 0,
    unknownTags,
    missingRequired,
  };
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
  const escapedFallback = escape(fallback);

  const rendered = template.replace(TAG_PATTERN, (match, rawKey: string) => {
    const key = rawKey.trim();
    const isKnown = REGISTRY_KEYS.has(key) || CUSTOM_ANSWER_PATTERN.test(key);
    if (!isKnown) {
      if (unknownBehavior === 'preserve') return match;
      if (unknownBehavior === 'error') {
        throw new MergeTagError(`Unknown merge tag: {{${key}}}`, key);
      }
      return escapedFallback;
    }
    const value = resolveTag(key, context);
    if (value === undefined || value === null) return escapedFallback;
    const resolved = String(value);
    if (URL_TAG_KEYS.has(key) && !isSafeUrlValue(resolved)) return escapedFallback;
    return escape(resolved);
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

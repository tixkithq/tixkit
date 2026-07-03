/**
 * Email template lifecycle registry.
 *
 * Source of truth: docs/email-template-lifecycle.md. This module gives the
 * `TemplateKey` union a runtime home and records family/category/audience,
 * required merge-tag variables, compliance behavior, and default subject
 * labels for every P0 lifecycle email. P1/P2 keys are documented in the spec
 * and will be added in later slices once seeding/merge-tag infrastructure
 * exists for them.
 *
 * P0 content defaults (blocks, sender, editor HTML) are intentionally NOT
 * defined here. Those belong to `@tixkit/content-email` as seeded editable
 * content documents (Phase 2) so the lifecycle metadata stays free of the
 * React Email block types and avoids a domain -> content-email dependency
 * cycle.
 */

export const TEMPLATE_KEYS = [
  // P0 — ticketing-critical
  'order-confirmed',
  'tickets-issued',
  'payment-failed',
  'order-cancelled',
  'order-refunded',
  'event-updated',
  'event-cancelled',
  'event-reminder',
  'attendee-message',
  'staff-order-notification',
  'checkin-device-invited',
  // P1 — competitor parity and growth
  'waitlist-joined',
  'waitlist-invite',
  'waitlist-invite-expiring',
  'abandoned-checkout',
  'ticket-transfer-started',
  'ticket-transfer-accepted',
  'ticket-transfer-cancelled',
  'wallet-pass-ready',
  'post-event-thank-you',
  'review-request',
  'daily-sales-digest',
  // P2 — managed/cloud/pro polish
  'payout-scheduled',
  'payout-paid',
  'payout-failed',
  'brand-sender-verification',
  'integration-disconnected',
  'webhook-failed',
  'chargeback-opened',
  'chargeback-won',
  'chargeback-lost',
] as const;

export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

export const P0_TEMPLATE_KEYS: readonly TemplateKey[] = [
  'order-confirmed',
  'tickets-issued',
  'payment-failed',
  'order-cancelled',
  'order-refunded',
  'event-updated',
  'event-cancelled',
  'event-reminder',
  'attendee-message',
  'staff-order-notification',
  'checkin-device-invited',
];

export const P1_TEMPLATE_KEYS: readonly TemplateKey[] = [
  'waitlist-joined',
  'waitlist-invite',
  'waitlist-invite-expiring',
  'abandoned-checkout',
  'ticket-transfer-started',
  'ticket-transfer-accepted',
  'ticket-transfer-cancelled',
  'wallet-pass-ready',
  'post-event-thank-you',
  'review-request',
  'daily-sales-digest',
];

export const P2_TEMPLATE_KEYS: readonly TemplateKey[] = [
  'payout-scheduled',
  'payout-paid',
  'payout-failed',
  'brand-sender-verification',
  'integration-disconnected',
  'webhook-failed',
  'chargeback-opened',
  'chargeback-won',
  'chargeback-lost',
];

export type TemplateFamily =
  | 'marketing'
  | 'checkout'
  | 'ticket'
  | 'event_update'
  | 'refund'
  | 'checkin'
  | 'post_event'
  | 'organizer_admin'
  | 'compliance'
  | 'waitlist'
  | 'reporting'
  | 'payout'
  | 'deliverability'
  | 'integration'
  | 'dispute';

export type TemplateCategory = 'transactional' | 'bulk' | 'staff' | 'system';

export type TemplateLifecycleTier = 'P0' | 'P1' | 'P2';

export type TemplateLifecycleCompliance = {
  requiresUnsubscribe: boolean;
  requiresConsent: boolean;
  bypassesMarketingOptOut: boolean;
  auditLog: boolean;
};

export type TemplateLifecycle = {
  key: TemplateKey;
  name: string;
  family: TemplateFamily;
  category: TemplateCategory;
  tier: TemplateLifecycleTier;
  trigger: string;
  defaultAudience:
    | 'buyer'
    | 'attendee'
    | 'organizer'
    | 'staff'
    | 'developer'
    | 'transfer_recipient'
    | 'custom';
  requiredVariables: string[];
  optionalVariables: string[];
  /**
   * Variables the lifecycle email needs but which are not yet present in the
   * merge-tag registry. Tracked explicitly so Phase 2 can close gaps before
   * seeding content defaults; requiredVariables only contains known tags.
   */
  variableGaps: string[];
  defaultSubject: string;
  defaultPreviewText?: string;
  compliance: TemplateLifecycleCompliance;
};

/**
 * Compliance matrix from docs/email-template-lifecycle.md.
 *
 * Transactional ticket/order/service emails bypass marketing opt-out but still
 * run suppression + audit checks. Bulk/marketing emails require consent and an
 * unsubscribe footer. Staff/system emails are relationship/account-scoped and do
 * not require marketing consent or unsubscribe.
 */
export function complianceForCategory(
  category: TemplateCategory,
): TemplateLifecycleCompliance {
  if (category === 'bulk') {
    return {
      requiresUnsubscribe: true,
      requiresConsent: true,
      bypassesMarketingOptOut: false,
      auditLog: true,
    };
  }
  return {
    requiresUnsubscribe: false,
    requiresConsent: false,
    bypassesMarketingOptOut: true,
    auditLog: true,
  };
}

const transactional = complianceForCategory('transactional');
const bulk = complianceForCategory('bulk');
const staff = complianceForCategory('staff');
const system = complianceForCategory('system');

export const TEMPLATE_LIFECYCLES: readonly TemplateLifecycle[] = [
  {
    key: 'order-confirmed',
    name: 'Order confirmed',
    family: 'checkout',
    category: 'transactional',
    tier: 'P0',
    trigger: 'Payment succeeds or a free order is created',
    defaultAudience: 'buyer',
    requiredVariables: ['recipient.name', 'event.title', 'order.id', 'order.total'],
    optionalVariables: [
      'event.startsAt',
      'event.venueName',
      'event.venueCity',
      'event.publicUrl',
      'brand.name',
      'order.manageUrl',
      'order.receiptUrl',
    ],
    variableGaps: [],
    defaultSubject: 'Your {{event.title}} order is confirmed',
    defaultPreviewText: 'Receipt and order details inside.',
    compliance: transactional,
  },
  {
    key: 'tickets-issued',
    name: 'Tickets issued',
    family: 'ticket',
    category: 'transactional',
    tier: 'P0',
    trigger: 'Ticket artifacts are generated',
    defaultAudience: 'buyer',
    requiredVariables: [
      'recipient.name',
      'event.title',
      'ticket.type',
      'ticket.code',
      'ticket.qrCodeUrl',
    ],
    optionalVariables: [
      'event.startsAt',
      'event.venueName',
      'event.venueCity',
      'order.id',
      'order.total',
      'ticket.pdfUrl',
      'ticket.walletAppleUrl',
      'ticket.walletGoogleUrl',
    ],
    variableGaps: [],
    defaultSubject: 'Your {{event.title}} tickets are ready',
    defaultPreviewText: 'Everything you need before arrival.',
    compliance: transactional,
  },
  {
    key: 'payment-failed',
    name: 'Payment failed',
    family: 'checkout',
    category: 'transactional',
    tier: 'P0',
    trigger: 'A payment attempt fails',
    defaultAudience: 'buyer',
    requiredVariables: ['recipient.name', 'event.title', 'order.id', 'brand.supportUrl'],
    optionalVariables: ['event.checkoutUrl', 'order.total', 'order.retryUrl'],
    variableGaps: [],
    defaultSubject: 'Payment could not be completed for {{event.title}}',
    defaultPreviewText: 'Retry your order before it expires.',
    compliance: transactional,
  },
  {
    key: 'order-cancelled',
    name: 'Order cancelled',
    family: 'checkout',
    category: 'transactional',
    tier: 'P0',
    trigger: 'An order is cancelled before the event',
    defaultAudience: 'buyer',
    requiredVariables: ['recipient.name', 'event.title', 'order.id'],
    optionalVariables: [
      'order.total',
      'brand.supportUrl',
      'event.publicUrl',
      'order.cancellationReason',
      'order.creditStatus',
    ],
    variableGaps: [],
    defaultSubject: 'Your {{event.title}} order was cancelled',
    compliance: transactional,
  },
  {
    key: 'order-refunded',
    name: 'Order refunded',
    family: 'refund',
    category: 'transactional',
    tier: 'P0',
    trigger: 'A refund is issued to the processor',
    defaultAudience: 'buyer',
    requiredVariables: ['recipient.name', 'order.id', 'refund.amount'],
    optionalVariables: [
      'event.title',
      'order.total',
      'brand.supportUrl',
      'refund.processingEta',
      'refund.processedAt',
    ],
    variableGaps: [],
    defaultSubject: 'Refund issued for your {{event.title}} order',
    compliance: transactional,
  },
  {
    key: 'event-updated',
    name: 'Event updated',
    family: 'event_update',
    category: 'transactional',
    tier: 'P0',
    trigger: 'Important non-critical event details change',
    defaultAudience: 'attendee',
    requiredVariables: ['recipient.name', 'event.title'],
    optionalVariables: [
      'event.startsAt',
      'event.venueName',
      'event.venueCity',
      'event.publicUrl',
      'brand.supportUrl',
      'event.changeSummary',
    ],
    variableGaps: [],
    defaultSubject: 'Important update for {{event.title}}',
    compliance: transactional,
  },
  {
    key: 'event-cancelled',
    name: 'Event cancelled',
    family: 'event_update',
    category: 'transactional',
    tier: 'P0',
    trigger: 'An event is cancelled',
    defaultAudience: 'attendee',
    requiredVariables: ['recipient.name', 'event.title'],
    optionalVariables: [
      'event.publicUrl',
      'brand.supportUrl',
      'event.cancellationReason',
      'event.refundPolicyUrl',
    ],
    variableGaps: [],
    defaultSubject: '{{event.title}} has been cancelled',
    compliance: transactional,
  },
  {
    key: 'event-reminder',
    name: 'Event reminder',
    family: 'event_update',
    category: 'transactional',
    tier: 'P0',
    trigger: 'Scheduled reminder before the event',
    defaultAudience: 'attendee',
    requiredVariables: ['recipient.name', 'event.title', 'event.startsAt', 'event.venueName'],
    optionalVariables: [
      'event.venueCity',
      'event.timezone',
      'event.publicUrl',
      'ticket.qrCodeUrl',
      'ticket.code',
      'event.doorTime',
      'event.mapUrl',
    ],
    variableGaps: [],
    defaultSubject: 'Reminder: {{event.title}} is almost here',
    defaultPreviewText: 'Date, venue, and your ticket inside.',
    compliance: transactional,
  },
  {
    key: 'attendee-message',
    name: 'Attendee message',
    family: 'marketing',
    category: 'bulk',
    tier: 'P0',
    trigger: 'Organizer sends a freeform broadcast to selected attendees',
    defaultAudience: 'attendee',
    requiredVariables: ['recipient.name', 'event.title'],
    optionalVariables: ['brand.name', 'brand.supportUrl'],
    variableGaps: [],
    defaultSubject: 'Message from the {{event.title}} organizer',
    compliance: bulk,
  },
  {
    key: 'staff-order-notification',
    name: 'Staff order notification',
    family: 'checkin',
    category: 'staff',
    tier: 'P0',
    trigger: 'A new order or important order event occurs',
    defaultAudience: 'staff',
    requiredVariables: ['recipient.name', 'event.title', 'order.id'],
    optionalVariables: ['order.total', 'ticket.type', 'dashboard.url', 'order.buyerName'],
    variableGaps: [],
    defaultSubject: 'New order for {{event.title}}',
    compliance: staff,
  },
  {
    key: 'checkin-device-invited',
    name: 'Check-in device invited',
    family: 'checkin',
    category: 'staff',
    tier: 'P0',
    trigger: 'Staff invited to a scanner or check-in device',
    defaultAudience: 'staff',
    requiredVariables: ['recipient.name', 'event.title'],
    optionalVariables: [
      'brand.name',
      'device.inviteUrl',
      'device.permissionScope',
      'device.expiresAt',
    ],
    variableGaps: [],
    defaultSubject: "You're invited to scan for {{event.title}}",
    compliance: staff,
  },
  // ---- P1: competitor parity and growth ----
  {
    key: 'waitlist-joined',
    name: 'Waitlist joined',
    family: 'waitlist',
    category: 'transactional',
    tier: 'P1',
    trigger: 'A buyer joins a waitlist',
    defaultAudience: 'buyer',
    requiredVariables: ['recipient.name', 'event.title'],
    optionalVariables: ['event.startsAt', 'event.venueName', 'brand.name', 'waitlist.position'],
    variableGaps: [],
    defaultSubject: "You're on the waitlist for {{event.title}}",
    compliance: transactional,
  },
  {
    key: 'waitlist-invite',
    name: 'Waitlist invite',
    family: 'waitlist',
    category: 'transactional',
    tier: 'P1',
    trigger: 'A waitlisted ticket becomes available',
    defaultAudience: 'buyer',
    requiredVariables: ['recipient.name', 'event.title', 'waitlist.inviteUrl'],
    optionalVariables: ['waitlist.expiresAt', 'ticket.type', 'event.checkoutUrl'],
    variableGaps: [],
    defaultSubject: 'Tickets are available for {{event.title}}',
    defaultPreviewText: 'Claim your spot before the offer expires.',
    compliance: transactional,
  },
  {
    key: 'waitlist-invite-expiring',
    name: 'Waitlist invite expiring',
    family: 'waitlist',
    category: 'transactional',
    tier: 'P1',
    trigger: 'A waitlist hold is about to expire',
    defaultAudience: 'buyer',
    requiredVariables: ['recipient.name', 'event.title', 'waitlist.inviteUrl', 'waitlist.expiresAt'],
    optionalVariables: ['event.checkoutUrl'],
    variableGaps: [],
    defaultSubject: 'Your waitlist offer for {{event.title}} is expiring',
    compliance: transactional,
  },
  {
    key: 'abandoned-checkout',
    name: 'Abandoned checkout',
    family: 'checkout',
    category: 'bulk',
    tier: 'P1',
    trigger: 'A checkout is started but not completed',
    defaultAudience: 'buyer',
    requiredVariables: ['recipient.name', 'event.title', 'event.checkoutUrl'],
    optionalVariables: ['order.total', 'order.id'],
    variableGaps: [],
    defaultSubject: 'Finish your {{event.title}} order',
    defaultPreviewText: 'Your tickets are still waiting.',
    compliance: bulk,
  },
  {
    key: 'ticket-transfer-started',
    name: 'Ticket transfer started',
    family: 'ticket',
    category: 'transactional',
    tier: 'P1',
    trigger: 'A holder transfers a ticket to a recipient',
    defaultAudience: 'transfer_recipient',
    requiredVariables: ['recipient.name', 'event.title', 'ticket.transferUrl', 'ticket.code'],
    optionalVariables: ['ticket.type', 'event.startsAt', 'event.venueName'],
    variableGaps: [],
    defaultSubject: 'A ticket for {{event.title}} is waiting for you',
    compliance: transactional,
  },
  {
    key: 'ticket-transfer-accepted',
    name: 'Ticket transfer accepted',
    family: 'ticket',
    category: 'transactional',
    tier: 'P1',
    trigger: 'A transfer recipient accepts the ticket',
    defaultAudience: 'buyer',
    requiredVariables: ['recipient.name', 'event.title', 'ticket.code'],
    optionalVariables: ['ticket.type'],
    variableGaps: [],
    defaultSubject: 'Ticket transfer accepted for {{event.title}}',
    compliance: transactional,
  },
  {
    key: 'ticket-transfer-cancelled',
    name: 'Ticket transfer cancelled',
    family: 'ticket',
    category: 'transactional',
    tier: 'P1',
    trigger: 'A ticket transfer is cancelled',
    defaultAudience: 'transfer_recipient',
    requiredVariables: ['recipient.name', 'event.title', 'ticket.code'],
    optionalVariables: ['brand.supportUrl'],
    variableGaps: [],
    defaultSubject: 'Ticket transfer cancelled for {{event.title}}',
    compliance: transactional,
  },
  {
    key: 'wallet-pass-ready',
    name: 'Wallet pass ready',
    family: 'ticket',
    category: 'transactional',
    tier: 'P1',
    trigger: 'An Apple/Google wallet pass is generated',
    defaultAudience: 'buyer',
    requiredVariables: ['recipient.name', 'event.title', 'ticket.code'],
    optionalVariables: ['ticket.walletAppleUrl', 'ticket.walletGoogleUrl', 'ticket.qrCodeUrl'],
    variableGaps: [],
    defaultSubject: 'Your wallet pass for {{event.title}} is ready',
    compliance: transactional,
  },
  {
    key: 'post-event-thank-you',
    name: 'Post-event thank you',
    family: 'post_event',
    category: 'bulk',
    tier: 'P1',
    trigger: 'An event ends',
    defaultAudience: 'attendee',
    requiredVariables: ['recipient.name', 'event.title'],
    optionalVariables: ['event.publicUrl', 'brand.name'],
    variableGaps: [],
    defaultSubject: 'Thanks for joining {{event.title}}',
    compliance: bulk,
  },
  {
    key: 'review-request',
    name: 'Review request',
    family: 'post_event',
    category: 'bulk',
    tier: 'P1',
    trigger: 'After an event, ask attendees for a review',
    defaultAudience: 'attendee',
    requiredVariables: ['recipient.name', 'event.title', 'review.platform'],
    optionalVariables: ['event.publicUrl'],
    variableGaps: [],
    defaultSubject: 'Share your review of {{event.title}}',
    compliance: bulk,
  },
  {
    key: 'daily-sales-digest',
    name: 'Daily sales digest',
    family: 'reporting',
    category: 'system',
    tier: 'P1',
    trigger: 'Daily scheduled sales summary',
    defaultAudience: 'organizer',
    requiredVariables: ['dashboard.url'],
    optionalVariables: [
      'event.title',
      'salesDigest.revenue',
      'salesDigest.orders',
      'salesDigest.topTicketType',
    ],
    variableGaps: [],
    defaultSubject: 'Daily sales digest',
    compliance: system,
  },
  // ---- P2: managed/cloud/pro polish ----
  {
    key: 'payout-scheduled',
    name: 'Payout scheduled',
    family: 'payout',
    category: 'system',
    tier: 'P2',
    trigger: 'A payout is scheduled',
    defaultAudience: 'organizer',
    requiredVariables: ['payout.amount'],
    optionalVariables: ['payout.eta', 'payout.account', 'dashboard.url'],
    variableGaps: [],
    defaultSubject: 'Payout scheduled for {{payout.amount}}',
    compliance: system,
  },
  {
    key: 'payout-paid',
    name: 'Payout paid',
    family: 'payout',
    category: 'system',
    tier: 'P2',
    trigger: 'A payout is completed',
    defaultAudience: 'organizer',
    requiredVariables: ['payout.amount'],
    optionalVariables: ['payout.account', 'payout.period', 'dashboard.url'],
    variableGaps: [],
    defaultSubject: 'Payout of {{payout.amount}} completed',
    compliance: system,
  },
  {
    key: 'payout-failed',
    name: 'Payout failed',
    family: 'payout',
    category: 'system',
    tier: 'P2',
    trigger: 'A payout fails',
    defaultAudience: 'organizer',
    requiredVariables: ['payout.amount', 'brand.supportUrl'],
    optionalVariables: ['dashboard.url'],
    variableGaps: [],
    defaultSubject: 'Payout of {{payout.amount}} failed',
    compliance: system,
  },
  {
    key: 'brand-sender-verification',
    name: 'Brand sender verification',
    family: 'deliverability',
    category: 'system',
    tier: 'P2',
    trigger: 'A sender domain needs verification',
    defaultAudience: 'organizer',
    requiredVariables: ['dashboard.url'],
    optionalVariables: ['brand.name'],
    variableGaps: [],
    defaultSubject: 'Verify your sender domain',
    compliance: system,
  },
  {
    key: 'integration-disconnected',
    name: 'Integration disconnected',
    family: 'integration',
    category: 'system',
    tier: 'P2',
    trigger: 'An integration disconnects',
    defaultAudience: 'organizer',
    requiredVariables: ['integration.name', 'integration.reconnectUrl'],
    optionalVariables: ['dashboard.url'],
    variableGaps: [],
    defaultSubject: '{{integration.name}} integration disconnected',
    compliance: system,
  },
  {
    key: 'webhook-failed',
    name: 'Webhook failed',
    family: 'integration',
    category: 'system',
    tier: 'P2',
    trigger: 'Webhook deliveries are failing',
    defaultAudience: 'developer',
    requiredVariables: ['webhook.endpointUrl', 'dashboard.url'],
    optionalVariables: ['webhook.attempts'],
    variableGaps: [],
    defaultSubject: 'Webhook delivery failures detected',
    compliance: system,
  },
  {
    key: 'chargeback-opened',
    name: 'Chargeback opened',
    family: 'dispute',
    category: 'system',
    tier: 'P2',
    trigger: 'A payment dispute is created',
    defaultAudience: 'organizer',
    requiredVariables: ['chargeback.id', 'chargeback.amount', 'chargeback.dueAt'],
    optionalVariables: ['order.id', 'chargeback.evidenceUrl', 'dashboard.url'],
    variableGaps: [],
    defaultSubject: 'Chargeback opened for {{chargeback.id}}',
    compliance: system,
  },
  {
    key: 'chargeback-won',
    name: 'Chargeback won',
    family: 'dispute',
    category: 'system',
    tier: 'P2',
    trigger: 'A dispute is resolved in favor of the organizer',
    defaultAudience: 'organizer',
    requiredVariables: ['chargeback.id', 'chargeback.amount'],
    optionalVariables: ['order.id', 'dashboard.url'],
    variableGaps: [],
    defaultSubject: 'Chargeback {{chargeback.id}} won',
    compliance: system,
  },
  {
    key: 'chargeback-lost',
    name: 'Chargeback lost',
    family: 'dispute',
    category: 'system',
    tier: 'P2',
    trigger: 'A dispute is resolved against the organizer',
    defaultAudience: 'organizer',
    requiredVariables: ['chargeback.id', 'chargeback.amount', 'brand.supportUrl'],
    optionalVariables: ['order.id', 'dashboard.url'],
    variableGaps: [],
    defaultSubject: 'Chargeback {{chargeback.id}} lost',
    compliance: system,
  },
];

const TEMPLATE_LIFECYCLE_BY_KEY: ReadonlyMap<TemplateKey, TemplateLifecycle> = new Map(
  TEMPLATE_LIFECYCLES.map((entry) => [entry.key, entry]),
);

export function getTemplateLifecycle(key: TemplateKey): TemplateLifecycle | undefined {
  return TEMPLATE_LIFECYCLE_BY_KEY.get(key);
}

export function listTemplateLifecyclesByFamily(family: TemplateFamily): TemplateLifecycle[] {
  return TEMPLATE_LIFECYCLES.filter((entry) => entry.family === family);
}

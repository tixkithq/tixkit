import type { TemplateKey } from '@tixkit/domain';

export type StudioArchetype = 'receipt' | 'access' | 'recovery' | 'announcement' | 'invite' | 'ops';

export type StudioAction = {
  label: string;
  url: string;
  optionalTag?: string;
};

export type StudioFact = {
  label: string;
  value: string;
  optionalTag?: string;
};

export type StudioTemplateDefinition = {
  archetype: StudioArchetype;
  headline: string;
  intro: string[];
  primaryAction?: StudioAction;
  secondaryActions?: StudioAction[];
  item?: { title: string; meta: string[]; optionalTag?: string };
  facts?: StudioFact[];
  totals?: StudioFact[];
  qr?: { imageUrl: string; code?: string; optionalTag?: string };
  wallets?: StudioAction[];
  benefits?: string[];
  quote?: string;
  stats?: StudioFact[];
  body?: string;
};

const action = (label: string, url: string, optionalTag?: string): StudioAction => ({
  label,
  url,
  optionalTag,
});
const fact = (label: string, value: string, optionalTag?: string): StudioFact => ({
  label,
  value,
  optionalTag,
});

export const STUDIO_TEMPLATE_CONTENT = {
  'order-confirmed': {
    archetype: 'receipt',
    headline: "You're going to {{event.title}}",
    intro: [
      'Hi {{recipient.name}} — your order is confirmed.',
      'Your tickets are being prepared and will follow shortly.',
    ],
    primaryAction: action('View your order →', '{{order.manageUrl}}', 'order.manageUrl'),
    secondaryActions: [action('View receipt', '{{order.receiptUrl}}', 'order.receiptUrl')],
    item: {
      title: '{{event.title}}',
      meta: ['{{event.startsAt}}', '{{event.venueName}} · {{event.venueCity}}'],
      optionalTag: 'event.startsAt',
    },
    totals: [fact('Order', '{{order.id}}'), fact('Total', '{{order.total}}')],
  },
  'tickets-issued': {
    archetype: 'access',
    headline: 'Your tickets are ready',
    intro: ['Hi {{recipient.name}} — everything you need at the door is below.'],
    primaryAction: action('Download tickets', '{{ticket.pdfUrl}}', 'ticket.pdfUrl'),
    qr: { imageUrl: '{{ticket.qrCodeUrl}}', code: '{{ticket.code}}' },
    facts: [
      fact('Ticket', '{{ticket.type}}'),
      fact('Event', '{{event.title}}'),
      fact('Date', '{{event.startsAt}}', 'event.startsAt'),
      fact('Venue', '{{event.venueName}}', 'event.venueName'),
    ],
    wallets: [
      action('Apple Wallet', '{{ticket.walletAppleUrl}}', 'ticket.walletAppleUrl'),
      action('Google Wallet', '{{ticket.walletGoogleUrl}}', 'ticket.walletGoogleUrl'),
    ],
    totals: [
      fact('Order', '{{order.id}}', 'order.id'),
      fact('Total', '{{order.total}}', 'order.total'),
    ],
  },
  'payment-failed': {
    archetype: 'recovery',
    headline: "Your payment didn't go through",
    intro: [
      'Hi {{recipient.name}} — no charge was completed.',
      'Your spot is held briefly while you try again.',
    ],
    primaryAction: action('Retry payment', '{{order.retryUrl}}', 'order.retryUrl'),
    secondaryActions: [action('Return to checkout', '{{event.checkoutUrl}}', 'event.checkoutUrl')],
    facts: [
      fact('Event', '{{event.title}}'),
      fact('Order', '{{order.id}}'),
      fact('Total', '{{order.total}}', 'order.total'),
    ],
    benefits: [
      'Your place stays reserved during the retry window.',
      'Need a hand? {{brand.supportUrl}}',
    ],
  },
  'order-cancelled': {
    archetype: 'receipt',
    headline: 'Your order was cancelled',
    intro: ['Hi {{recipient.name}} — this confirms that your order is no longer active.'],
    primaryAction: action('Browse the event', '{{event.publicUrl}}', 'event.publicUrl'),
    facts: [
      fact('Event', '{{event.title}}'),
      fact('Order', '{{order.id}}'),
      fact('Total', '{{order.total}}', 'order.total'),
      fact('Reason', '{{order.cancellationReason}}', 'order.cancellationReason'),
      fact('Credit', '{{order.creditStatus}}', 'order.creditStatus'),
    ],
  },
  'order-refunded': {
    archetype: 'receipt',
    headline: 'Your refund is on the way',
    intro: [
      'Hi {{recipient.name}} — your refund has been sent for processing.',
      'Timing depends on your bank or card provider.',
    ],
    totals: [
      fact('Refund', '{{refund.amount}}'),
      fact('Order', '{{order.id}}'),
      fact('Original total', '{{order.total}}', 'order.total'),
    ],
    facts: [
      fact('Processed', '{{refund.processedAt}}', 'refund.processedAt'),
      fact('Expected', '{{refund.processingEta}}', 'refund.processingEta'),
      fact('Event', '{{event.title}}', 'event.title'),
    ],
  },
  'event-updated': {
    archetype: 'announcement',
    headline: '{{event.title}} has changed',
    intro: ['Hi {{recipient.name}} — here is the latest update.', '{{event.changeSummary}}'],
    primaryAction: action('View event', '{{event.publicUrl}}', 'event.publicUrl'),
    facts: [
      fact('New date', '{{event.startsAt}}', 'event.startsAt'),
      fact('Venue', '{{event.venueName}}', 'event.venueName'),
      fact('City', '{{event.venueCity}}', 'event.venueCity'),
    ],
  },
  'event-cancelled': {
    archetype: 'announcement',
    headline: '{{event.title}} is cancelled',
    intro: [
      'Hi {{recipient.name}} — the event will no longer take place.',
      '{{event.cancellationReason}}',
    ],
    primaryAction: action('Refund policy', '{{event.refundPolicyUrl}}', 'event.refundPolicyUrl'),
    body: 'For questions about your order, visit {{brand.supportUrl}}.',
  },
  'event-reminder': {
    archetype: 'access',
    headline: 'See you at {{event.title}}',
    intro: ['Hi {{recipient.name}} — keep this email handy for arrival.'],
    primaryAction: action('Open map', '{{event.mapUrl}}', 'event.mapUrl'),
    secondaryActions: [action('View event', '{{event.publicUrl}}', 'event.publicUrl')],
    qr: {
      imageUrl: '{{ticket.qrCodeUrl}}',
      code: '{{ticket.code}}',
      optionalTag: 'ticket.qrCodeUrl',
    },
    facts: [
      fact('Date', '{{event.startsAt}}'),
      fact('Timezone', '{{event.timezone}}', 'event.timezone'),
      fact('Doors', '{{event.doorTime}}', 'event.doorTime'),
      fact('Venue', '{{event.venueName}}'),
      fact('City', '{{event.venueCity}}', 'event.venueCity'),
    ],
  },
  'attendee-message': {
    archetype: 'announcement',
    headline: 'A note about {{event.title}}',
    intro: ['Hi {{recipient.name}} — the organizer has an update for you.'],
    body: 'Add your message here. Keep it short, useful, and easy to scan.',
  },
  'staff-order-notification': {
    archetype: 'ops',
    headline: 'New order for {{event.title}}',
    intro: ['Hi {{recipient.name}} — a new order is ready to review.'],
    primaryAction: action('Open dashboard', '{{dashboard.url}}', 'dashboard.url'),
    facts: [
      fact('Order', '{{order.id}}'),
      fact('Buyer', '{{order.buyerName}}', 'order.buyerName'),
      fact('Ticket', '{{ticket.type}}', 'ticket.type'),
      fact('Total', '{{order.total}}', 'order.total'),
    ],
  },
  'organization-member-invited': {
    archetype: 'invite',
    headline: "You're invited to join an organization",
    intro: [
      'Hi {{recipient.name}} — you have been invited to join the organization.',
      'Accept the invitation to review the access assigned to you.',
    ],
    primaryAction: action('Accept invitation', '{{dashboard.url}}', 'dashboard.url'),
    facts: [fact('Organization', '{{brand.name}}', 'brand.name')],
  },
  'checkin-device-invited': {
    archetype: 'invite',
    headline: "You're on the door for {{event.title}}",
    intro: ['Hi {{recipient.name}} — you have been invited to help with check-in.'],
    primaryAction: action('Open scanner', '{{device.inviteUrl}}', 'device.inviteUrl'),
    facts: [
      fact('Access', '{{device.permissionScope}}', 'device.permissionScope'),
      fact('Expires', '{{device.expiresAt}}', 'device.expiresAt'),
      fact('Brand', '{{brand.name}}', 'brand.name'),
    ],
  },
  'waitlist-joined': {
    archetype: 'invite',
    headline: "You're on the list",
    intro: ['Hi {{recipient.name}} — we will let you know if tickets open up for {{event.title}}.'],
    facts: [
      fact('Event', '{{event.title}}'),
      fact('Date', '{{event.startsAt}}', 'event.startsAt'),
      fact('Venue', '{{event.venueName}}', 'event.venueName'),
      fact('Position', '{{waitlist.position}}', 'waitlist.position'),
    ],
  },
  'waitlist-invite': {
    archetype: 'recovery',
    headline: 'Tickets just opened up',
    intro: [
      'Hi {{recipient.name}} — a spot is available for {{event.title}}.',
      'The offer is first come, first served.',
    ],
    primaryAction: action('Claim your tickets', '{{waitlist.inviteUrl}}'),
    facts: [
      fact('Event', '{{event.title}}'),
      fact('Ticket', '{{ticket.type}}', 'ticket.type'),
      fact('Offer expires', '{{waitlist.expiresAt}}', 'waitlist.expiresAt'),
    ],
  },
  'waitlist-invite-expiring': {
    archetype: 'recovery',
    headline: 'Last call for {{event.title}}',
    intro: ['Hi {{recipient.name}} — your ticket offer closes at the time below.'],
    primaryAction: action('Claim before it expires', '{{waitlist.inviteUrl}}'),
    facts: [fact('Expires', '{{waitlist.expiresAt}}')],
  },
  'abandoned-checkout': {
    archetype: 'recovery',
    headline: 'Pick up where you left off',
    intro: [
      'Hi {{recipient.name}} — your checkout for {{event.title}} is saved.',
      'Return when you are ready to finish.',
    ],
    primaryAction: action('Finish checkout', '{{event.checkoutUrl}}'),
    item: {
      title: '{{event.title}}',
      meta: ['Order {{order.id}}', '{{order.total}}'],
      optionalTag: 'order.id',
    },
    benefits: [
      'Your selections are saved for a limited time.',
      'Secure checkout. Immediate confirmation.',
    ],
  },
  'ticket-transfer-started': {
    archetype: 'invite',
    headline: '{{event.title}}: a ticket is waiting for you',
    intro: [
      'Hi {{recipient.name}} — someone sent you a ticket. Accept it to add it to your account.',
    ],
    primaryAction: action('Accept your ticket', '{{ticket.transferUrl}}'),
    facts: [
      fact('Ticket', '{{ticket.type}}', 'ticket.type'),
      fact('Code', '{{ticket.code}}'),
      fact('Date', '{{event.startsAt}}', 'event.startsAt'),
      fact('Venue', '{{event.venueName}}', 'event.venueName'),
    ],
  },
  'ticket-transfer-accepted': {
    archetype: 'receipt',
    headline: 'Transfer complete',
    intro: ['Hi {{recipient.name}} — the ticket transfer for {{event.title}} is complete.'],
    facts: [
      fact('Event', '{{event.title}}'),
      fact('Ticket', '{{ticket.type}}', 'ticket.type'),
      fact('Code', '{{ticket.code}}'),
    ],
  },
  'ticket-transfer-cancelled': {
    archetype: 'receipt',
    headline: 'Transfer cancelled',
    intro: ['Hi {{recipient.name}} — the ticket for {{event.title}} has returned to its sender.'],
    facts: [fact('Event', '{{event.title}}'), fact('Code', '{{ticket.code}}')],
    body: 'Questions? Visit {{brand.supportUrl}}.',
  },
  'wallet-pass-ready': {
    archetype: 'access',
    headline: 'Add {{event.title}} to your wallet',
    intro: ['Hi {{recipient.name}} — keep your ticket one tap away on your lock screen.'],
    qr: {
      imageUrl: '{{ticket.qrCodeUrl}}',
      code: '{{ticket.code}}',
      optionalTag: 'ticket.qrCodeUrl',
    },
    wallets: [
      action('Apple Wallet', '{{ticket.walletAppleUrl}}', 'ticket.walletAppleUrl'),
      action('Google Wallet', '{{ticket.walletGoogleUrl}}', 'ticket.walletGoogleUrl'),
    ],
    facts: [fact('Ticket code', '{{ticket.code}}')],
  },
  'post-event-thank-you': {
    archetype: 'announcement',
    headline: 'Thanks for coming',
    intro: [
      'Hi {{recipient.name}} — thanks for spending time with {{brand.name}} at {{event.title}}.',
    ],
    primaryAction: action("See what's next", '{{event.publicUrl}}', 'event.publicUrl'),
    quote: 'The room is what made it memorable.',
  },
  'review-request': {
    archetype: 'announcement',
    headline: 'How was {{event.title}}?',
    intro: ['Hi {{recipient.name}} — one quick review helps the next guest know what to expect.'],
    primaryAction: action(
      'Review on {{review.platform}}',
      '{{event.publicUrl}}',
      'event.publicUrl',
    ),
    body: 'Your perspective matters, wherever you choose to share it: {{review.platform}}.',
  },
  'daily-sales-digest': {
    archetype: 'ops',
    headline: 'Today at a glance',
    intro: ['Hi {{recipient.name}} — here is a concise sales snapshot for {{event.title}}.'],
    primaryAction: action('Open dashboard', '{{dashboard.url}}'),
    stats: [
      fact('Revenue', '{{salesDigest.revenue}}', 'salesDigest.revenue'),
      fact('Orders', '{{salesDigest.orders}}', 'salesDigest.orders'),
      fact('Top ticket', '{{salesDigest.topTicketType}}', 'salesDigest.topTicketType'),
    ],
  },
  'payout-scheduled': {
    archetype: 'ops',
    headline: '{{payout.amount}} is on the way',
    intro: ['Hi {{recipient.name}} — your payout is scheduled and no action is needed.'],
    primaryAction: action('Open dashboard', '{{dashboard.url}}', 'dashboard.url'),
    facts: [
      fact('ETA', '{{payout.eta}}', 'payout.eta'),
      fact('Account', '{{payout.account}}', 'payout.account'),
    ],
  },
  'payout-paid': {
    archetype: 'ops',
    headline: '{{payout.amount}} paid out',
    intro: ['Hi {{recipient.name}} — the payout has completed successfully.'],
    primaryAction: action('Open dashboard', '{{dashboard.url}}', 'dashboard.url'),
    facts: [
      fact('Account', '{{payout.account}}', 'payout.account'),
      fact('Period', '{{payout.period}}', 'payout.period'),
    ],
  },
  'payout-failed': {
    archetype: 'ops',
    headline: 'Payout failed',
    intro: [
      'Hi {{recipient.name}} — we could not complete the {{payout.amount}} payout.',
      'Contact support for the next step.',
    ],
    primaryAction: action('Contact support', '{{brand.supportUrl}}'),
    secondaryActions: [action('Open dashboard', '{{dashboard.url}}', 'dashboard.url')],
    facts: [fact('Amount', '{{payout.amount}}')],
  },
  'brand-sender-verification': {
    archetype: 'ops',
    headline: 'Verify your sending domain',
    intro: [
      'Hi {{recipient.name}} — verification helps messages from {{brand.name}} reach the inbox reliably.',
    ],
    primaryAction: action('Verify domain', '{{dashboard.url}}'),
    facts: [fact('Brand', '{{brand.name}}', 'brand.name')],
  },
  'integration-disconnected': {
    archetype: 'ops',
    headline: '{{integration.name}} disconnected',
    intro: [
      'Hi {{recipient.name}} — the connection stopped working. Reconnect it to resume automatic updates.',
    ],
    primaryAction: action('Reconnect', '{{integration.reconnectUrl}}'),
    secondaryActions: [action('Open dashboard', '{{dashboard.url}}', 'dashboard.url')],
  },
  'webhook-failed': {
    archetype: 'ops',
    headline: 'Webhook deliveries are failing',
    intro: ['Hi {{recipient.name}} — review the endpoint before the next delivery attempt.'],
    primaryAction: action('Review endpoint', '{{dashboard.url}}'),
    facts: [
      fact('Endpoint', '{{webhook.endpointUrl}}'),
      fact('Attempts', '{{webhook.attempts}}', 'webhook.attempts'),
    ],
  },
  'chargeback-opened': {
    archetype: 'ops',
    headline: 'A dispute needs your response',
    intro: ['Hi {{recipient.name}} — submit clear evidence by the deadline below.'],
    primaryAction: action(
      'Submit evidence',
      '{{chargeback.evidenceUrl}}',
      'chargeback.evidenceUrl',
    ),
    facts: [
      fact('Dispute', '{{chargeback.id}}'),
      fact('Amount', '{{chargeback.amount}}'),
      fact('Respond by', '{{chargeback.dueAt}}'),
      fact('Order', '{{order.id}}', 'order.id'),
    ],
  },
  'chargeback-won': {
    archetype: 'ops',
    headline: 'Dispute resolved in your favor',
    intro: ['Hi {{recipient.name}} — the dispute is closed and no further action is needed.'],
    primaryAction: action('Open dashboard', '{{dashboard.url}}', 'dashboard.url'),
    facts: [fact('Dispute', '{{chargeback.id}}'), fact('Amount', '{{chargeback.amount}}')],
  },
  'chargeback-lost': {
    archetype: 'ops',
    headline: 'Dispute closed',
    intro: [
      'Hi {{recipient.name}} — the dispute was not resolved in your favor.',
      'Contact support to review the available next steps.',
    ],
    primaryAction: action('Contact support', '{{brand.supportUrl}}'),
    secondaryActions: [action('Open dashboard', '{{dashboard.url}}', 'dashboard.url')],
    facts: [fact('Dispute', '{{chargeback.id}}'), fact('Amount', '{{chargeback.amount}}')],
  },
} as const satisfies Record<TemplateKey, StudioTemplateDefinition>;

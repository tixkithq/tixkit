import type { ContentValidationIssue } from '@tixkit/content-core';
import type { EmailTemplateDocument } from '@tixkit/content-email';
import type { AdminBrandSenderIdentity, AdminEventDetail } from '@/lib/api';

export const emailCategoryOptions = ['transactional', 'bulk', 'staff', 'system'] as const;

export function sampleContext(event: AdminEventDetail): Record<string, unknown> {
  const brandName = event.title.trim() || 'Event';
  return {
    event: {
      title: event.title,
      startsAt: event.startsAt,
      venueName: 'Radius Chicago',
      checkoutUrl: `https://checkout.example.test/checkout?eventId=${event.id}`,
      publicUrl: `https://events.example.test/e/${event.id}`,
    },
    brand: {
      name: brandName,
      supportUrl: `https://events.example.test/e/${event.id}/preferences`,
    },
    recipient: {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    },
    ticket: {
      type: 'General Admission',
      code: 'TKT-123',
      qrCodeUrl: 'https://tickets.example.test/qr/preview.png',
    },
    order: {
      id: 'ord_preview_123',
      total: '$35.00',
    },
  };
}

export function validationIssueKey(issue: ContentValidationIssue): string {
  return `${issue.code}:${issue.field ?? ''}:${issue.message}:${issue.severity}`;
}

export function mergeValidationIssues(issues: ContentValidationIssue[]): ContentValidationIssue[] {
  const seen = new Set<string>();
  const uniqueIssues: ContentValidationIssue[] = [];
  const errors: ContentValidationIssue[] = [];
  const warnings: ContentValidationIssue[] = [];
  for (const issue of issues) {
    const key = validationIssueKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueIssues.push(issue);
  }
  for (const issue of uniqueIssues) {
    if (issue.severity === 'error') {
      errors.push(issue);
    } else {
      warnings.push(issue);
    }
  }
  return [...errors, ...warnings];
}

export function hasBlockingIssues(issues: ContentValidationIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

export function waitForReviewAnalysis(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function verifiedSenderIdentities(identities: AdminBrandSenderIdentity[]) {
  return identities.filter((identity) => identity.verified && identity.email.trim());
}

export function findVerifiedSenderIdentity(
  identities: AdminBrandSenderIdentity[],
  fromEmail?: string,
): AdminBrandSenderIdentity | undefined {
  const normalizedFromEmail = fromEmail?.trim().toLowerCase();
  if (!normalizedFromEmail) return verifiedSenderIdentities(identities)[0];
  return verifiedSenderIdentities(identities).find(
    (identity) => identity.email.trim().toLowerCase() === normalizedFromEmail,
  );
}

export function senderIdentityIssues(
  document: EmailTemplateDocument,
  identities: AdminBrandSenderIdentity[],
): ContentValidationIssue[] {
  if (findVerifiedSenderIdentity(identities, document.settings.sender.fromEmail)) return [];
  const verified = verifiedSenderIdentities(identities);
  if (verified.length > 0) {
    return [
      {
        code: 'email_sender_identity_mismatch',
        field: 'settings.sender.fromEmail',
        message: `Choose a verified sender identity before sending (e.g. ${verified[0]!.email}). Template placeholders like tickets@example.test are rejected by Resend.`,
        severity: 'error',
      },
    ];
  }
  return [
    {
      code: 'email_sender_identity_missing',
      field: 'settings.sender.fromEmail',
      message:
        'This brand has no verified email sender identity. Set RESEND_FROM_EMAIL (onboarding@resend.dev or a verified domain address), restart the API, and reload.',
      severity: 'error',
    },
  ];
}

export function ensureBulkUnsubscribeFooter(
  document: EmailTemplateDocument,
): EmailTemplateDocument {
  if (document.settings.category !== 'bulk') return document;
  if (document.blocks.some((block) => block.type === 'unsubscribe_footer')) return document;
  return {
    ...document,
    blocks: [
      ...document.blocks,
      {
        type: 'unsubscribe_footer',
        body: 'You are receiving this because you subscribed to updates from {{brand.name}}.',
        unsubscribeUrl: '{{brand.supportUrl}}',
      },
    ],
  };
}

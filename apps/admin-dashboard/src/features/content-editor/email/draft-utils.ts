import {
  REACT_EMAIL_EDITOR_PACKAGE,
  createDefaultEmailTemplate,
  type EmailTemplateDocument,
} from '@tixkit/content-email';
import type {
  AdminBrandSenderIdentity,
  AdminContentDocument,
  AdminContentDocumentVersion,
  AdminContentRenderOutput,
  AdminEventDetail,
} from '@/lib/api';
import type { EmailEditorPreview } from './preview-drawer';

export function listItemsFromResponse<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== 'object') return [];
  const keyed = value as { items?: unknown };
  if (Array.isArray(keyed.items)) return keyed.items as T[];
  return Object.values(value).filter(
    (item): item is T => Boolean(item) && typeof item === 'object',
  );
}

export function defaultEmailDocument(
  event?: AdminEventDetail,
  senderIdentity?: AdminBrandSenderIdentity,
): EmailTemplateDocument {
  return createDefaultEmailTemplate({
    editor: {
      provider: REACT_EMAIL_EDITOR_PACKAGE,
      contentHtml: [
        '<h1>{{event.title}}</h1>',
        '<p>Hi {{recipient.name}}, your tickets are ready.</p>',
        '<p>Order {{order.id}} - {{order.total}}</p>',
        '<p>{{ticket.type}} - {{ticket.code}}</p>',
        '<p><img src="{{ticket.qrCodeUrl}}" alt="Ticket QR code" /></p>',
        '<p>You are receiving this because you purchased or manage tickets with {{brand.name}}.</p>',
      ].join(''),
      contentText: [
        '{{event.title}}',
        'Hi {{recipient.name}}, your tickets are ready.',
        'Order {{order.id}} - {{order.total}}',
        '{{ticket.type}} - {{ticket.code}}',
        'You are receiving this because you purchased or manage tickets with {{brand.name}}.',
      ].join('\n\n'),
    },
    settings: {
      templateKey: 'order-confirmed',
      subject: event
        ? `Your ${event.title} tickets are ready`
        : 'Your {{event.title}} tickets are ready',
      previewText: 'Everything you need before arrival.',
      locale: 'en',
      category: 'transactional',
      sender: {
        fromEmail: senderIdentity?.email ?? '',
        fromName: senderIdentity?.name || '{{brand.name}}',
        replyToEmail: senderIdentity?.replyToEmail,
      },
    },
    blocks: [
      {
        type: 'event_hero',
        headline: '{{event.title}}',
        body: 'Hi {{recipient.name}}, your order is confirmed.',
        ctaLabel: 'View tickets',
        ctaUrl: '{{event.checkoutUrl}}',
      },
      {
        type: 'ticket_summary',
        title: 'Ticket summary',
        body: 'Order {{order.id}} - {{order.total}} - {{ticket.type}} - {{ticket.code}}',
      },
      {
        type: 'qr_code',
        title: 'Ticket QR code',
        imageUrl: '{{ticket.qrCodeUrl}}',
        imageAlt: 'Ticket QR code',
      },
      {
        type: 'unsubscribe_footer',
        body: 'You are receiving this because you purchased or manage tickets with {{brand.name}}.',
        unsubscribeUrl: '{{brand.supportUrl}}',
      },
    ],
  });
}

export function previewFromEditorDocument(
  label: string,
  document: EmailTemplateDocument,
): EmailEditorPreview {
  const html = document.editor.contentHtml.trim();
  const text = document.editor.contentText?.trim();
  return {
    label,
    format: html ? 'html' : 'text',
    output: html || text || '',
  };
}

export function previewFromEmailOutput(
  label: string,
  output: Pick<AdminContentRenderOutput, 'html' | 'text'>,
): EmailEditorPreview {
  const text = output.text?.trim();
  const html = output.html?.trim();
  return {
    label,
    format: html ? 'html' : 'text',
    output: text || html || '',
  };
}

export function versionSummaries(versions: AdminContentDocumentVersion[]) {
  return versions.map((version) => ({
    id: version.id,
    label: `${version.status === 'published' ? 'Published' : 'Draft'} v${version.versionNumber}`,
    status: version.status,
    timestamp: version.publishedAt ?? version.createdAt,
    author: version.createdBy,
  }));
}

export function latestVersion(items: AdminContentDocumentVersion[]) {
  return items.reduce<AdminContentDocumentVersion | undefined>(
    (current, version) =>
      !current || version.versionNumber > current.versionNumber ? version : current,
    undefined,
  );
}

export function latestDraft(
  versions: AdminContentDocumentVersion[],
  document: AdminContentDocument,
) {
  return (
    versions.find((version) => version.id === document.currentDraftVersionId) ??
    latestVersion(versions.filter((version) => version.status === 'draft')) ??
    latestVersion(versions)
  );
}

export function resultMessage(error: { message?: string } | undefined, defaultMessage: string) {
  return error?.message ?? defaultMessage;
}

export function duplicateDocumentName(name: string): string {
  const suffix = ' Copy';
  return name.endsWith(suffix) ? name : `${name.slice(0, 160 - suffix.length)}${suffix}`;
}

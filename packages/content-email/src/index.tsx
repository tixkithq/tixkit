import * as React from 'react';
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import { render } from '@react-email/render';
import {
  validateContentVersion,
  type ContentValidationIssue,
  type ContentValidationResult,
} from '@tixkit/content-core';
import {
  isAllowedDestination,
  MERGE_TAG_REGISTRY,
  renderMergeTags,
  validateMergeTags,
  getTemplateLifecycle,
  P0_TEMPLATE_KEYS,
  type MergeTagContext,
  type SendEmailInput,
  type TemplateKey,
} from '@tixkit/domain';

export const REACT_EMAIL_EDITOR_PACKAGE = '@react-email/editor' as const;
export { MERGE_TAG_REGISTRY };

export type EmailTemplateCategory = 'transactional' | 'bulk' | 'staff' | 'system';

export type EmailTemplateSender = {
  fromEmail?: string;
  fromName?: string;
  replyToEmail?: string;
};

export type EmailTemplateSettings = {
  templateKey: string;
  subject: string;
  previewText?: string;
  locale: string;
  category: EmailTemplateCategory;
  sender: EmailTemplateSender;
};

export type EmailTemplateBlock =
  | {
      type: 'event_hero';
      headline: string;
      body?: string;
      imageUrl?: string;
      imageAlt?: string;
      ctaLabel?: string;
      ctaUrl?: string;
    }
  | {
      type: 'ticket_summary';
      title: string;
      body: string;
    }
  | {
      type: 'order_summary';
      title: string;
      rows: { label: string; value: string }[];
    }
  | {
      type: 'qr_code';
      title: string;
      imageUrl: string;
      imageAlt?: string;
    }
  | {
      type: 'calendar_button';
      label: string;
      url: string;
    }
  | {
      type: 'venue_block';
      title: string;
      address: string;
      mapUrl?: string;
    }
  | {
      type: 'social_links';
      links: { label: string; url: string }[];
    }
  | {
      type: 'unsubscribe_footer';
      body: string;
      unsubscribeUrl: string;
    }
  | {
      type: 'raw_html';
      html: string;
      safe: boolean;
    };

export type EmailTemplateDocument = {
  schemaVersion: 1;
  editor: {
    provider: typeof REACT_EMAIL_EDITOR_PACKAGE;
    contentHtml: string;
    contentText?: string;
    globalCss?: string;
    contentJson?: Record<string, unknown>;
  };
  settings: EmailTemplateSettings;
  blocks: EmailTemplateBlock[];
};

export type RenderedEmailTemplate = {
  subject: string;
  previewText?: string;
  html: string;
  text: string;
  validation: ContentValidationResult;
};

export type EmailTestSendInput = {
  tenantId: string;
  organizationId: string;
  brandId: string;
  templateVersionId: string;
  providerRouteId: string;
  deliveryId: string;
  to: { email: string; name?: string }[];
  idempotencyKey: string;
  metadata?: SendEmailInput['metadata'];
};

export function normalizeEmailTemplateDocument(value: unknown): EmailTemplateDocument | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const document = value as Partial<EmailTemplateDocument>;
  if (document.schemaVersion !== 1) return undefined;
  if (!document.editor || typeof document.editor !== 'object') return undefined;
  if (document.editor.provider !== REACT_EMAIL_EDITOR_PACKAGE) return undefined;
  if (typeof document.editor.contentHtml !== 'string') return undefined;
  if (
    document.editor.contentText !== undefined &&
    typeof document.editor.contentText !== 'string'
  ) {
    return undefined;
  }
  if (
    document.editor.globalCss !== undefined &&
    typeof document.editor.globalCss !== 'string'
  ) {
    return undefined;
  }
  if (
    document.editor.contentJson !== undefined &&
    (!document.editor.contentJson || typeof document.editor.contentJson !== 'object')
  ) {
    return undefined;
  }
  if (!document.settings || typeof document.settings !== 'object') return undefined;
  if (typeof document.settings.templateKey !== 'string') return undefined;
  if (typeof document.settings.subject !== 'string') return undefined;
  if (
    document.settings.previewText !== undefined &&
    typeof document.settings.previewText !== 'string'
  ) {
    return undefined;
  }
  if (typeof document.settings.locale !== 'string') return undefined;
  if (!isEmailTemplateCategory(document.settings.category)) return undefined;
  if (!document.settings.sender || typeof document.settings.sender !== 'object') return undefined;
  if (
    document.settings.sender.fromEmail !== undefined &&
    typeof document.settings.sender.fromEmail !== 'string'
  ) {
    return undefined;
  }
  if (
    document.settings.sender.fromName !== undefined &&
    typeof document.settings.sender.fromName !== 'string'
  ) {
    return undefined;
  }
  if (
    document.settings.sender.replyToEmail !== undefined &&
    typeof document.settings.sender.replyToEmail !== 'string'
  ) {
    return undefined;
  }
  if (!Array.isArray(document.blocks) || !document.blocks.every(isEmailTemplateBlock)) {
    return undefined;
  }
  return document as EmailTemplateDocument;
}

const defaultContainerStyle = {
  margin: '0 auto',
  padding: '24px 0',
  width: '100%',
  maxWidth: '640px',
} satisfies React.CSSProperties;

const paragraphStyle = {
  color: '#243145',
  fontSize: '15px',
  lineHeight: '24px',
  margin: '0 0 16px',
} satisfies React.CSSProperties;

const buttonStyle = {
  backgroundColor: '#111827',
  borderRadius: '6px',
  color: '#ffffff',
  display: 'inline-block',
  fontSize: '14px',
  fontWeight: 600,
  padding: '11px 16px',
  textDecoration: 'none',
} satisfies React.CSSProperties;

export const EMAIL_GLOBAL_CSS_STYLE_ID = 'tixkit-email-global-css';
const emailGlobalCssStylePattern =
  /<style\b[^>]*(?:data-tixkit-global-css=["']true["']|id=["']tixkit-email-global-css["'])[^>]*>[\s\S]*?<\/style>/gi;
const emailGlobalCssMaxLength = 8000;

function normalizedEmailGlobalCss(css: string | undefined): string {
  return typeof css === 'string' ? css.replace(/\r\n?/g, '\n').trim() : '';
}

function styleElementText(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

export function stripEmailGlobalCssFromHtml(html: string): string {
  return html.replace(emailGlobalCssStylePattern, '').trim();
}

export function applyEmailGlobalCssToHtml(html: string, css: string | undefined): string {
  const baseHtml = stripEmailGlobalCssFromHtml(html);
  const globalCss = normalizedEmailGlobalCss(css);
  if (!globalCss) return baseHtml;
  const styleTag = `<style id="${EMAIL_GLOBAL_CSS_STYLE_ID}" data-tixkit-global-css="true">${styleElementText(globalCss)}</style>`;
  if (/<\/head>/i.test(baseHtml)) {
    return baseHtml.replace(/<\/head>/i, `${styleTag}</head>`);
  }
  return `${styleTag}${baseHtml}`;
}

function validateEmailGlobalCss(css: string | undefined): ContentValidationIssue[] {
  const globalCss = normalizedEmailGlobalCss(css);
  if (!globalCss) return [];
  const issues: ContentValidationIssue[] = [];
  if (globalCss.length > emailGlobalCssMaxLength) {
    issues.push({
      code: 'unsafe_global_css',
      message: `Global CSS must be ${emailGlobalCssMaxLength} characters or fewer`,
      severity: 'error',
      field: 'editor.globalCss',
    });
  }
  if (
    /<\/?\s*(?:script|style|iframe|object|embed|svg|math|link|meta|base)\b/i.test(globalCss) ||
    /(?:expression\s*\(|url\s*\(\s*['"]?\s*(?:javascript|data|vbscript):|@import\b)/i.test(
      globalCss,
    )
  ) {
    issues.push({
      code: 'unsafe_global_css',
      message: 'Global CSS contains unsafe rules or markup',
      severity: 'error',
      field: 'editor.globalCss',
    });
  }
  return issues;
}

export function createDefaultEmailTemplate(
  overrides: Partial<EmailTemplateDocument> = {},
): EmailTemplateDocument {
  const base: EmailTemplateDocument = {
    schemaVersion: 1,
    editor: {
      provider: REACT_EMAIL_EDITOR_PACKAGE,
      contentHtml: [
        '<h1>{{event.title}}</h1>',
        '<p>Hi {{recipient.name}}, your tickets are ready.</p>',
        '<p>{{ticket.type}} - {{order.total}}</p>',
        '<p>Ticket code: {{ticket.code}}</p>',
        '<p><img src="{{ticket.qrCodeUrl}}" alt="Ticket QR code" /></p>',
      ].join(''),
    },
    settings: {
      templateKey: 'custom',
      subject: 'Your {{event.title}} tickets are ready',
      previewText: 'Everything you need before arrival.',
      locale: 'en',
      category: 'transactional',
      sender: {
        fromEmail: 'tickets@example.test',
        fromName: '{{brand.name}}',
        replyToEmail: 'support@example.test',
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
        body: '{{ticket.type}} · {{order.total}} · {{ticket.code}}',
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
  };

  return {
    ...base,
    ...overrides,
    editor: { ...base.editor, ...overrides.editor },
    settings: {
      ...base.settings,
      ...overrides.settings,
      sender: { ...base.settings.sender, ...overrides.settings?.sender },
    },
    blocks: overrides.blocks ?? base.blocks,
  };
}

/**
 * Returns a canonical default `EmailTemplateDocument` for a registered template
 * lifecycle key, built from the lifecycle registry metadata in `@tixkit/domain`
 * (subject/category/preview) plus per-family default blocks that reference the
 * key's required merge tags. These defaults are the seedable Phase-2 source for
 * editable content documents; they are intentionally provider- and brand-agnostic
 * (sender/links use placeholder merge tags resolved at send time).
 *
 * Source of truth: docs/email-template-lifecycle.md.
 */
export function createDefaultEmailTemplateForKey(key: TemplateKey): EmailTemplateDocument {
  const lifecycle = getTemplateLifecycle(key);
  if (!lifecycle) {
    throw new Error(`No lifecycle metadata registered for template key: ${key}`);
  }
  const editor =
    key === 'waitlist-invite'
      ? {
          provider: REACT_EMAIL_EDITOR_PACKAGE,
          contentHtml: [
            '<h1>Tickets are available for {{event.title}}</h1>',
            '<p>Hi {{recipient.name}}, claim your waitlist offer at {{waitlist.inviteUrl}}.</p>',
          ].join(''),
          contentText:
            'Tickets are available for {{event.title}}\nHi {{recipient.name}}, claim your waitlist offer at {{waitlist.inviteUrl}}.',
        }
      : {
          provider: REACT_EMAIL_EDITOR_PACKAGE,
          contentHtml: '<h1>{{event.title}}</h1><p>Hi {{recipient.name}},</p>',
        };
  return {
    schemaVersion: 1,
    editor,
    settings: {
      templateKey: key,
      subject: lifecycle.defaultSubject,
      previewText: lifecycle.defaultPreviewText,
      locale: 'en',
      category: lifecycle.category,
      sender: {
        fromEmail: 'tickets@example.test',
        fromName: '{{brand.name}}',
        replyToEmail: 'support@example.test',
      },
    },
    blocks: defaultBlocksForKey(key),
  };
}

function defaultBlocksForKey(key: TemplateKey): EmailTemplateBlock[] {
  switch (key) {
    case 'order-confirmed':
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, your order is confirmed.',
          ctaLabel: 'Manage order',
          ctaUrl: '{{order.manageUrl}}',
        },
        {
          type: 'order_summary',
          title: 'Order summary',
          rows: [
            { label: 'Order ID', value: '{{order.id}}' },
            { label: 'Total', value: '{{order.total}}' },
          ],
        },
      ];
    case 'tickets-issued':
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, your tickets are ready.',
          ctaLabel: 'Download tickets',
          ctaUrl: '{{ticket.pdfUrl}}',
        },
        {
          type: 'ticket_summary',
          title: 'Ticket',
          body: '{{ticket.type}} - Code {{ticket.code}}',
        },
        {
          type: 'qr_code',
          title: 'Your ticket QR',
          imageUrl: '{{ticket.qrCodeUrl}}',
          imageAlt: 'Ticket QR code',
        },
        {
          type: 'calendar_button',
          label: 'Add to Apple Wallet',
          url: '{{ticket.walletAppleUrl}}',
        },
      ];
    case 'payment-failed':
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, your payment could not be completed.',
        },
        {
          type: 'order_summary',
          title: 'Order summary',
          rows: [{ label: 'Order ID', value: '{{order.id}}' }],
        },
        { type: 'calendar_button', label: 'Retry payment', url: '{{order.retryUrl}}' },
        { type: 'calendar_button', label: 'Get support', url: '{{brand.supportUrl}}' },
      ];
    case 'order-cancelled':
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, your order was cancelled.',
        },
        {
          type: 'order_summary',
          title: 'Order summary',
          rows: [{ label: 'Order ID', value: '{{order.id}}' }],
        },
      ];
    case 'order-refunded':
      return [
        {
          type: 'event_hero',
          headline: 'Refund issued',
          body: 'Hi {{recipient.name}}, your refund has been issued.',
        },
        {
          type: 'order_summary',
          title: 'Refund summary',
          rows: [
            { label: 'Order ID', value: '{{order.id}}' },
            { label: 'Refund amount', value: '{{refund.amount}}' },
          ],
        },
      ];
    case 'event-updated':
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, event details have been updated.',
        },
        { type: 'ticket_summary', title: 'What changed', body: '{{event.changeSummary}}' },
      ];
    case 'event-cancelled':
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, this event has been cancelled.',
        },
        { type: 'calendar_button', label: 'Refund policy', url: '{{event.refundPolicyUrl}}' },
      ];
    case 'event-reminder':
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, your event is coming up.',
        },
        {
          type: 'order_summary',
          title: 'Event details',
          rows: [
            { label: 'Starts', value: '{{event.startsAt}}' },
            { label: 'Venue', value: '{{event.venueName}}' },
          ],
        },
        {
          type: 'qr_code',
          title: 'Your ticket QR',
          imageUrl: '{{ticket.qrCodeUrl}}',
          imageAlt: 'Ticket QR code',
        },
      ];
    case 'attendee-message':
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, you have a message from the organizer.',
        },
        {
          type: 'unsubscribe_footer',
          body: 'You are receiving this because you purchased tickets with {{brand.name}}.',
          unsubscribeUrl: '{{brand.supportUrl}}',
        },
      ];
    case 'staff-order-notification':
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, a new order was placed.',
        },
        {
          type: 'order_summary',
          title: 'Order summary',
          rows: [{ label: 'Order ID', value: '{{order.id}}' }],
        },
        { type: 'calendar_button', label: 'Open dashboard', url: '{{dashboard.url}}' },
      ];
    case 'checkin-device-invited':
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}}, you are invited to scan for this event.',
        },
        { type: 'calendar_button', label: 'Open scanner', url: '{{device.inviteUrl}}' },
      ];
    case 'waitlist-invite':
      return [
        {
          type: 'event_hero',
          headline: 'Tickets are available for {{event.title}}',
          body: 'Hi {{recipient.name}}, your spot on the waitlist is ready.',
          ctaLabel: 'Claim tickets',
          ctaUrl: '{{waitlist.inviteUrl}}',
        },
        {
          type: 'ticket_summary',
          title: 'Offer details',
          body: '{{ticket.type}}',
        },
        {
          type: 'order_summary',
          title: 'Claim before it expires',
          rows: [{ label: 'Expires', value: '{{waitlist.expiresAt}}' }],
        },
      ];
    default:
      // P1/P2 keys are not seeded yet; provide a minimal generic block so the
      // function stays total over the full TemplateKey union.
      return [
        {
          type: 'event_hero',
          headline: '{{event.title}}',
          body: 'Hi {{recipient.name}},',
        },
      ];
  }
}

/**
 * Seedable default email template document for every P0 lifecycle key.
 * Use this to bootstrap editable content documents per brand/event scope.
 */
export const P0_EMAIL_TEMPLATE_DEFAULTS: Readonly<Record<TemplateKey, EmailTemplateDocument>> =
  Object.fromEntries(
    P0_TEMPLATE_KEYS.map((key) => [key, createDefaultEmailTemplateForKey(key)]),
  ) as Readonly<Record<TemplateKey, EmailTemplateDocument>>;

export function validateEmailTemplate(
  document: EmailTemplateDocument,
  options: {
    provider?: 'resend' | 'opencore_email_sdk' | 'smtp';
    allowPrivateLinks?: boolean;
  } = {},
): ContentValidationResult {
  const issues: ContentValidationIssue[] = [];
  const renderedForValidation = collectTemplateStrings(document).join('\n');
  const base = validateContentVersion(
    {
      subject: document.settings.subject,
      previewText: document.settings.previewText,
      renderedHtml: renderedForValidation,
      renderedText: renderedForValidation,
      contentJson: document,
    },
    'email',
  );
  issues.push(...base.issues);
  issues.push(...validateRequiredMergeTags(renderedForValidation));
  issues.push(...getEmailTemplateLifecycleIssues(document));

  if (!document.settings.sender.fromEmail || !isEmailLike(document.settings.sender.fromEmail)) {
    issues.push({
      code: 'invalid_sender_context',
      message: 'Email templates require a valid From email before publish',
      severity: 'error',
      field: 'settings.sender.fromEmail',
    });
  }

  if (
    document.settings.sender.replyToEmail &&
    !isEmailLike(document.settings.sender.replyToEmail)
  ) {
    issues.push({
      code: 'invalid_reply_to',
      message: 'Reply-To must be a valid email address when provided',
      severity: 'error',
      field: 'settings.sender.replyToEmail',
    });
  }

  if (document.settings.category === 'bulk' && !hasUnsubscribeFooter(document)) {
    issues.push({
      code: 'missing_unsubscribe',
      message: 'Bulk email templates require an unsubscribe footer',
      severity: 'error',
      field: 'blocks.unsubscribe_footer',
    });
  }

  for (const issue of validateLinks(document, Boolean(options.allowPrivateLinks))) {
    issues.push(issue);
  }
  for (const issue of validateImageSources(document, Boolean(options.allowPrivateLinks))) {
    issues.push(issue);
  }

  for (const issue of validateEmailGlobalCss(document.editor.globalCss)) {
    issues.push(issue);
  }

  for (const issue of validateHtmlSafety(
    applyEmailGlobalCssToHtml(document.editor.contentHtml, document.editor.globalCss),
    {
      code: 'unsafe_editor_html',
      field: 'editor.contentHtml',
      message: 'Editor HTML may not contain active HTML, scripting attributes, or unsafe URLs',
      allowEmailDocumentShell: true,
    },
  )) {
    issues.push(issue);
  }

  for (const issue of validateImageAlts(document)) {
    issues.push(issue);
  }
  for (const issue of validateEditorImageAlts(document.editor.contentHtml)) {
    issues.push(issue);
  }

  for (const block of document.blocks) {
    if (block.type !== 'raw_html') continue;
    if (!block.safe) {
      issues.push({
        code: 'unsafe_raw_html',
        message: 'Raw HTML blocks must be explicitly marked safe after sanitization review',
        severity: 'error',
        field: 'blocks.raw_html',
      });
    }
    for (const issue of validateHtmlSafety(block.html, {
      code: 'unsafe_raw_html',
      field: 'blocks.raw_html',
      message: 'Raw HTML blocks may not contain active HTML, scripting attributes, or unsafe URLs',
    })) {
      issues.push(issue);
    }
  }

  if (options.provider === 'resend' && document.settings.subject.length > 998) {
    issues.push({
      code: 'provider_incompatible_subject',
      message: 'Resend-compatible subjects must stay under 998 characters',
      severity: 'error',
      field: 'settings.subject',
    });
  }

  const uniqueIssues = dedupeIssues(issues);
  return {
    valid: uniqueIssues.every((issue) => issue.severity !== 'error'),
    severity: uniqueIssues.some((issue) => issue.severity === 'error') ? 'error' : 'warning',
    issues: uniqueIssues,
  };
}

export async function renderEmailTemplate(
  document: EmailTemplateDocument,
  context: MergeTagContext,
  options: { allowPrivateLinks?: boolean } = {},
): Promise<RenderedEmailTemplate> {
  const validation = validateEmailTemplate(document, {
    allowPrivateLinks: options.allowPrivateLinks,
  });
  if (!validation.valid) {
    return {
      subject: renderPlain(document.settings.subject, context),
      previewText: document.settings.previewText
        ? renderPlain(document.settings.previewText, context)
        : undefined,
      html: '',
      text: '',
      validation,
    };
  }

  const subject = renderPlain(document.settings.subject, context);
  const previewText = document.settings.previewText
    ? renderPlain(document.settings.previewText, context)
    : undefined;
  if (document.editor.contentJson) {
    const editorHtml = renderHtml(
      applyEmailGlobalCssToHtml(document.editor.contentHtml, document.editor.globalCss),
      context,
    );
    const editorHtmlWithFooter = appendEditorUnsubscribeFooter(editorHtml, document, context);
    const editorText =
      document.editor.contentText?.trim() || plainTextFromHtml(editorHtml) || '';
    const editorTextWithFooter = appendEditorUnsubscribeText(editorText, document, context);
    return {
      subject,
      previewText,
      html: editorHtmlWithFooter,
      text: renderPlain(editorTextWithFooter, context),
      validation,
    };
  }

  const html = await render(
    React.createElement(EmailTemplate, {
      blocks: document.blocks,
      context,
      previewText,
    }),
  );
  const text = await render(
    React.createElement(EmailTemplate, {
      blocks: document.blocks,
      context,
      previewText,
    }),
    { plainText: true },
  );

  return { subject, previewText, html, text, validation };
}

function appendEditorUnsubscribeFooter(
  html: string,
  document: EmailTemplateDocument,
  context: MergeTagContext,
): string {
  if (document.settings.category !== 'bulk') return html;
  const footer = document.blocks.find(
    (block): block is Extract<EmailTemplateBlock, { type: 'unsubscribe_footer' }> =>
      block.type === 'unsubscribe_footer',
  );
  if (!footer) return html;
  const href = renderUrl(footer.unsubscribeUrl, context);
  if (!href || html.includes(href)) return html;
  const footerHtml = [
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px">',
    '<tbody><tr><td style="border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:18px;padding:20px 0 0">',
    `<p style="margin:0 0 8px">${renderHtml(footer.body, context)}</p>`,
    `<a href="${escapeHtmlAttribute(href)}" style="color:#475569;text-decoration:underline">Manage preferences</a>`,
    '</td></tr></tbody></table>',
  ].join('');
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${footerHtml}</body>`);
  }
  return `${html}${footerHtml}`;
}

function appendEditorUnsubscribeText(
  text: string,
  document: EmailTemplateDocument,
  context: MergeTagContext,
): string {
  if (document.settings.category !== 'bulk') return text;
  const footer = document.blocks.find(
    (block): block is Extract<EmailTemplateBlock, { type: 'unsubscribe_footer' }> =>
      block.type === 'unsubscribe_footer',
  );
  if (!footer) return text;
  const href = renderUrl(footer.unsubscribeUrl, context);
  if (!href || text.includes(href)) return text;
  const footerText = [renderPlain(footer.body, context), `Manage preferences: ${href}`]
    .filter(Boolean)
    .join('\n');
  return [text.trim(), footerText].filter(Boolean).join('\n\n');
}

export function createEmailTestSend(
  document: EmailTemplateDocument,
  rendered: RenderedEmailTemplate,
  input: EmailTestSendInput,
): SendEmailInput {
  return {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    brandId: input.brandId,
    templateKey: document.settings.templateKey,
    templateVersionId: input.templateVersionId,
    deliveryId: input.deliveryId,
    from: {
      email: document.settings.sender.fromEmail ?? 'noreply@example.test',
      name: document.settings.sender.fromName,
    },
    to: input.to,
    replyTo: document.settings.sender.replyToEmail
      ? { email: document.settings.sender.replyToEmail }
      : undefined,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    providerRouteId: input.providerRouteId,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata ?? {
      notificationType: document.settings.category,
    },
  };
}

function EmailTemplate({
  blocks,
  context,
  previewText,
}: {
  blocks: EmailTemplateBlock[];
  context: MergeTagContext;
  previewText?: string;
}) {
  return React.createElement(
    Html,
    { lang: 'en' },
    React.createElement(Head),
    previewText ? React.createElement(Preview, null, previewText) : undefined,
    React.createElement(
      Body,
      { style: { backgroundColor: '#f8fafc', fontFamily: 'Arial, sans-serif' } },
      React.createElement(
        Container,
        { style: defaultContainerStyle },
        blocks.map((block, index) =>
          React.createElement(
            React.Fragment,
            { key: `${block.type}-${index}` },
            renderBlock(block, context),
          ),
        ),
      ),
    ),
  );
}

function renderBlock(block: EmailTemplateBlock, context: MergeTagContext): React.ReactNode {
  switch (block.type) {
    case 'event_hero': {
      const imageUrl = block.imageUrl ? renderUrl(block.imageUrl, context).trim() : '';
      return React.createElement(
        Section,
        { style: { backgroundColor: '#ffffff', borderRadius: '8px', padding: '28px' } },
        imageUrl
          ? React.createElement(Img, {
              alt: block.imageAlt ?? '',
              src: imageUrl,
              style: { borderRadius: '6px', marginBottom: '20px', width: '100%' },
            })
          : undefined,
        React.createElement(Heading, { as: 'h1' }, renderPlain(block.headline, context)),
        block.body
          ? React.createElement(Text, { style: paragraphStyle }, renderPlain(block.body, context))
          : undefined,
        block.ctaLabel && block.ctaUrl
          ? React.createElement(
              Button,
              { href: renderUrl(block.ctaUrl, context), style: buttonStyle },
              renderPlain(block.ctaLabel, context),
            )
          : undefined,
      );
    }
    case 'ticket_summary':
      return React.createElement(
        Section,
        { style: { backgroundColor: '#ffffff', padding: '24px 28px' } },
        React.createElement(Heading, { as: 'h2' }, renderPlain(block.title, context)),
        React.createElement(Text, { style: paragraphStyle }, renderPlain(block.body, context)),
      );
    case 'order_summary':
      return React.createElement(
        Section,
        { style: { backgroundColor: '#ffffff', padding: '24px 28px' } },
        React.createElement(Heading, { as: 'h2' }, renderPlain(block.title, context)),
        block.rows.map((row) =>
          React.createElement(
            Text,
            { key: `${row.label}-${row.value}`, style: paragraphStyle },
            `${renderPlain(row.label, context)}: ${renderPlain(row.value, context)}`,
          ),
        ),
      );
    case 'qr_code': {
      const imageUrl = renderUrl(block.imageUrl, context).trim();
      return React.createElement(
        Section,
        { style: { backgroundColor: '#ffffff', padding: '24px 28px', textAlign: 'center' } },
        React.createElement(Heading, { as: 'h2' }, renderPlain(block.title, context)),
        imageUrl
          ? React.createElement(Img, {
              alt: block.imageAlt ?? '',
              src: imageUrl,
              style: { margin: '0 auto', maxWidth: '220px' },
            })
          : undefined,
      );
    }
    case 'calendar_button':
      return React.createElement(
        Section,
        { style: { backgroundColor: '#ffffff', padding: '24px 28px' } },
        React.createElement(
          Button,
          { href: renderUrl(block.url, context), style: buttonStyle },
          renderPlain(block.label, context),
        ),
      );
    case 'venue_block':
      return React.createElement(
        Section,
        { style: { backgroundColor: '#ffffff', padding: '24px 28px' } },
        React.createElement(Heading, { as: 'h2' }, renderPlain(block.title, context)),
        React.createElement(Text, { style: paragraphStyle }, renderPlain(block.address, context)),
        block.mapUrl
          ? React.createElement(Link, { href: renderUrl(block.mapUrl, context) }, 'Open map')
          : undefined,
      );
    case 'social_links':
      return React.createElement(
        Section,
        { style: { backgroundColor: '#ffffff', padding: '24px 28px' } },
        block.links.map((link) =>
          React.createElement(
            Link,
            { href: renderUrl(link.url, context), key: `${link.label}-${link.url}` },
            renderPlain(link.label, context),
          ),
        ),
      );
    case 'unsubscribe_footer':
      return React.createElement(
        Section,
        { style: { color: '#64748b', fontSize: '12px', padding: '20px 28px' } },
        React.createElement(Hr),
        React.createElement(Text, null, renderPlain(block.body, context)),
        React.createElement(
          Link,
          { href: renderUrl(block.unsubscribeUrl, context) },
          'Manage preferences',
        ),
      );
    case 'raw_html':
      return React.createElement('div', {
        dangerouslySetInnerHTML: { __html: block.safe ? block.html : '' },
        style: { backgroundColor: '#ffffff', padding: '24px 28px' },
      });
  }
}

function collectTemplateStrings(document: EmailTemplateDocument): string[] {
  const values = [
    document.settings.subject,
    document.settings.previewText ?? '',
    document.settings.sender.fromName ?? '',
    document.editor.contentHtml,
    document.editor.contentText ?? '',
    document.editor.globalCss ?? '',
  ];
  if (document.editor.contentJson) {
    return values.filter(Boolean);
  }
  for (const block of document.blocks) {
    values.push(...stringsFromBlock(block));
  }
  return values.filter(Boolean);
}

function validateRequiredMergeTags(template: string): ContentValidationIssue[] {
  const result = validateMergeTags(template);
  return result.missingRequired.map(
    (tag): ContentValidationIssue => ({
      code: 'missing_required_variable',
      message: `Required merge tag {{${tag}}} must appear in rendered email content`,
      severity: 'error',
      field: tag,
    }),
  );
}

/**
 * Check that the email template includes every merge-tag variable the lifecycle
 * registry marks as required for its template key. Returns error-severity issues
 * for any missing required variable. Custom/unknown keys produce no issues.
 */
export function getEmailTemplateLifecycleIssues(
  document: EmailTemplateDocument,
): ContentValidationIssue[] {
  const lifecycle = getTemplateLifecycle(document.settings.templateKey as TemplateKey);
  if (!lifecycle) return [];
  const content = collectTemplateStrings(document).join('\n');
  return lifecycle.requiredVariables
    .filter((variable) => !content.includes(`{{${variable}}}`))
    .map(
      (variable): ContentValidationIssue => ({
        code: 'missing_lifecycle_variable',
        message: `{{${variable}}} is required for ${lifecycle.name} (${lifecycle.family})`,
        severity: 'error',
        field: variable,
      }),
    );
}

function stringsFromBlock(block: EmailTemplateBlock): string[] {
  switch (block.type) {
    case 'event_hero':
      return [
        block.headline,
        block.body ?? '',
        block.imageUrl ?? '',
        block.imageAlt ?? '',
        block.ctaLabel ?? '',
        block.ctaUrl ?? '',
      ];
    case 'ticket_summary':
      return [block.title, block.body];
    case 'order_summary':
      return [block.title, ...block.rows.flatMap((row) => [row.label, row.value])];
    case 'qr_code':
      return [block.title, block.imageUrl, block.imageAlt ?? ''];
    case 'calendar_button':
      return [block.label, block.url];
    case 'venue_block':
      return [block.title, block.address, block.mapUrl ?? ''];
    case 'social_links':
      return block.links.flatMap((link) => [link.label, link.url]);
    case 'unsubscribe_footer':
      return [block.body, block.unsubscribeUrl];
    case 'raw_html':
      return [block.html];
  }
}

function validateLinks(
  document: EmailTemplateDocument,
  allowPrivate: boolean,
): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  for (const link of linkFields(document)) {
    const withExampleContext = decodeHtmlAttributeValue(renderUrl(link.url, sampleContext()));
    if (!isAllowedDestination(withExampleContext, allowPrivate)) {
      issues.push({
        code: 'unsafe_link',
        message: `${link.field} must be an http(s) URL and may not target private hosts`,
        severity: 'error',
        field: link.field,
      });
    }
  }
  return issues;
}

function validateImageSources(
  document: EmailTemplateDocument,
  allowPrivate: boolean,
): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  for (const image of imageSourceFields(document)) {
    const withExampleContext = decodeHtmlAttributeValue(renderUrl(image.url, sampleContext()));
    if (!isAllowedDestination(withExampleContext, allowPrivate)) {
      issues.push({
        code: 'unsafe_image',
        message: `${image.field} must be an http(s) URL and may not target private hosts`,
        severity: 'error',
        field: image.field,
      });
    }
  }
  return issues;
}

function validateHtmlSafety(
  html: string,
  issue: Pick<ContentValidationIssue, 'code' | 'field' | 'message'> & {
    allowEmailDocumentShell?: boolean;
  },
): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  const blockedElementPattern = issue.allowEmailDocumentShell
    ? /<\s*(?:script|iframe|object|embed|form|input|button|base|svg|math|template|link)\b/i
    : /<\s*(?:script|iframe|object|embed|form|input|button|base|svg|math|style|template|meta|link)\b/i;
  if (blockedElementPattern.test(html)) {
    issues.push({
      code: issue.code,
      message: issue.message,
      severity: 'error',
      field: issue.field,
    });
  }
  if (/[\s/]+on[a-z][a-z0-9_-]*\s*=/i.test(html)) {
    issues.push({
      code: issue.code,
      message: issue.message,
      severity: 'error',
      field: issue.field,
    });
  }
  if (/[\s/]+(?:srcdoc|[a-z][\w-]*:[\w-]+)\s*=/i.test(html)) {
    issues.push({
      code: issue.code,
      message: issue.message,
      severity: 'error',
      field: issue.field,
    });
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const styleContent = decodeHtmlAttributeValue(match[1] ?? '');
    if (
      !/(?:expression\s*\(|url\s*\(\s*['"]?\s*(?:javascript|data|vbscript):)/i.test(styleContent)
    ) {
      continue;
    }
    issues.push({
      code: issue.code,
      message: issue.message,
      severity: 'error',
      field: issue.field,
    });
    break;
  }
  for (const match of html.matchAll(/[\s/]+style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const styleValue = decodeHtmlAttributeValue(match[1] ?? match[2] ?? match[3] ?? '');
    if (!/(?:expression\s*\(|url\s*\(\s*['"]?\s*(?:javascript|data|vbscript):)/i.test(styleValue)) {
      continue;
    }
    issues.push({
      code: issue.code,
      message: issue.message,
      severity: 'error',
      field: issue.field,
    });
    break;
  }
  return issues;
}

function validateImageAlts(document: EmailTemplateDocument): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  document.blocks.forEach((block, index) => {
    if (block.type === 'event_hero' && block.imageUrl && !block.imageAlt?.trim()) {
      issues.push({
        code: 'missing_image_alt',
        message: 'Hero images require alt text',
        severity: 'error',
        field: `blocks.${index}.imageAlt`,
      });
    }
    if (block.type === 'qr_code' && !block.imageAlt?.trim()) {
      issues.push({
        code: 'missing_image_alt',
        message: 'QR-code images require alt text',
        severity: 'error',
        field: `blocks.${index}.imageAlt`,
      });
    }
  });
  return issues;
}

function validateEditorImageAlts(html: string): ContentValidationIssue[] {
  const issues: ContentValidationIssue[] = [];
  const imageTagPattern = /<img\b[^>]*>/gi;
  let imageIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = imageTagPattern.exec(html))) {
    const imageTag = match[0];
    const altMatch = /[\s/]+alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(imageTag);
    const altText = decodeHtmlAttributeValue(altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? '');
    if (!altText.trim()) {
      issues.push({
        code: 'missing_image_alt',
        message: 'Editor images require alt text before publish',
        severity: 'error',
        field: `editor.contentHtml.images.${imageIndex}.alt`,
      });
    }
    imageIndex += 1;
  }

  return issues;
}

function linkFields(document: EmailTemplateDocument): { field: string; url: string }[] {
  const links: { field: string; url: string }[] = [];
  document.blocks.forEach((block, index) => {
    if (block.type === 'event_hero' && block.ctaUrl) {
      links.push({ field: `blocks.${index}.ctaUrl`, url: block.ctaUrl });
    }
    if (block.type === 'calendar_button') {
      links.push({ field: `blocks.${index}.url`, url: block.url });
    }
    if (block.type === 'venue_block' && block.mapUrl) {
      links.push({ field: `blocks.${index}.mapUrl`, url: block.mapUrl });
    }
    if (block.type === 'social_links') {
      block.links.forEach((link, linkIndex) => {
        links.push({ field: `blocks.${index}.links.${linkIndex}.url`, url: link.url });
      });
    }
    if (block.type === 'unsubscribe_footer') {
      links.push({ field: `blocks.${index}.unsubscribeUrl`, url: block.unsubscribeUrl });
    }
    if (block.type === 'raw_html') {
      links.push(...htmlLinkFields(block.html, `blocks.${index}.html`));
    }
  });
  links.push(...htmlLinkFields(document.editor.contentHtml, 'editor.contentHtml'));
  return links;
}

function imageSourceFields(document: EmailTemplateDocument): { field: string; url: string }[] {
  const images: { field: string; url: string }[] = [];
  document.blocks.forEach((block, index) => {
    if (block.type === 'event_hero' && block.imageUrl) {
      images.push({ field: `blocks.${index}.imageUrl`, url: block.imageUrl });
    }
    if (block.type === 'qr_code') {
      images.push({ field: `blocks.${index}.imageUrl`, url: block.imageUrl });
    }
  });
  return images;
}

function htmlLinkFields(html: string, field: string): { field: string; url: string }[] {
  const links: { field: string; url: string }[] = [];
  const attributePattern =
    /[\s/]+(?:href|src|data|action|formaction|xlink:href)\s*=\s*(?:(['"])(.*?)\1|([^\s"'=<>`]+))/gi;
  for (const match of html.matchAll(attributePattern)) {
    links.push({ field, url: match[2] ?? match[3] ?? '' });
  }
  return links;
}

function decodeHtmlAttributeValue(value: string): string {
  return value.replace(
    /&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z][a-z0-9]+));?/gi,
    (_entity, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (hex) return htmlCodePointEntity(hex, 16);
      if (decimal) return htmlCodePointEntity(decimal, 10);
      switch (named?.toLowerCase()) {
        case 'amp':
          return '&';
        case 'colon':
          return ':';
        case 'tab':
          return '\t';
        case 'newline':
          return '\n';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return '';
      }
    },
  );
}

function htmlCodePointEntity(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return '';
  }
  return String.fromCodePoint(codePoint);
}

function hasUnsubscribeFooter(document: EmailTemplateDocument): boolean {
  return document.blocks.some(
    (block) => block.type === 'unsubscribe_footer' && Boolean(block.unsubscribeUrl.trim()),
  );
}

function isEmailTemplateCategory(value: unknown): value is EmailTemplateCategory {
  return value === 'transactional' || value === 'bulk' || value === 'staff' || value === 'system';
}

function isEmailTemplateBlock(value: unknown): value is EmailTemplateBlock {
  if (!value || typeof value !== 'object') return false;
  const block = value as Record<string, unknown>;
  switch (block.type) {
    case 'event_hero':
      return (
        typeof block.headline === 'string' &&
        optionalString(block.body) &&
        optionalString(block.imageUrl) &&
        optionalString(block.imageAlt) &&
        optionalString(block.ctaLabel) &&
        optionalString(block.ctaUrl)
      );
    case 'ticket_summary':
      return typeof block.title === 'string' && typeof block.body === 'string';
    case 'order_summary':
      return (
        typeof block.title === 'string' &&
        Array.isArray(block.rows) &&
        block.rows.every(
          (row) =>
            row &&
            typeof row === 'object' &&
            typeof (row as Record<string, unknown>).label === 'string' &&
            typeof (row as Record<string, unknown>).value === 'string',
        )
      );
    case 'qr_code':
      return (
        typeof block.title === 'string' &&
        typeof block.imageUrl === 'string' &&
        optionalString(block.imageAlt)
      );
    case 'calendar_button':
      return typeof block.label === 'string' && typeof block.url === 'string';
    case 'venue_block':
      return (
        typeof block.title === 'string' &&
        typeof block.address === 'string' &&
        optionalString(block.mapUrl)
      );
    case 'social_links':
      return (
        Array.isArray(block.links) &&
        block.links.every(
          (link) =>
            link &&
            typeof link === 'object' &&
            typeof (link as Record<string, unknown>).label === 'string' &&
            typeof (link as Record<string, unknown>).url === 'string',
        )
      );
    case 'unsubscribe_footer':
      return typeof block.body === 'string' && typeof block.unsubscribeUrl === 'string';
    case 'raw_html':
      return typeof block.html === 'string' && typeof block.safe === 'boolean';
    default:
      return false;
  }
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function renderPlain(template: string, context: MergeTagContext): string {
  return renderMergeTags(template, context, { channel: 'email', escape: 'plain' });
}

function renderHtml(template: string, context: MergeTagContext): string {
  return renderMergeTags(template, context, { channel: 'email', escape: 'html' });
}

function renderUrl(template: string, context: MergeTagContext): string {
  return renderMergeTags(template, context, { channel: 'email', escape: 'plain' });
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function plainTextFromHtml(html: string): string {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function sampleContext(): MergeTagContext {
  return {
    event: {
      title: 'All Access Chicago',
      startsAt: '2026-07-17 19:00',
      endsAt: '2026-07-17 23:00',
      timezone: 'America/Chicago',
      venueName: 'The Grand Hall',
      venueCity: 'Brooklyn',
      publicUrl: 'https://events.example.test/e/all-access-chicago',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
      doorTime: '2026-07-17 18:00',
      mapUrl: 'https://maps.example.test/the-grand-hall',
      refundPolicyUrl: 'https://help.example.test/refunds',
      changeSummary: 'Venue moved to The Forum',
      cancellationReason: 'Unforeseen weather',
    },
    brand: {
      name: 'Tixkit',
      supportUrl: 'https://help.example.test',
    },
    recipient: {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
      phone: '+15551234567',
    },
    ticket: {
      type: 'General Admission',
      code: 'TKT-123',
      qrCodeUrl: 'https://tickets.example.test/qr/TKT-123.png',
      pdfUrl: 'https://tickets.example.test/pdf/TKT-123.pdf',
      walletAppleUrl: 'https://tickets.example.test/pass/apple/TKT-123.pkpass',
      walletGoogleUrl: 'https://pay.google.com/gp/v/save/abc123',
    },
    order: {
      id: 'ord_123',
      total: '$35.00',
      manageUrl: 'https://checkout.example.test/orders/ord_123',
      receiptUrl: 'https://checkout.example.test/receipts/ord_123',
      retryUrl: 'https://checkout.example.test/checkout?retry=ord_123',
      cancellationReason: 'Cancelled by organizer',
      creditStatus: 'Full credit issued',
      buyerName: 'Ada Lovelace',
      buyerEmail: 'ada@example.test',
    },
    refund: {
      amount: '$20.00',
      processingEta: '5-10 business days',
      processedAt: '2026-07-10 12:00',
    },
    device: {
      inviteUrl: 'https://scan.example.test/invite/dev_1',
      permissionScope: 'checkins.write',
      expiresAt: '2026-07-17 19:00',
    },
    dashboard: { url: 'https://admin.example.test/events/evt_demo_001' },
    waitlist: {
      position: '3',
      inviteUrl: 'https://checkout.example.test/waitlist/claim/demo',
      expiresAt: '2026-07-17 20:00',
    },
  };
}

function dedupeIssues(issues: ContentValidationIssue[]): ContentValidationIssue[] {
  const seen = new Set<string>();
  const unique: ContentValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}:${issue.field ?? ''}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(issue);
  }
  return unique;
}

export function validateEditorExport(html: string): ContentValidationResult {
  const result = validateMergeTags(html);
  const issues = result.unknownTags.map(
    (tag): ContentValidationIssue => ({
      code: 'unknown_variable',
      message: `Unknown merge tag {{${tag}}} — add it to the registry or remove it`,
      severity: 'error',
      field: tag,
    }),
  );
  return {
    valid: issues.length === 0,
    severity: issues.length > 0 ? 'error' : 'warning',
    issues,
  };
}

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
  type MergeTagContext,
  type SendEmailInput,
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
      templateKey: 'order-confirmed',
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

  for (const issue of validateHtmlSafety(document.editor.contentHtml, {
    code: 'unsafe_editor_html',
    field: 'editor.contentHtml',
    message: 'Editor HTML may not contain active HTML, scripting attributes, or unsafe URLs',
    allowEmailDocumentShell: true,
  })) {
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
    const editorHtml = renderHtml(document.editor.contentHtml, context);
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
      publicUrl: 'https://events.example.test/e/all-access-chicago',
      checkoutUrl: 'https://checkout.example.test/checkout?eventId=evt_demo_001',
    },
    brand: {
      name: 'Tixkit',
      supportUrl: 'https://help.example.test',
    },
    recipient: {
      name: 'Ada Lovelace',
      email: 'ada@example.test',
    },
    ticket: {
      type: 'General Admission',
      code: 'TKT-123',
      qrCodeUrl: 'https://tickets.example.test/qr/TKT-123.png',
    },
    order: {
      id: 'ord_123',
      total: '$35.00',
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

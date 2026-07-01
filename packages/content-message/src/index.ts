import {
  validateContentVersion,
  type ContentValidationIssue,
  type ContentValidationResult,
} from '@tixkit/content-core';
import {
  countSmsSegments,
  detectEncoding,
  estimateSmsCost,
  injectOptOutToken,
  isAllowedDestination,
  renderMergeTags,
  validateMergeTags,
  type MergeTagContext,
  type SendSmsInput,
} from '@tixkit/domain';

export const SMS_TEMPLATE_SCHEMA_VERSION = 1 as const;
export const SMS_TEMPLATE_COMPOSER = '@tixkit/content-message/sms-composer' as const;

export type SmsTemplateCategory = 'transactional' | 'bulk' | 'staff' | 'system';

export type SmsConsentCategory = 'transactional' | 'marketing' | 'staff' | 'system';

export type SmsTemplateSettings = {
  templateKey: string;
  locale: string;
  category: SmsTemplateCategory;
  consentCategory: SmsConsentCategory;
  segmentLimit: number;
  estimatedCostPerSegmentCents: number;
  optOutText?: string;
};

export type SmsTemplateDocument = {
  schemaVersion: typeof SMS_TEMPLATE_SCHEMA_VERSION;
  editor: {
    provider: typeof SMS_TEMPLATE_COMPOSER;
    body: string;
  };
  settings: SmsTemplateSettings;
  shortLinks: SmsShortLinkSuggestion[];
};

export type SmsTemplateDocumentOverrides = Partial<
  Omit<SmsTemplateDocument, 'editor' | 'settings'>
> & {
  editor?: Partial<SmsTemplateDocument['editor']>;
  settings?: Partial<SmsTemplateSettings>;
};

export type SmsShortLinkSuggestion = {
  originalUrl: string;
  reason: 'long_url' | 'unsafe_url';
  field: string;
};

export type SmsTemplateValidationOptions = {
  allowPrivateLinks?: boolean;
};

export type SmsRenderOptions = SmsTemplateValidationOptions & {
  optOutToken?: string;
  fallback?: string;
};

export type RenderedSmsTemplate = {
  text: string;
  encoding: 'gsm' | 'unicode';
  segments: number;
  charsPerSegment: number;
  unitsUsed: number;
  remaining: number;
  estimatedCostCents: number;
  validation: ContentValidationResult;
  shortLinks: SmsShortLinkSuggestion[];
};

export type SmsTestSendInput = {
  tenantId: string;
  organizationId: string;
  brandId: string;
  jobId: string;
  templateVersionId: string;
  providerRouteId: string;
  deliveryId: string;
  from: string;
  to: string;
  idempotencyKey: string;
  metadata?: SendSmsInput['metadata'];
};

const urlPattern = /\bhttps?:\/\/[^\s<>"')]+/gi;

export function createDefaultSmsTemplate(
  overrides: SmsTemplateDocumentOverrides = {},
): SmsTemplateDocument {
  const base: SmsTemplateDocument = {
    schemaVersion: SMS_TEMPLATE_SCHEMA_VERSION,
    editor: {
      provider: SMS_TEMPLATE_COMPOSER,
      body: 'Hi {{recipient.name}}, {{event.title}} starts {{event.startsAt}}. Tickets: {{event.checkoutUrl}}',
    },
    settings: {
      templateKey: 'event-update',
      locale: 'en',
      category: 'bulk',
      consentCategory: 'marketing',
      segmentLimit: 3,
      estimatedCostPerSegmentCents: 2,
      optOutText: 'Reply STOP to opt out',
    },
    shortLinks: [],
  };

  return {
    ...base,
    ...overrides,
    editor: { ...base.editor, ...overrides.editor },
    settings: { ...base.settings, ...overrides.settings },
    shortLinks: overrides.shortLinks ?? base.shortLinks,
  };
}

export function normalizeSmsTemplateDocument(value: unknown): SmsTemplateDocument | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== SMS_TEMPLATE_SCHEMA_VERSION) return undefined;
  if (!isRecord(value.editor) || value.editor.provider !== SMS_TEMPLATE_COMPOSER) return undefined;
  if (typeof value.editor.body !== 'string') return undefined;
  if (!isRecord(value.settings)) return undefined;
  const settings = value.settings;
  if (typeof settings.templateKey !== 'string' || settings.templateKey.trim().length === 0) {
    return undefined;
  }
  if (typeof settings.locale !== 'string' || settings.locale.trim().length === 0) {
    return undefined;
  }
  if (!isSmsCategory(settings.category)) return undefined;
  if (!isConsentCategory(settings.consentCategory)) return undefined;
  if (!isPositiveInteger(settings.segmentLimit)) return undefined;
  if (!isNonNegativeInteger(settings.estimatedCostPerSegmentCents)) return undefined;
  if (settings.optOutText !== undefined && typeof settings.optOutText !== 'string') {
    return undefined;
  }
  const shortLinks = Array.isArray(value.shortLinks)
    ? value.shortLinks.filter(isShortLinkSuggestion)
    : [];

  return {
    schemaVersion: SMS_TEMPLATE_SCHEMA_VERSION,
    editor: {
      provider: SMS_TEMPLATE_COMPOSER,
      body: value.editor.body,
    },
    settings: {
      templateKey: settings.templateKey,
      locale: settings.locale,
      category: settings.category,
      consentCategory: settings.consentCategory,
      segmentLimit: settings.segmentLimit,
      estimatedCostPerSegmentCents: settings.estimatedCostPerSegmentCents,
      optOutText: settings.optOutText,
    },
    shortLinks,
  };
}

export function validateSmsTemplate(
  document: SmsTemplateDocument,
  options: SmsTemplateValidationOptions = {},
): ContentValidationResult {
  const issues: ContentValidationIssue[] = [];
  const body = document.editor.body;
  const optOutText = document.settings.optOutText?.trim();
  const validationText =
    requiresOptOut(document.settings) && optOutText ? injectOptOutToken(body, optOutText) : body;
  const baseSegments = countSmsSegments(validationText);
  const base = validateContentVersion(
    {
      renderedText: validationText,
      contentJson: document,
    },
    'sms',
    { smsSegmentLimit: document.settings.segmentLimit, smsSegmentCount: baseSegments.segments },
  );
  issues.push(...base.issues);

  if (!templateKeyIsSafe(document.settings.templateKey)) {
    issues.push({
      code: 'invalid_template_key',
      message:
        'SMS template keys must use lowercase letters, numbers, dots, underscores, or dashes',
      severity: 'error',
      field: 'settings.templateKey',
    });
  }

  if (requiresOptOut(document.settings) && !optOutText) {
    issues.push({
      code: 'missing_opt_out_token',
      message: 'Bulk SMS templates require opt-out text before publishing',
      severity: 'error',
      field: 'settings.optOutText',
    });
  }

  if (!consentMatchesCategory(document.settings.category, document.settings.consentCategory)) {
    issues.push({
      code: 'consent_category_mismatch',
      message: 'SMS consent category must match the template notification category',
      severity: 'error',
      field: 'settings.consentCategory',
    });
  }

  for (const suggestion of findShortLinkSuggestions(document, options.allowPrivateLinks ?? false)) {
    if (suggestion.reason === 'unsafe_url') {
      issues.push({
        code: 'unsafe_link',
        message: 'SMS links must be http(s) destinations and may not target private hosts',
        severity: 'error',
        field: suggestion.field,
      });
    } else {
      issues.push({
        code: 'short_link_recommended',
        message: 'Long SMS links should use Tixkit short links before sending',
        severity: 'warning',
        field: suggestion.field,
      });
    }
  }

  const uniqueIssues = dedupeIssues(issues);
  return {
    valid: uniqueIssues.every((issue) => issue.severity !== 'error'),
    severity: uniqueIssues.some((issue) => issue.severity === 'error') ? 'error' : 'warning',
    issues: uniqueIssues,
  };
}

export function renderSmsTemplate(
  document: SmsTemplateDocument,
  context: MergeTagContext,
  options: SmsRenderOptions = {},
): RenderedSmsTemplate {
  const validation = validateSmsTemplate(document, options);
  const optOutText = options.optOutToken ?? document.settings.optOutText;
  const personalized = renderMergeTags(document.editor.body, context, {
    channel: 'sms',
    escape: 'plain',
    fallback: options.fallback ?? '',
  });
  const text =
    requiresOptOut(document.settings) && optOutText
      ? injectOptOutToken(personalized, optOutText)
      : personalized;
  const segmentInfo = countSmsSegments(text);
  const cost = estimateSmsCost(text, document.settings.estimatedCostPerSegmentCents);
  const renderIssues: ContentValidationIssue[] = [...validation.issues];
  if (segmentInfo.segments > document.settings.segmentLimit) {
    renderIssues.push({
      code: 'segment_limit_exceeded',
      message: `Rendered SMS body is ${segmentInfo.segments} segments; limit is ${document.settings.segmentLimit}`,
      severity: 'error',
      field: 'renderedText',
    });
  }
  const uniqueIssues = dedupeIssues(renderIssues);
  const renderValidation: ContentValidationResult = {
    valid: uniqueIssues.every((issue) => issue.severity !== 'error'),
    severity: uniqueIssues.some((issue) => issue.severity === 'error') ? 'error' : 'warning',
    issues: uniqueIssues,
  };

  return {
    text,
    encoding: detectEncoding(text),
    segments: segmentInfo.segments,
    charsPerSegment: segmentInfo.charsPerSegment,
    unitsUsed: segmentInfo.unitsUsed,
    remaining: segmentInfo.remaining,
    estimatedCostCents: cost,
    validation: renderValidation,
    shortLinks: findShortLinkSuggestions(document, options.allowPrivateLinks ?? false),
  };
}

export function createSmsTestSend(
  document: SmsTemplateDocument,
  rendered: RenderedSmsTemplate,
  input: SmsTestSendInput,
): SendSmsInput {
  return {
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    brandId: input.brandId,
    jobId: input.jobId,
    deliveryId: input.deliveryId,
    from: input.from,
    to: input.to,
    body: rendered.text,
    providerRouteId: input.providerRouteId,
    idempotencyKey: input.idempotencyKey,
    notificationType: document.settings.category,
    metadata: input.metadata,
  };
}

export function findShortLinkSuggestions(
  document: SmsTemplateDocument,
  allowPrivateLinks = false,
): SmsShortLinkSuggestion[] {
  const suggestions: SmsShortLinkSuggestion[] = [];
  for (const url of document.editor.body.match(urlPattern) ?? []) {
    if (!isAllowedDestination(url, allowPrivateLinks)) {
      suggestions.push({ originalUrl: url, reason: 'unsafe_url', field: 'editor.body' });
      continue;
    }
    if (url.length > 40) {
      suggestions.push({ originalUrl: url, reason: 'long_url', field: 'editor.body' });
    }
  }
  return suggestions;
}

export function unknownSmsVariables(document: SmsTemplateDocument): string[] {
  return validateMergeTags(document.editor.body).unknownTags;
}

function requiresOptOut(settings: SmsTemplateSettings): boolean {
  return settings.category === 'bulk' || settings.consentCategory === 'marketing';
}

function consentMatchesCategory(
  category: SmsTemplateCategory,
  consentCategory: SmsConsentCategory,
): boolean {
  if (category === 'bulk') return consentCategory === 'marketing';
  if (category === 'transactional') return consentCategory === 'transactional';
  return category === consentCategory;
}

function templateKeyIsSafe(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(value);
}

function isSmsCategory(value: unknown): value is SmsTemplateCategory {
  return value === 'transactional' || value === 'bulk' || value === 'staff' || value === 'system';
}

function isConsentCategory(value: unknown): value is SmsConsentCategory {
  return (
    value === 'transactional' || value === 'marketing' || value === 'staff' || value === 'system'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isShortLinkSuggestion(value: unknown): value is SmsShortLinkSuggestion {
  if (!isRecord(value)) return false;
  return (
    typeof value.originalUrl === 'string' &&
    (value.reason === 'long_url' || value.reason === 'unsafe_url') &&
    typeof value.field === 'string'
  );
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

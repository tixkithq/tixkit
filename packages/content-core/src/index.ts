/**
 * @tixkit/content-core (C-083)
 *
 * The content-document/version foundation shared by every channel editor
 * (event page, email, SMS, future channels). Provides channel enums,
 * document/version schemas, validation result types, variable metadata,
 * render contracts, a channel adapter registry (C-089 seam), and fixtures.
 *
 * Personalization builds on the @tixkit/domain merge-tag engine: whitelisted
 * variables only, channel-specific escaping, missing-value fallbacks, and
 * unknown-variable publish blockers.
 */

import {
  MERGE_TAG_REGISTRY,
  validateMergeTags,
  type MergeTagVariable,
} from '@tixkit/domain';

export type ContentChannel = 'event_page' | 'email' | 'sms' | 'imessage' | 'social_invite';

export type ContentDocumentStatus = 'draft' | 'published' | 'archived';

export type ContentVersionStatus = 'draft' | 'published' | 'superseded';

export type ContentDocument = {
  id: string;
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId?: string;
  channel: ContentChannel;
  key: string;
  name: string;
  status: ContentDocumentStatus;
  locale: string;
  currentDraftVersionId?: string;
  publishedVersionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ContentVariableDefinition = {
  key: string;
  required: boolean;
  description?: string;
};

export type ValidationSeverity = 'error' | 'warning';

export type ContentValidationResult = {
  valid: boolean;
  severity: ValidationSeverity;
  issues: ContentValidationIssue[];
};

export type ContentValidationIssue = {
  code: string;
  message: string;
  severity: ValidationSeverity;
  field?: string;
};

export type ContentDocumentVersion = {
  id: string;
  documentId: string;
  versionNumber: number;
  status: ContentVersionStatus;
  schemaVersion: number;
  subject?: string;
  previewText?: string;
  contentJson: unknown;
  renderedHtml?: string;
  renderedText?: string;
  variables: ContentVariableDefinition[];
  validation: ContentValidationResult;
  createdBy: string;
  createdAt: string;
  publishedAt?: string;
};

export type RenderContract = {
  channel: ContentChannel;
  /** Output format the renderer must produce. */
  output: 'html' | 'text' | 'json';
  /** Escape mode for variable interpolation. */
  escape: 'html' | 'plain' | 'url';
  /** Whether opt-out token injection applies (SMS/bulk). */
  supportsOptOut: boolean;
  /** Whether segment accounting applies (SMS). */
  supportsSegmentAccounting: boolean;
};

export const RENDER_CONTRACTS: Record<ContentChannel, RenderContract> = {
  event_page: {
    channel: 'event_page',
    output: 'html',
    escape: 'html',
    supportsOptOut: false,
    supportsSegmentAccounting: false,
  },
  email: {
    channel: 'email',
    output: 'html',
    escape: 'html',
    supportsOptOut: false,
    supportsSegmentAccounting: false,
  },
  sms: {
    channel: 'sms',
    output: 'text',
    escape: 'plain',
    supportsOptOut: true,
    supportsSegmentAccounting: true,
  },
  imessage: {
    channel: 'imessage',
    output: 'json',
    escape: 'plain',
    supportsOptOut: true,
    supportsSegmentAccounting: false,
  },
  social_invite: {
    channel: 'social_invite',
    output: 'text',
    escape: 'plain',
    supportsOptOut: false,
    supportsSegmentAccounting: false,
  },
};

export const CONTENT_SCHEMA_VERSION = 1;

export const SUPPORTED_CONTENT_CHANNELS: readonly ContentChannel[] = [
  'event_page',
  'email',
  'sms',
];

/** Channels that are stubbed and fail closed until explicitly enabled (C-089). */
export const STUBBED_CHANNELS: readonly ContentChannel[] = ['imessage', 'social_invite'];

// ---- Validation ----

/**
 * Validate a content version for publish. Reuses the merge-tag engine so
 * unknown variables block publish, and adds channel-specific blockers:
 * email requires a subject; sms requires renderedText within segment limits.
 */
export function validateContentVersion(
  version: {
    subject?: string;
    previewText?: string;
    renderedHtml?: string;
    renderedText?: string;
    contentJson: unknown;
  },
  channel: ContentChannel,
  options?: { smsSegmentLimit?: number; smsSegmentCount?: number },
): ContentValidationResult {
  const issues: ContentValidationIssue[] = [];

  // Variable validation against the whitelisted merge-tag registry.
  const templatesToCheck = [version.subject ?? '', version.renderedHtml ?? '', version.renderedText ?? ''];
  for (const template of templatesToCheck) {
    if (!template) continue;
    const tagResult = validateMergeTags(template);
    for (const tag of tagResult.unknownTags) {
      issues.push({
        code: 'unknown_variable',
        message: `Unknown merge tag {{${tag}}} — add it to the registry or remove it`,
        severity: 'error',
        field: tag,
      });
    }
  }

  if (channel === 'email') {
    if (!version.subject || version.subject.trim().length === 0) {
      issues.push({
        code: 'missing_subject',
        message: 'Email templates require a subject line before publishing',
        severity: 'error',
        field: 'subject',
      });
    }
  }

  if (channel === 'sms') {
    if (!version.renderedText || version.renderedText.trim().length === 0) {
      issues.push({
        code: 'missing_body',
        message: 'SMS templates require a text body before publishing',
        severity: 'error',
        field: 'renderedText',
      });
    }
    const limit = options?.smsSegmentLimit ?? 10;
    if (options?.smsSegmentCount !== undefined && options.smsSegmentCount > limit) {
      issues.push({
        code: 'segment_limit_exceeded',
        message: `SMS body is ${options.smsSegmentCount} segments; limit is ${limit}`,
        severity: 'error',
        field: 'renderedText',
      });
    }
  }

  if (STUBBED_CHANNELS.includes(channel)) {
    issues.push({
      code: 'channel_unavailable',
      message: `Channel ${channel} is not yet available`,
      severity: 'error',
    });
  }

  const valid = issues.filter((i) => i.severity === 'error').length === 0;
  return { valid, severity: valid ? 'warning' : 'error', issues };
}

// ---- Document status state machine ----

const DOCUMENT_TRANSITIONS: Record<ContentDocumentStatus, Set<ContentDocumentStatus>> = {
  draft: new Set(['draft', 'published', 'archived']),
  published: new Set(['published', 'archived', 'draft']),
  archived: new Set(['draft', 'archived']),
};

export function transitionDocumentStatus(
  current: ContentDocumentStatus,
  next: ContentDocumentStatus,
): ContentDocumentStatus {
  if (!DOCUMENT_TRANSITIONS[current].has(next)) {
    throw new ContentError(`Cannot transition a ${current} document to ${next}`);
  }
  return next;
}

export class ContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContentError';
  }
}

// ---- Channel adapter registry (C-089 seam) ----

export type ChannelAdapter = {
  channel: ContentChannel;
  available: boolean;
  renderContract: RenderContract;
};

export class ChannelAdapterRegistry {
  private readonly adapters = new Map<ContentChannel, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  get(channel: ContentChannel): ChannelAdapter | undefined {
    return this.adapters.get(channel);
  }

  isAvailable(channel: ContentChannel): boolean {
    return this.adapters.get(channel)?.available ?? false;
  }

  /** Fail closed: stubbed channels are unavailable unless explicitly enabled. */
  assertAvailable(channel: ContentChannel): void {
    if (!this.isAvailable(channel)) {
      throw new ContentError(`Channel ${channel} is not available`);
    }
  }
}

export function createDefaultChannelRegistry(): ChannelAdapterRegistry {
  const registry = new ChannelAdapterRegistry();
  for (const channel of SUPPORTED_CONTENT_CHANNELS) {
    registry.register({ channel, available: true, renderContract: RENDER_CONTRACTS[channel] });
  }
  for (const channel of STUBBED_CHANNELS) {
    registry.register({ channel, available: false, renderContract: RENDER_CONTRACTS[channel] });
  }
  return registry;
}

// ---- Variable metadata (reuses the merge-tag registry) ----

export function variableDefinitionsForChannel(_channel: ContentChannel): ContentVariableDefinition[] {
  // All channels share the base merge-tag vocabulary; SMS adds opt-out implicitly.
  return MERGE_TAG_REGISTRY.map((v: MergeTagVariable) => ({
    key: v.key,
    required: Boolean(v.required),
    description: v.description,
  }));
}

// ---- Fixtures ----

export function fixtureEmailDocument(overrides: Partial<ContentDocument> = {}): ContentDocument {
  return {
    id: 'cdoc_email_1',
    tenantId: 'tnt_1',
    organizationId: 'org_1',
    brandId: 'br_1',
    channel: 'email',
    key: 'order-confirmed',
    name: 'Order confirmed',
    status: 'draft',
    locale: 'en',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

export function fixtureSmsDocument(overrides: Partial<ContentDocument> = {}): ContentDocument {
  return fixtureEmailDocument({
    id: 'cdoc_sms_1',
    channel: 'sms',
    key: 'attendee-message',
    name: 'Attendee message',
    ...overrides,
  });
}

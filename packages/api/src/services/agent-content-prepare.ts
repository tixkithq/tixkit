import {
  agentSha256,
  canonicalAgentJson,
  type ContentPreparePayload,
} from '@tixkit/agent-protocol';
import {
  PUCK_EVENT_PAGE_PROVIDER,
  createDefaultEventPageDocument,
  normalizeOrMigrateEventPageDocumentV2,
  resolveEventPageDocumentV2Discovery,
  validateEventPageDocumentV2,
  type CreateDefaultEventPageDocumentInput,
  type EventPageDocumentV2,
  type EventPageRenderContext,
} from '@tixkit/content-event-page';

const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_CONTENT_DEPTH = 24;
const MAX_COLLECTION_ITEMS = 1_000;
const MAX_STRING_BYTES = 100_000;

export interface AgentContentEventSnapshot {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  coverImageUrl: string | null;
}

export interface AgentPreparedContentPreview extends Readonly<Record<string, unknown>> {
  channel: 'event_page';
  content: Readonly<Record<string, unknown>>;
  preview: ContentPreparePayload['preview'];
  validation: ContentPreparePayload['validation'];
  contentPreviewSha256: string;
}

function assertInputBounds(
  value: unknown,
  field: string,
  depth = 0,
  ancestors = new WeakSet<object>(),
): void {
  if (depth > MAX_CONTENT_DEPTH) throw new Error(`AGENT_ACTION_${field}_INVALID`);
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES)
      throw new Error(`AGENT_ACTION_${field}_TOO_LARGE`);
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`AGENT_ACTION_${field}_INVALID`);
    return;
  }
  if (typeof value !== 'object') throw new Error(`AGENT_ACTION_${field}_INVALID`);
  if (ancestors.has(value)) throw new Error(`AGENT_ACTION_${field}_INVALID`);
  ancestors.add(value);
  const items = Array.isArray(value) ? value : Object.values(value);
  if (items.length > MAX_COLLECTION_ITEMS) throw new Error(`AGENT_ACTION_${field}_TOO_LARGE`);
  for (const item of items) assertInputBounds(item, field, depth + 1, ancestors);
  ancestors.delete(value);
}

function jsonRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`AGENT_ACTION_${field}_INVALID`);
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_CONTENT_BYTES)
    throw new Error(`AGENT_ACTION_${field}_TOO_LARGE`);
  const parsed: unknown = JSON.parse(serialized);
  assertInputBounds(parsed, field);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`AGENT_ACTION_${field}_INVALID`);
  return parsed as Readonly<Record<string, unknown>>;
}

function rawZones(value: Readonly<Record<string, unknown>>): unknown {
  const editor = value.editor;
  if (!editor || typeof editor !== 'object' || Array.isArray(editor)) return undefined;
  const data = (editor as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return (data as Record<string, unknown>).zones;
}

function assertSubmittedZones(value: Readonly<Record<string, unknown>>): void {
  const zones = rawZones(value);
  if (zones === undefined) return;
  if (!zones || typeof zones !== 'object' || Array.isArray(zones))
    throw new Error('AGENT_ACTION_CONTENT_INVALID');
  for (const items of Object.values(zones)) {
    if (!Array.isArray(items)) throw new Error('AGENT_ACTION_CONTENT_INVALID');
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('AGENT_ACTION_CONTENT_INVALID');
      if ('type' in item && item.type === 'CustomEmbed')
        throw new Error('AGENT_ACTION_CONTENT_UNSAFE');
    }
    if (items.length > 0) throw new Error('AGENT_ACTION_CONTENT_UNSUPPORTED');
  }
}

function assertSupportedZones(document: EventPageDocumentV2): void {
  const zones: unknown = document.editor.data.zones;
  if (zones === undefined) return;
  if (!zones || typeof zones !== 'object' || Array.isArray(zones))
    throw new Error('AGENT_ACTION_CONTENT_INVALID');
  for (const items of Object.values(zones)) {
    if (!Array.isArray(items)) throw new Error('AGENT_ACTION_CONTENT_INVALID');
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('AGENT_ACTION_CONTENT_INVALID');
      if ('type' in item && item.type === 'CustomEmbed')
        throw new Error('AGENT_ACTION_CONTENT_UNSAFE');
    }
    if (items.length > 0) throw new Error('AGENT_ACTION_CONTENT_UNSUPPORTED');
  }
}

function sanitizeAgainstTemplate(value: unknown, template: unknown): unknown {
  if (Array.isArray(template)) {
    if (!Array.isArray(value)) throw new Error('AGENT_ACTION_CONTENT_INVALID');
    if (value.length > 0) throw new Error('AGENT_ACTION_CONTENT_UNSUPPORTED');
    return [];
  }
  if (template && typeof template === 'object') {
    const source =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return Object.fromEntries(
      Object.entries(template as Record<string, unknown>).map(([key, fallback]) => [
        key,
        Object.hasOwn(source, key)
          ? sanitizeAgainstTemplate(source[key], fallback)
          : sanitizeAgainstTemplate(fallback, fallback),
      ]),
    );
  }
  if (template === undefined) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw new Error('AGENT_ACTION_CONTENT_INVALID');
    return value;
  }
  if (template === null) {
    if (value !== null) throw new Error('AGENT_ACTION_CONTENT_INVALID');
    return null;
  }
  if (typeof value !== typeof template) throw new Error('AGENT_ACTION_CONTENT_INVALID');
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new Error('AGENT_ACTION_CONTENT_INVALID');
  return value;
}

function canonicalizeSafeEventPage(
  document: EventPageDocumentV2,
  fallback: CreateDefaultEventPageDocumentInput,
): EventPageDocumentV2 {
  const template = createDefaultEventPageDocument(fallback);
  const templates = new Map<string, (typeof template.editor.data.content)[number]>(
    template.editor.data.content.map((item) => [item.type, item]),
  );
  const content = document.editor.data.content.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('AGENT_ACTION_CONTENT_INVALID');
    const candidate = item as { type?: unknown; props?: unknown };
    if (typeof candidate.type !== 'string') throw new Error('AGENT_ACTION_CONTENT_INVALID');
    const componentTemplate = templates.get(candidate.type);
    if (!componentTemplate) throw new Error('AGENT_ACTION_CONTENT_UNSUPPORTED');
    return sanitizeAgainstTemplate(candidate, componentTemplate) as typeof componentTemplate;
  });
  const sanitized = {
    schemaVersion: template.schemaVersion,
    editor: {
      provider: template.editor.provider,
      data: {
        root: sanitizeAgainstTemplate(document.editor.data.root, template.editor.data.root),
        content,
      },
    },
    settings: sanitizeAgainstTemplate(document.settings, template.settings),
  };
  return sanitized as EventPageDocumentV2;
}

function containsCustomEmbed(document: EventPageDocumentV2): boolean {
  const components = [
    ...document.editor.data.content,
    ...Object.values(document.editor.data.zones ?? {}).flat(),
  ];
  return components.some(
    (component) =>
      component !== null &&
      typeof component === 'object' &&
      !Array.isArray(component) &&
      'type' in component &&
      component.type === 'CustomEmbed',
  );
}

function fallbackForEvent(event: AgentContentEventSnapshot): CreateDefaultEventPageDocumentInput {
  return {
    eventId: event.id,
    eventTitle: event.title,
    eventDescription: event.description ?? undefined,
    startsAt: event.startsAt,
    endsAt: event.endsAt ?? undefined,
    timezone: event.timezone,
    coverImageUrl: event.coverImageUrl ?? undefined,
    coverImageAlt: event.title,
    publicUrl: `/e/${event.slug ?? event.id}`,
    locale: 'en',
  };
}

function contextForEvent(event: AgentContentEventSnapshot): EventPageRenderContext {
  return {
    event: {
      id: event.id,
      title: event.title,
      description: event.description ?? undefined,
      startsAt: event.startsAt,
      endsAt: event.endsAt ?? undefined,
      timezone: event.timezone,
      publicUrl: `/e/${event.slug ?? event.id}`,
    },
  };
}

export function prepareAgentEventPageContent(input: {
  event: AgentContentEventSnapshot;
  content: unknown;
}): AgentPreparedContentPreview {
  const submitted = jsonRecord(input.content, 'CONTENT');
  assertSubmittedZones(submitted);
  const fallback = fallbackForEvent(input.event);
  const normalized = normalizeOrMigrateEventPageDocumentV2(submitted, fallback);
  if (!normalized) throw new Error('AGENT_ACTION_CONTENT_INVALID');
  if (normalized.editor.data.content.length > 100)
    throw new Error('AGENT_ACTION_CONTENT_TOO_LARGE');
  assertSupportedZones(normalized);
  if (containsCustomEmbed(normalized)) throw new Error('AGENT_ACTION_CONTENT_UNSAFE');

  const canonical = canonicalizeSafeEventPage(normalized, fallback);
  const content = jsonRecord(canonical, 'CONTENT');
  const rawValidation = validateEventPageDocumentV2(canonical);
  const validation: ContentPreparePayload['validation'] = {
    valid: rawValidation.valid,
    severity: rawValidation.severity,
    issueCodes: [...new Set(rawValidation.issues.map((issue) => issue.code))].sort(),
  };
  const discovery = jsonRecord(
    resolveEventPageDocumentV2Discovery(canonical, contextForEvent(input.event)),
    'CONTENT_PREVIEW',
  );
  const preview: ContentPreparePayload['preview'] = {
    provider: PUCK_EVENT_PAGE_PROVIDER,
    discovery,
  };
  const projection = {
    channel: 'event_page' as const,
    content,
    preview,
    validation,
  };
  const contentPreviewSha256 = agentSha256(projection);
  if (
    Buffer.byteLength(canonicalAgentJson({ ...projection, contentPreviewSha256 }), 'utf8') >
    MAX_CONTENT_BYTES
  )
    throw new Error('AGENT_ACTION_CONTENT_TOO_LARGE');
  return { ...projection, contentPreviewSha256 };
}

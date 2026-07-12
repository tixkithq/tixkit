import { agentSha256, canonicalAgentJson, AgentProtocolValidationError } from './protocol.js';

export type AgentMemoryScopeType = 'workspace' | 'project' | 'event';
export type AgentMemoryPurpose = 'organizer_preferences' | 'project_context';
export type AgentMemoryProvenanceType = 'organizer' | 'agent_observation' | 'import';

export interface AgentMemoryNamespace {
  tenantId: string;
  sponsorPrincipalId: string;
  scopeType: AgentMemoryScopeType;
  scopeId?: string;
  purpose: AgentMemoryPurpose;
}

export interface AgentMemoryContent extends Readonly<Record<string, unknown>> {
  kind: AgentMemoryPurpose;
  summary: string;
  tone?: 'concise' | 'warm' | 'formal' | 'direct';
  verbosity?: 'brief' | 'standard' | 'detailed';
  locale?: string;
  timezone?: string;
  currency?: string;
  facts?: readonly { kind: 'objective' | 'constraint' | 'decision'; text: string }[];
}

export interface AgentMemoryProvenance {
  type: AgentMemoryProvenanceType;
  actorPrincipalId: string;
  agentPrincipalId?: string;
  sourceReference?: string;
  observedAt: string;
}

export interface AgentMemoryEntry {
  id: string;
  namespace: AgentMemoryNamespace;
  key: string;
  content: AgentMemoryContent;
  contentSha256: string;
  provenance: AgentMemoryProvenance;
  version: number;
  retentionExpiresAt: string;
  createdAt: string;
  updatedAt: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u;
const KEY = /^[a-z][a-z0-9_.-]{1,63}$/u;
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|cvv|cvc|card|pan|ssn|authorization|access[_-]?code|address|date[_-]?of[_-]?birth|buyer|customer)/iu;
const CREDENTIAL_VALUE = /(?:sk_(?:live|test)_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:bearer|basic)\s+[A-Za-z0-9+/._~=-]+)/iu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PHONE = /(?:\+?\d[\d .()-]{8,}\d)/u;
const LONG_DIGITS = /\b\d{12,19}\b/u;
const POSTAL_ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9 .'-]+\s(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct)\b/iu;
const BIRTH_DATE = /\b(?:date of birth|born on|birthday)\b/iu;
const FULL_NAME = /\b[A-Z][a-z]{1,30}\s+[A-Z][a-z]{1,30}\b/u;
const MAX_RETENTION_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_PROVENANCE_AGE_MS = 5 * 366 * 24 * 60 * 60 * 1000;
const FORMAT_OR_CONTROL = /[\p{Cc}\p{Cf}]/u;
const SOURCE_REFERENCE = /^(?:event|project|import|action|recommendation):[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/u;

function normalized(value: string): string {
  const result = value.normalize('NFKC');
  if (FORMAT_OR_CONTROL.test(result))
    throw new AgentProtocolValidationError('agent memory contains prohibited characters');
  return result;
}

function inspect(value: unknown, depth = 0): void {
  if (depth > 6) throw new AgentProtocolValidationError('agent memory content is too deep');
  if (typeof value === 'string') {
    const text = normalized(value);
    if (text.length > 2_000 || !/^[\x20-\x7E]*$/u.test(text) || CREDENTIAL_VALUE.test(text) ||
      EMAIL.test(text) || PHONE.test(text) || LONG_DIGITS.test(text) ||
      POSTAL_ADDRESS.test(text) || BIRTH_DATE.test(text) || FULL_NAME.test(text))
      throw new AgentProtocolValidationError('agent memory contains prohibited sensitive data');
    return;
  }
  if (value === null || typeof value === 'boolean' || Number.isSafeInteger(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 50) throw new AgentProtocolValidationError('agent memory array is too large');
    for (const item of value) inspect(item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new AgentProtocolValidationError('agent memory content is invalid');
  const entries = Object.entries(value);
  if (entries.length > 50) throw new AgentProtocolValidationError('agent memory object is too large');
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) || SENSITIVE_KEY.test(key))
      throw new AgentProtocolValidationError('agent memory key is prohibited');
    inspect(item, depth + 1);
  }
}

export function normalizeAgentMemoryContent(content: AgentMemoryContent): AgentMemoryContent {
  const allowed = content.kind === 'organizer_preferences'
    ? new Set(['kind', 'summary', 'tone', 'verbosity', 'locale', 'timezone', 'currency'])
    : new Set(['kind', 'summary', 'facts']);
  if (Object.keys(content).some((key) => !allowed.has(key)) ||
    !['organizer_preferences', 'project_context'].includes(content.kind))
    throw new AgentProtocolValidationError('agent memory content shape is invalid');
  const result: Record<string, unknown> = { kind: content.kind, summary: normalized(content.summary) };
  if (content.kind === 'organizer_preferences') {
    if (content.tone !== undefined && !['concise', 'warm', 'formal', 'direct'].includes(content.tone))
      throw new AgentProtocolValidationError('agent memory tone is invalid');
    if (content.verbosity !== undefined && !['brief', 'standard', 'detailed'].includes(content.verbosity))
      throw new AgentProtocolValidationError('agent memory verbosity is invalid');
    if (content.locale !== undefined) result.locale = normalized(content.locale);
    if (content.timezone !== undefined) result.timezone = normalized(content.timezone);
    if (content.currency !== undefined) result.currency = normalized(content.currency);
    if (content.tone !== undefined) result.tone = content.tone;
    if (content.verbosity !== undefined) result.verbosity = content.verbosity;
    if (result.locale !== undefined && !/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(String(result.locale)))
      throw new AgentProtocolValidationError('agent memory locale is invalid');
    if (result.timezone !== undefined && !/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/u.test(String(result.timezone)))
      throw new AgentProtocolValidationError('agent memory timezone is invalid');
    if (result.currency !== undefined && !/^[A-Z]{3}$/u.test(String(result.currency)))
      throw new AgentProtocolValidationError('agent memory currency is invalid');
  } else {
    if (content.facts !== undefined) {
      if (!Array.isArray(content.facts) || content.facts.length > 25)
        throw new AgentProtocolValidationError('agent memory facts are invalid');
      result.facts = content.facts.map((fact) => {
        if (!fact || !['objective', 'constraint', 'decision'].includes(fact.kind) ||
          typeof fact.text !== 'string')
          throw new AgentProtocolValidationError('agent memory fact is invalid');
        return { kind: fact.kind, text: normalized(fact.text) };
      });
    }
  }
  inspect(result);
  return result as AgentMemoryContent;
}

export function normalizeAgentMemoryProvenance(
  provenance: AgentMemoryProvenance,
): AgentMemoryProvenance {
  const allowed = provenance.type === 'organizer'
    ? new Set(['type', 'actorPrincipalId', 'observedAt'])
    : provenance.type === 'agent_observation'
      ? new Set(['type', 'actorPrincipalId', 'agentPrincipalId', 'sourceReference', 'observedAt'])
      : new Set(['type', 'actorPrincipalId', 'sourceReference', 'observedAt']);
  if (Object.keys(provenance).some((key) => !allowed.has(key)))
    throw new AgentProtocolValidationError('agent memory provenance shape is invalid');
  return { type: provenance.type, actorPrincipalId: provenance.actorPrincipalId,
    observedAt: provenance.observedAt,
    ...(provenance.agentPrincipalId === undefined ? {} :
      { agentPrincipalId: provenance.agentPrincipalId }),
    ...(provenance.sourceReference === undefined ? {} :
      { sourceReference: normalized(provenance.sourceReference) }) };
}

export function validateAgentMemoryNamespace(namespace: AgentMemoryNamespace): void {
  if (!ID.test(namespace.tenantId) || !ID.test(namespace.sponsorPrincipalId) ||
    !['workspace', 'project', 'event'].includes(namespace.scopeType) ||
    !['organizer_preferences', 'project_context'].includes(namespace.purpose) ||
    (namespace.scopeType === 'workspace' ? namespace.scopeId !== undefined :
      !namespace.scopeId || !ID.test(namespace.scopeId)))
    throw new AgentProtocolValidationError('agent memory namespace is invalid');
}

export function validateAgentMemoryWrite(input: { namespace: AgentMemoryNamespace; key: string;
  content: AgentMemoryContent; provenance: AgentMemoryProvenance;
  retentionExpiresAt: string; now: string }): string {
  validateAgentMemoryNamespace(input.namespace);
  const provenance = normalizeAgentMemoryProvenance(input.provenance);
  if (!KEY.test(input.key) || SENSITIVE_KEY.test(input.key) ||
    !ID.test(provenance.actorPrincipalId) ||
    !['organizer', 'agent_observation', 'import'].includes(provenance.type) ||
    !Number.isFinite(new Date(provenance.observedAt).getTime()) ||
    (provenance.sourceReference !== undefined && !SOURCE_REFERENCE.test(provenance.sourceReference)) ||
    (provenance.type === 'organizer' &&
      provenance.actorPrincipalId !== input.namespace.sponsorPrincipalId) ||
    (provenance.type === 'agent_observation' &&
      provenance.agentPrincipalId !== provenance.actorPrincipalId) ||
    (provenance.type === 'import' && provenance.sourceReference === undefined))
    throw new AgentProtocolValidationError('agent memory metadata is invalid');
  if (input.content.kind !== input.namespace.purpose)
    throw new AgentProtocolValidationError('agent memory purpose does not match content');
  const content = normalizeAgentMemoryContent(input.content);
  if (content.summary.trim().length < 1)
    throw new AgentProtocolValidationError('agent memory summary is required');
  const now = new Date(input.now).getTime();
  const expires = new Date(input.retentionExpiresAt).getTime();
  const observed = new Date(provenance.observedAt).getTime();
  if (!Number.isFinite(now) || !Number.isFinite(expires) || expires <= now ||
    expires - now > MAX_RETENTION_MS || observed > now || now - observed > MAX_PROVENANCE_AGE_MS)
    throw new AgentProtocolValidationError('agent memory retention is invalid');
  if (Buffer.byteLength(canonicalAgentJson(content), 'utf8') > 8_192)
    throw new AgentProtocolValidationError('agent memory content is too large');
  return agentSha256(content);
}

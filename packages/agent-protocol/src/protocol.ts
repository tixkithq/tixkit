import { createHash, timingSafeEqual } from 'node:crypto';

export const AGENT_PROTOCOL_VERSION = '2026-07-22' as const;
export type AgentAutonomy = 'read' | 'recommend' | 'prepare' | 'execute_with_approval';
export type AgentKind = 'managed_cloud' | 'third_party' | 'self_hosted';
export type AgentCapability =
  | 'events.read'
  | 'events.prepare'
  | 'events.execute'
  | 'readiness.read'
  | 'reports.read'
  | 'content.prepare'
  | 'campaigns.prepare'
  | 'campaigns.execute'
  | 'inventory.prepare'
  | 'inventory.execute'
  | 'refunds.prepare'
  | 'refunds.execute'
  | 'exports.prepare'
  | 'exports.execute'
  | 'settings.prepare'
  | 'settings.execute'
  | 'memory.read'
  | 'memory.write';

export interface AgentPrincipal {
  id: string;
  kind: AgentKind;
  tenantId: string;
  sponsorPrincipalId: string;
  capabilities: readonly AgentCapability[];
  maximumAutonomy: AgentAutonomy;
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  state: 'active' | 'suspended' | 'revoked';
  registeredAt: string;
}

export interface AgentDelegationGrant {
  id: string;
  tenantId: string;
  agentPrincipalId: string;
  sponsorPrincipalId: string;
  capabilities: readonly AgentCapability[];
  resourceScopes: readonly string[];
  permissionSnapshot: readonly string[];
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export type AgentActionKind =
  | 'event.read'
  | 'readiness.read'
  | 'report.read'
  | 'event.prepare'
  | 'content.prepare'
  | 'campaign.prepare'
  | 'event.update'
  | 'event.publish'
  | 'inventory.change'
  | 'campaign.send'
  | 'refund.issue'
  | 'permission.change'
  | 'personal_data.export'
  | 'credential.change'
  | 'domain.change'
  | 'provider.change'
  | 'migration.execute'
  | 'resource.delete';

export interface AgentActionTarget {
  tenantId: string;
  resourceType: string;
  resourceId: string;
  resourceVersion: number;
  apiOperation: string;
}

export interface AgentAction<
  TPayload extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  id: string;
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  agentPrincipalId: string;
  sponsorPrincipalId: string;
  delegationGrantId: string;
  kind: AgentActionKind;
  autonomy: AgentAutonomy;
  target: AgentActionTarget;
  payload: TPayload;
  idempotencyKey: string;
  expectedPolicyVersion: number;
  preparedAt: string;
}

export interface CampaignSendPayload extends Readonly<Record<string, unknown>> {
  channel: 'email' | 'sms' | 'whatsapp' | 'rcs' | 'apple_messages_for_business';
  contentVersion: string;
  audienceSnapshotSha256: string;
  exclusionSnapshotSha256: string;
  complianceResultSha256: string;
  scheduledAt: string;
  estimatedCostMinor: number;
  currency: string;
}

export interface EventPublishPayload extends Readonly<Record<string, unknown>> {
  readinessSnapshotSha256: string;
}

export interface AgentPlan {
  id: string;
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  agentPrincipalId: string;
  tenantId: string;
  purpose: string;
  actionDigests: readonly string[];
  createdAt: string;
  expiresAt: string;
  planSha256: string;
}

export interface AgentApproval {
  id: string;
  tenantId: string;
  actionDigest: string;
  planSha256?: string;
  approverPrincipalId: string;
  approverPermissionSnapshot: readonly string[];
  policyVersion: number;
  approvedAt: string;
  expiresAt: string;
  revokedAt?: string;
  consumedAt?: string;
}

export type AgentAuthorizationDenial =
  | 'agent_inactive'
  | 'agent_identity_mismatch'
  | 'protocol_mismatch'
  | 'sponsor_mismatch'
  | 'delegation_inactive'
  | 'tenant_mismatch'
  | 'capability_denied'
  | 'sponsor_permission_denied'
  | 'resource_scope_denied'
  | 'resource_version_changed'
  | 'policy_version_changed'
  | 'tenant_policy_denied'
  | 'risk_policy_denied'
  | 'approval_required'
  | 'approval_invalid'
  | 'approval_expired'
  | 'approval_consumed'
  | 'approval_revoked';

export interface AgentAuthorizationInput {
  principal: AgentPrincipal;
  delegation: AgentDelegationGrant;
  action: AgentAction;
  actionDigest: string;
  sponsorPermissions: readonly string[];
  tenantAllowedActions: readonly AgentActionKind[];
  currentResourceVersion: number;
  currentPolicyVersion: number;
  now: string;
  approval?: AgentApproval;
}

export interface AgentAuthorizationDecision {
  allowed: boolean;
  reasons: readonly AgentAuthorizationDenial[];
  consequential: boolean;
  requiresApproval: boolean;
  actionDigest: string;
}

export interface AgentApprovalStore {
  /** Atomically changes one matching, unrevoked, unexpired, unconsumed approval to consumed. */
  consume(input: {
    approvalId: string;
    tenantId: string;
    actionDigest: string;
    policyVersion: number;
    consumedAt: string;
    executionId: string;
  }): Promise<AgentApproval | null>;
}

export interface AgentActionDescriptor {
  capability: AgentCapability;
  sponsorPermission: string;
  resourceTypes: readonly string[];
  apiOperation: string;
  consequential: boolean;
}

export interface AgentAuditRecord {
  id: string;
  tenantId: string;
  agentPrincipalId: string;
  sponsorPrincipalId: string;
  delegationGrantId: string;
  actionId: string;
  actionDigest: string;
  planSha256?: string;
  approvalId?: string;
  phase: 'prepared' | 'authorized' | 'denied' | 'started' | 'succeeded' | 'failed' | 'compensated';
  idempotencyKey: string;
  resourceVersion: number;
  occurredAt: string;
  reasonCodes: readonly string[];
}

export class AgentProtocolValidationError extends Error {}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;
const SCOPE = /^[a-z][a-z0-9_-]{1,31}:[A-Za-z0-9][A-Za-z0-9_-]{1,127}$/u;
const OPERATION = /^[a-z][a-z0-9_.-]{2,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const PERMISSION = /^[a-z][a-z0-9_-]{1,31}:[a-z][a-z0-9_-]{1,63}$/u;
const CAPABILITIES = new Set<AgentCapability>([
  'events.read',
  'events.prepare',
  'events.execute',
  'readiness.read',
  'reports.read',
  'content.prepare',
  'campaigns.prepare',
  'campaigns.execute',
  'inventory.prepare',
  'inventory.execute',
  'refunds.prepare',
  'refunds.execute',
  'exports.prepare',
  'exports.execute',
  'settings.prepare',
  'settings.execute',
  'memory.read',
  'memory.write',
]);
const KINDS = new Set<AgentKind>(['managed_cloud', 'third_party', 'self_hosted']);
const AUTONOMY = new Set<AgentAutonomy>(['read', 'recommend', 'prepare', 'execute_with_approval']);
const STATES = new Set<AgentPrincipal['state']>(['active', 'suspended', 'revoked']);

function validUniqueStrings(values: readonly string[], maximum: number): boolean {
  return values.length > 0 && values.length <= maximum && new Set(values).size === values.length;
}

export function validateAgentPrincipal(principal: AgentPrincipal): void {
  const invalidField = !ID.test(principal.id)
    ? 'id'
    : !ID.test(principal.tenantId)
      ? 'tenantId'
      : !ID.test(principal.sponsorPrincipalId)
        ? 'sponsorPrincipalId'
        : !KINDS.has(principal.kind)
          ? 'kind'
          : !AUTONOMY.has(principal.maximumAutonomy)
            ? 'maximumAutonomy'
            : !STATES.has(principal.state)
              ? 'state'
              : principal.protocolVersion !== AGENT_PROTOCOL_VERSION
                ? 'protocolVersion'
                : !validUniqueStrings(principal.capabilities, CAPABILITIES.size) ||
                    principal.capabilities.some((capability) => !CAPABILITIES.has(capability))
                  ? 'capabilities'
                  : !Number.isFinite(new Date(principal.registeredAt).getTime())
                    ? 'registeredAt'
                    : undefined;
  if (invalidField)
    throw new AgentProtocolValidationError(`agent principal ${invalidField} is invalid`);
}

export function validateAgentDelegation(
  delegation: AgentDelegationGrant,
  principal: AgentPrincipal,
): void {
  const issuedAt = new Date(delegation.issuedAt).getTime();
  const expiresAt = new Date(delegation.expiresAt).getTime();
  if (
    !ID.test(delegation.id) ||
    delegation.tenantId !== principal.tenantId ||
    delegation.agentPrincipalId !== principal.id ||
    delegation.sponsorPrincipalId !== principal.sponsorPrincipalId ||
    !validUniqueStrings(delegation.capabilities, CAPABILITIES.size) ||
    delegation.capabilities.some(
      (capability) => !CAPABILITIES.has(capability) || !principal.capabilities.includes(capability),
    ) ||
    !validUniqueStrings(delegation.resourceScopes, 100) ||
    delegation.resourceScopes.some((scope) => !SCOPE.test(scope)) ||
    !validUniqueStrings(delegation.permissionSnapshot, 100) ||
    delegation.permissionSnapshot.some((permission) => !PERMISSION.test(permission)) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt >= expiresAt ||
    (delegation.revokedAt && !Number.isFinite(new Date(delegation.revokedAt).getTime()))
  )
    throw new AgentProtocolValidationError('agent delegation is invalid');
}
export const AGENT_ACTION_DESCRIPTORS: Readonly<Record<AgentActionKind, AgentActionDescriptor>> = {
  'event.read': {
    capability: 'events.read',
    sponsorPermission: 'events:read',
    resourceTypes: ['event'],
    apiOperation: 'events.get',
    consequential: false,
  },
  'readiness.read': {
    capability: 'readiness.read',
    sponsorPermission: 'events:read',
    resourceTypes: ['event'],
    apiOperation: 'events.readiness.get',
    consequential: false,
  },
  'report.read': {
    capability: 'reports.read',
    sponsorPermission: 'reports:read',
    resourceTypes: ['event', 'tenant'],
    apiOperation: 'reports.get',
    consequential: false,
  },
  'event.prepare': {
    capability: 'events.prepare',
    sponsorPermission: 'events:write',
    resourceTypes: ['event'],
    apiOperation: 'events.prepare',
    consequential: false,
  },
  'content.prepare': {
    capability: 'content.prepare',
    sponsorPermission: 'events:write',
    resourceTypes: ['event'],
    apiOperation: 'content.prepare',
    consequential: false,
  },
  'campaign.prepare': {
    capability: 'campaigns.prepare',
    sponsorPermission: 'campaigns:write',
    resourceTypes: ['event'],
    apiOperation: 'campaigns.prepare',
    consequential: false,
  },
  'event.update': {
    capability: 'events.execute',
    sponsorPermission: 'events:write',
    resourceTypes: ['event'],
    apiOperation: 'events.update',
    consequential: true,
  },
  'event.publish': {
    capability: 'events.execute',
    sponsorPermission: 'events:publish',
    resourceTypes: ['event'],
    apiOperation: 'events.publish',
    consequential: true,
  },
  'inventory.change': {
    capability: 'inventory.execute',
    sponsorPermission: 'inventory:write',
    resourceTypes: ['event', 'ticket_type'],
    apiOperation: 'inventory.update',
    consequential: true,
  },
  'campaign.send': {
    capability: 'campaigns.execute',
    sponsorPermission: 'campaigns:send',
    resourceTypes: ['event'],
    apiOperation: 'campaigns.send',
    consequential: true,
  },
  'refund.issue': {
    capability: 'refunds.execute',
    sponsorPermission: 'refunds:write',
    resourceTypes: ['order'],
    apiOperation: 'refunds.issue',
    consequential: true,
  },
  'permission.change': {
    capability: 'settings.execute',
    sponsorPermission: 'members:write',
    resourceTypes: ['tenant'],
    apiOperation: 'permissions.update',
    consequential: true,
  },
  'personal_data.export': {
    capability: 'exports.execute',
    sponsorPermission: 'exports:personal_data',
    resourceTypes: ['tenant', 'event'],
    apiOperation: 'exports.create',
    consequential: true,
  },
  'credential.change': {
    capability: 'settings.execute',
    sponsorPermission: 'settings:credentials',
    resourceTypes: ['tenant'],
    apiOperation: 'settings.credentials.update',
    consequential: true,
  },
  'domain.change': {
    capability: 'settings.execute',
    sponsorPermission: 'settings:domains',
    resourceTypes: ['tenant', 'event'],
    apiOperation: 'settings.domains.update',
    consequential: true,
  },
  'provider.change': {
    capability: 'settings.execute',
    sponsorPermission: 'settings:providers',
    resourceTypes: ['tenant'],
    apiOperation: 'settings.providers.update',
    consequential: true,
  },
  'migration.execute': {
    capability: 'settings.execute',
    sponsorPermission: 'migrations:execute',
    resourceTypes: ['tenant'],
    apiOperation: 'migrations.execute',
    consequential: true,
  },
  'resource.delete': {
    capability: 'settings.execute',
    sponsorPermission: 'resources:delete',
    resourceTypes: ['event', 'tenant'],
    apiOperation: 'resources.delete',
    consequential: true,
  },
};
const CONSEQUENTIAL = new Set(
  Object.entries(AGENT_ACTION_DESCRIPTORS)
    .filter(([, descriptor]) => descriptor.consequential)
    .map(([kind]) => kind as AgentActionKind),
);
const READ_ONLY_ACTIONS = new Set<AgentActionKind>(['event.read', 'readiness.read', 'report.read']);
const AUTONOMY_RANK: Record<AgentAutonomy, number> = {
  read: 0,
  recommend: 1,
  prepare: 2,
  execute_with_approval: 3,
};

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 24) throw new AgentProtocolValidationError('canonical value exceeds maximum depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new AgentProtocolValidationError('numbers must be safe integers');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, depth + 1));
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    throw new AgentProtocolValidationError('canonical values must be plain JSON objects');
  const object = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    if (object[key] === undefined || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(key))
      throw new AgentProtocolValidationError('canonical object contains an invalid field');
    result[key] = canonical(object[key], depth + 1);
  }
  return result;
}

export function canonicalAgentJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}
export function agentSha256(value: unknown): string {
  return createHash('sha256').update(canonicalAgentJson(value)).digest('hex');
}

interface AgentSchemaKeywordHost {
  addKeyword(definition: {
    keyword: string;
    schemaType: string;
    type: string;
    validate: (limit: number, data: unknown) => boolean;
  }): unknown;
}

function canonicalDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.reduce(
    (maximum, child) => Math.max(maximum, canonicalDepth(child, depth + 1)),
    depth,
  );
}

/** Installs the required custom keywords for the published Agent Action JSON Schema. */
export function installAgentProtocolSchemaKeywords(host: AgentSchemaKeywordHost): void {
  host.addKeyword({
    keyword: 'x-tixkit-maxCanonicalBytes',
    schemaType: 'number',
    type: 'object',
    validate(limit, data) {
      try {
        return Buffer.byteLength(canonicalAgentJson(data)) <= limit;
      } catch {
        return false;
      }
    },
  });
  host.addKeyword({
    keyword: 'x-tixkit-maxDepth',
    schemaType: 'number',
    type: 'object',
    validate: (limit, data) => canonicalDepth(data) <= limit,
  });
}

function validateAction(action: AgentAction): void {
  for (const value of [
    action.id,
    action.agentPrincipalId,
    action.sponsorPrincipalId,
    action.delegationGrantId,
    action.target.tenantId,
    action.target.resourceType,
    action.target.resourceId,
  ])
    if (!ID.test(value)) throw new AgentProtocolValidationError('action identifier is invalid');
  const descriptor = AGENT_ACTION_DESCRIPTORS[action.kind];
  if (
    !descriptor ||
    action.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    !SAFE_TOKEN.test(action.idempotencyKey) ||
    !OPERATION.test(action.target.apiOperation) ||
    action.target.apiOperation !== descriptor.apiOperation ||
    !descriptor.resourceTypes.includes(action.target.resourceType) ||
    !Number.isSafeInteger(action.target.resourceVersion) ||
    action.target.resourceVersion < 1 ||
    !Number.isSafeInteger(action.expectedPolicyVersion) ||
    action.expectedPolicyVersion < 1 ||
    !Number.isFinite(new Date(action.preparedAt).getTime())
  )
    throw new AgentProtocolValidationError('action contract is invalid');
  canonical(action.payload);
  if (Buffer.byteLength(canonicalAgentJson(action.payload)) > 256 * 1024)
    throw new AgentProtocolValidationError('action payload exceeds 256 KiB');
  if (action.kind === 'campaign.send') validateCampaignSendPayload(action.payload);
  if (action.kind === 'event.publish') validateEventPublishPayload(action.payload);
  if (action.kind === 'event.prepare') validateEventPreparePayload(action.payload);
  const expectedAutonomy = descriptor.consequential
    ? 'execute_with_approval'
    : READ_ONLY_ACTIONS.has(action.kind)
      ? 'read'
      : 'prepare';
  if (action.autonomy !== expectedAutonomy)
    throw new AgentProtocolValidationError('action autonomy does not match its declared kind');
}

const EVENT_PREPARE_FIELDS = new Set([
  'capacity',
  'coverImageAlt',
  'coverImageUrl',
  'currency',
  'description',
  'endsAt',
  'externalUrl',
  'lastSetupSection',
  'minimumAge',
  'seo',
  'seoUseCoverImage',
  'slug',
  'startsAt',
  'timezone',
  'title',
  'venue',
  'venueId',
  'visibility',
]);
const EVENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const isSafeEventText = (value: string): boolean => !value.includes('\0');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

function isEventTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048 || !isSafeEventText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isMediaReference(value: unknown): value is string {
  return (
    isHttpUrl(value) ||
    (typeof value === 'string' &&
      value.length <= 2048 &&
      isSafeEventText(value) &&
      /^\/v1\/public\/event-media\/[A-Za-z0-9_/-]+$/u.test(value))
  );
}

function hasUnsafeNestedString(value: unknown): boolean {
  if (typeof value === 'string') return !isSafeEventText(value);
  if (Array.isArray(value)) return value.some(hasUnsafeNestedString);
  if (!isPlainObject(value)) return false;
  return Object.values(value).some(hasUnsafeNestedString);
}

function validEventSeo(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !['description', 'imageUrl', 'title'].includes(key))) return false;
  return (
    (value.title === undefined ||
      (typeof value.title === 'string' &&
        value.title.length <= 200 &&
        isSafeEventText(value.title))) &&
    (value.description === undefined ||
      (typeof value.description === 'string' &&
        value.description.length <= 500 &&
        isSafeEventText(value.description))) &&
    (value.imageUrl === undefined || isMediaReference(value.imageUrl))
  );
}

function validEventVenue(value: unknown): boolean {
  if (value === null) return true;
  if (!isPlainObject(value) || Object.keys(value).length > 64 || hasUnsafeNestedString(value))
    return false;
  try {
    return Buffer.byteLength(canonicalAgentJson(value)) <= 16 * 1024 && canonicalDepth(value) <= 4;
  } catch {
    return false;
  }
}

function validEventPrepareField(field: string, value: unknown): boolean {
  switch (field) {
    case 'title':
      return (
        typeof value === 'string' &&
        value.length >= 1 &&
        value.length <= 512 &&
        isSafeEventText(value)
      );
    case 'slug':
      return typeof value === 'string' && value.length <= 200 && EVENT_SLUG.test(value);
    case 'description':
      return (
        value === null ||
        (typeof value === 'string' && value.length <= 50_000 && isSafeEventText(value))
      );
    case 'currency':
      return typeof value === 'string' && CURRENCY.test(value);
    case 'timezone':
      return (
        typeof value === 'string' &&
        value.length >= 1 &&
        value.length <= 100 &&
        isSafeEventText(value)
      );
    case 'startsAt':
      return isEventTimestamp(value);
    case 'endsAt':
      return value === null || isEventTimestamp(value);
    case 'venue':
      return validEventVenue(value);
    case 'venueId':
      return value === null || (typeof value === 'string' && ID.test(value));
    case 'visibility':
      return value === 'public' || value === 'unlisted' || value === 'private';
    case 'seo':
      return validEventSeo(value);
    case 'capacity':
      return value === null || (Number.isSafeInteger(value) && Number(value) >= 1);
    case 'minimumAge':
      return (
        value === null ||
        (Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 120)
      );
    case 'coverImageUrl':
      return value === null || isMediaReference(value);
    case 'externalUrl':
      return value === null || isHttpUrl(value);
    case 'coverImageAlt':
      return (
        value === null ||
        (typeof value === 'string' && value.length <= 500 && isSafeEventText(value))
      );
    case 'seoUseCoverImage':
      return typeof value === 'boolean';
    case 'lastSetupSection':
      return (
        value === null ||
        (typeof value === 'string' && value.length <= 100 && isSafeEventText(value))
      );
    default:
      return false;
  }
}

export function validateAgentEventPrepareProjection(
  value: unknown,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainObject(value))
    throw new AgentProtocolValidationError('event prepare projection must be a plain object');
  const keys = Object.keys(value);
  if (
    keys.length < 1 ||
    keys.length > EVENT_PREPARE_FIELDS.size ||
    keys.some(
      (field) => !EVENT_PREPARE_FIELDS.has(field) || !validEventPrepareField(field, value[field]),
    )
  )
    throw new AgentProtocolValidationError(
      'event prepare projection contains an invalid field value',
    );
}

function isOwnedEventMediaReference(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    isSafeEventText(value) &&
    /^\/v1\/public\/event-media\/[A-Za-z0-9_/-]+$/u.test(value)
  );
}

export function validateAgentEventPrepareResolvedChanges(
  value: unknown,
): asserts value is Readonly<Record<string, unknown>> {
  validateAgentEventPrepareProjection(value);
  if ('description' in value && value.description === null)
    throw new AgentProtocolValidationError('event prepare resolved description must not be null');
  if (
    'coverImageUrl' in value &&
    value.coverImageUrl !== null &&
    !isOwnedEventMediaReference(value.coverImageUrl)
  )
    throw new AgentProtocolValidationError(
      'event prepare resolved cover image must be owned event media',
    );
  if (
    'seo' in value &&
    isPlainObject(value.seo) &&
    value.seo.imageUrl !== undefined &&
    !isOwnedEventMediaReference(value.seo.imageUrl)
  )
    throw new AgentProtocolValidationError(
      'event prepare resolved SEO image must be owned event media',
    );
}

function validateEventPreparePayload(payload: Readonly<Record<string, unknown>>): void {
  if (
    JSON.stringify(Object.keys(payload).sort()) !==
      JSON.stringify(['changePreviewSha256', 'changes']) ||
    typeof payload.changePreviewSha256 !== 'string' ||
    !SHA256.test(payload.changePreviewSha256) ||
    !payload.changes ||
    typeof payload.changes !== 'object' ||
    Array.isArray(payload.changes)
  )
    throw new AgentProtocolValidationError('event prepare payload is invalid');
  validateAgentEventPrepareResolvedChanges(payload.changes);
}

function validateEventPublishPayload(payload: Readonly<Record<string, unknown>>): void {
  if (
    JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(['readinessSnapshotSha256']) ||
    typeof payload.readinessSnapshotSha256 !== 'string' ||
    !SHA256.test(payload.readinessSnapshotSha256)
  )
    throw new AgentProtocolValidationError('event publish payload is invalid');
}

function validateCampaignSendPayload(payload: Readonly<Record<string, unknown>>): void {
  const expected = [
    'audienceSnapshotSha256',
    'channel',
    'complianceResultSha256',
    'contentVersion',
    'currency',
    'estimatedCostMinor',
    'exclusionSnapshotSha256',
    'scheduledAt',
  ];
  const channels = new Set(['email', 'sms', 'whatsapp', 'rcs', 'apple_messages_for_business']);
  if (
    JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expected) ||
    typeof payload.channel !== 'string' ||
    !channels.has(payload.channel) ||
    typeof payload.contentVersion !== 'string' ||
    !ID.test(payload.contentVersion) ||
    typeof payload.audienceSnapshotSha256 !== 'string' ||
    !SHA256.test(payload.audienceSnapshotSha256) ||
    typeof payload.exclusionSnapshotSha256 !== 'string' ||
    !SHA256.test(payload.exclusionSnapshotSha256) ||
    typeof payload.complianceResultSha256 !== 'string' ||
    !SHA256.test(payload.complianceResultSha256) ||
    typeof payload.scheduledAt !== 'string' ||
    !Number.isFinite(new Date(payload.scheduledAt).getTime()) ||
    !Number.isSafeInteger(payload.estimatedCostMinor) ||
    Number(payload.estimatedCostMinor) < 0 ||
    Number(payload.estimatedCostMinor) > 1_000_000_000 ||
    typeof payload.currency !== 'string' ||
    !CURRENCY.test(payload.currency)
  )
    throw new AgentProtocolValidationError('campaign send payload is invalid');
}

export function agentActionDigest(action: AgentAction): string {
  validateAction(action);
  return agentSha256(action);
}

export function buildAgentPlan(input: Omit<AgentPlan, 'planSha256'>): AgentPlan {
  if (
    !ID.test(input.id) ||
    !ID.test(input.agentPrincipalId) ||
    !ID.test(input.tenantId) ||
    input.actionDigests.length < 1 ||
    input.actionDigests.length > 100 ||
    input.actionDigests.some((item) => !SHA256.test(item)) ||
    new Date(input.expiresAt).getTime() <= new Date(input.createdAt).getTime()
  )
    throw new AgentProtocolValidationError('agent plan is invalid');
  return {
    ...input,
    actionDigests: [...input.actionDigests],
    planSha256: agentSha256(input),
  };
}

function includes<T>(items: readonly T[], value: T): boolean {
  return items.includes(value);
}
function activeAt(issuedAt: string, expiresAt: string, now: string): boolean {
  const time = new Date(now).getTime();
  return (
    Number.isFinite(time) &&
    new Date(issuedAt).getTime() <= time &&
    time < new Date(expiresAt).getTime()
  );
}
function hashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizeAgentAction(input: AgentAuthorizationInput): AgentAuthorizationDecision {
  validateAction(input.action);
  const reasons: AgentAuthorizationDenial[] = [];
  const consequential = CONSEQUENTIAL.has(input.action.kind);
  const requiresApproval = consequential || input.action.autonomy === 'execute_with_approval';
  const { principal, delegation, action } = input;
  const descriptor = AGENT_ACTION_DESCRIPTORS[action.kind];
  for (const value of [
    principal.id,
    principal.tenantId,
    principal.sponsorPrincipalId,
    delegation.id,
    delegation.tenantId,
    delegation.agentPrincipalId,
    delegation.sponsorPrincipalId,
  ])
    if (!ID.test(value))
      throw new AgentProtocolValidationError('principal or delegation identifier is invalid');
  if (principal.state !== 'active') reasons.push('agent_inactive');
  if (action.agentPrincipalId !== principal.id) reasons.push('agent_identity_mismatch');
  if (
    principal.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    action.protocolVersion !== AGENT_PROTOCOL_VERSION
  )
    reasons.push('protocol_mismatch');
  if (
    principal.sponsorPrincipalId !== action.sponsorPrincipalId ||
    delegation.sponsorPrincipalId !== action.sponsorPrincipalId
  )
    reasons.push('sponsor_mismatch');
  if (
    delegation.revokedAt ||
    !activeAt(delegation.issuedAt, delegation.expiresAt, input.now) ||
    delegation.agentPrincipalId !== principal.id ||
    delegation.id !== action.delegationGrantId
  )
    reasons.push('delegation_inactive');
  if (
    principal.tenantId !== action.target.tenantId ||
    delegation.tenantId !== action.target.tenantId
  )
    reasons.push('tenant_mismatch');
  if (
    !includes(principal.capabilities, descriptor.capability) ||
    !includes(delegation.capabilities, descriptor.capability)
  )
    reasons.push('capability_denied');
  if (
    !includes(input.sponsorPermissions, descriptor.sponsorPermission) ||
    !includes(delegation.permissionSnapshot, descriptor.sponsorPermission)
  )
    reasons.push('sponsor_permission_denied');
  if (
    !delegation.resourceScopes.some(
      (scope) =>
        SCOPE.test(scope) && scope === `${action.target.resourceType}:${action.target.resourceId}`,
    )
  )
    reasons.push('resource_scope_denied');
  if (action.target.resourceVersion !== input.currentResourceVersion)
    reasons.push('resource_version_changed');
  if (action.expectedPolicyVersion !== input.currentPolicyVersion)
    reasons.push('policy_version_changed');
  if (!includes(input.tenantAllowedActions, action.kind)) reasons.push('tenant_policy_denied');
  if (AUTONOMY_RANK[action.autonomy] > AUTONOMY_RANK[principal.maximumAutonomy])
    reasons.push('risk_policy_denied');
  if (!hashEqual(input.actionDigest, agentActionDigest(action))) reasons.push('approval_invalid');
  if (requiresApproval) {
    const approval = input.approval;
    if (!approval) reasons.push('approval_required');
    else {
      if (
        approval.tenantId !== action.target.tenantId ||
        !hashEqual(approval.actionDigest, input.actionDigest) ||
        approval.policyVersion !== action.expectedPolicyVersion ||
        approval.policyVersion !== input.currentPolicyVersion ||
        !includes(approval.approverPermissionSnapshot, descriptor.sponsorPermission)
      )
        reasons.push('approval_invalid');
      if (approval.revokedAt) reasons.push('approval_revoked');
      if (approval.consumedAt) reasons.push('approval_consumed');
      if (!activeAt(approval.approvedAt, approval.expiresAt, input.now))
        reasons.push('approval_expired');
    }
  }
  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    consequential,
    requiresApproval,
    actionDigest: input.actionDigest,
  };
}

export async function consumeApprovedAgentAction(
  input: AgentAuthorizationInput & {
    approvalStore: AgentApprovalStore;
    executionId: string;
  },
): Promise<{ decision: AgentAuthorizationDecision; approval?: AgentApproval }> {
  const decision = authorizeAgentAction(input);
  if (!decision.allowed) return { decision };
  if (!decision.requiresApproval) return { decision };
  if (!input.approval || !ID.test(input.executionId))
    throw new AgentProtocolValidationError('approved execution identity is invalid');
  const consumed = await input.approvalStore.consume({
    approvalId: input.approval.id,
    tenantId: input.action.target.tenantId,
    actionDigest: input.actionDigest,
    policyVersion: input.currentPolicyVersion,
    consumedAt: input.now,
    executionId: input.executionId,
  });
  if (!consumed)
    return {
      decision: { ...decision, allowed: false, reasons: ['approval_consumed'] },
    };
  const descriptor = AGENT_ACTION_DESCRIPTORS[input.action.kind];
  const authoritativeReasons: AgentAuthorizationDenial[] = [];
  if (
    consumed.id !== input.approval.id ||
    consumed.tenantId !== input.action.target.tenantId ||
    !hashEqual(consumed.actionDigest, input.actionDigest) ||
    consumed.policyVersion !== input.currentPolicyVersion ||
    consumed.planSha256 !== input.approval.planSha256 ||
    !ID.test(consumed.approverPrincipalId) ||
    !includes(consumed.approverPermissionSnapshot, descriptor.sponsorPermission) ||
    consumed.consumedAt !== input.now
  )
    authoritativeReasons.push('approval_invalid');
  if (consumed.revokedAt) authoritativeReasons.push('approval_revoked');
  if (!activeAt(consumed.approvedAt, consumed.expiresAt, input.now))
    authoritativeReasons.push('approval_expired');
  if (authoritativeReasons.length > 0)
    return {
      decision: {
        ...decision,
        allowed: false,
        reasons: [...new Set(authoritativeReasons)],
      },
    };
  return { decision, approval: consumed };
}

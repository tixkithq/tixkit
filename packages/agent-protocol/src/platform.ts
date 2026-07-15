import {
  AGENT_ACTION_DESCRIPTORS,
  AGENT_PROTOCOL_VERSION,
  AgentProtocolValidationError,
  agentActionDigest,
  agentSha256,
  canonicalAgentJson,
  validateAgentContentPrepareDocument,
  validateAgentContentPreparePreview,
  validateAgentContentPrepareValidation,
  validateAgentCampaignPreparePayload,
  validateAgentEventPrepareProjection,
  validateAgentEventPrepareResolvedChanges,
  type AgentAction,
  type AgentActionKind,
  type ContentPreparePayload,
  type AgentApproval,
  type AgentCapability,
  type CampaignPreparePayload,
} from './protocol.js';
import {
  validateAgentActionResultForAction,
  type AgentActionResult,
  type AgentExecution,
} from './execution.js';

export const AGENT_PLATFORM_PROTOCOL_VERSION = '2026-07-27' as const;
export const AGENT_PLATFORM_PLAN_DIGEST_DOMAIN =
  'tixkit.agent-plan-definition.v2026-07-27' as const;
export const AGENT_ACTION_CONTRACT_VERSION = '2026-08-04' as const;

export type AgentRiskClass = 'read_only' | 'low' | 'high' | 'critical';
export type AgentReversibilityMode = 'none' | 'reversible' | 'compensatable';

export interface AgentPlanAssumption {
  id: string;
  statement: string;
  provenanceType: 'user' | 'system' | 'tool' | 'inferred';
  sourceReference?: string;
  verification: 'confirmed' | 'unverified' | 'rejected';
}

export interface AgentPlanProjectedChange {
  resourceType: string;
  resourceId: string;
  operation: 'create' | 'update' | 'publish' | 'send' | 'refund' | 'export' | 'delete';
  beforeVersion?: number;
  projectedVersion?: number;
  previewSha256: string;
}

export interface AgentPlanCost {
  amountMinor: number;
  currency: string;
  basis: string;
  quoteSha256: string;
  expiresAt: string;
}

export interface AgentPlanReadinessImpact {
  beforeSnapshotSha256: string;
  projectedSnapshotSha256: string;
  introducedReasonCodes: readonly string[];
  resolvedReasonCodes: readonly string[];
}

export interface AgentPlanApprovalRequirement {
  mode: 'none' | 'fresh_action';
  riskClass: AgentRiskClass;
}

export interface AgentPlanReversibility {
  mode: AgentReversibilityMode;
  compensationActionKind?: AgentActionKind;
  windowSeconds?: number;
}

export interface AgentPlanStep {
  id: string;
  actionKind: AgentActionKind;
  actionProtocolVersion: typeof AGENT_PROTOCOL_VERSION;
  actionDigest: string;
  dependsOnStepIds: readonly string[];
  projectedChanges: readonly AgentPlanProjectedChange[];
  costs: readonly AgentPlanCost[];
  readinessImpact: AgentPlanReadinessImpact;
  approvalRequirement: AgentPlanApprovalRequirement;
  reversibility: AgentPlanReversibility;
}

export interface AgentPlanDefinition {
  id: string;
  protocolVersion: typeof AGENT_PLATFORM_PROTOCOL_VERSION;
  tenantId: string;
  agentPrincipalId: string;
  sponsorPrincipalId: string;
  delegationGrantId: string;
  purpose: string;
  assumptions: readonly AgentPlanAssumption[];
  steps: readonly AgentPlanStep[];
  createdAt: string;
  expiresAt: string;
  planSha256: string;
}

export type AgentPlanStatus =
  | 'prepared'
  | 'awaiting_approval'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'compensated';

export type AgentPlanStepStatus =
  | 'pending'
  | 'blocked'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'compensated';

export interface AgentPlanStepState {
  stepId: string;
  status: AgentPlanStepStatus;
  approvalId?: string;
  executionId?: string;
  resultSha256?: string;
  failureCode?: string;
}

export interface AgentPlanState {
  planId: string;
  planSha256: string;
  stateVersion: number;
  status: AgentPlanStatus;
  stepStates: readonly AgentPlanStepState[];
  updatedAt: string;
}

export interface AgentPlanTransitionEvidence {
  actions: readonly AgentAction[];
  approvals: readonly AgentApproval[];
  executions: readonly AgentExecution[];
}

export interface AgentSchemaReference {
  schemaId: string;
  schemaSha256: string;
  jsonPointer: string;
}

export interface AgentActionRegistryDefinition {
  kind: AgentActionKind;
  availability: 'implemented' | 'reserved';
  planSupport: 'supported' | 'direct_only' | 'unavailable';
  prepareInputSchema: AgentSchemaReference;
  resolvedPayloadSchema: AgentSchemaReference;
  resultSchema: AgentSchemaReference;
  requiredCapabilities: readonly AgentCapability[];
  requiredSponsorPermissions: readonly string[];
  resourceScope: {
    resourceTypes: readonly string[];
    scopeTemplate: '{resourceType}:{resourceId}';
  };
  preconditions: {
    resourceVersion: 'exact';
    policyVersion: 'exact';
    requiredMaterialDigests: readonly string[];
  };
  riskClass: AgentRiskClass;
  reversibility: AgentPlanReversibility;
  approvalPolicy: {
    mode: 'none' | 'fresh_action';
    ttlSeconds?: number;
    confirmationRequired: boolean;
  };
  idempotency: {
    prepare: AgentActionIdempotencyPhase;
    approve: AgentActionIdempotencyPhase;
    execute: AgentActionIdempotencyPhase;
  };
  executionBoundary: {
    kind: 'api' | 'durable_workflow';
    operation: string;
  };
}

export interface AgentActionIdempotencyPhase {
  keySource: 'caller' | 'derived';
  scope: 'agent_action';
  replay: 'exact_result';
  intentMismatch: 'conflict';
}

export interface AgentActionRegistry {
  protocolVersion: typeof AGENT_ACTION_CONTRACT_VERSION;
  actionProtocolVersion: typeof AGENT_PROTOCOL_VERSION;
  actions: readonly AgentActionRegistryDefinition[];
  registrySha256: string;
}

export interface AgentReadinessReadResult extends Readonly<Record<string, unknown>> {
  resourceId: string;
  resourceVersion: number;
  status: 'ready' | 'blocked';
  readinessSnapshotSha256: string;
  generatedAt: string;
  published: boolean;
  blockerReasonCodes: readonly string[];
  warningReasonCodes: readonly string[];
}

export interface AgentEventReadResult extends Readonly<Record<string, unknown>> {
  resourceId: string;
  resourceVersion: number;
  eventSnapshotSha256: string;
  observedAt: string;
  event: {
    title: string;
    description: string | null;
    status: 'draft' | 'published' | 'paused' | 'ended' | 'archived';
    currency: string;
    timezone: string;
    startsAt: string;
    endsAt: string | null;
    visibility: 'public' | 'unlisted' | 'private';
    capacity: number | null;
    minimumAge: number | null;
  };
  untrustedContentPaths: readonly ['event.title', 'event.description'];
}

export interface AgentReportReadResult extends Readonly<Record<string, unknown>> {
  resourceId: string;
  resourceVersion: number;
  reportType: 'event_sales';
  from: string;
  to: string;
  reportSnapshotSha256: string;
  observedAt: string;
  report: {
    currency: string;
    grossSalesCents: number;
    grossSalesByChannelCents: { online: number; boxOffice: number };
    netRevenueCents: number;
    refundsCents: number;
    feesCents: number;
    taxCents: number;
    ticketsSold: number;
    checkIns: number;
    ordersCount: number;
    paidOrdersCount: number;
  };
  untrustedContentPaths: readonly [];
}

export interface AgentEventPrepareResult extends Readonly<Record<string, unknown>> {
  resourceId: string;
  resourceVersion: number;
  changePreviewSha256: string;
  observedAt: string;
  changedFields: readonly string[];
  before: Readonly<Record<string, unknown>>;
  after: Readonly<Record<string, unknown>>;
  untrustedContentPaths: readonly string[];
}

export interface AgentEventUpdatePreview extends AgentEventPrepareResult {}

export interface AgentContentPrepareResult extends Readonly<Record<string, unknown>> {
  resourceId: string;
  resourceVersion: number;
  contentPreviewSha256: string;
  observedAt: string;
  channel: 'event_page';
  content: Readonly<Record<string, unknown>>;
  preview: ContentPreparePayload['preview'];
  validation: ContentPreparePayload['validation'];
  untrustedContentPaths: readonly ['content', 'preview.discovery'];
}

export interface AgentCampaignPrepareResult extends Readonly<Record<string, unknown>> {
  resourceId: string;
  resourceVersion: number;
  observedAt: string;
  audience: CampaignPreparePayload['audience'];
  channel: CampaignPreparePayload['channel'];
  requestedAttendeeIds: readonly string[];
  templateVersions: CampaignPreparePayload['templateVersions'];
  contentVersionSha256: string;
  audienceSnapshotSha256: string;
  exclusionSnapshotSha256: string;
  complianceResultSha256: string;
  audienceCount: number;
  eligibleRecipientCount: number;
  eligibleDeliveryCount: number;
  suppressedDeliveryCount: number;
  consentExclusionCount: number;
  missingContactCount: number;
  untrustedContentPaths: readonly [];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const REASON_CODE = /^[a-z0-9][a-z0-9_.-]{1,63}$/u;
const FAILURE_CODE = /^[A-Z0-9_]{3,64}$/u;
const MATERIAL_DIGEST = /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/u;
const RFC3339_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RFC3339_WHOLE_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AgentProtocolValidationError(message);
}

function validDate(value: string): number {
  const time = new Date(value).getTime();
  assert(
    RFC3339_MILLISECONDS.test(value) &&
      Number.isFinite(time) &&
      new Date(time).toISOString() === value,
    'agent platform timestamp is invalid',
  );
  return time;
}

function assertExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  assert(
    Object.getPrototypeOf(value) === Object.prototype,
    'agent platform object must be a plain object',
  );
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  assert(
    required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key)),
    'agent platform object shape is invalid',
  );
}

function assertUnique<T>(items: readonly T[], key: (item: T) => string, message: string): void {
  const keys = items.map(key);
  assert(new Set(keys).size === keys.length, message);
}

function assertReasonCodes(values: readonly string[]): void {
  assert(values.length <= 64, 'agent plan readiness reason list is too large');
  assert(new Set(values).size === values.length, 'agent plan readiness reasons must be unique');
  assert(
    values.every((value) => REASON_CODE.test(value)),
    'agent plan readiness reason is invalid',
  );
}

function assertAcyclicSteps(steps: readonly AgentPlanStep[]): void {
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    assert(!visiting.has(stepId), 'agent plan dependencies contain a cycle');
    visiting.add(stepId);
    const step = stepsById.get(stepId);
    assert(step, 'agent plan dependency references an unknown step');
    for (const dependencyId of step.dependsOnStepIds) visit(dependencyId);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.id);
}

function assertPlanStep(step: AgentPlanStep, createdAt: number, expiresAt: number): void {
  assertExactKeys(step, [
    'id',
    'actionKind',
    'actionProtocolVersion',
    'actionDigest',
    'dependsOnStepIds',
    'projectedChanges',
    'costs',
    'readinessImpact',
    'approvalRequirement',
    'reversibility',
  ]);
  assert(ID.test(step.id), 'agent plan step id is invalid');
  const registryDefinition = AGENT_ACTION_REGISTRY.actions.find(
    (definition) => definition.kind === step.actionKind,
  );
  assert(
    registryDefinition?.availability === 'implemented' &&
      registryDefinition.planSupport === 'supported',
    'agent plan step action is not implemented',
  );
  assert(
    step.actionProtocolVersion === AGENT_PROTOCOL_VERSION,
    'agent plan action version is invalid',
  );
  assert(SHA256.test(step.actionDigest), 'agent plan action digest is invalid');
  assert(step.dependsOnStepIds.length <= 100, 'agent plan dependency list is too large');
  assertUnique(step.dependsOnStepIds, (item) => item, 'agent plan dependencies must be unique');
  assert(!step.dependsOnStepIds.includes(step.id), 'agent plan step cannot depend on itself');
  assert(step.projectedChanges.length <= 100, 'agent plan projected change list is too large');
  for (const change of step.projectedChanges) {
    assertExactKeys(
      change,
      ['resourceType', 'resourceId', 'operation', 'previewSha256'],
      ['beforeVersion', 'projectedVersion'],
    );
    assert(
      ID.test(change.resourceType) && ID.test(change.resourceId),
      'projected change target is invalid',
    );
    assert(SHA256.test(change.previewSha256), 'projected change preview digest is invalid');
    assert(
      ['create', 'update', 'publish', 'send', 'refund', 'export', 'delete'].includes(
        change.operation,
      ),
      'projected change operation is invalid',
    );
    for (const version of [change.beforeVersion, change.projectedVersion])
      if (version !== undefined)
        assert(
          Number.isSafeInteger(version) && version >= 1,
          'projected change version is invalid',
        );
  }
  assert(step.costs.length <= 20, 'agent plan cost list is too large');
  for (const cost of step.costs) {
    assertExactKeys(cost, ['amountMinor', 'currency', 'basis', 'quoteSha256', 'expiresAt']);
    assert(
      Number.isSafeInteger(cost.amountMinor) && cost.amountMinor >= 0,
      'agent plan cost amount is invalid',
    );
    assert(CURRENCY.test(cost.currency), 'agent plan cost currency is invalid');
    assert(
      cost.basis.trim() === cost.basis && cost.basis.length >= 1 && cost.basis.length <= 500,
      'agent plan cost basis is invalid',
    );
    assert(SHA256.test(cost.quoteSha256), 'agent plan quote digest is invalid');
    const quoteExpiry = validDate(cost.expiresAt);
    assert(
      quoteExpiry > createdAt && quoteExpiry <= expiresAt,
      'agent plan quote expiry is invalid',
    );
  }
  assertExactKeys(step.readinessImpact, [
    'beforeSnapshotSha256',
    'projectedSnapshotSha256',
    'introducedReasonCodes',
    'resolvedReasonCodes',
  ]);
  assert(
    SHA256.test(step.readinessImpact.beforeSnapshotSha256),
    'before readiness digest is invalid',
  );
  assertExactKeys(step.approvalRequirement, ['mode', 'riskClass']);
  assert(
    SHA256.test(step.readinessImpact.projectedSnapshotSha256),
    'projected readiness digest is invalid',
  );
  assertExactKeys(step.reversibility, ['mode'], ['compensationActionKind', 'windowSeconds']);
  assertReasonCodes(step.readinessImpact.introducedReasonCodes);
  assertReasonCodes(step.readinessImpact.resolvedReasonCodes);
  assert(
    step.approvalRequirement.mode === 'none' || step.approvalRequirement.mode === 'fresh_action',
    'agent plan approval mode is invalid',
  );
  assert(
    ['read_only', 'low', 'high', 'critical'].includes(step.approvalRequirement.riskClass),
    'agent plan risk class is invalid',
  );
  assert(
    step.approvalRequirement.mode === registryDefinition.approvalPolicy.mode &&
      step.approvalRequirement.riskClass === registryDefinition.riskClass,
    'agent plan approval requirement does not match the registry',
  );
  assert(
    ['none', 'reversible', 'compensatable'].includes(step.reversibility.mode),
    'agent plan reversibility is invalid',
  );
  if (step.reversibility.mode === 'compensatable')
    assert(step.reversibility.compensationActionKind, 'compensatable step requires an action kind');
  else
    assert(
      step.reversibility.compensationActionKind === undefined &&
        step.reversibility.windowSeconds === undefined,
      'non-compensatable step cannot declare compensation',
    );
  assert(
    step.reversibility.mode === registryDefinition.reversibility.mode &&
      step.reversibility.compensationActionKind ===
        registryDefinition.reversibility.compensationActionKind,
    'agent plan reversibility does not match the registry',
  );
  if (step.reversibility.windowSeconds !== undefined)
    assert(
      Number.isSafeInteger(step.reversibility.windowSeconds) &&
        step.reversibility.windowSeconds > 0 &&
        step.reversibility.windowSeconds <= 31_536_000,
      'agent plan compensation window is invalid',
    );
}

export function buildAgentPlanDefinition(
  input: Omit<AgentPlanDefinition, 'planSha256'>,
): AgentPlanDefinition {
  assertExactKeys(input, [
    'id',
    'protocolVersion',
    'tenantId',
    'agentPrincipalId',
    'sponsorPrincipalId',
    'delegationGrantId',
    'purpose',
    'assumptions',
    'steps',
    'createdAt',
    'expiresAt',
  ]);
  assert(
    input.protocolVersion === AGENT_PLATFORM_PROTOCOL_VERSION,
    'agent plan protocol is invalid',
  );
  for (const id of [
    input.id,
    input.tenantId,
    input.agentPrincipalId,
    input.sponsorPrincipalId,
    input.delegationGrantId,
  ])
    assert(ID.test(id), 'agent plan identity is invalid');
  assert(
    input.purpose.trim() === input.purpose &&
      input.purpose.length >= 1 &&
      input.purpose.length <= 1000,
    'agent plan purpose is invalid',
  );
  assert(input.assumptions.length <= 100, 'agent plan assumption list is too large');
  assertUnique(input.assumptions, (item) => item.id, 'agent plan assumption ids must be unique');
  for (const assumption of input.assumptions) {
    assertExactKeys(
      assumption,
      ['id', 'statement', 'provenanceType', 'verification'],
      ['sourceReference'],
    );
    assert(ID.test(assumption.id), 'agent plan assumption id is invalid');
    assert(
      ['user', 'system', 'tool', 'inferred'].includes(assumption.provenanceType),
      'agent plan assumption provenance is invalid',
    );
    assert(
      ['confirmed', 'unverified', 'rejected'].includes(assumption.verification),
      'agent plan assumption verification is invalid',
    );
    assert(
      assumption.statement.trim() === assumption.statement &&
        assumption.statement.length >= 1 &&
        assumption.statement.length <= 1000,
      'agent plan assumption statement is invalid',
    );
    if (assumption.sourceReference !== undefined)
      assert(
        assumption.sourceReference.trim() === assumption.sourceReference &&
          assumption.sourceReference.length >= 1 &&
          assumption.sourceReference.length <= 500,
        'agent plan assumption source is invalid',
      );
  }
  assert(input.steps.length >= 1 && input.steps.length <= 100, 'agent plan step list is invalid');
  assertUnique(input.steps, (item) => item.id, 'agent plan step ids must be unique');
  assertUnique(
    input.steps,
    (item) => item.actionDigest,
    'agent plan action digests must be unique',
  );
  const createdAt = validDate(input.createdAt);
  const expiresAt = validDate(input.expiresAt);
  assert(
    expiresAt > createdAt && expiresAt - createdAt <= 86_400_000,
    'agent plan lifetime is invalid',
  );
  for (const step of input.steps) assertPlanStep(step, createdAt, expiresAt);
  assertAcyclicSteps(input.steps);
  const definition = {
    ...input,
    assumptions: input.assumptions.map((assumption) => ({ ...assumption })),
    steps: input.steps.map((step) => ({
      ...step,
      dependsOnStepIds: [...step.dependsOnStepIds],
      projectedChanges: step.projectedChanges.map((change) => ({ ...change })),
      costs: step.costs.map((cost) => ({ ...cost })),
      readinessImpact: {
        ...step.readinessImpact,
        introducedReasonCodes: [...step.readinessImpact.introducedReasonCodes],
        resolvedReasonCodes: [...step.readinessImpact.resolvedReasonCodes],
      },
      approvalRequirement: { ...step.approvalRequirement },
      reversibility: { ...step.reversibility },
    })),
  };
  return {
    ...definition,
    planSha256: agentSha256({
      domain: AGENT_PLATFORM_PLAN_DIGEST_DOMAIN,
      definition,
    }),
  };
}

export function validateAgentPlanDefinition(definition: AgentPlanDefinition): void {
  assertExactKeys(definition, [
    'id',
    'protocolVersion',
    'tenantId',
    'agentPrincipalId',
    'sponsorPrincipalId',
    'delegationGrantId',
    'purpose',
    'assumptions',
    'steps',
    'createdAt',
    'expiresAt',
    'planSha256',
  ]);
  const { planSha256, ...input } = definition;
  assert(SHA256.test(planSha256), 'agent plan digest is invalid');
  const rebuilt = buildAgentPlanDefinition(input);
  assert(rebuilt.planSha256 === planSha256, 'agent plan digest does not match its definition');
}

export function validateAgentPlanActionBindings(
  definition: AgentPlanDefinition,
  actions: readonly AgentAction[],
): void {
  validateAgentPlanDefinition(definition);
  assert(actions.length === definition.steps.length, 'agent plan action count is invalid');
  const actionsByDigest = new Map(actions.map((action) => [agentActionDigest(action), action]));
  assert(actionsByDigest.size === actions.length, 'agent plan actions must be unique');
  for (const step of definition.steps) {
    const action = actionsByDigest.get(step.actionDigest);
    assert(action, 'agent plan action digest is unavailable');
    assert(
      action.protocolVersion === step.actionProtocolVersion &&
        action.kind === step.actionKind &&
        action.target.tenantId === definition.tenantId &&
        action.agentPrincipalId === definition.agentPrincipalId &&
        action.sponsorPrincipalId === definition.sponsorPrincipalId &&
        action.delegationGrantId === definition.delegationGrantId,
      'agent plan action identity binding is invalid',
    );
    if (action.kind === 'event.publish') {
      const change = step.projectedChanges[0];
      assert(
        step.projectedChanges.length === 1 &&
          change?.resourceType === action.target.resourceType &&
          change.resourceId === action.target.resourceId &&
          change.operation === 'publish' &&
          change.beforeVersion === action.target.resourceVersion &&
          change.projectedVersion === action.target.resourceVersion + 1 &&
          step.readinessImpact.beforeSnapshotSha256 === action.payload.readinessSnapshotSha256,
        'agent plan event publication preview does not match the action',
      );
    }
  }
}

export function validateAgentPlanStepApprovalBinding(
  definition: AgentPlanDefinition,
  stepId: string,
  action: AgentAction,
  approval: AgentApproval,
): void {
  validateAgentPlanDefinition(definition);
  const step = definition.steps.find((item) => item.id === stepId);
  assert(step, 'agent plan approval references an unknown step');
  const registryDefinition = AGENT_ACTION_REGISTRY.actions.find(
    (item) => item.kind === action.kind,
  );
  assert(registryDefinition, 'agent plan action registry definition is unavailable');
  assert(
    step.approvalRequirement.mode === 'fresh_action' &&
      agentActionDigest(action) === step.actionDigest &&
      approval.tenantId === definition.tenantId &&
      approval.actionDigest === step.actionDigest &&
      approval.planSha256 === definition.planSha256 &&
      approval.approverPrincipalId === definition.sponsorPrincipalId &&
      approval.policyVersion === action.expectedPolicyVersion &&
      registryDefinition.requiredSponsorPermissions.every((permission) =>
        approval.approverPermissionSnapshot.includes(permission),
      ),
    'agent plan approval binding is invalid',
  );
}

export function validateAgentPlanState(
  definition: AgentPlanDefinition,
  state: AgentPlanState,
): void {
  validateAgentPlanDefinition(definition);
  assertExactKeys(state, [
    'planId',
    'planSha256',
    'stateVersion',
    'status',
    'stepStates',
    'updatedAt',
  ]);
  assert(
    state.planId === definition.id && state.planSha256 === definition.planSha256,
    'agent plan state binding is invalid',
  );
  assert(
    Number.isSafeInteger(state.stateVersion) && state.stateVersion >= 1,
    'agent plan state version is invalid',
  );
  assert(
    [
      'prepared',
      'awaiting_approval',
      'executing',
      'succeeded',
      'failed',
      'cancelled',
      'expired',
      'compensated',
    ].includes(state.status),
    'agent plan status is invalid',
  );
  validDate(state.updatedAt);
  assert(
    state.stepStates.length === definition.steps.length,
    'agent plan state step count is invalid',
  );
  assertUnique(state.stepStates, (item) => item.stepId, 'agent plan state step ids must be unique');
  assertUnique(
    state.stepStates.filter((item) => item.approvalId !== undefined),
    (item) => item.approvalId!,
    'agent plan approval ids must be unique',
  );
  assertUnique(
    state.stepStates.filter((item) => item.executionId !== undefined),
    (item) => item.executionId!,
    'agent plan execution ids must be unique',
  );
  const stepIds = new Set(definition.steps.map((step) => step.id));
  for (const step of state.stepStates) {
    assertExactKeys(
      step,
      ['stepId', 'status'],
      ['approvalId', 'executionId', 'resultSha256', 'failureCode'],
    );
    assert(stepIds.has(step.stepId), 'agent plan state references an unknown step');
    assert(
      [
        'pending',
        'blocked',
        'awaiting_approval',
        'approved',
        'executing',
        'succeeded',
        'failed',
        'cancelled',
        'compensated',
      ].includes(step.status),
      'agent plan step status is invalid',
    );
    if (step.approvalId !== undefined)
      assert(ID.test(step.approvalId), 'agent plan approval id is invalid');
    if (step.executionId !== undefined)
      assert(ID.test(step.executionId), 'agent plan execution id is invalid');
    if (step.resultSha256 !== undefined)
      assert(SHA256.test(step.resultSha256), 'agent plan result digest is invalid');
    if (step.failureCode !== undefined)
      assert(FAILURE_CODE.test(step.failureCode), 'agent plan failure code is invalid');
    assert(
      step.status !== 'approved' && step.status !== 'executing' && step.status !== 'succeeded'
        ? true
        : step.approvalId !== undefined ||
            definition.steps.find((item) => item.id === step.stepId)?.approvalRequirement.mode ===
              'none',
      'agent plan step status lacks required approval evidence',
    );
    if (step.status === 'executing' || step.status === 'succeeded')
      assert(step.executionId, 'agent plan executing step lacks execution evidence');
    if (step.status === 'succeeded')
      assert(step.resultSha256, 'agent plan succeeded step lacks result evidence');
    if (step.status === 'failed')
      assert(
        step.approvalId && step.executionId && step.failureCode,
        'agent plan failed step lacks failure evidence',
      );
  }
  if (state.status === 'succeeded')
    assert(
      state.stepStates.every((step) => step.status === 'succeeded'),
      'succeeded agent plan contains an incomplete step',
    );
  if (state.status === 'failed')
    assert(
      state.stepStates.some((step) => step.status === 'failed'),
      'failed agent plan lacks a failed step',
    );
  if (state.status === 'executing')
    assert(
      state.stepStates.some((step) => step.status === 'executing'),
      'executing agent plan lacks an executing step',
    );
  if (state.status === 'awaiting_approval')
    assert(
      state.stepStates.some((step) => step.status === 'awaiting_approval'),
      'agent plan awaiting approval lacks a waiting step',
    );
  if (state.status === 'compensated')
    assert(
      state.stepStates.some((step) => step.status === 'compensated') &&
        state.stepStates.every((step) =>
          ['succeeded', 'compensated', 'cancelled'].includes(step.status),
        ),
      'compensated agent plan has inconsistent steps',
    );
}

const PLAN_STATUS_TRANSITIONS: Readonly<Record<AgentPlanStatus, readonly AgentPlanStatus[]>> = {
  prepared: ['prepared', 'awaiting_approval', 'cancelled', 'expired'],
  awaiting_approval: [
    'awaiting_approval',
    'executing',
    'succeeded',
    'failed',
    'cancelled',
    'expired',
  ],
  executing: ['executing', 'awaiting_approval', 'succeeded', 'failed', 'cancelled', 'compensated'],
  succeeded: ['succeeded'],
  failed: ['failed', 'compensated', 'cancelled'],
  cancelled: ['cancelled'],
  expired: ['expired'],
  compensated: ['compensated'],
};

const STEP_STATUS_TRANSITIONS: Readonly<
  Record<AgentPlanStepStatus, readonly AgentPlanStepStatus[]>
> = {
  pending: ['pending', 'blocked', 'awaiting_approval', 'cancelled'],
  blocked: ['blocked', 'pending', 'awaiting_approval', 'cancelled'],
  awaiting_approval: [
    'awaiting_approval',
    'approved',
    'executing',
    'succeeded',
    'failed',
    'cancelled',
  ],
  approved: ['approved', 'executing', 'cancelled'],
  executing: ['executing', 'succeeded', 'failed', 'compensated'],
  succeeded: ['succeeded'],
  failed: ['failed', 'compensated', 'cancelled'],
  cancelled: ['cancelled'],
  compensated: ['compensated'],
};

export function validateAgentPlanStateTransition(
  definition: AgentPlanDefinition,
  previous: AgentPlanState | undefined,
  next: AgentPlanState,
  evidence: AgentPlanTransitionEvidence,
): void {
  validateAgentPlanState(definition, next);
  validateAgentPlanActionBindings(definition, evidence.actions);
  const createdAt = validDate(definition.createdAt);
  const expiresAt = validDate(definition.expiresAt);
  const observedAt = validDate(next.updatedAt);
  assert(observedAt >= createdAt, 'agent plan state predates its definition');
  if (!previous) {
    assert(
      next.stateVersion === 1 &&
        next.status === 'prepared' &&
        next.stepStates.every((step) => step.status === 'pending' || step.status === 'blocked') &&
        observedAt < expiresAt,
      'initial agent plan state is invalid',
    );
  } else {
    validateAgentPlanState(definition, previous);
    const previousAt = validDate(previous.updatedAt);
    assert(
      next.stateVersion === previous.stateVersion + 1,
      'agent plan state version is not monotonic',
    );
    assert(observedAt > previousAt, 'agent plan state time is not monotonic');
    if (observedAt >= expiresAt) {
      assert(
        previousAt < expiresAt &&
          ['prepared', 'awaiting_approval', 'executing'].includes(previous.status) &&
          next.status === 'expired' &&
          agentSha256(next.stepStates) === agentSha256(previous.stepStates),
        'expired agent plan may only enter the exact expired state',
      );
      return;
    }
    assert(
      PLAN_STATUS_TRANSITIONS[previous.status].includes(next.status),
      'agent plan status transition is invalid',
    );
    const previousByStep = new Map(previous.stepStates.map((step) => [step.stepId, step]));
    for (const step of next.stepStates) {
      const prior = previousByStep.get(step.stepId);
      assert(prior, 'agent plan transition lacks a previous step');
      assert(
        STEP_STATUS_TRANSITIONS[prior.status].includes(step.status),
        'agent plan step status transition is invalid',
      );
      if (prior.approvalId !== undefined)
        assert(step.approvalId === prior.approvalId, 'agent plan approval evidence changed');
      if (prior.executionId !== undefined)
        assert(step.executionId === prior.executionId, 'agent plan execution evidence changed');
    }
  }

  assertUnique(evidence.approvals, (item) => item.id, 'agent plan approval evidence is duplicated');
  assertUnique(
    evidence.executions,
    (item) => item.id,
    'agent plan execution evidence is duplicated',
  );
  const approvals = new Map(evidence.approvals.map((approval) => [approval.id, approval]));
  const executions = new Map(evidence.executions.map((execution) => [execution.id, execution]));
  const actions = new Map(evidence.actions.map((action) => [agentActionDigest(action), action]));
  const stateByStep = new Map(next.stepStates.map((step) => [step.stepId, step]));

  for (const planStep of definition.steps) {
    const stepState = stateByStep.get(planStep.id)!;
    const action = actions.get(planStep.actionDigest)!;
    const registryDefinition = AGENT_ACTION_REGISTRY.actions.find(
      (definition) => definition.kind === planStep.actionKind,
    )!;
    if (['approved', 'executing', 'succeeded'].includes(stepState.status)) {
      for (const dependencyId of planStep.dependsOnStepIds)
        assert(
          stateByStep.get(dependencyId)?.status === 'succeeded',
          'agent plan step advanced before its dependency succeeded',
        );
    }
    if (stepState.status === 'compensated')
      assert(
        planStep.reversibility.mode === 'compensatable',
        'non-compensatable agent plan step claims compensation',
      );
    if (stepState.approvalId) {
      const approval = approvals.get(stepState.approvalId);
      assert(approval, 'agent plan approval evidence is unavailable');
      validateAgentPlanStepApprovalBinding(definition, planStep.id, action, approval);
      const approvedAt = validDate(approval.approvedAt);
      const approvalExpiresAt = validDate(approval.expiresAt);
      const approvalTtlSeconds = registryDefinition.approvalPolicy.ttlSeconds;
      assert(
        !approval.revokedAt &&
          approvedAt >= createdAt &&
          approvalExpiresAt <= expiresAt &&
          approvalTtlSeconds !== undefined &&
          approvalExpiresAt - approvedAt <= approvalTtlSeconds * 1000,
        'agent plan approval is not fresh',
      );
      if (!stepState.executionId)
        assert(
          approvedAt <= observedAt && observedAt < approvalExpiresAt,
          'agent plan approval is not fresh',
        );
    }
    if (stepState.executionId) {
      const execution = executions.get(stepState.executionId);
      assert(execution, 'agent plan execution evidence is unavailable');
      const approval = approvals.get(stepState.approvalId!);
      assert(approval?.consumedAt, 'agent plan execution lacks consumed approval evidence');
      const consumedAt = validDate(approval.consumedAt);
      const executionCreatedAt = validDate(execution.createdAt);
      assert(
        execution.tenantId === definition.tenantId &&
          execution.actionId === action.id &&
          execution.agentPrincipalId === definition.agentPrincipalId &&
          execution.sponsorPrincipalId === definition.sponsorPrincipalId &&
          execution.delegationGrantId === definition.delegationGrantId &&
          execution.actionDigest === planStep.actionDigest &&
          execution.planSha256 === definition.planSha256 &&
          execution.approvalId === stepState.approvalId &&
          execution.resourceVersion === action.target.resourceVersion &&
          execution.policyVersion === action.expectedPolicyVersion &&
          validDate(approval.approvedAt) <= consumedAt &&
          consumedAt < validDate(approval.expiresAt) &&
          consumedAt === executionCreatedAt &&
          executionCreatedAt < validDate(approval.expiresAt) &&
          executionCreatedAt < expiresAt,
        'agent plan execution binding is invalid',
      );
      if (stepState.status === 'executing')
        assert(execution.state === 'running', 'agent plan running evidence is invalid');
      if (stepState.status === 'succeeded') {
        assert(
          execution.state === 'succeeded' && execution.result,
          'agent plan success evidence is invalid',
        );
        assert(
          stepState.resultSha256 === agentSha256(execution.result),
          'agent plan result digest is invalid',
        );
        validateAgentActionResultForAction(action, execution.result as AgentActionResult);
      }
      if (stepState.status === 'failed')
        assert(
          execution.state === 'failed' && execution.failureCode === stepState.failureCode,
          'agent plan failure evidence is invalid',
        );
    }
  }
}

export function validateAgentReadinessReadResult(
  action: AgentAction,
  result: AgentReadinessReadResult,
): void {
  assert(action.kind === 'readiness.read', 'agent readiness result action kind is invalid');
  assertExactKeys(action.payload, ['readinessSnapshotSha256']);
  assertExactKeys(result, [
    'resourceId',
    'resourceVersion',
    'status',
    'readinessSnapshotSha256',
    'generatedAt',
    'published',
    'blockerReasonCodes',
    'warningReasonCodes',
  ]);
  assert(
    action.autonomy === 'read' &&
      action.target.resourceType === 'event' &&
      action.target.apiOperation === 'events.readiness.get' &&
      result.resourceId === action.target.resourceId &&
      result.resourceVersion === action.target.resourceVersion,
    'agent readiness result target binding is invalid',
  );
  assert(
    typeof action.payload.readinessSnapshotSha256 === 'string' &&
      SHA256.test(action.payload.readinessSnapshotSha256) &&
      result.readinessSnapshotSha256 === action.payload.readinessSnapshotSha256,
    'agent readiness result digest binding is invalid',
  );
  validDate(result.generatedAt);
  assert(typeof result.published === 'boolean', 'agent readiness publication state is invalid');
  for (const reasons of [result.blockerReasonCodes, result.warningReasonCodes]) {
    assert(Array.isArray(reasons) && reasons.length <= 100, 'agent readiness reasons are invalid');
    assertUnique(reasons, (item) => item, 'agent readiness reasons must be unique');
    assert(
      reasons.every((item) => REASON_CODE.test(item)),
      'agent readiness reason code is invalid',
    );
  }
  assert(
    result.status === (result.blockerReasonCodes.length === 0 ? 'ready' : 'blocked'),
    'agent readiness status is inconsistent',
  );
}

export function validateAgentEventReadResult(
  action: AgentAction,
  result: AgentEventReadResult,
): void {
  assert(action.kind === 'event.read', 'agent event result action kind is invalid');
  assertExactKeys(action.payload, ['eventSnapshotSha256']);
  assertExactKeys(result, [
    'resourceId',
    'resourceVersion',
    'eventSnapshotSha256',
    'observedAt',
    'event',
    'untrustedContentPaths',
  ]);
  assertExactKeys(result.event, [
    'title',
    'description',
    'status',
    'currency',
    'timezone',
    'startsAt',
    'endsAt',
    'visibility',
    'capacity',
    'minimumAge',
  ]);
  assert(
    action.autonomy === 'read' &&
      action.target.resourceType === 'event' &&
      action.target.apiOperation === 'events.get' &&
      result.resourceId === action.target.resourceId &&
      result.resourceVersion === action.target.resourceVersion,
    'agent event result target binding is invalid',
  );
  assert(
    typeof action.payload.eventSnapshotSha256 === 'string' &&
      SHA256.test(action.payload.eventSnapshotSha256) &&
      result.eventSnapshotSha256 === action.payload.eventSnapshotSha256 &&
      result.eventSnapshotSha256 === agentSha256(result.event),
    'agent event result digest binding is invalid',
  );
  validDate(result.observedAt);
  assert(
    typeof result.event.title === 'string' &&
      result.event.title.length >= 1 &&
      result.event.title.length <= 512 &&
      !result.event.title.includes('\0'),
    'agent event title is invalid',
  );
  assert(
    result.event.description === null ||
      (typeof result.event.description === 'string' &&
        result.event.description.length <= 50_000 &&
        !result.event.description.includes('\0')),
    'agent event description is invalid',
  );
  assert(
    ['draft', 'published', 'paused', 'ended', 'archived'].includes(result.event.status),
    'agent event status is invalid',
  );
  assert(CURRENCY.test(result.event.currency), 'agent event currency is invalid');
  assert(
    typeof result.event.timezone === 'string' &&
      result.event.timezone.length >= 1 &&
      result.event.timezone.length <= 128 &&
      !result.event.timezone.includes('\0'),
    'agent event timezone is invalid',
  );
  const startsAt = validDate(result.event.startsAt);
  const endsAt = result.event.endsAt === null ? undefined : validDate(result.event.endsAt);
  assert(endsAt === undefined || endsAt >= startsAt, 'agent event time range is invalid');
  assert(
    ['public', 'unlisted', 'private'].includes(result.event.visibility),
    'agent event visibility is invalid',
  );
  assert(
    result.event.capacity === null ||
      (Number.isSafeInteger(result.event.capacity) && result.event.capacity >= 0),
    'agent event capacity is invalid',
  );
  assert(
    result.event.minimumAge === null ||
      (Number.isSafeInteger(result.event.minimumAge) &&
        result.event.minimumAge >= 0 &&
        result.event.minimumAge <= 255),
    'agent event minimum age is invalid',
  );
  assert(
    result.untrustedContentPaths.length === 2 &&
      result.untrustedContentPaths[0] === 'event.title' &&
      result.untrustedContentPaths[1] === 'event.description',
    'agent event untrusted content declaration is invalid',
  );
}

export function validateAgentReportReadResult(
  action: AgentAction,
  result: AgentReportReadResult,
): void {
  assert(action.kind === 'report.read', 'agent report result action kind is invalid');
  assertExactKeys(action.payload, ['reportType', 'from', 'to', 'reportSnapshotSha256']);
  assertExactKeys(result, [
    'resourceId',
    'resourceVersion',
    'reportType',
    'from',
    'to',
    'reportSnapshotSha256',
    'observedAt',
    'report',
    'untrustedContentPaths',
  ]);
  assertExactKeys(result.report, [
    'currency',
    'grossSalesCents',
    'grossSalesByChannelCents',
    'netRevenueCents',
    'refundsCents',
    'feesCents',
    'taxCents',
    'ticketsSold',
    'checkIns',
    'ordersCount',
    'paidOrdersCount',
  ]);
  assertExactKeys(result.report.grossSalesByChannelCents, ['online', 'boxOffice']);
  assert(
    action.autonomy === 'read' &&
      action.target.resourceType === 'event' &&
      action.target.apiOperation === 'reports.get' &&
      result.resourceId === action.target.resourceId &&
      result.resourceVersion === action.target.resourceVersion &&
      action.payload.reportType === 'event_sales' &&
      result.reportType === action.payload.reportType,
    'agent report result target binding is invalid',
  );
  assert(
    typeof action.payload.from === 'string' && typeof action.payload.to === 'string',
    'agent report range binding is invalid',
  );
  const from = validDate(action.payload.from);
  const to = validDate(action.payload.to);
  assert(
    RFC3339_WHOLE_SECONDS.test(action.payload.from) &&
      RFC3339_WHOLE_SECONDS.test(action.payload.to) &&
      result.from === action.payload.from &&
      result.to === action.payload.to &&
      from <= to,
    'agent report range binding is invalid',
  );
  assert(
    typeof action.payload.reportSnapshotSha256 === 'string' &&
      SHA256.test(action.payload.reportSnapshotSha256) &&
      result.reportSnapshotSha256 === action.payload.reportSnapshotSha256 &&
      result.reportSnapshotSha256 === agentSha256(result.report),
    'agent report digest binding is invalid',
  );
  validDate(result.observedAt);
  assert(CURRENCY.test(result.report.currency), 'agent report currency is invalid');
  for (const [key, value] of Object.entries(result.report)) {
    if (key === 'currency' || key === 'grossSalesByChannelCents' || key === 'netRevenueCents')
      continue;
    assert(
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
      `agent report ${key} is invalid`,
    );
  }
  assert(
    Number.isSafeInteger(result.report.netRevenueCents),
    'agent report net revenue is invalid',
  );
  for (const value of Object.values(result.report.grossSalesByChannelCents))
    assert(Number.isSafeInteger(value) && value >= 0, 'agent report channel amount is invalid');
  assert(
    result.report.netRevenueCents === result.report.grossSalesCents - result.report.refundsCents,
    'agent report net revenue is inconsistent',
  );
  assert(
    result.report.grossSalesCents ===
      result.report.grossSalesByChannelCents.online +
        result.report.grossSalesByChannelCents.boxOffice,
    'agent report channel totals are inconsistent',
  );
  assert(
    result.report.paidOrdersCount <= result.report.ordersCount,
    'agent report order counts are inconsistent',
  );
  assert(result.untrustedContentPaths.length === 0, 'agent report untrusted content is invalid');
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

export function validateAgentEventPrepareResult(
  action: AgentAction,
  result: AgentEventPrepareResult,
): void {
  validateAgentEventChangePreview(action, result, 'event.prepare');
}

export function validateAgentEventUpdatePreview(
  action: AgentAction,
  result: AgentEventUpdatePreview,
): void {
  validateAgentEventChangePreview(action, result, 'event.update');
}

export function validateAgentContentPrepareResult(
  action: AgentAction,
  result: AgentContentPrepareResult,
): void {
  assert(action.kind === 'content.prepare', 'agent content prepare action kind is invalid');
  assertExactKeys(action.payload, [
    'channel',
    'content',
    'contentPreviewSha256',
    'preview',
    'validation',
  ]);
  assertExactKeys(result, [
    'resourceId',
    'resourceVersion',
    'contentPreviewSha256',
    'observedAt',
    'channel',
    'content',
    'preview',
    'validation',
    'untrustedContentPaths',
  ]);
  assert(
    action.autonomy === 'prepare' &&
      action.target.resourceType === 'event' &&
      action.target.apiOperation === 'content.prepare' &&
      result.resourceId === action.target.resourceId &&
      result.resourceVersion === action.target.resourceVersion,
    'agent content prepare target binding is invalid',
  );
  const payload = action.payload as ContentPreparePayload;
  validateAgentContentPrepareDocument(payload.content);
  validateAgentContentPreparePreview(payload.preview);
  validateAgentContentPrepareValidation(payload.validation);
  validateAgentContentPrepareDocument(result.content);
  validateAgentContentPreparePreview(result.preview);
  validateAgentContentPrepareValidation(result.validation);
  assert(
    result.channel === payload.channel &&
      canonicalAgentJson(result.content) === canonicalAgentJson(payload.content) &&
      canonicalAgentJson(result.preview) === canonicalAgentJson(payload.preview) &&
      canonicalAgentJson(result.validation) === canonicalAgentJson(payload.validation) &&
      result.contentPreviewSha256 === payload.contentPreviewSha256 &&
      result.contentPreviewSha256 ===
        agentSha256({
          channel: result.channel,
          content: result.content,
          preview: result.preview,
          validation: result.validation,
        }),
    'agent content prepare preview binding is invalid',
  );
  validDate(result.observedAt);
  assert(
    result.untrustedContentPaths.length === 2 &&
      result.untrustedContentPaths[0] === 'content' &&
      result.untrustedContentPaths[1] === 'preview.discovery',
    'agent content prepare untrusted content declaration is invalid',
  );
}

export function validateAgentCampaignPrepareResult(
  action: AgentAction,
  result: AgentCampaignPrepareResult,
): void {
  assert(action.kind === 'campaign.prepare', 'agent campaign prepare action kind is invalid');
  assertExactKeys(result, [
    'resourceId',
    'resourceVersion',
    'observedAt',
    'audience',
    'channel',
    'requestedAttendeeIds',
    'templateVersions',
    'contentVersionSha256',
    'audienceSnapshotSha256',
    'exclusionSnapshotSha256',
    'complianceResultSha256',
    'audienceCount',
    'eligibleRecipientCount',
    'eligibleDeliveryCount',
    'suppressedDeliveryCount',
    'consentExclusionCount',
    'missingContactCount',
    'untrustedContentPaths',
  ]);
  assert(
    action.autonomy === 'prepare' &&
      action.target.resourceType === 'event' &&
      action.target.apiOperation === 'campaigns.prepare' &&
      result.resourceId === action.target.resourceId &&
      result.resourceVersion === action.target.resourceVersion &&
      Array.isArray(result.untrustedContentPaths) &&
      result.untrustedContentPaths.length === 0,
    'agent campaign prepare target binding is invalid',
  );
  validateAgentCampaignPreparePayload(action.payload);
  const projection = { ...result } as Record<string, unknown>;
  delete projection.resourceId;
  delete projection.resourceVersion;
  delete projection.observedAt;
  delete projection.untrustedContentPaths;
  validateAgentCampaignPreparePayload(projection);
  assert(
    canonicalAgentJson(action.payload) === canonicalAgentJson(projection),
    'agent campaign prepare snapshot binding is invalid',
  );
  validDate(result.observedAt);
}

function validateAgentEventChangePreview(
  action: AgentAction,
  result: AgentEventPrepareResult,
  kind: 'event.prepare' | 'event.update',
): void {
  assert(action.kind === kind, 'agent event change preview action kind is invalid');
  assertExactKeys(action.payload, ['changePreviewSha256', 'changes']);
  assertExactKeys(result, [
    'resourceId',
    'resourceVersion',
    'changePreviewSha256',
    'observedAt',
    'changedFields',
    'before',
    'after',
    'untrustedContentPaths',
  ]);
  assert(
    action.autonomy === (kind === 'event.prepare' ? 'prepare' : 'execute_with_approval') &&
      action.target.resourceType === 'event' &&
      action.target.apiOperation ===
        (kind === 'event.prepare' ? 'events.prepare' : 'events.update') &&
      result.resourceId === action.target.resourceId &&
      result.resourceVersion === action.target.resourceVersion,
    'agent event change preview target binding is invalid',
  );
  assert(
    Array.isArray(result.changedFields) &&
      result.changedFields.length >= 1 &&
      result.changedFields.length <= EVENT_PREPARE_FIELDS.size &&
      result.changedFields.every((field) => EVENT_PREPARE_FIELDS.has(field)) &&
      result.changedFields.every(
        (field, index) => index === 0 || result.changedFields[index - 1]! < field,
      ),
    'agent event prepare changed fields are invalid',
  );
  assertExactKeys(result.before, [...result.changedFields]);
  assertExactKeys(result.after, [...result.changedFields]);
  validateAgentEventPrepareProjection(result.before);
  validateAgentEventPrepareResolvedChanges(result.after);
  assert(
    action.payload.changes !== null &&
      typeof action.payload.changes === 'object' &&
      !Array.isArray(action.payload.changes) &&
      agentSha256(action.payload.changes) === agentSha256(result.after),
    'agent event prepare normalized changes are invalid',
  );
  const preview = {
    resourceId: result.resourceId,
    resourceVersion: result.resourceVersion,
    changedFields: result.changedFields,
    before: result.before,
    after: result.after,
  };
  assert(
    typeof action.payload.changePreviewSha256 === 'string' &&
      SHA256.test(action.payload.changePreviewSha256) &&
      result.changePreviewSha256 === action.payload.changePreviewSha256 &&
      result.changePreviewSha256 === agentSha256(preview),
    'agent event prepare preview digest binding is invalid',
  );
  validDate(result.observedAt);
  assert(
    result.untrustedContentPaths.length === result.changedFields.length * 2 &&
      result.untrustedContentPaths.every((path, index) => {
        const field = result.changedFields[Math.floor(index / 2)];
        return path === `${index % 2 === 0 ? 'before' : 'after'}.${field}`;
      }),
    'agent event prepare untrusted content declaration is invalid',
  );
}

const CONTRACT_SCHEMA_ID = 'https://tixkit.com/schemas/agent-action-contracts/2026-08-04';
// Updated only alongside the immutable schema and verified by schema-parity tests.
export const AGENT_ACTION_CONTRACT_SCHEMA_SHA256_2026_07_27 =
  'fd74b30a8ba72341fcf4fa6984dca901ba7dec95cf305dc98f5cc38c184b092f' as const;
export const AGENT_ACTION_CONTRACT_SCHEMA_SHA256_2026_07_29 =
  '13c927eacc6b21b14a5637f95b479aa6ae0707db75bc1a508e489bb0ff813f83' as const;
export const AGENT_ACTION_CONTRACT_SCHEMA_SHA256_2026_07_30 =
  '2fb854eba68e6c9b1b6f9c1fce5e9d585b49a09d62b1642119497a4c46548843' as const;
export const AGENT_ACTION_CONTRACT_SCHEMA_SHA256_2026_07_31 =
  'e4bc8989e8763f8089eff14f24e35677c62148dbd6ced92f555ad54a346d9bd3' as const;
export const AGENT_ACTION_CONTRACT_SCHEMA_SHA256_2026_08_01 =
  '335e70ca4930b26cfe47b866eedeaacea9c802b5f844e2e26c2e9f40201b8984' as const;
export const AGENT_ACTION_CONTRACT_SCHEMA_SHA256_2026_08_02 =
  'a12327ff58bee27b566408ddc4c054e49463a851c1d5a36974575bc592578626' as const;
export const AGENT_ACTION_CONTRACT_SCHEMA_SHA256_2026_08_03 =
  '90a370a02930c77d2726a78a03ebd77e679184396165727b0f72cf9af0308aea' as const;
export const AGENT_ACTION_CONTRACT_SCHEMA_SHA256 =
  '8f9a908cb690a36918ef31944f94bd2837aa69ba9a8d5f72997ade2f76897741' as const;

const riskByKind: Readonly<Record<AgentActionKind, AgentRiskClass>> = {
  'event.read': 'read_only',
  'readiness.read': 'read_only',
  'report.read': 'read_only',
  'event.prepare': 'low',
  'content.prepare': 'low',
  'campaign.prepare': 'low',
  'event.update': 'high',
  'event.publish': 'high',
  'inventory.change': 'high',
  'campaign.send': 'critical',
  'refund.issue': 'critical',
  'permission.change': 'critical',
  'personal_data.export': 'critical',
  'credential.change': 'critical',
  'domain.change': 'high',
  'provider.change': 'critical',
  'migration.execute': 'critical',
  'resource.delete': 'critical',
};

const reversibilityByKind: Readonly<Record<AgentActionKind, AgentPlanReversibility>> = {
  'event.read': { mode: 'none' },
  'readiness.read': { mode: 'none' },
  'report.read': { mode: 'none' },
  'event.prepare': { mode: 'reversible' },
  'content.prepare': { mode: 'none' },
  'campaign.prepare': { mode: 'none' },
  'event.update': { mode: 'none' },
  'event.publish': { mode: 'none' },
  'inventory.change': {
    mode: 'compensatable',
    compensationActionKind: 'inventory.change',
  },
  'campaign.send': { mode: 'none' },
  'refund.issue': { mode: 'none' },
  'permission.change': {
    mode: 'compensatable',
    compensationActionKind: 'permission.change',
  },
  'personal_data.export': { mode: 'none' },
  'credential.change': {
    mode: 'compensatable',
    compensationActionKind: 'credential.change',
  },
  'domain.change': {
    mode: 'compensatable',
    compensationActionKind: 'domain.change',
  },
  'provider.change': {
    mode: 'compensatable',
    compensationActionKind: 'provider.change',
  },
  'migration.execute': {
    mode: 'compensatable',
    compensationActionKind: 'migration.execute',
  },
  'resource.delete': { mode: 'none' },
};

const materialDigestsByKind: Readonly<Record<AgentActionKind, readonly string[]>> = {
  'event.read': [],
  'readiness.read': [],
  'report.read': ['reportSnapshotSha256'],
  'event.prepare': ['changePreviewSha256'],
  'content.prepare': ['contentPreviewSha256'],
  'campaign.prepare': [
    'audienceSnapshotSha256',
    'exclusionSnapshotSha256',
    'complianceResultSha256',
    'contentVersionSha256',
  ],
  'event.update': ['changePreviewSha256'],
  'event.publish': ['readinessSnapshotSha256'],
  'inventory.change': ['inventorySnapshotSha256', 'changePreviewSha256'],
  'campaign.send': [
    'audienceSnapshotSha256',
    'exclusionSnapshotSha256',
    'complianceResultSha256',
    'contentVersionSha256',
  ],
  'refund.issue': ['refundPreviewSha256', 'paymentStateSha256'],
  'permission.change': ['permissionSnapshotSha256', 'changePreviewSha256'],
  'personal_data.export': ['exportScopeSha256'],
  'credential.change': ['changePreviewSha256'],
  'domain.change': ['changePreviewSha256'],
  'provider.change': ['changePreviewSha256'],
  'migration.execute': ['migrationPlanSha256'],
  'resource.delete': ['deletionPreviewSha256'],
};

function schemaReference(jsonPointer: string): AgentSchemaReference {
  return {
    schemaId: CONTRACT_SCHEMA_ID,
    schemaSha256: AGENT_ACTION_CONTRACT_SCHEMA_SHA256,
    jsonPointer,
  };
}

const actions = (Object.keys(AGENT_ACTION_DESCRIPTORS) as AgentActionKind[]).map(
  (kind): AgentActionRegistryDefinition => {
    const descriptor = AGENT_ACTION_DESCRIPTORS[kind];
    const implemented =
      kind === 'event.publish' ||
      kind === 'event.read' ||
      kind === 'readiness.read' ||
      kind === 'report.read' ||
      kind === 'event.prepare' ||
      kind === 'content.prepare' ||
      kind === 'campaign.prepare' ||
      kind === 'event.update';
    const schemaPrefix =
      kind === 'event.publish'
        ? 'eventPublish'
        : kind === 'event.read'
          ? 'eventRead'
          : kind === 'readiness.read'
            ? 'readinessRead'
            : kind === 'report.read'
              ? 'reportRead'
              : kind === 'event.prepare'
                ? 'eventPrepare'
                : kind === 'content.prepare'
                  ? 'contentPrepare'
                  : kind === 'campaign.prepare'
                    ? 'campaignPrepare'
                    : kind === 'event.update'
                      ? 'eventUpdate'
                      : undefined;
    return {
      kind,
      availability: implemented ? 'implemented' : 'reserved',
      planSupport:
        kind === 'event.publish' ? 'supported' : implemented ? 'direct_only' : 'unavailable',
      prepareInputSchema: schemaReference(
        schemaPrefix ? `#/$defs/${schemaPrefix}PrepareInput` : '#/$defs/reservedAction',
      ),
      resolvedPayloadSchema: schemaReference(
        schemaPrefix ? `#/$defs/${schemaPrefix}ResolvedPayload` : '#/$defs/reservedAction',
      ),
      resultSchema: schemaReference(
        schemaPrefix ? `#/$defs/${schemaPrefix}Result` : '#/$defs/reservedAction',
      ),
      requiredCapabilities: [descriptor.capability],
      requiredSponsorPermissions: [descriptor.sponsorPermission],
      resourceScope: {
        resourceTypes: [...descriptor.resourceTypes],
        scopeTemplate: '{resourceType}:{resourceId}',
      },
      preconditions: {
        resourceVersion: 'exact',
        policyVersion: 'exact',
        requiredMaterialDigests: [...materialDigestsByKind[kind]],
      },
      riskClass: riskByKind[kind],
      reversibility: { ...reversibilityByKind[kind] },
      approvalPolicy: {
        mode: descriptor.consequential ? 'fresh_action' : 'none',
        ...(descriptor.consequential ? { ttlSeconds: 300 } : {}),
        confirmationRequired: descriptor.consequential,
      },
      idempotency: {
        prepare: {
          keySource: 'caller',
          scope: 'agent_action',
          replay: 'exact_result',
          intentMismatch: 'conflict',
        },
        approve: {
          keySource: 'caller',
          scope: 'agent_action',
          replay: 'exact_result',
          intentMismatch: 'conflict',
        },
        execute: {
          keySource: 'derived',
          scope: 'agent_action',
          replay: 'exact_result',
          intentMismatch: 'conflict',
        },
      },
      executionBoundary: { kind: 'api', operation: descriptor.apiOperation },
    };
  },
);

export const AGENT_ACTION_REGISTRY: AgentActionRegistry = {
  protocolVersion: AGENT_ACTION_CONTRACT_VERSION,
  actionProtocolVersion: AGENT_PROTOCOL_VERSION,
  actions,
  registrySha256: agentSha256({
    domain: 'tixkit.agent-action-registry.v2026-08-04',
    protocolVersion: AGENT_ACTION_CONTRACT_VERSION,
    actionProtocolVersion: AGENT_PROTOCOL_VERSION,
    actions,
  }),
};

export function validateAgentActionRegistry(registry: AgentActionRegistry): void {
  assert(
    registry.protocolVersion === AGENT_ACTION_CONTRACT_VERSION,
    'agent registry version is invalid',
  );
  assert(
    registry.actionProtocolVersion === AGENT_PROTOCOL_VERSION,
    'agent action registry version is invalid',
  );
  assert(
    registry.actions.length === Object.keys(AGENT_ACTION_DESCRIPTORS).length,
    'agent registry is incomplete',
  );
  assertUnique(registry.actions, (item) => item.kind, 'agent registry action kinds must be unique');
  for (const definition of registry.actions) {
    const descriptor = AGENT_ACTION_DESCRIPTORS[definition.kind];
    assert(descriptor, 'agent registry action kind is invalid');
    assert(
      definition.requiredCapabilities.length === 1 &&
        definition.requiredCapabilities[0] === descriptor.capability,
      'agent registry capability binding is invalid',
    );
    assert(
      definition.requiredSponsorPermissions.length === 1 &&
        definition.requiredSponsorPermissions[0] === descriptor.sponsorPermission,
      'agent registry sponsor permission binding is invalid',
    );
    assert(
      definition.resourceScope.resourceTypes.length === descriptor.resourceTypes.length &&
        definition.resourceScope.resourceTypes.every((item) =>
          descriptor.resourceTypes.includes(item),
        ),
      'agent registry resource scope is invalid',
    );
    assert(
      definition.preconditions.requiredMaterialDigests.every((item) => MATERIAL_DIGEST.test(item)),
      'agent registry material digest name is invalid',
    );
    for (const reference of [
      definition.prepareInputSchema,
      definition.resolvedPayloadSchema,
      definition.resultSchema,
    ]) {
      assert(reference.schemaId === CONTRACT_SCHEMA_ID, 'agent registry schema id is invalid');
      assert(
        reference.schemaSha256 === AGENT_ACTION_CONTRACT_SCHEMA_SHA256,
        'agent registry schema digest is invalid',
      );
      assert(
        reference.jsonPointer.startsWith('#/$defs/'),
        'agent registry schema pointer is invalid',
      );
    }
    if (definition.availability === 'implemented')
      assert(
        definition.kind === 'event.publish' ||
          definition.kind === 'event.read' ||
          definition.kind === 'readiness.read' ||
          definition.kind === 'report.read' ||
          definition.kind === 'event.prepare' ||
          definition.kind === 'content.prepare' ||
          definition.kind === 'campaign.prepare' ||
          definition.kind === 'event.update',
        'unimplemented agent action is advertised',
      );
    else
      assert(
        definition.prepareInputSchema.jsonPointer === '#/$defs/reservedAction' &&
          definition.resolvedPayloadSchema.jsonPointer === '#/$defs/reservedAction' &&
          definition.resultSchema.jsonPointer === '#/$defs/reservedAction',
        'reserved agent action exposes executable schemas',
      );
    assert(
      definition.planSupport ===
        (definition.kind === 'event.publish'
          ? 'supported'
          : definition.availability === 'implemented'
            ? 'direct_only'
            : 'unavailable'),
      'agent registry plan support is invalid',
    );
    assert(
      definition.approvalPolicy.mode === (descriptor.consequential ? 'fresh_action' : 'none'),
      'agent registry approval policy is invalid',
    );
    assert(
      definition.executionBoundary.operation === descriptor.apiOperation,
      'agent registry execution boundary is invalid',
    );
  }
  const { registrySha256: _digest, ...material } = registry;
  assert(
    registry.registrySha256 ===
      agentSha256({
        domain: 'tixkit.agent-action-registry.v2026-08-04',
        ...material,
      }),
    'agent registry digest is invalid',
  );
  assert(
    agentSha256(registry) === agentSha256(AGENT_ACTION_REGISTRY),
    'agent registry differs from the canonical pinned policy',
  );
}

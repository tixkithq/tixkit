import {
  AGENT_ACTION_DESCRIPTORS,
  AgentProtocolValidationError,
  agentActionDigest,
  agentSha256,
  authorizeAgentAction,
  canonicalAgentJson,
  type AgentAction,
  type AgentApproval,
  type AgentAuditRecord,
  type AgentAuthorizationInput,
  type AgentDelegationGrant,
  type AgentPrincipal,
} from './protocol.js';

export interface AgentExecution {
  id: string;
  tenantId: string;
  actionId: string;
  actionDigest: string;
  agentPrincipalId: string;
  sponsorPrincipalId: string;
  delegationGrantId: string;
  approvalId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  state: 'reserved' | 'running' | 'succeeded' | 'failed' | 'compensated';
  resourceVersion: number;
  policyVersion: number;
  fenceToken: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  result?: Readonly<Record<string, unknown>>;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentExecutionEvidence {
  execution: AgentExecution;
  audit: readonly AgentExecutionAuditRecord[];
}

/** Audit evidence returned with an execution is always bound to its consumed approval. */
export type AgentExecutionAuditRecord = AgentAuditRecord & { approvalId: string };

export interface AgentExecutionStore {
  /**
   * Atomically consumes the exact authoritative approval and inserts/reads the payload-bound
   * execution plus its prepared/authorized audit records. No execution may be returned as newly
   * reserved unless approval consumption committed in the same transaction.
   */
  reserveAndConsume(input: {
    execution: AgentExecution;
    approval: AgentApproval;
    requiredApproverPermission: string;
    now: string;
    audit: readonly AgentAuditRecord[];
  }): Promise<{ created: boolean; execution: AgentExecution }>;
  /** Claims or resumes one execution with a database-authoritative lease and increasing fence. */
  claim(input: {
    tenantId: string;
    executionId: string;
    workerId: string;
    audit: AgentAuditRecord;
  }): Promise<AgentExecution | null>;
  /** Exact owner/fence CAS that atomically appends the terminal audit record. */
  complete(input: {
    execution: AgentExecution;
    expectedRevision: { fenceToken: number; leaseOwner: string };
    audit: AgentAuditRecord;
  }): Promise<boolean>;
  /** Returns only exact, immutable, digest-validated evidence of an already committed effect. */
  recoverEffect(input: {
    execution: AgentExecution;
    action: AgentAction;
  }): Promise<AgentActionResult | undefined>;
}

export interface AgentActionInvoker {
  /** Invokes only the action's registry operation and atomically rechecks authorizationStateDigest. */
  invoke(input: {
    tenantId: string;
    operation: string;
    resourceType: string;
    resourceId: string;
    expectedResourceVersion: number;
    payload: Readonly<Record<string, unknown>>;
    idempotencyKey: string;
    agentPrincipalId: string;
    sponsorPrincipalId: string;
    delegationGrantId: string;
    approvalId: string;
    executionId: string;
    actionKind: AgentAction['kind'];
    actionDigest: string;
    expectedPolicyVersion: number;
    authorizationStateDigest: string;
    expectedLeaseOwner: string;
    expectedFenceToken: number;
  }): Promise<AgentActionResult>;
}

export interface AgentCurrentAuthorization {
  principal: AgentPrincipal;
  delegation: AgentDelegationGrant;
  approval: AgentApproval;
  approvalExecutionId: string;
  sponsorPermissions: readonly string[];
  tenantAllowedActions: AgentAuthorizationInput['tenantAllowedActions'];
  currentResourceVersion: number;
  currentPolicyVersion: number;
  riskPolicyAllowed: boolean;
  observedAt: string;
}

export interface AgentAuthorizationStateProvider {
  /** Reads the current authoritative permission, policy, resource and approval state. */
  load(input: {
    action: AgentAction;
    execution: AgentExecution;
  }): Promise<AgentCurrentAuthorization>;
}

export function agentAuthorizationStateDigest(current: AgentCurrentAuthorization): string {
  return agentSha256({
    principal: current.principal,
    delegation: current.delegation,
    approval: current.approval,
    approvalExecutionId: current.approvalExecutionId,
    sponsorPermissions: [...current.sponsorPermissions].sort(),
    tenantAllowedActions: [...current.tenantAllowedActions].sort(),
    currentResourceVersion: current.currentResourceVersion,
    currentPolicyVersion: current.currentPolicyVersion,
    riskPolicyAllowed: current.riskPolicyAllowed,
  });
}

export interface AgentActionResult extends Readonly<Record<string, unknown>> {
  resourceId: string;
  resourceVersion: number;
  status: string;
}

export interface AgentExecutionIds {
  executionId(): string;
  auditId(): string;
}

export interface AgentExecutionClock {
  now(): Date;
}

export class AgentExecutionConflictError extends Error {}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u;
const FAILURE_CODE = /^[A-Z0-9_]{3,64}$/u;
const RESULT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESULT_KEYS = new Set(['resourceId', 'resourceVersion', 'status']);

export function validateAgentActionResult(result: AgentActionResult): void {
  const keys = Object.keys(result);
  if (
    keys.length !== RESULT_KEYS.size ||
    keys.some((key) => !RESULT_KEYS.has(key)) ||
    typeof result.resourceId !== 'string' ||
    typeof result.status !== 'string' ||
    !RESULT_VALUE.test(result.resourceId) ||
    !RESULT_VALUE.test(result.status) ||
    !Number.isSafeInteger(result.resourceVersion) ||
    result.resourceVersion < 0 ||
    Buffer.byteLength(canonicalAgentJson(result), 'utf8') > 1_024
  )
    throw new AgentProtocolValidationError('agent action result is unsafe');
}

export function validateAgentActionResultForAction(
  action: AgentAction,
  result: AgentActionResult,
): void {
  validateAgentActionResult(result);
  if (result.resourceId !== action.target.resourceId)
    throw new AgentProtocolValidationError('agent action result resource is invalid');
  if (
    action.kind === 'event.publish' &&
    (result.status !== 'published' ||
      (result.resourceVersion !== action.target.resourceVersion &&
        result.resourceVersion !== action.target.resourceVersion + 1))
  )
    throw new AgentProtocolValidationError('event publish result is invalid');
}

export function agentExecutionIdempotencyKey(
  action: Pick<AgentAction, 'agentPrincipalId' | 'idempotencyKey'>,
): string {
  return agentSha256({
    agentPrincipalId: action.agentPrincipalId,
    idempotencyKey: action.idempotencyKey,
  });
}

function requestFingerprint(action: AgentAction, actionDigest: string): string {
  return agentSha256({
    actionDigest,
    idempotencyKey: agentExecutionIdempotencyKey(action),
    tenantId: action.target.tenantId,
  });
}

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code).toUpperCase();
    if (FAILURE_CODE.test(code)) return code;
  }
  return 'AGENT_ACTION_FAILED';
}

export class DurableAgentExecutionService {
  constructor(
    private readonly store: AgentExecutionStore,
    private readonly invoker: AgentActionInvoker,
    private readonly clock: AgentExecutionClock,
    private readonly ids: AgentExecutionIds,
    private readonly authorizationState: AgentAuthorizationStateProvider,
  ) {}

  async reserve(
    input: AgentAuthorizationInput & {
      approval: AgentApproval;
    },
  ): Promise<AgentExecution> {
    const decision = authorizeAgentAction(input);
    if (!decision.allowed || !decision.requiresApproval)
      throw new AgentExecutionConflictError(
        `agent execution denied: ${decision.reasons.join(',')}`,
      );
    const now = this.clock.now().toISOString();
    const executionId = this.ids.executionId();
    if (!ID.test(executionId)) throw new AgentProtocolValidationError('execution ID is invalid');
    const fingerprint = requestFingerprint(input.action, input.actionDigest);
    const execution: AgentExecution = {
      id: executionId,
      tenantId: input.action.target.tenantId,
      actionId: input.action.id,
      actionDigest: input.actionDigest,
      agentPrincipalId: input.action.agentPrincipalId,
      sponsorPrincipalId: input.action.sponsorPrincipalId,
      delegationGrantId: input.action.delegationGrantId,
      approvalId: input.approval.id,
      idempotencyKey: agentExecutionIdempotencyKey(input.action),
      requestFingerprint: fingerprint,
      state: 'reserved',
      resourceVersion: input.currentResourceVersion,
      policyVersion: input.currentPolicyVersion,
      fenceToken: 0,
      createdAt: now,
      updatedAt: now,
    };
    const audit = (['prepared', 'authorized'] as const).map((phase) =>
      this.audit(execution, phase, now),
    );
    const descriptorPermission = AGENT_ACTION_DESCRIPTORS[input.action.kind].sponsorPermission;
    const reserved = await this.store.reserveAndConsume({
      execution,
      approval: input.approval,
      requiredApproverPermission: descriptorPermission,
      now,
      audit,
    });
    if (
      reserved.execution.requestFingerprint !== fingerprint ||
      reserved.execution.actionDigest !== input.actionDigest
    )
      throw new AgentExecutionConflictError('execution idempotency key is bound to another action');
    return reserved.execution;
  }

  async run(input: {
    action: AgentAction;
    execution: AgentExecution;
    workerId: string;
  }): Promise<AgentExecution> {
    if (
      !ID.test(input.workerId) ||
      input.execution.actionDigest !== agentActionDigest(input.action) ||
      input.execution.tenantId !== input.action.target.tenantId
    )
      throw new AgentExecutionConflictError('execution does not match the action');
    const claimTime = this.clock.now().toISOString();
    const claimed = await this.store.claim({
      tenantId: input.execution.tenantId,
      executionId: input.execution.id,
      workerId: input.workerId,
      audit: this.audit(input.execution, 'started', claimTime),
    });
    if (!claimed) throw new AgentExecutionConflictError('execution is not claimable');
    if (
      claimed.actionDigest !== agentActionDigest(input.action) ||
      claimed.actionId !== input.action.id ||
      claimed.tenantId !== input.action.target.tenantId ||
      claimed.agentPrincipalId !== input.action.agentPrincipalId ||
      claimed.sponsorPrincipalId !== input.action.sponsorPrincipalId ||
      claimed.delegationGrantId !== input.action.delegationGrantId
    )
      throw new AgentExecutionConflictError('claimed execution does not match the action');
    if (claimed.state === 'succeeded' || claimed.state === 'compensated') return claimed;
    if (!claimed.leaseOwner || claimed.state !== 'running')
      throw new AgentExecutionConflictError('execution is not claimable');
    const recovered = await this.store.recoverEffect({ execution: claimed, action: input.action });
    if (recovered) {
      validateAgentActionResultForAction(input.action, recovered);
      const completed: AgentExecution = {
        ...claimed,
        state: 'succeeded',
        result: recovered,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: this.clock.now().toISOString(),
      };
      if (
        !(await this.store.complete({
          execution: completed,
          expectedRevision: { fenceToken: claimed.fenceToken, leaseOwner: claimed.leaseOwner },
          audit: this.audit(completed, 'succeeded', completed.updatedAt),
        }))
      )
        throw new AgentExecutionConflictError('effect recovery completion raced');
      return completed;
    }
    let current: AgentCurrentAuthorization;
    try {
      current = await this.authorizationState.load({
        action: input.action,
        execution: claimed,
      });
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
      if (
        code === 'AGENT_AUTHORIZATION_CHANGED' ||
        code === 'AGENT_STATE_INVALID' ||
        code === 'AGENT_OPERATION_DENIED'
      )
        return this.failAuthorization(claimed, [code.toLowerCase()]);
      throw error;
    }
    const approval =
      current.approvalExecutionId === claimed.id
        ? { ...current.approval, consumedAt: undefined }
        : current.approval;
    const currentDecision = authorizeAgentAction({
      principal: current.principal,
      delegation: current.delegation,
      action: input.action,
      actionDigest: claimed.actionDigest,
      sponsorPermissions: current.sponsorPermissions,
      tenantAllowedActions: current.riskPolicyAllowed ? current.tenantAllowedActions : [],
      currentResourceVersion: current.currentResourceVersion,
      currentPolicyVersion: current.currentPolicyVersion,
      now: current.observedAt,
      approval,
    });
    const authorizationStateDigest = agentAuthorizationStateDigest(current);
    if (!currentDecision.allowed) return this.failAuthorization(claimed, currentDecision.reasons);
    try {
      const result = await this.invoker.invoke({
        tenantId: claimed.tenantId,
        operation: input.action.target.apiOperation,
        resourceType: input.action.target.resourceType,
        resourceId: input.action.target.resourceId,
        expectedResourceVersion: claimed.resourceVersion,
        payload: input.action.payload,
        idempotencyKey: claimed.idempotencyKey,
        agentPrincipalId: claimed.agentPrincipalId,
        sponsorPrincipalId: claimed.sponsorPrincipalId,
        delegationGrantId: claimed.delegationGrantId,
        approvalId: claimed.approvalId,
        executionId: claimed.id,
        actionKind: input.action.kind,
        actionDigest: claimed.actionDigest,
        expectedPolicyVersion: claimed.policyVersion,
        authorizationStateDigest,
        expectedLeaseOwner: claimed.leaseOwner,
        expectedFenceToken: claimed.fenceToken,
      });
      validateAgentActionResult(result);
      const completed: AgentExecution = {
        ...claimed,
        state: 'succeeded',
        result,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: this.clock.now().toISOString(),
      };
      if (
        !(await this.store.complete({
          execution: completed,
          expectedRevision: { fenceToken: claimed.fenceToken, leaseOwner: claimed.leaseOwner },
          audit: this.audit(completed, 'succeeded', completed.updatedAt),
        }))
      )
        throw new AgentExecutionConflictError('execution completion raced');
      return completed;
    } catch (error) {
      if (error instanceof AgentExecutionConflictError) throw error;
      const failed: AgentExecution = {
        ...claimed,
        state: 'failed',
        failureCode: failureCode(error),
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: this.clock.now().toISOString(),
      };
      if (
        !(await this.store.complete({
          execution: failed,
          expectedRevision: { fenceToken: claimed.fenceToken, leaseOwner: claimed.leaseOwner },
          audit: this.audit(failed, 'failed', failed.updatedAt),
        }))
      )
        throw new AgentExecutionConflictError('execution failure commit raced');
      return failed;
    }
  }

  private async failAuthorization(
    execution: AgentExecution,
    reasons: readonly string[],
  ): Promise<AgentExecution> {
    const failed: AgentExecution = {
      ...execution,
      state: 'failed',
      failureCode: 'AGENT_AUTHORIZATION_CHANGED',
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: this.clock.now().toISOString(),
    };
    if (
      !execution.leaseOwner ||
      !(await this.store.complete({
        execution: failed,
        expectedRevision: { fenceToken: execution.fenceToken, leaseOwner: execution.leaseOwner },
        audit: { ...this.audit(failed, 'failed', failed.updatedAt), reasonCodes: reasons },
      }))
    )
      throw new AgentExecutionConflictError('authorization denial commit raced');
    return failed;
  }

  private audit(
    execution: AgentExecution,
    phase: AgentAuditRecord['phase'],
    occurredAt: string,
  ): AgentAuditRecord {
    return {
      id: this.ids.auditId(),
      tenantId: execution.tenantId,
      agentPrincipalId: execution.agentPrincipalId,
      sponsorPrincipalId: execution.sponsorPrincipalId,
      delegationGrantId: execution.delegationGrantId,
      actionId: execution.actionId,
      actionDigest: execution.actionDigest,
      approvalId: execution.approvalId,
      phase,
      idempotencyKey: execution.idempotencyKey,
      resourceVersion: execution.resourceVersion,
      occurredAt,
      reasonCodes: [],
    };
  }
}

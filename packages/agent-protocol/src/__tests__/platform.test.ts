import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROTOCOL_VERSION,
  agentActionDigest,
  agentSha256,
  type AgentAction,
  type AgentApproval,
} from '../protocol.js';
import {
  AGENT_ACTION_CONTRACT_SCHEMA_SHA256,
  AGENT_ACTION_CONTRACT_SCHEMA_SHA256_2026_07_27,
  AGENT_ACTION_REGISTRY,
  AGENT_PLATFORM_PROTOCOL_VERSION,
  buildAgentPlanDefinition,
  validateAgentActionRegistry,
  validateAgentReadinessReadResult,
  validateAgentPlanActionBindings,
  validateAgentPlanDefinition,
  validateAgentPlanState,
  validateAgentPlanStateTransition,
  validateAgentPlanStepApprovalBinding,
  type AgentPlanDefinition,
  type AgentPlanState,
  type AgentReadinessReadResult,
} from '../platform.js';

const createdAt = '2026-07-14T12:00:00.000Z';
const expiresAt = '2026-07-14T12:30:00.000Z';

function definitionInput(): Omit<AgentPlanDefinition, 'planSha256'> {
  return {
    id: 'plan_primary',
    protocolVersion: AGENT_PLATFORM_PROTOCOL_VERSION,
    tenantId: 'tenant_primary',
    agentPrincipalId: 'agent_primary',
    sponsorPrincipalId: 'sponsor_primary',
    delegationGrantId: 'delegation_primary',
    purpose: 'Publish the reviewed event configuration',
    assumptions: [
      {
        id: 'assumption_launch_date',
        statement: 'The organizer confirmed the launch date.',
        provenanceType: 'user',
        sourceReference: 'approval_session_primary',
        verification: 'confirmed',
      },
    ],
    steps: [
      {
        id: 'step_publish',
        actionKind: 'event.publish',
        actionProtocolVersion: AGENT_PROTOCOL_VERSION,
        actionDigest: 'a'.repeat(64),
        dependsOnStepIds: [],
        projectedChanges: [
          {
            resourceType: 'event',
            resourceId: 'event_primary',
            operation: 'publish',
            beforeVersion: 7,
            projectedVersion: 8,
            previewSha256: 'b'.repeat(64),
          },
        ],
        costs: [
          {
            amountMinor: 0,
            currency: 'USD',
            basis: 'Event publication has no direct platform charge.',
            quoteSha256: 'c'.repeat(64),
            expiresAt,
          },
        ],
        readinessImpact: {
          beforeSnapshotSha256: 'd'.repeat(64),
          projectedSnapshotSha256: 'e'.repeat(64),
          introducedReasonCodes: [],
          resolvedReasonCodes: ['event_unpublished'],
        },
        approvalRequirement: { mode: 'fresh_action', riskClass: 'high' },
        reversibility: { mode: 'none' },
      },
    ],
    createdAt,
    expiresAt,
  };
}

function state(plan: AgentPlanDefinition): AgentPlanState {
  return {
    planId: plan.id,
    planSha256: plan.planSha256,
    stateVersion: 1,
    status: 'awaiting_approval',
    stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
    updatedAt: createdAt,
  };
}

function action(): AgentAction {
  return {
    id: 'action_publish',
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentPrincipalId: 'agent_primary',
    sponsorPrincipalId: 'sponsor_primary',
    delegationGrantId: 'delegation_primary',
    kind: 'event.publish',
    autonomy: 'execute_with_approval',
    target: {
      tenantId: 'tenant_primary',
      resourceType: 'event',
      resourceId: 'event_primary',
      resourceVersion: 7,
      apiOperation: 'events.publish',
    },
    payload: { readinessSnapshotSha256: 'd'.repeat(64) },
    idempotencyKey: 'agent-plan-action-2026-07-27',
    expectedPolicyVersion: 3,
    preparedAt: createdAt,
  };
}

describe('agent platform contracts', () => {
  it('domain-separates immutable plan material from mutable server state', () => {
    const plan = buildAgentPlanDefinition(definitionInput());
    expect(plan.planSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => validateAgentPlanDefinition(plan)).not.toThrow();
    expect(() => validateAgentPlanState(plan, state(plan))).not.toThrow();
    expect(
      buildAgentPlanDefinition({
        ...definitionInput(),
        assumptions: [
          {
            ...definitionInput().assumptions[0]!,
            verification: 'rejected',
          },
        ],
      }).planSha256,
    ).not.toBe(plan.planSha256);
    expect({ ...state(plan), status: 'cancelled' }).toMatchObject({
      planSha256: plan.planSha256,
    });
  });

  it('rejects cycles, reserved actions, registry-policy substitution and forged state evidence', () => {
    const base = definitionInput();
    expect(() =>
      buildAgentPlanDefinition({
        ...base,
        steps: [
          { ...base.steps[0]!, dependsOnStepIds: ['step_second'] },
          {
            ...base.steps[0]!,
            id: 'step_second',
            actionDigest: 'f'.repeat(64),
            dependsOnStepIds: ['step_publish'],
          },
        ],
      }),
    ).toThrow('cycle');
    expect(() =>
      buildAgentPlanDefinition({
        ...base,
        steps: [
          {
            ...base.steps[0]!,
            actionKind: 'refund.issue',
            approvalRequirement: { mode: 'fresh_action', riskClass: 'critical' },
            reversibility: { mode: 'none' },
          },
        ],
      }),
    ).toThrow('not implemented');
    expect(() =>
      buildAgentPlanDefinition({
        ...base,
        steps: [
          {
            ...base.steps[0]!,
            actionKind: 'readiness.read',
            approvalRequirement: { mode: 'none', riskClass: 'read_only' },
            reversibility: { mode: 'none' },
          },
        ],
      }),
    ).toThrow('not implemented');
    expect(() =>
      buildAgentPlanDefinition({
        ...base,
        steps: [
          {
            ...base.steps[0]!,
            approvalRequirement: { mode: 'none', riskClass: 'low' },
          },
        ],
      }),
    ).toThrow('does not match the registry');
    const plan = buildAgentPlanDefinition(base);
    expect(() =>
      validateAgentPlanState(plan, {
        ...state(plan),
        status: 'succeeded',
        stepStates: [{ stepId: 'step_publish', status: 'succeeded' }],
      }),
    ).toThrow('approval evidence');
  });

  it('binds every plan step and fresh approval to the exact action identity and plan digest', () => {
    const preparedAction = action();
    const input = definitionInput();
    const plan = buildAgentPlanDefinition({
      ...input,
      steps: [{ ...input.steps[0]!, actionDigest: agentActionDigest(preparedAction) }],
    });
    expect(() => validateAgentPlanActionBindings(plan, [preparedAction])).not.toThrow();
    expect(() =>
      validateAgentPlanActionBindings(plan, [
        { ...preparedAction, sponsorPrincipalId: 'sponsor_substituted' },
      ]),
    ).toThrow();
    const misleadingInput = definitionInput();
    const misleadingPlan = buildAgentPlanDefinition({
      ...misleadingInput,
      steps: [
        {
          ...misleadingInput.steps[0]!,
          actionDigest: agentActionDigest(preparedAction),
          projectedChanges: [
            {
              ...misleadingInput.steps[0]!.projectedChanges[0]!,
              resourceId: 'event_substituted',
            },
          ],
        },
      ],
    });
    expect(() => validateAgentPlanActionBindings(misleadingPlan, [preparedAction])).toThrow(
      'preview does not match',
    );
    const approval: AgentApproval = {
      id: 'approval_primary',
      tenantId: plan.tenantId,
      actionDigest: plan.steps[0]!.actionDigest,
      planSha256: plan.planSha256,
      approverPrincipalId: plan.sponsorPrincipalId,
      approverPermissionSnapshot: ['events:publish'],
      policyVersion: 3,
      approvedAt: createdAt,
      expiresAt,
    };
    expect(() =>
      validateAgentPlanStepApprovalBinding(plan, 'step_publish', preparedAction, approval),
    ).not.toThrow();
    expect(() =>
      validateAgentPlanStepApprovalBinding(plan, 'step_publish', preparedAction, {
        ...approval,
        planSha256: 'f'.repeat(64),
      }),
    ).toThrow('binding');
  });

  it('allows only monotonic dependency-gated state transitions with exact evidence', () => {
    const preparedAction = action();
    const input = definitionInput();
    const plan = buildAgentPlanDefinition({
      ...input,
      steps: [{ ...input.steps[0]!, actionDigest: agentActionDigest(preparedAction) }],
    });
    const initial: AgentPlanState = {
      planId: plan.id,
      planSha256: plan.planSha256,
      stateVersion: 1,
      status: 'prepared',
      stepStates: [{ stepId: 'step_publish', status: 'pending' }],
      updatedAt: '2026-07-14T12:01:00.000Z',
    };
    expect(() =>
      validateAgentPlanStateTransition(plan, undefined, initial, {
        actions: [preparedAction],
        approvals: [],
        executions: [],
      }),
    ).not.toThrow();
    const awaitingApproval: AgentPlanState = {
      ...initial,
      stateVersion: 2,
      status: 'awaiting_approval',
      stepStates: [{ stepId: 'step_publish', status: 'awaiting_approval' }],
      updatedAt: '2026-07-14T12:01:05.000Z',
    };
    expect(() =>
      validateAgentPlanStateTransition(plan, initial, awaitingApproval, {
        actions: [preparedAction],
        approvals: [],
        executions: [],
      }),
    ).not.toThrow();

    const approval: AgentApproval = {
      id: 'approval_primary',
      tenantId: plan.tenantId,
      actionDigest: plan.steps[0]!.actionDigest,
      planSha256: plan.planSha256,
      approverPrincipalId: plan.sponsorPrincipalId,
      approverPermissionSnapshot: ['events:publish'],
      policyVersion: 3,
      approvedAt: '2026-07-14T12:01:10.000Z',
      expiresAt: '2026-07-14T12:06:10.000Z',
      consumedAt: '2026-07-14T12:01:20.000Z',
    };
    const execution = {
      id: 'execution_primary',
      tenantId: plan.tenantId,
      actionId: preparedAction.id,
      actionDigest: plan.steps[0]!.actionDigest,
      planSha256: plan.planSha256,
      agentPrincipalId: plan.agentPrincipalId,
      sponsorPrincipalId: plan.sponsorPrincipalId,
      delegationGrantId: plan.delegationGrantId,
      approvalId: approval.id,
      idempotencyKey: 'f'.repeat(64),
      requestFingerprint: '1'.repeat(64),
      state: 'running' as const,
      resourceVersion: 7,
      policyVersion: 3,
      fenceToken: 1,
      leaseOwner: 'worker_primary',
      leaseExpiresAt: '2026-07-14T12:03:00.000Z',
      createdAt: '2026-07-14T12:01:20.000Z',
      updatedAt: '2026-07-14T12:01:30.000Z',
    };
    const executing: AgentPlanState = {
      ...initial,
      stateVersion: 3,
      status: 'executing',
      stepStates: [
        {
          stepId: 'step_publish',
          status: 'executing',
          approvalId: approval.id,
          executionId: execution.id,
        },
      ],
      updatedAt: '2026-07-14T12:02:00.000Z',
    };
    expect(() =>
      validateAgentPlanStateTransition(plan, awaitingApproval, executing, {
        actions: [preparedAction],
        approvals: [approval],
        executions: [execution],
      }),
    ).not.toThrow();
    expect(() =>
      validateAgentPlanStateTransition(
        plan,
        awaitingApproval,
        { ...executing, stateVersion: 4 },
        {
          actions: [preparedAction],
          approvals: [approval],
          executions: [execution],
        },
      ),
    ).toThrow('monotonic');
    for (const invalidApproval of [
      { ...approval, approverPrincipalId: 'sponsor_substituted' },
      { ...approval, policyVersion: 4 },
      { ...approval, expiresAt: '2026-07-14T12:20:00.000Z' },
      { ...approval, consumedAt: undefined },
      { ...approval, approverPermissionSnapshot: ['events:read'] },
    ])
      expect(() =>
        validateAgentPlanStateTransition(plan, awaitingApproval, executing, {
          actions: [preparedAction],
          approvals: [invalidApproval],
          executions: [execution],
        }),
      ).toThrow();

    for (const invalidExecution of [
      { ...execution, actionId: 'action_substituted' },
      { ...execution, resourceVersion: 8 },
      { ...execution, policyVersion: 4 },
      { ...execution, createdAt: '2026-07-14T12:06:11.000Z' },
    ])
      expect(() =>
        validateAgentPlanStateTransition(plan, awaitingApproval, executing, {
          actions: [preparedAction],
          approvals: [approval],
          executions: [invalidExecution],
        }),
      ).toThrow('execution binding');

    const succeededExecution = {
      ...execution,
      state: 'succeeded' as const,
      result: { resourceId: 'event_primary', resourceVersion: 8, status: 'published' },
      updatedAt: '2026-07-14T12:07:00.000Z',
    };
    const succeeded: AgentPlanState = {
      ...executing,
      stateVersion: 4,
      status: 'succeeded',
      stepStates: [
        {
          stepId: 'step_publish',
          status: 'succeeded',
          approvalId: approval.id,
          executionId: execution.id,
          resultSha256: agentSha256(succeededExecution.result),
        },
      ],
      updatedAt: '2026-07-14T12:07:00.000Z',
    };
    expect(() =>
      validateAgentPlanStateTransition(plan, executing, succeeded, {
        actions: [preparedAction],
        approvals: [approval],
        executions: [succeededExecution],
      }),
    ).not.toThrow();
    const directlySucceeded: AgentPlanState = {
      ...succeeded,
      stateVersion: 3,
      updatedAt: '2026-07-14T12:02:00.000Z',
    };
    expect(() =>
      validateAgentPlanStateTransition(plan, awaitingApproval, directlySucceeded, {
        actions: [preparedAction],
        approvals: [approval],
        executions: [succeededExecution],
      }),
    ).not.toThrow();
    for (const invalidResult of [
      { resourceId: 'event_substituted', resourceVersion: 8, status: 'published' },
      { resourceId: 'event_primary', resourceVersion: 9, status: 'published' },
      { resourceId: 'event_primary', resourceVersion: 8, status: 'wrong' },
    ]) {
      const invalidSucceededExecution = { ...succeededExecution, result: invalidResult };
      expect(() =>
        validateAgentPlanStateTransition(
          plan,
          executing,
          {
            ...succeeded,
            stepStates: [
              {
                ...succeeded.stepStates[0]!,
                resultSha256: agentSha256(invalidResult),
              },
            ],
          },
          {
            actions: [preparedAction],
            approvals: [approval],
            executions: [invalidSucceededExecution],
          },
        ),
      ).toThrow();
    }

    const failedExecution = {
      ...execution,
      state: 'failed' as const,
      failureCode: 'EVENT_NOT_READY',
      updatedAt: '2026-07-14T12:03:00.000Z',
    };
    const failed: AgentPlanState = {
      ...executing,
      stateVersion: 4,
      status: 'failed',
      stepStates: [
        {
          stepId: 'step_publish',
          status: 'failed',
          approvalId: approval.id,
          executionId: execution.id,
          failureCode: 'EVENT_NOT_READY',
        },
      ],
      updatedAt: '2026-07-14T12:03:00.000Z',
    };
    expect(() =>
      validateAgentPlanStateTransition(plan, executing, failed, {
        actions: [preparedAction],
        approvals: [approval],
        executions: [failedExecution],
      }),
    ).not.toThrow();
    expect(() =>
      validateAgentPlanStateTransition(
        plan,
        executing,
        {
          ...failed,
          stepStates: [{ ...failed.stepStates[0]!, failureCode: 'FORGED_FAILURE' }],
        },
        {
          actions: [preparedAction],
          approvals: [approval],
          executions: [failedExecution],
        },
      ),
    ).toThrow('failure evidence');
    expect(() =>
      validateAgentPlanStateTransition(
        plan,
        executing,
        {
          ...failed,
          stepStates: [
            {
              stepId: 'step_publish',
              status: 'failed',
              failureCode: 'EVENT_NOT_READY',
            },
          ],
        } as AgentPlanState,
        {
          actions: [preparedAction],
          approvals: [approval],
          executions: [failedExecution],
        },
      ),
    ).toThrow();

    const expired: AgentPlanState = {
      ...awaitingApproval,
      stateVersion: 3,
      status: 'expired',
      updatedAt: expiresAt,
    };
    expect(() =>
      validateAgentPlanStateTransition(plan, awaitingApproval, expired, {
        actions: [preparedAction],
        approvals: [],
        executions: [],
      }),
    ).not.toThrow();
    expect(() =>
      validateAgentPlanStateTransition(
        plan,
        awaitingApproval,
        { ...executing, updatedAt: expiresAt },
        { actions: [preparedAction], approvals: [approval], executions: [execution] },
      ),
    ).toThrow('exact expired state');
    expect(() =>
      validateAgentPlanStateTransition(
        plan,
        undefined,
        { ...initial, updatedAt: '2026-07-14T11:59:59.999Z' },
        { actions: [preparedAction], approvals: [], executions: [] },
      ),
    ).toThrow('predates');

    const secondAction = {
      ...preparedAction,
      id: 'action_second',
      idempotencyKey: 'agent-plan-action-second-2026',
    };
    const twoStepInput = definitionInput();
    const twoStepPlan = buildAgentPlanDefinition({
      ...twoStepInput,
      steps: [
        { ...twoStepInput.steps[0]!, actionDigest: agentActionDigest(preparedAction) },
        {
          ...twoStepInput.steps[0]!,
          id: 'step_second',
          actionDigest: agentActionDigest(secondAction),
          dependsOnStepIds: ['step_publish'],
        },
      ],
    });
    const dependencyPrevious: AgentPlanState = {
      planId: twoStepPlan.id,
      planSha256: twoStepPlan.planSha256,
      stateVersion: 1,
      status: 'awaiting_approval',
      stepStates: [
        { stepId: 'step_publish', status: 'pending' },
        { stepId: 'step_second', status: 'awaiting_approval' },
      ],
      updatedAt: '2026-07-14T12:01:00.000Z',
    };
    const invalidDependencyState: AgentPlanState = {
      ...dependencyPrevious,
      stateVersion: 2,
      status: 'executing',
      stepStates: [
        { stepId: 'step_publish', status: 'pending' },
        {
          stepId: 'step_second',
          status: 'executing',
          approvalId: approval.id,
          executionId: execution.id,
        },
      ],
      updatedAt: '2026-07-14T12:02:00.000Z',
    };
    expect(() =>
      validateAgentPlanStateTransition(twoStepPlan, dependencyPrevious, invalidDependencyState, {
        actions: [preparedAction, secondAction],
        approvals: [approval],
        executions: [execution],
      }),
    ).toThrow();
  });

  it('publishes one digest-bound registry and never advertises reserved actions as callable', () => {
    expect(() => validateAgentActionRegistry(AGENT_ACTION_REGISTRY)).not.toThrow();
    expect(
      AGENT_ACTION_REGISTRY.actions.filter((item) => item.availability === 'implemented'),
    ).toEqual([
      expect.objectContaining({ kind: 'readiness.read', planSupport: 'direct_only' }),
      expect.objectContaining({ kind: 'event.publish', planSupport: 'supported' }),
    ]);
    for (const definition of AGENT_ACTION_REGISTRY.actions.filter(
      (item) => item.availability === 'reserved',
    )) {
      expect(definition.prepareInputSchema.jsonPointer).toBe('#/$defs/reservedAction');
      expect(definition.resultSchema.jsonPointer).toBe('#/$defs/reservedAction');
    }
    expect(() =>
      validateAgentActionRegistry({
        ...AGENT_ACTION_REGISTRY,
        actions: AGENT_ACTION_REGISTRY.actions.map((item) =>
          item.kind === 'refund.issue' ? { ...item, availability: 'implemented' as const } : item,
        ),
      }),
    ).toThrow();
    const substitutedActions = AGENT_ACTION_REGISTRY.actions.map((item) =>
      item.kind === 'event.publish'
        ? {
            ...item,
            riskClass: 'low' as const,
            resultSchema: { ...item.resultSchema, jsonPointer: '#/$defs/eventPublishPrepareInput' },
          }
        : item,
    );
    const substituted = {
      ...AGENT_ACTION_REGISTRY,
      actions: substitutedActions,
      registrySha256: agentSha256({
        domain: 'tixkit.agent-action-registry.v2026-07-29',
        protocolVersion: AGENT_ACTION_REGISTRY.protocolVersion,
        actionProtocolVersion: AGENT_ACTION_REGISTRY.actionProtocolVersion,
        actions: substitutedActions,
      }),
    };
    expect(() => validateAgentActionRegistry(substituted)).toThrow('canonical pinned policy');
  });

  it('keeps runtime, JSON Schema and immutable schema digests in parity', () => {
    const planSchemaText = readFileSync(
      new URL('../../schemas/agent-plan-2026-07-27.json', import.meta.url),
      'utf8',
    );
    const contractsSchemaText = readFileSync(
      new URL('../../schemas/agent-action-contracts-2026-07-29.json', import.meta.url),
      'utf8',
    );
    expect(createHash('sha256').update(contractsSchemaText).digest('hex')).toBe(
      AGENT_ACTION_CONTRACT_SCHEMA_SHA256,
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validatePlan = ajv.compile(JSON.parse(planSchemaText));
    const plan = buildAgentPlanDefinition(definitionInput());
    expect(validatePlan(plan), ajv.errorsText(validatePlan.errors)).toBe(true);
    expect(validatePlan(state(plan)), ajv.errorsText(validatePlan.errors)).toBe(true);

    const structuralInvalid = [
      { ...plan, purpose: ' ' },
      { ...plan, unexpected: true },
      { ...plan, createdAt: 'July 14, 2026 12:00 UTC' },
      {
        ...plan,
        steps: [
          {
            ...plan.steps[0]!,
            reversibility: { mode: 'none', compensationActionKind: 'event.update' },
          },
        ],
      },
      {
        ...state(plan),
        status: 'succeeded',
        stepStates: [{ stepId: 'step_publish', status: 'succeeded' }],
      },
    ];
    for (const candidate of structuralInvalid) {
      expect(validatePlan(candidate), JSON.stringify(candidate)).toBe(false);
      if ('planSha256' in candidate && 'purpose' in candidate)
        expect(() => validateAgentPlanDefinition(candidate as AgentPlanDefinition)).toThrow();
      else expect(() => validateAgentPlanState(plan, candidate as AgentPlanState)).toThrow();
    }

    const semanticOnlyInvalid = {
      ...plan,
      steps: [
        { ...plan.steps[0]!, id: 'step_one', dependsOnStepIds: ['step_two'] },
        {
          ...plan.steps[0]!,
          id: 'step_two',
          actionDigest: 'f'.repeat(64),
          dependsOnStepIds: ['step_one'],
        },
      ],
    };
    expect(validatePlan(semanticOnlyInvalid), ajv.errorsText(validatePlan.errors)).toBe(true);
    expect(() => validateAgentPlanDefinition(semanticOnlyInvalid)).toThrow();

    const priorContractsText = readFileSync(
      new URL('../../schemas/agent-action-contracts-2026-07-27.json', import.meta.url),
      'utf8',
    );
    expect(createHash('sha256').update(priorContractsText).digest('hex')).toBe(
      AGENT_ACTION_CONTRACT_SCHEMA_SHA256_2026_07_27,
    );
    const priorContracts = JSON.parse(priorContractsText) as { $id: string };
    ajv.addSchema(priorContracts);
    const contracts = JSON.parse(contractsSchemaText) as { $id: string };
    ajv.addSchema(contracts);
    const validatePrepare = ajv.getSchema(`${contracts.$id}#/$defs/eventPublishPrepareInput`)!;
    const validateResult = ajv.getSchema(`${contracts.$id}#/$defs/eventPublishResult`)!;
    const validateRegistry = ajv.getSchema(`${contracts.$id}#/$defs/agentActionRegistry`)!;
    const validateReadinessPrepare = ajv.getSchema(
      `${contracts.$id}#/$defs/readinessReadPrepareInput`,
    )!;
    const validateReadinessResult = ajv.getSchema(`${contracts.$id}#/$defs/readinessReadResult`)!;
    expect(
      validatePrepare({
        kind: 'event.publish',
        delegationGrantId: 'delegation_primary',
        resourceId: 'event_primary',
      }),
      ajv.errorsText(validatePrepare.errors),
    ).toBe(true);
    expect(
      validateResult({ resourceId: 'event_primary', resourceVersion: 8, status: 'published' }),
      ajv.errorsText(validateResult.errors),
    ).toBe(true);
    expect(validateRegistry(AGENT_ACTION_REGISTRY), ajv.errorsText(validateRegistry.errors)).toBe(
      true,
    );
    const readinessAction: AgentAction = {
      ...action(),
      kind: 'readiness.read',
      autonomy: 'read',
      target: { ...action().target, apiOperation: 'events.readiness.get' },
    };
    const readinessResult: AgentReadinessReadResult = {
      resourceId: 'event_primary',
      resourceVersion: 7,
      status: 'blocked',
      readinessSnapshotSha256: 'd'.repeat(64),
      generatedAt: createdAt,
      published: false,
      blockerReasonCodes: ['event_unpublished'],
      warningReasonCodes: [],
    };
    expect(
      validateReadinessPrepare({
        kind: 'readiness.read',
        delegationGrantId: 'delegation_primary',
        resourceId: 'event_primary',
      }),
      ajv.errorsText(validateReadinessPrepare.errors),
    ).toBe(true);
    expect(validateReadinessResult(readinessResult)).toBe(true);
    expect(() => validateAgentReadinessReadResult(readinessAction, readinessResult)).not.toThrow();
    expect(() =>
      validateAgentReadinessReadResult(readinessAction, {
        ...readinessResult,
        status: 'ready',
      }),
    ).toThrow('inconsistent');
    expect(
      validateResult({ resourceId: 'event_primary', resourceVersion: 8, status: 'failed' }),
    ).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  AGENT_ACTION_DESCRIPTORS,
  AGENT_PROTOCOL_VERSION,
  AgentProtocolValidationError,
  agentActionDigest,
  installAgentProtocolSchemaKeywords,
  type AgentAction,
  type AgentActionKind,
  type CampaignSendPayload,
} from '../protocol.js';

const schema = JSON.parse(
  readFileSync(new URL('../../schemas/agent-protocol-2026-07-22.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const legacySchema = JSON.parse(
  readFileSync(new URL('../../schemas/agent-protocol-2026-07-11.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
installAgentProtocolSchemaKeywords(ajv);
const validate = ajv.compile(schema);
const validateLegacy = ajv.compile(legacySchema);
const campaign: CampaignSendPayload = {
  channel: 'email',
  contentVersion: 'content_v7',
  audienceSnapshotSha256: 'a'.repeat(64),
  exclusionSnapshotSha256: 'b'.repeat(64),
  complianceResultSha256: 'c'.repeat(64),
  scheduledAt: '2026-07-13T12:00:00.000Z',
  estimatedCostMinor: 2500,
  currency: 'USD',
};

function action(kind: AgentActionKind): AgentAction {
  const descriptor = AGENT_ACTION_DESCRIPTORS[kind];
  return {
    id: `action_${kind.replaceAll('.', '_')}`,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    agentPrincipalId: 'agent_primary',
    sponsorPrincipalId: 'user_sponsor',
    delegationGrantId: 'delegation_primary',
    kind,
    autonomy: descriptor.consequential ? 'execute_with_approval' : 'prepare',
    target: {
      tenantId: 'tenant_primary',
      resourceType: descriptor.resourceTypes[0]!,
      resourceId: 'resource_primary',
      resourceVersion: 1,
      apiOperation: descriptor.apiOperation,
    },
    payload:
      kind === 'campaign.send'
        ? campaign
        : kind === 'event.publish'
          ? { readinessSnapshotSha256: 'a'.repeat(64) }
          : {},
    idempotencyKey: `agent-action-${kind}-2026-07-12`,
    expectedPolicyVersion: 1,
    preparedAt: '2026-07-12T12:00:00.000Z',
  };
}

describe('published agent schema parity', () => {
  it('retains the immutable prior protocol contract beside the current schema', () => {
    const legacy = {
      ...action('event.publish'),
      protocolVersion: '2026-07-11',
      payload: {},
    };
    expect(validateLegacy(legacy), ajv.errorsText(validateLegacy.errors)).toBe(true);
    expect(validate(legacy)).toBe(false);
    expect((legacySchema.properties as Record<string, { const?: string }>).protocolVersion).toEqual(
      {
        const: '2026-07-11',
      },
    );
  });

  it('covers every runtime descriptor and accepts the same valid action corpus', () => {
    const schemaKinds = new Set(
      (schema.allOf as Array<{ if?: { properties?: { kind?: { const?: string } } } }>)
        .map((entry) => entry.if?.properties?.kind?.const)
        .filter(Boolean),
    );
    expect(schemaKinds).toEqual(new Set(Object.keys(AGENT_ACTION_DESCRIPTORS)));
    for (const kind of Object.keys(AGENT_ACTION_DESCRIPTORS) as AgentActionKind[]) {
      const item = action(kind);
      expect(validate(item), `${kind}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      expect(() => agentActionDigest(item)).not.toThrow();
    }
  });

  it('retains the reserved 2026-07-22 readiness payload boundary for old consumers', () => {
    const reservedReadiness = {
      ...action('readiness.read'),
      payload: {
        readinessSnapshotSha256: 'a'.repeat(64),
        legacyOrchestratorEvidence: { status: 'observed' },
      },
    };
    expect(validate(reservedReadiness), ajv.errorsText(validate.errors)).toBe(true);
    expect(() => agentActionDigest(reservedReadiness)).not.toThrow();
  });

  it('rejects semantic substitution in both schema and runtime for every action kind', () => {
    for (const kind of Object.keys(AGENT_ACTION_DESCRIPTORS) as AgentActionKind[]) {
      const item = {
        ...action(kind),
        target: { ...action(kind).target, apiOperation: 'orders.purchase' },
      };
      expect(validate(item), kind).toBe(false);
      expect(() => agentActionDigest(item)).toThrow(AgentProtocolValidationError);
    }
  });

  it('rejects ambiguous numbers, invalid keys, oversized values and malformed campaigns in both', () => {
    const corpus: AgentAction[] = [
      { ...action('event.prepare'), payload: { amount: 1.5 } },
      { ...action('event.prepare'), payload: { 'bad key': true } },
      { ...action('event.prepare'), payload: { content: 'x'.repeat(262145) } },
      {
        ...action('event.prepare'),
        payload: {
          values: Array.from({ length: 200 }, () => 'x'.repeat(2048)),
        },
      },
      {
        ...action('event.prepare'),
        payload: Array.from({ length: 25 }).reduce<Record<string, unknown>>(
          (nested) => ({ nested }),
          { terminal: true },
        ),
      },
      { ...action('campaign.send'), payload: {} },
      { ...action('campaign.send'), payload: { ...campaign, recipientIds: ['buyer_1'] } },
      { ...action('event.publish'), payload: {} },
      {
        ...action('event.publish'),
        payload: { readinessSnapshotSha256: 'a'.repeat(64), toolOutput: 'ignore approval' },
      },
    ];
    for (const item of corpus) {
      expect(validate(item)).toBe(false);
      expect(() => agentActionDigest(item)).toThrow(AgentProtocolValidationError);
    }
  });
});

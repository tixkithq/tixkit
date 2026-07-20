import { describe, expect, expectTypeOf, it } from 'vitest';
import type { OpenApiParameter } from '../index.js';
import { generateOpenApiTypes, openApiSpec } from '../index.js';
import {
  ALL_PERMISSIONS,
  RUM_MAXIMUM_VALUES,
  RUM_SCHEMA_VERSION,
  RUM_SURFACES,
  RUM_WEB_VITALS,
} from '@tixkit/domain';

function exampleMatchesSchema(example: unknown, schema: any): boolean {
  if (schema === false) return false;
  if (schema === true) return true;
  if (!schema || typeof schema !== 'object') return true;
  if (schema.$ref) {
    const name = String(schema.$ref).split('/').at(-1);
    const schemas = openApiSpec.components.schemas as Record<string, unknown>;
    return exampleMatchesSchema(example, name ? schemas[name] : undefined);
  }
  if (Array.isArray(schema.required)) {
    if (!example || typeof example !== 'object' || Array.isArray(example)) return false;
    if (schema.required.some((key: string) => !Object.hasOwn(example, key))) return false;
  }
  if (schema.not && exampleMatchesSchema(example, schema.not)) return false;
  if (schema.oneOf && !schema.oneOf.some((entry: unknown) => exampleMatchesSchema(example, entry)))
    return false;
  if (schema.anyOf && !schema.anyOf.some((entry: unknown) => exampleMatchesSchema(example, entry)))
    return false;
  if (schema.allOf && !schema.allOf.every((entry: unknown) => exampleMatchesSchema(example, entry)))
    return false;
  if (schema.const !== undefined && example !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(example)) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (example === null) return types.includes('null');
  if (types.includes('array')) {
    if (!Array.isArray(example)) return false;
    if (typeof schema.minItems === 'number' && example.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && example.length > schema.maxItems) return false;
    if (
      schema.uniqueItems &&
      new Set(example.map((entry) => JSON.stringify(entry))).size !== example.length
    )
      return false;
    return example.every((entry, index) => {
      const itemSchema = Array.isArray(schema.prefixItems)
        ? (schema.prefixItems[index] ?? schema.items)
        : schema.items;
      return exampleMatchesSchema(entry, itemSchema);
    });
  }
  if (types.includes('object') || schema.properties) {
    if (!example || typeof example !== 'object' || Array.isArray(example)) return false;
    const record = example as Record<string, unknown>;
    return Object.entries(record).every(([key, value]) => {
      if (schema.properties?.[key]) return exampleMatchesSchema(value, schema.properties[key]);
      return schema.additionalProperties !== false;
    });
  }
  if (types.includes('string')) {
    if (typeof example !== 'string') return false;
    if (typeof schema.minLength === 'number' && example.length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && example.length > schema.maxLength) return false;
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(example))
      return false;
    return true;
  }
  if (types.includes('boolean')) return typeof example === 'boolean';
  if (types.includes('integer') || types.includes('number')) {
    if (typeof example !== 'number' || (types.includes('integer') && !Number.isInteger(example)))
      return false;
    if (typeof schema.minimum === 'number' && example < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && example > schema.maximum) return false;
    return true;
  }
  return true;
}

describe('openApiSpec', () => {
  it('keeps waitlist settings strict and aligned with the runtime bounds', () => {
    const settings = openApiSpec.components.schemas.WaitlistSettings;

    expect(settings).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        autoOfferEnabled: { type: 'boolean' },
        offerTtlMinutes: { type: 'integer', minimum: 5, maximum: 20160 },
      },
      required: ['autoOfferEnabled', 'offerTtlMinutes'],
    });
    expect(
      openApiSpec.paths['/events/{eventId}/waitlist/settings'].patch.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/WaitlistSettings' });
  });

  it('keeps manual waitlist offers strict and aligned with runtime conflicts', () => {
    const operation = openApiSpec.paths['/events/{eventId}/waitlist/{entryId}/offer'].post;
    const body = operation.requestBody.content['application/json'].schema;

    expect(body).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        expiresInMinutes: {
          type: 'integer',
          minimum: 5,
          maximum: 20160,
        },
      },
    });
    expect(operation.responses['409']).toBeDefined();
  });

  it('documents event media purposes and safe test checkout tagging', () => {
    expect(openApiSpec.components.schemas.CreateUploadArtifact.properties.purpose.enum).toEqual(
      expect.arrayContaining(['event_poster', 'event_cover', 'event_social', 'event_seo_image']),
    );
    expect(
      openApiSpec.paths['/events/{eventId}/media/{role}'].put.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/AttachEventMedia' });
    expect(
      openApiSpec.paths['/events/{eventId}/media/{role}'].delete.responses['204'].description,
    ).toBe('Event media role removed');
    expect(
      openApiSpec.paths['/public/event-media/renditions/{renditionId}'].get.responses['200']
        .content['image/webp'].schema,
    ).toMatchObject({ format: 'binary' });
    expect(
      openApiSpec.paths['/events/{eventId}/media/renditions/{renditionId}'].get.responses['200']
        .content['image/webp'].schema,
    ).toMatchObject({ format: 'binary' });
    expect(
      openApiSpec.paths['/events/{eventId}/media/renditions/{renditionId}'].get.responses['200']
        .headers['Cache-Control'].description,
    ).toBe('private, max-age=31536000, immutable');
    expect(openApiSpec.components.schemas.Event.properties.thumbnail).toEqual({
      oneOf: [{ $ref: '#/components/schemas/EventThumbnail' }, { type: 'null' }],
    });
    expect(openApiSpec.components.schemas.EventThumbnail.properties.variant.enum).toEqual([
      'card',
      'thumbnail',
    ]);
    expect(openApiSpec.components.schemas.EventMediaRendition.properties.variant.enum).toEqual([
      'thumbnail',
      'card',
      'page',
      'social',
    ]);
    expect(
      Object.prototype.hasOwnProperty.call(
        openApiSpec.paths,
        '/public/event-media/{purpose}/{artifactId}',
      ),
    ).toBe(false);
    expect(openApiSpec.components.schemas.Order.properties.isTest).toMatchObject({
      type: 'boolean',
    });
    expect(openApiSpec.paths['/checkout/sessions'].post.parameters).toContainEqual(
      expect.objectContaining({ name: 'X-Tixkit-Test-Order', in: 'header' }),
    );
  });
  it('publishes the documented API lifecycle version', () => {
    expect(openApiSpec.info.version).toBe('2026-08-30');
  });

  it('keeps the privacy-minimized RUM operation bound to the shared domain contract', () => {
    const operation = openApiSpec.paths['/public/rum'].post;
    expect(operation.operationId).toBe('submitRumWebVital');
    expect(operation.security).toEqual([]);
    expect(Object.keys(operation.responses).sort()).toEqual(['202', '400', '413', '429']);
    const branches = operation.requestBody.content['application/json'].schema.oneOf;
    expect(branches).toHaveLength(RUM_WEB_VITALS.length);
    for (const metric of RUM_WEB_VITALS) {
      const branch = branches.find(
        (candidate: { properties: { metric: { enum: readonly string[] } } }) =>
          candidate.properties.metric.enum[0] === metric,
      );
      expect(branch).toMatchObject({
        additionalProperties: false,
        required: ['schemaVersion', 'surface', 'metric', 'value'],
        properties: {
          schemaVersion: { enum: [RUM_SCHEMA_VERSION] },
          surface: { enum: [...RUM_SURFACES] },
          metric: { enum: [metric] },
          value: { minimum: 0, maximum: RUM_MAXIMUM_VALUES[metric] },
        },
      });
    }
    expect(operation.responses['202'].content['application/json'].schema).toMatchObject({
      additionalProperties: false,
      required: ['accepted'],
      properties: { accepted: { enum: [true] } },
    });
  });

  it('publishes digest-bound agent plan creation, inspection and CAS transitions', () => {
    const create = openApiSpec.paths['/agent/plans'].post;
    const inspect = openApiSpec.paths['/agent/plans/{planId}'].get;
    const transition = openApiSpec.paths['/agent/plans/{planId}/transitions'].post;
    expect(create.security).toEqual([{ AgentOAuth: ['agent.invoke'] }]);
    expect(create.security).not.toContainEqual({ BearerAuth: [] });
    expect(inspect.security).toEqual([{ AgentOAuth: ['agent.invoke'] }, { BearerAuth: [] }]);
    expect(transition.security).toEqual([{ AgentOAuth: ['agent.invoke'] }, { BearerAuth: [] }]);
    expect(create.requestBody.content['application/json'].schema).toMatchObject({
      additionalProperties: false,
      required: ['definition', 'actionBindings'],
    });
    expect(transition.requestBody.content['application/json'].schema).toMatchObject({
      additionalProperties: false,
      required: ['expectedStateVersion', 'status', 'stepStates', 'reasonCode'],
    });
    const planSchemas = openApiSpec.components.schemas as Record<string, Record<string, unknown>>;
    expect(planSchemas.AgentPlanProtocol_agentPlanDefinition).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['planSha256', 'steps', 'agentPrincipalId']),
    });
    expect(planSchemas.AgentPlanProtocol_agentPlanState).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['stateVersion', 'status', 'stepStates']),
    });
    expect(openApiSpec.components.schemas.PersistedAgentPlan).toMatchObject({
      additionalProperties: false,
      required: ['definition', 'state', 'actionBindings'],
    });
  });

  it('publishes agent-only immutable action preparation without caller-owned bindings', () => {
    const prepare = openApiSpec.paths['/agent/actions'].post;
    const get = openApiSpec.paths['/agent/actions/{actionId}'].get;
    const approve = openApiSpec.paths['/agent/actions/{actionId}/approvals'].post;
    const revoke =
      openApiSpec.paths['/agent/actions/{actionId}/approvals/{approvalId}/revoke'].post;
    const execute = openApiSpec.paths['/agent/actions/{actionId}/executions'].post;
    const inspect = openApiSpec.paths['/agent/actions/{actionId}/executions/{executionId}'].get;
    expect(prepare.security).toEqual([{ AgentOAuth: ['agent.invoke'] }]);
    expect(get.security).toEqual([{ AgentOAuth: ['agent.invoke'] }, { BearerAuth: [] }]);
    expect(get.responses['401'].description).toMatch(/Agent OAuth or human bearer/u);
    expect(approve.security).toEqual([{ BearerAuth: [] }]);
    expect(approve.security).not.toContainEqual({
      AgentOAuth: ['agent.invoke'],
    });
    expect(revoke.security).toEqual([{ BearerAuth: [] }]);
    expect(revoke.description).toMatch(/even after losing event permission/u);
    expect(execute.security).toEqual([{ AgentOAuth: ['agent.invoke'] }]);
    expect(execute.security).not.toContainEqual({ BearerAuth: [] });
    expect(inspect.security).toEqual([{ AgentOAuth: ['agent.invoke'] }, { BearerAuth: [] }]);
    expect(inspect.description).toMatch(/after event permission loss/u);
    expect(prepare.security).not.toContainEqual({ BearerAuth: [] });
    expect(prepare.security).not.toContainEqual({ ApiKey: [] });
    const body = prepare.requestBody.content['application/json'].schema;
    expect(body.additionalProperties).toBe(false);
    expect(body.required).toEqual(['kind', 'delegationGrantId', 'resourceId']);
    expect(Object.keys(body.properties)).toEqual(['kind', 'delegationGrantId', 'resourceId']);
    expect(openApiSpec.components.schemas.AgentAction.properties.protocolVersion).toEqual({
      type: 'string',
      const: '2026-07-22',
    });
    expect(openApiSpec.components.schemas.AgentAction.required).toEqual(
      expect.arrayContaining([
        'agentPrincipalId',
        'sponsorPrincipalId',
        'target',
        'payload',
        'expectedPolicyVersion',
        'preparedAt',
      ]),
    );
    expect(openApiSpec.components.schemas.PreparedAgentAction.description).toMatch(
      /fresh human approval remains mandatory/u,
    );
    expect(approve.parameters).toEqual(
      expect.arrayContaining([
        { $ref: '#/components/parameters/AgentApprovalIdempotencyKey' },
        { $ref: '#/components/parameters/AgentApprovalConfirmation' },
      ]),
    );
    expect(approve.requestBody.content['application/json'].schema).toMatchObject({
      additionalProperties: false,
      required: ['actionDigest'],
      properties: { planSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
    });
    expect(openApiSpec.components.schemas.AgentApproval.required).toContain('actionDigest');
    expect(openApiSpec.components.schemas.AgentExecution.properties.planSha256).toEqual({
      type: 'string',
      pattern: '^[a-f0-9]{64}$',
    });
    expect(revoke.parameters).toEqual(
      expect.arrayContaining([
        { $ref: '#/components/parameters/AgentApprovalIdempotencyKey' },
        { $ref: '#/components/parameters/AgentApprovalRevocationConfirmation' },
      ]),
    );
    expect(revoke.requestBody.content['application/json'].schema).toMatchObject({
      additionalProperties: false,
      required: ['actionDigest'],
    });
    expect(execute.parameters).toContainEqual({
      $ref: '#/components/parameters/AgentExecutionConfirmation',
    });
    expect(execute.parameters).toContainEqual({
      $ref: '#/components/parameters/AgentExecutionIdempotencyKey',
    });
    expect(execute.requestBody.content['application/json'].schema).toMatchObject({
      additionalProperties: false,
      required: ['approvalId', 'actionDigest'],
    });
    expect(openApiSpec.components.schemas.AgentExecution.required).toEqual(
      expect.arrayContaining(['actionId', 'approvalId', 'actionDigest', 'state', 'fenceToken']),
    );
    expect(openApiSpec.components.schemas.AgentExecutionEvidence).toMatchObject({
      additionalProperties: false,
      required: ['execution', 'audit'],
      properties: {
        audit: { minItems: 2, maxItems: 100 },
      },
    });
    expect(openApiSpec.components.schemas.AgentExecutionAuditRecord.required).toEqual(
      expect.arrayContaining([
        'approvalId',
        'phase',
        'idempotencyKey',
        'resourceVersion',
        'reasonCodes',
      ]),
    );
    const evidenceExample = inspect.responses['200'].content['application/json'].example;
    const { execution, audit } = evidenceExample;
    expect(
      exampleMatchesSchema(
        evidenceExample,
        inspect.responses['200'].content['application/json'].schema,
      ),
    ).toBe(true);
    expect(audit.map((record: { phase: string }) => record.phase)).toEqual([
      'prepared',
      'authorized',
    ]);
    expect(new Set(audit.map((record: { id: string }) => record.id)).size).toBe(audit.length);
    for (const record of audit) {
      expect(record).toMatchObject({
        tenantId: execution.tenantId,
        agentPrincipalId: execution.agentPrincipalId,
        sponsorPrincipalId: execution.sponsorPrincipalId,
        delegationGrantId: execution.delegationGrantId,
        actionId: execution.actionId,
        actionDigest: execution.actionDigest,
        approvalId: execution.approvalId,
        idempotencyKey: execution.idempotencyKey,
        resourceVersion: execution.resourceVersion,
      });
    }
  });

  it('adds direct readiness as a separate required-result contract without widening publish', () => {
    const readiness = openApiSpec.paths['/agent/readiness'].post;
    const inspect = openApiSpec.paths['/agent/readiness/{actionId}'].get;
    const publishAction = openApiSpec.components.schemas.AgentAction;
    const publishPrepared = openApiSpec.components.schemas.PreparedAgentAction;
    const readinessAction = openApiSpec.components.schemas.AgentReadinessReadAction;
    const readinessPrepared = openApiSpec.components.schemas.PreparedAgentReadinessReadAction;
    expect(readiness.security).toEqual([{ AgentOAuth: ['agent.invoke'] }]);
    expect(inspect.security).toEqual([{ AgentOAuth: ['agent.invoke'] }, { BearerAuth: [] }]);
    expect(readiness.requestBody.content['application/json'].schema).toMatchObject({
      additionalProperties: false,
      required: ['delegationGrantId', 'resourceId'],
    });
    expect(publishAction.properties.kind).toEqual({
      type: 'string',
      const: 'event.publish',
    });
    expect(publishAction).not.toHaveProperty('oneOf');
    expect(publishPrepared.properties).not.toHaveProperty('result');
    expect(publishPrepared.properties).not.toHaveProperty('resultSha256');
    expect(publishPrepared.properties.authorization.properties).not.toHaveProperty('allowed');
    expect(readinessAction.properties.kind).toEqual({
      type: 'string',
      const: 'readiness.read',
    });
    expect(readinessPrepared.required).toEqual(expect.arrayContaining(['result', 'resultSha256']));
    expect(readinessPrepared.properties.authorization.required).toContain('allowed');
    expect(
      openApiSpec.components.schemas.AgentReadinessReadResult.properties.blockerReasonCodes.items,
    ).toMatchObject({ pattern: '^[a-z0-9][a-z0-9_.-]{1,63}$' });
  });

  it('adds a direct event projection with exact authority and untrusted-content boundaries', () => {
    const read = openApiSpec.paths['/agent/events'].post;
    const inspect = openApiSpec.paths['/agent/events/{actionId}'].get;
    const action = openApiSpec.components.schemas.AgentEventReadAction;
    const result = openApiSpec.components.schemas.AgentEventReadResult;
    const prepared = openApiSpec.components.schemas.PreparedAgentEventReadAction;
    expect(read.security).toEqual([{ AgentOAuth: ['agent.invoke'] }]);
    expect(inspect.security).toEqual([{ AgentOAuth: ['agent.invoke'] }, { BearerAuth: [] }]);
    expect(action.properties.kind).toEqual({
      type: 'string',
      const: 'event.read',
    });
    expect(action.properties.target.properties.apiOperation).toEqual({
      type: 'string',
      const: 'events.get',
    });
    expect(prepared.required).toEqual(expect.arrayContaining(['result', 'resultSha256']));
    expect(prepared.properties).not.toHaveProperty('dryRun');
    expect(result.properties.event.additionalProperties).toBe(false);
    expect(result.properties.untrustedContentPaths.prefixItems).toEqual([
      { type: 'string', const: 'event.title' },
      { type: 'string', const: 'event.description' },
    ]);
  });

  it('adds an aggregate-only direct event sales report with exact range and authority boundaries', () => {
    const read = openApiSpec.paths['/agent/reports'].post;
    const inspect = openApiSpec.paths['/agent/reports/{actionId}'].get;
    const action = openApiSpec.components.schemas.AgentReportReadAction;
    const result = openApiSpec.components.schemas.AgentReportReadResult;
    const prepared = openApiSpec.components.schemas.PreparedAgentReportReadAction;
    expect(read.security).toEqual([{ AgentOAuth: ['agent.invoke'] }]);
    expect(inspect.security).toEqual([{ AgentOAuth: ['agent.invoke'] }, { BearerAuth: [] }]);
    expect(read.requestBody.content['application/json'].schema).toMatchObject({
      additionalProperties: false,
      required: ['delegationGrantId', 'resourceId'],
      dependentRequired: { from: ['to'], to: ['from'] },
    });
    expect(read.requestBody.content['application/json'].schema.properties.from).toMatchObject({
      format: 'date-time',
      pattern: expect.stringContaining('\\.000Z'),
    });
    expect(action.properties.kind).toEqual({
      type: 'string',
      const: 'report.read',
    });
    expect(action.properties.target.properties).toMatchObject({
      resourceType: { type: 'string', const: 'event' },
      apiOperation: { type: 'string', const: 'reports.get' },
    });
    expect(action.properties.payload).toMatchObject({
      additionalProperties: false,
      required: ['reportType', 'from', 'to', 'reportSnapshotSha256'],
    });
    expect(action.properties.payload.properties.from.pattern).toContain('\\.000Z');
    expect(result.properties.from.pattern).toContain('\\.000Z');
    expect(result.properties.report.additionalProperties).toBe(false);
    expect(result.properties.report['x-tixkit-reportAggregateCoherent']).toBe(true);
    expect(result.properties.untrustedContentPaths.maxItems).toBe(0);
    expect(result.properties).not.toHaveProperty('buyerEmail');
    expect(prepared.required).toEqual(expect.arrayContaining(['result', 'resultSha256']));
    expect(prepared.properties).not.toHaveProperty('dryRun');
  });

  it('adds direct event preparation with the complete non-status patch surface', () => {
    const prepare = openApiSpec.paths['/agent/event-preparations'].post;
    const inspect = openApiSpec.paths['/agent/event-preparations/{actionId}'].get;
    const changes = openApiSpec.components.schemas.AgentEventPrepareChanges;
    const resolved = openApiSpec.components.schemas.AgentEventPrepareResolvedChanges;
    const action = openApiSpec.components.schemas.AgentEventPrepareAction;
    const result = openApiSpec.components.schemas.AgentEventPrepareResult;
    const prepared = openApiSpec.components.schemas.PreparedAgentEventPrepareAction;
    expect(prepare.security).toEqual([{ AgentOAuth: ['agent.invoke'] }]);
    expect(inspect.security).toEqual([{ AgentOAuth: ['agent.invoke'] }, { BearerAuth: [] }]);
    expect(prepare.requestBody.content['application/json'].schema.properties.changes).toEqual({
      $ref: '#/components/schemas/AgentEventPrepareChanges',
    });
    expect(Object.keys(changes.properties).sort()).toEqual([
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
    expect(changes.properties).not.toHaveProperty('status');
    expect(changes.properties).not.toHaveProperty('expectedVersion');
    expect(changes.properties.venue).toMatchObject({
      'x-tixkit-noNulStrings': true,
      'x-tixkit-maxCanonicalBytes': 16 * 1024,
      'x-tixkit-maxDepth': 4,
    });
    expect(changes.properties.externalUrl.maxLength).toBe(2048);
    expect(changes.properties.coverImageUrl.maxLength).toBe(2048);
    expect(changes.properties.seo.properties.imageUrl.maxLength).toBe(2048);
    expect(action.properties).toMatchObject({
      kind: { type: 'string', const: 'event.prepare' },
      autonomy: { type: 'string', const: 'prepare' },
    });
    expect(action.properties.target.properties.apiOperation).toEqual({
      type: 'string',
      const: 'events.prepare',
    });
    expect(action.properties.payload.required).toEqual(['changePreviewSha256', 'changes']);
    expect(action.properties.payload.properties.changes).toEqual({
      $ref: '#/components/schemas/AgentEventPrepareResolvedChanges',
    });
    expect(resolved.allOf[1].properties.description.type).toBe('string');
    expect(resolved.allOf[1].properties.coverImageUrl.pattern).toBe(
      '^/v1/public/event-media/[A-Za-z0-9_/-]+$',
    );
    expect(result.properties.before).toEqual({
      $ref: '#/components/schemas/AgentEventPrepareProjection',
    });
    expect(result.properties.after).toEqual({
      $ref: '#/components/schemas/AgentEventPrepareResolvedChanges',
    });
    expect(result.required).toEqual(
      expect.arrayContaining(['changePreviewSha256', 'changedFields', 'before', 'after']),
    );
    expect(prepared.required).toEqual(expect.arrayContaining(['result', 'resultSha256']));
    expect(prepared.properties).not.toHaveProperty('dryRun');
  });

  it('adds approval-bound event.update preparation, inspection and execution evidence', () => {
    const prepare = openApiSpec.paths['/agent/event-updates'].post;
    const inspect = openApiSpec.paths['/agent/event-updates/{actionId}'].get;
    const action = openApiSpec.components.schemas.AgentEventUpdateAction;
    const prepared = openApiSpec.components.schemas.PreparedAgentEventUpdateAction;
    expect(prepare.security).toEqual([{ AgentOAuth: ['agent.invoke'] }]);
    expect(inspect.security).toEqual([{ AgentOAuth: ['agent.invoke'] }, { BearerAuth: [] }]);
    expect(prepare.requestBody.content['application/json'].schema.properties.changes).toEqual({
      $ref: '#/components/schemas/AgentEventPrepareChanges',
    });
    expect(action.properties).toMatchObject({
      kind: { type: 'string', const: 'event.update' },
      autonomy: { type: 'string', const: 'execute_with_approval' },
    });
    expect(action.properties.target.properties.apiOperation).toEqual({
      type: 'string',
      const: 'events.update',
    });
    expect(action.properties.payload.properties.changes).toEqual({
      $ref: '#/components/schemas/AgentEventPrepareResolvedChanges',
    });
    expect(prepared.required).toEqual(
      expect.arrayContaining(['action', 'authorization', 'preview', 'previewSha256']),
    );
    expect(
      openApiSpec.components.schemas.AgentApproval.properties.approverPermissionSnapshot.items,
    ).toEqual({ type: 'string', enum: ['events:publish'] });
    expect(
      openApiSpec.components.schemas.AgentExecution.properties.result.properties.status,
    ).toEqual({ type: 'string', enum: ['published'] });
    expect(
      openApiSpec.components.schemas.AgentEventUpdateApproval.properties.approverPermissionSnapshot
        .items,
    ).toEqual({ type: 'string', const: 'events:write' });
    expect(
      openApiSpec.components.schemas.AgentEventUpdateExecution.properties.result.properties.status,
    ).toEqual({ type: 'string', const: 'updated' });
    expect(openApiSpec.paths).toHaveProperty('/agent/event-updates/{actionId}/approvals');
    expect(openApiSpec.paths).toHaveProperty('/agent/event-updates/{actionId}/executions');
    expect(openApiSpec.paths).toHaveProperty(
      '/agent/event-updates/{actionId}/executions/{executionId}',
    );
    expect(
      openApiSpec.paths['/agent/actions/{actionId}'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PreparedAgentAction' });
  });

  it('publishes consent-aware campaign preparation without send authority', () => {
    const prepare = openApiSpec.paths['/agent/campaign-preparations'].post;
    const inspect = openApiSpec.paths['/agent/campaign-preparations/{actionId}'].get;
    const request = prepare.requestBody.content['application/json'].schema;
    const action = openApiSpec.components.schemas.AgentCampaignPrepareAction;
    const payload = openApiSpec.components.schemas.AgentCampaignPreparePayload;
    const result = openApiSpec.components.schemas.AgentCampaignPrepareResult;
    expect(prepare.security).toEqual([{ AgentOAuth: ['agent.invoke'] }]);
    expect(inspect.security).toEqual([{ AgentOAuth: ['agent.invoke'] }, { BearerAuth: [] }]);
    expect(request.additionalProperties).toBe(false);
    expect(request.required).toEqual(['delegationGrantId', 'resourceId', 'audience', 'channel']);
    expect(action.properties).toMatchObject({
      kind: { type: 'string', const: 'campaign.prepare' },
      autonomy: { type: 'string', const: 'prepare' },
    });
    expect(action.properties.target.properties.apiOperation).toEqual({
      type: 'string',
      const: 'campaigns.prepare',
    });
    expect(payload.additionalProperties).toBe(false);
    expect(payload.required).toEqual(
      expect.arrayContaining([
        'contentVersionSha256',
        'audienceSnapshotSha256',
        'exclusionSnapshotSha256',
        'complianceResultSha256',
      ]),
    );
    expect(result.properties.untrustedContentPaths).toMatchObject({
      maxItems: 0,
      items: false,
    });
    expect(prepare.responses).toMatchObject({
      '400': { description: expect.stringContaining('Idempotency-Key') },
      '404': {
        description: 'Current principal, delegation, sponsor or event unavailable',
      },
      '409': {
        description: expect.stringContaining('action policy unavailable'),
      },
    });
    expect(prepare.responses['404'].description).not.toContain('template');
    expect(openApiSpec.paths).not.toHaveProperty('/agent/campaign-preparations/{actionId}/send');
  });

  it('keeps historical portability authorization discriminated across runtime and generated types', () => {
    expect(openApiSpec.paths).toHaveProperty('/portable-export-authorizations');
    expect(openApiSpec.paths).toHaveProperty(
      '/portable-export-authorizations/{authorizationId}/revoke',
    );
    expect(
      openApiSpec.paths['/portable-exports'].post.requestBody.content['application/json'].schema
        .oneOf,
    ).toEqual([
      expect.objectContaining({
        required: ['organizationId'],
        properties: expect.objectContaining({
          mode: { const: 'configuration', default: 'configuration' },
        }),
      }),
      expect.objectContaining({
        required: ['organizationId', 'mode', 'authorizationId'],
        properties: expect.objectContaining({ mode: { const: 'historical' } }),
      }),
    ]);
    expect(
      openApiSpec.paths['/portable-export-authorizations/{authorizationId}/revoke'].post.responses[
        '204'
      ].description,
    ).toMatch(/already applied/u);
    const grantRequest =
      openApiSpec.paths['/portable-export-authorizations'].post.requestBody.content[
        'application/json'
      ].example;
    const grantResponse =
      openApiSpec.paths['/portable-export-authorizations'].post.responses['201'].content[
        'application/json'
      ].example;
    expect(grantRequest).toMatchObject({
      organizationId: grantResponse.organizationId,
      expiresAt: grantResponse.expiresAt,
    });
    expect(Date.parse(grantResponse.expiresAt) - Date.parse(grantResponse.grantedAt)).toBe(
      3_600_000,
    );

    const declaration = generateOpenApiTypes(openApiSpec);
    expect(declaration).toContain('mode?: "configuration";');
    expect(declaration).toContain(
      'mode: "historical";\n                    authorizationId: string;',
    );
    expect(declaration).not.toContain('authorizationId?: string;\n                } & unknown');
  });

  it('publishes the authoritative API-key permission scope catalog', () => {
    expect(openApiSpec.components.securitySchemes.ApiKey['x-api-key-scopes']).toEqual(
      ALL_PERMISSIONS,
    );
  });

  it('provides sanitized JSON examples for every documented request and response body', () => {
    const methods = new Set(['get', 'put', 'post', 'delete', 'patch']);
    const missing: string[] = [];
    for (const [path, pathItem] of Object.entries(openApiSpec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!methods.has(method) || !operation || typeof operation !== 'object') continue;
        const bodies = [
          'requestBody' in operation ? operation.requestBody : undefined,
          ...Object.values('responses' in operation ? operation.responses : {}),
        ];
        for (const body of bodies) {
          if (!body || typeof body !== 'object' || !('content' in body)) continue;
          const json = body.content?.['application/json'];
          if (json?.schema && json.example === undefined && json.examples === undefined) {
            missing.push(`${method.toUpperCase()} ${path}`);
          }
          if (json?.example !== undefined) {
            const serialized = JSON.stringify(json.example);
            expect(serialized).not.toMatch(/\btk_(?!agent_)[A-Za-z0-9_-]+/);
            expect(serialized).not.toContain('one-time-secret');
            expect(
              exampleMatchesSchema(json.example, json.schema),
              `${method.toUpperCase()} ${path}: ${serialized}`,
            ).toBe(true);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('documents workspace/event readiness, acknowledgements, and publish conflicts', () => {
    expect(openApiSpec.paths).toHaveProperty('/organizations/{organizationId}/readiness');
    expect(openApiSpec.paths).toHaveProperty('/organizations/{organizationId}/dashboard-actions');
    expect(openApiSpec.paths).toHaveProperty('/events/{eventId}/launch-readiness');
    expect(openApiSpec.paths).toHaveProperty('/events/{eventId}/operational-health');
    expect(openApiSpec.paths).toHaveProperty('/events/{eventId}/setup-section');
    expect(openApiSpec.paths).toHaveProperty(
      '/events/{eventId}/readiness-acknowledgements/{stepId}',
    );
    expect(openApiSpec.components.schemas).toHaveProperty('WorkspaceReadiness');
    expect(openApiSpec.components.schemas).toHaveProperty('WorkspaceDashboardAction');
    expect(openApiSpec.components.schemas).toHaveProperty('DashboardAction');
    expect(openApiSpec.components.schemas).toHaveProperty('DashboardActionFeed');
    expect(openApiSpec.components.schemas.WorkspaceReadiness.properties).toHaveProperty(
      'actionFeed',
    );
    expect(openApiSpec.components.schemas).toHaveProperty('EventLaunchReadiness');
    expect(openApiSpec.components.schemas).toHaveProperty('ReadinessAcknowledgement');
    const readinessOperations = [
      openApiSpec.paths['/organizations/{organizationId}/readiness'].get,
      openApiSpec.paths['/organizations/{organizationId}/dashboard-actions'].get,
      openApiSpec.paths['/events/{eventId}/launch-readiness'].get,
      openApiSpec.paths['/events/{eventId}/operational-health'].get,
      openApiSpec.paths['/events/{eventId}/setup-section'].put,
      openApiSpec.paths['/events/{eventId}/readiness-acknowledgements/{stepId}'].post,
      openApiSpec.paths['/events/{eventId}/readiness-acknowledgements/{stepId}'].delete,
    ];
    expect(readinessOperations.map((operation) => operation['x-required-permissions'])).toEqual([
      ['events.read'],
      ['events.read'],
      ['events.read'],
      ['events.read'],
      ['events.write'],
      ['events.write'],
      ['events.write'],
    ]);
    for (const operation of readinessOperations)
      expect(operation.security).toEqual([{ BearerAuth: [] }, { ApiKey: [] }]);
    expect(openApiSpec.components.schemas.DashboardAction.properties.reasonCode.enum).toEqual([
      'event_unpublished',
      'event_starting_soon',
      'event_sales_paused',
      'failed_exports',
    ]);
    expect(
      openApiSpec.components.schemas.DashboardAction.properties.remediation.properties.availability
        .enum,
    ).toEqual(['available', 'permission_required', 'unsupported']);
    const launchExample = openApiSpec.components.schemas.EventLaunchReadiness.example;
    expect(launchExample.launchable).toBe(true);
    expect(launchExample.requiredBlockers).toEqual([]);
    expect(launchExample.recommendedWarnings).toEqual([]);
    expect(launchExample.steps.every((step) => String(step.id) !== 'workspace_selection')).toBe(
      true,
    );
    const failureExample = openApiSpec.components.schemas.LaunchReadinessFailedError.example;
    expect(failureExample.error.code).toBe('launch_readiness_failed');
    expect(failureExample.error.details.requiredBlockers).toEqual([
      expect.objectContaining({
        id: 'sellable_tickets',
        status: 'incomplete',
        priority: 'required',
      }),
    ]);
    expect(failureExample.error.details.recommendedWarnings).toEqual([]);
    expect(openApiSpec.paths['/events/{eventId}/publish'].post.responses).toHaveProperty('409');
    expect(
      openApiSpec.paths['/events/{eventId}/publish'].post.responses['409'].content[
        'application/json'
      ].schema,
    ).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/LaunchReadinessFailedError' },
        { $ref: '#/components/schemas/StaleEventVersionError' },
        { $ref: '#/components/schemas/EventArchivedError' },
      ],
    });
  });

  it('declares required path parameters for every templated path operation', () => {
    const pathTemplateParameterPattern = /\{([^}]+)\}/g;
    const operations = new Set([
      'get',
      'put',
      'post',
      'delete',
      'options',
      'head',
      'patch',
      'trace',
    ]);
    const missingParameters: string[] = [];

    for (const [path, pathItem] of Object.entries(openApiSpec.paths)) {
      const parameterNames = [...path.matchAll(pathTemplateParameterPattern)].map(
        (match) => match[1],
      );
      if (parameterNames.length === 0) continue;

      const pathParameters =
        'parameters' in pathItem && Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!operations.has(method) || !operation || typeof operation !== 'object') continue;

        const operationParameters =
          'parameters' in operation && Array.isArray(operation.parameters)
            ? operation.parameters
            : [];
        const declaredParameters = [...pathParameters, ...operationParameters];
        for (const name of parameterNames) {
          const isDeclared = declaredParameters.some(
            (parameter) =>
              !('$ref' in parameter) &&
              parameter.name === name &&
              parameter.in === 'path' &&
              parameter.required === true,
          );
          if (!isDeclared)
            missingParameters.push(`${method.toUpperCase()} ${path} missing ${name}`);
        }
      }
    }

    expect(missingParameters).toEqual([]);
  });

  it('types normalized templated path operation parameters as exported runtime fields', () => {
    expectTypeOf(openApiSpec.paths['/checkout/sessions/{sessionId}'].get.parameters).toEqualTypeOf<
      OpenApiParameter[]
    >();
    expectTypeOf(openApiSpec.paths['/orders/{orderId}/cancel'].post.parameters).toEqualTypeOf<
      OpenApiParameter[]
    >();
  });

  it('documents the root-level health route outside the versioned API server', () => {
    expect(openApiSpec.paths['/health'].get).toBeDefined();
    expect(openApiSpec.paths['/health'].get.summary).toBe('Health check');
    expect(openApiSpec.paths['/health'].servers).toEqual([
      {
        url: 'https://api.tixkit.com',
        description: 'Production operational root',
      },
      { url: 'http://localhost:4000', description: 'Local operational root' },
    ]);
  });

  it('documents paginated private list endpoints as envelopes', () => {
    expect(
      openApiSpec.paths['/events'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/EventPage' });
    expect(
      openApiSpec.paths['/orders'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/OrderPage' });
    expect(
      openApiSpec.paths['/api-keys'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/ApiKeyPage' });
  });

  it('documents tenant settings lists as runtime array responses', () => {
    expect(
      openApiSpec.paths['/bootstrap-context'].get.responses['200'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/BootstrapContext' });
    expect(openApiSpec.components.schemas.BootstrapContext.properties.organizations.items).toEqual({
      $ref: '#/components/schemas/BootstrapOrganization',
    });
    expect(openApiSpec.components.schemas.BootstrapOrganization.required).not.toContain(
      'boxOfficeSettings',
    );
    expect(
      openApiSpec.paths['/organizations'].get.responses['200'].content['application/json'].schema,
    ).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/Organization' },
    });
    expect(openApiSpec.paths['/organizations'].get.parameters).toBeUndefined();
    expect(
      openApiSpec.paths['/brands'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ type: 'array', items: { $ref: '#/components/schemas/Brand' } });
    expect(openApiSpec.paths['/brands'].get.parameters).toBeUndefined();
    expect(
      openApiSpec.paths['/organizations/{organizationId}/payment-accounts'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/PaymentAccount' },
    });
  });

  it('uses implemented developer route paths', () => {
    expect(openApiSpec.paths['/api-keys']).toBeDefined();
    expect(openApiSpec.paths['/scanner-devices']).toBeDefined();
    expect(openApiSpec.paths['/oauth-applications']).toBeDefined();
    expect(openApiSpec.paths['/scanner-devices/{deviceId}/revoke']).toBeDefined();
    expect(openApiSpec.paths['/scanner-devices/{deviceId}/revoke'].post.responses).toHaveProperty(
      '200',
    );
    expect(
      openApiSpec.paths['/scanner-devices/{deviceId}/revoke'].post.responses,
    ).not.toHaveProperty('204');
    expect(openApiSpec.components.schemas.ScannerDevice.properties.scopes.items.enum).toEqual([
      'checkins.read',
      'checkins.write',
    ]);
    expect(openApiSpec.components.schemas.ScannerDevice.required).toContain('scopes');
    expect(
      openApiSpec.paths['/scanner-devices'].post.requestBody.content['application/json'].schema
        .properties.scopes.default,
    ).toEqual(['checkins.read', 'checkins.write']);
    const oauthApplicationFields = Object.keys(
      openApiSpec.paths['/oauth-applications'].post.requestBody.content['application/json'].schema
        .properties,
    );
    // eslint-disable-next-line unicorn/no-array-sort -- Sorting a fresh key array keeps this assertion stable without requiring ES2023 toSorted.
    oauthApplicationFields.sort();
    expect(oauthApplicationFields).toEqual(['name', 'organizationId', 'redirectUris', 'scopes']);
    expect(openApiSpec.paths).not.toHaveProperty('/developer/api-keys');
  });

  it('documents the sponsor-bound experimental agent control surface', () => {
    const register = openApiSpec.paths['/agent-principals'].post;
    const getPrincipal = openApiSpec.paths['/agent-principals/{id}'].get;
    const revokePrincipal = openApiSpec.paths['/agent-principals/{id}/revoke'].post;
    const grant = openApiSpec.paths['/agent-delegations'].post;
    const revokeDelegation = openApiSpec.paths['/agent-delegations/{id}/revoke'].post;

    for (const operation of [register, getPrincipal, revokePrincipal, grant, revokeDelegation]) {
      expect(operation.security).toEqual([{ BearerAuth: [] }]);
      expect(operation.security).not.toContainEqual({ ApiKey: [] });
      expect(operation.tags).toEqual(['Agent platform']);
      expect(operation['x-required-permissions']).toEqual(['developers.write']);
    }
    for (const mutation of [register, revokePrincipal, grant, revokeDelegation]) {
      expect(mutation.parameters).toContainEqual({
        $ref: '#/components/parameters/AgentControlIdempotencyKey',
      });
    }
    expect(openApiSpec.components.parameters.AgentControlIdempotencyKey.schema).toMatchObject({
      minLength: 16,
      maxLength: 255,
    });

    const registerSchema = register.requestBody.content['application/json'].schema;
    expect(registerSchema.additionalProperties).toBe(false);
    expect(Object.keys(registerSchema.properties).sort()).toEqual([
      'capabilities',
      'id',
      'kind',
      'maximumAutonomy',
    ]);
    expect(registerSchema.properties).not.toHaveProperty('tenantId');
    expect(registerSchema.properties).not.toHaveProperty('sponsorPrincipalId');
    expect(registerSchema.properties).not.toHaveProperty('registeredAt');

    const grantSchema = grant.requestBody.content['application/json'].schema;
    expect(grantSchema.additionalProperties).toBe(false);
    expect(grantSchema.properties).not.toHaveProperty('permissionSnapshot');
    expect(grantSchema.properties).not.toHaveProperty('issuedAt');
    expect(grantSchema.properties).not.toHaveProperty('sponsorPrincipalId');
    expect(grantSchema.properties.capabilities.uniqueItems).toBe(true);
    expect(grantSchema.properties.resourceScopes.uniqueItems).toBe(true);
    expect(openApiSpec.components.schemas.AgentPrincipal.required).toContain('protocolVersion');
    expect(openApiSpec.components.schemas.AgentDelegation.required).toContain('permissionSnapshot');
  });

  it('documents sponsor-created agent credentials and default-isolated agent authentication', () => {
    const create = openApiSpec.paths['/agent-principals/{id}/oauth-clients'].post;
    const revoke = openApiSpec.paths['/agent-principals/{id}/oauth-clients/{clientId}/revoke'].post;
    const session = openApiSpec.paths['/agent/session'].get;
    const token = openApiSpec.paths['/oauth/token'].post;

    for (const operation of [create, revoke]) {
      expect(operation.security).toEqual([{ BearerAuth: [] }]);
      expect(operation['x-required-permissions']).toEqual(['developers.write']);
      expect(operation.parameters).toContainEqual({
        $ref: '#/components/parameters/AgentControlIdempotencyKey',
      });
      expect(operation.tags).toEqual(['Agent platform']);
    }
    expect(create.requestBody.content['application/json'].schema).toMatchObject({
      additionalProperties: false,
      required: ['organizationId', 'name'],
    });
    expect(openApiSpec.components.schemas.AgentOAuthClient.properties.clientSecret).toMatchObject({
      readOnly: true,
    });
    expect(openApiSpec.components.schemas.AgentOAuthClient.required).not.toContain('clientSecret');
    expect(openApiSpec.components.schemas.AgentOAuthClientCreated.required).toContain(
      'clientSecret',
    );
    expect(create.responses['201'].content['application/json'].schema.$ref).toContain(
      'AgentOAuthClientCreated',
    );
    expect(create.responses['200'].content['application/json'].schema.$ref).toContain(
      'AgentOAuthClient',
    );
    expect(session.security).toEqual([{ AgentOAuth: ['agent.invoke'] }]);
    expect(session.tags).toEqual(['Agent platform']);
    expect(openApiSpec.components.securitySchemes.AgentOAuth.flows.clientCredentials).toMatchObject(
      {
        tokenUrl: '/v1/oauth/token',
        scopes: { 'agent.invoke': expect.any(String) },
      },
    );
    for (const server of openApiSpec.servers) {
      expect(
        new URL(
          openApiSpec.components.securitySchemes.AgentOAuth.flows.clientCredentials.tokenUrl,
          server.url,
        ).pathname,
      ).toBe('/v1/oauth/token');
    }
    expect(
      openApiSpec.components.schemas.AgentSession.properties.authentication.properties
        .productPermissions.maxItems,
    ).toBe(0);
    expect(
      token.requestBody.content['application/json'].schema.properties.grant_type.enum,
    ).toContain('client_credentials');
    expect(token.requestBody.content).toHaveProperty('application/x-www-form-urlencoded');
    expect(token.requestBody.content['application/json'].schema.required).toEqual(['grant_type']);
    expect(token.description).toContain('never receive a refresh token');
  });

  it('documents organizer-controlled agent memory without writable ownership fields', () => {
    const create = openApiSpec.paths['/agent-memory'].post;
    const inspect = openApiSpec.paths['/agent-memory/inspect'].post;
    const exportMemory = openApiSpec.paths['/agent-memory/export'].post;
    const correct = openApiSpec.paths['/agent-memory/{id}'].patch;
    const remove = openApiSpec.paths['/agent-memory/{id}/delete'].post;

    for (const operation of [create, inspect, exportMemory, correct, remove]) {
      expect(operation.security).toEqual([{ BearerAuth: [] }]);
      expect(operation.security).not.toContainEqual({ ApiKey: [] });
      expect(operation.tags).toEqual(['Agent platform']);
      expect('x-required-permissions' in operation).toBe(false);
      expect(operation.parameters).toContainEqual({
        $ref: '#/components/parameters/AgentMemoryIdempotencyKey',
      });
    }
    expect(openApiSpec.components.parameters.AgentMemoryIdempotencyKey.schema).toMatchObject({
      minLength: 16,
      maxLength: 255,
    });
    const namespace = openApiSpec.components.schemas.AgentMemoryNamespaceRequest;
    expect(namespace.oneOf).toHaveLength(2);
    expect(namespace.oneOf[0]).toMatchObject({
      additionalProperties: false,
      properties: { scopeType: { const: 'workspace' } },
      required: ['scopeType', 'purpose'],
    });
    expect(namespace.oneOf[0].properties).not.toHaveProperty('scopeId');
    expect(namespace.oneOf[1]).toMatchObject({
      additionalProperties: false,
      properties: { scopeType: { const: 'event' } },
      required: ['scopeType', 'scopeId', 'purpose'],
    });
    const createBranches = openApiSpec.components.schemas.AgentMemoryCreateRequest.oneOf;
    expect(createBranches).toHaveLength(2);
    expect(createBranches[0].properties.content.$ref).toContain('AgentMemoryOrganizerPreferences');
    expect(createBranches[0].properties.namespace.allOf[1].properties.purpose.const).toBe(
      'organizer_preferences',
    );
    expect(createBranches[1].properties.content.$ref).toContain('AgentMemoryProjectContext');
    expect(createBranches[1].properties.namespace.allOf[1].properties.purpose.const).toBe(
      'project_context',
    );
    expect(createBranches[0].properties.retentionExpiresAt.example).toBe(
      '2026-08-20T12:00:00.000Z',
    );
    expect(openApiSpec.components.schemas.AgentMemoryCorrectRequest.properties).not.toHaveProperty(
      'provenance',
    );
    expect(openApiSpec.components.schemas.AgentMemoryEntry.required).toEqual(
      expect.arrayContaining(['contentSha256', 'provenance', 'retentionExpiresAt', 'version']),
    );
    expect(openApiSpec.components.schemas.AgentMemoryExportBundle.required).toContain('sha256');
    expect(remove.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/AgentMemoryDeleteRequest',
    });
  });

  it('documents API-key authentication on scoped developer and audit automation routes', () => {
    const apiKeyCapableOperations = [
      openApiSpec.paths['/scanner-devices'].get,
      openApiSpec.paths['/scanner-devices'].post,
      openApiSpec.paths['/scanner-devices/{deviceId}/revoke'].post,
      openApiSpec.paths['/oauth-applications'].get,
      openApiSpec.paths['/oauth-applications'].post,
      openApiSpec.paths['/oauth-applications/{appId}'].delete,
      openApiSpec.paths['/webhook-endpoints'].get,
      openApiSpec.paths['/webhook-endpoints'].post,
      openApiSpec.paths['/webhook-endpoints/{endpointId}'].patch,
      openApiSpec.paths['/webhook-endpoints/{endpointId}/events'].get,
      openApiSpec.paths['/webhook-endpoints/{endpointId}/events/{eventId}/replay'].post,
      openApiSpec.paths['/webhook-events/{eventId}/replay'].post,
      openApiSpec.paths['/audit-logs'].get,
    ];

    for (const operation of apiKeyCapableOperations) {
      expect(operation.security).toEqual([{ BearerAuth: [] }, { ApiKey: [] }]);
    }
  });

  it('documents the human-only, idempotent API-key lifecycle contract', () => {
    const list = openApiSpec.paths['/api-keys'].get;
    const create = openApiSpec.paths['/api-keys'].post;
    const revoke = openApiSpec.paths['/api-keys/{keyId}'].delete;

    for (const operation of [list, create, revoke]) {
      expect(operation['x-required-permissions']).toEqual(['developers.write']);
      expect(operation['x-principal-type-restrictions']).toEqual({ allowed: ['user'] });
      expect(operation.security).toEqual([{ BearerAuth: [] }]);
    }
    expect(list.parameters).toContainEqual({
      name: 'organizationId',
      in: 'query',
      required: false,
      schema: { type: 'string' },
    });
    expect(create.parameters).toContainEqual({
      $ref: '#/components/parameters/ApiKeyCreationIdempotencyKey',
    });
    expect(openApiSpec.components.parameters.ApiKeyCreationIdempotencyKey.schema).toMatchObject({
      minLength: 16,
      maxLength: 255,
      pattern: '^[!-~]+$',
    });
    expect(create.responses['409'].description).toContain('API_KEY_SECRET_NOT_REPLAYABLE');
    expect(create.responses['409'].description).toContain('IDEMPOTENCY_CONFLICT');
    expect(create.responses['409'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ApiError',
    });
    expect(create.responses['201'].headers).toMatchObject({
      'Cache-Control': { schema: { enum: ['private, no-store'] } },
    });
    expect(create.operationId).toBe('postApiKeys');
    expect(list.operationId).toBe('getApiKeys');
    expect(revoke.operationId).toBe('deleteApiKeysByKeyId');
  });

  it('documents webhook endpoint management permissions, selectors, and retained history scope', () => {
    const list = openApiSpec.paths['/webhook-endpoints'].get;
    const create = openApiSpec.paths['/webhook-endpoints'].post;
    const update = openApiSpec.paths['/webhook-endpoints/{endpointId}'].patch;
    const history = openApiSpec.paths['/webhook-endpoints/{endpointId}/events'].get;

    for (const operation of [list, create, update, history]) {
      expect(operation['x-required-permissions']).toEqual(['developers.write']);
    }
    expect(list.parameters).toContainEqual({
      name: 'organizationId',
      in: 'query',
      required: false,
      schema: { type: 'string' },
    });
    for (const operation of [update, history]) {
      expect(operation.parameters).toContainEqual({
        name: 'endpointId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    }
    expect(history.description).toContain('after an endpoint is deleted');
    expect(history.description).toContain('tenant and organization scope');
    expect(create.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(create.description).toContain('replay the same endpoint and one-time signing secret');
    expect(create.responses['201'].headers).toMatchObject({
      'Cache-Control': { schema: { enum: ['private, no-store'] } },
      Pragma: { schema: { enum: ['no-cache'] } },
    });
    expect(create.responses['400'].description).toContain('Idempotency-Key');
    expect(create.responses['409'].description).toContain('different request');
    expect(create.responses['409'].description).toContain('secret replay window expired');
    expect(create.responses['409'].description).toContain('rotation is required');
  });

  it('requires an idempotency key when creating a saved venue', () => {
    const operation = openApiSpec.paths['/venues'].post;
    expect(operation.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(operation.responses['400'].description).toContain('Idempotency-Key');
    expect(operation.responses['409'].description).toContain('different venue request');
  });

  it('documents stable credential metadata returned by API serializers', () => {
    expect(openApiSpec.components.schemas.ApiKey.properties).toMatchObject({
      tenantId: { type: 'string' },
      organizationId: { type: 'string' },
      brandIds: { type: 'array', items: { type: 'string' } },
      eventIds: { type: 'array', items: { type: 'string' } },
      revokedAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    });
    expect(openApiSpec.components.schemas.ApiKey.required).toEqual([
      'id',
      'tenantId',
      'organizationId',
      'name',
      'keyPrefix',
      'scopes',
      'createdAt',
      'updatedAt',
    ]);

    expect(openApiSpec.components.schemas.ScannerDevice.properties).toMatchObject({
      tenantId: { type: 'string' },
      organizationId: { type: 'string' },
      updatedAt: { type: 'string', format: 'date-time' },
    });
    expect(openApiSpec.components.schemas.ScannerDevice.required).toEqual([
      'id',
      'tenantId',
      'organizationId',
      'name',
      'deviceId',
      'eventIds',
      'scopes',
      'status',
      'createdAt',
      'updatedAt',
    ]);

    expect(openApiSpec.components.schemas.WebhookEndpoint.required).toEqual([
      'id',
      'tenantId',
      'organizationId',
      'url',
      'events',
      'status',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('documents one-time webhook signing secrets on endpoint creation', () => {
    expect(
      openApiSpec.paths['/webhook-endpoints'].post.responses['201'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/WebhookEndpointCreated' });
    expect(openApiSpec.components.schemas.WebhookEndpointCreated).toMatchObject({
      allOf: expect.arrayContaining([
        expect.objectContaining({
          required: ['secret'],
        }),
      ]),
    });
    expect(openApiSpec.components.schemas.WebhookEventType).toEqual({
      type: 'string',
      enum: [
        'order.created',
        'order.paid',
        'order.refunded',
        'order.disputed',
        'ticket.issued',
        'ticket.checked_in',
        'attendee.updated',
        'event.published',
        'event.cancelled',
      ],
    });
    const createEventsSchema =
      openApiSpec.paths['/webhook-endpoints'].post.requestBody.content['application/json'].schema
        .properties.events;
    expect(createEventsSchema).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/WebhookEventType' },
      minItems: 1,
      maxItems: 9,
      uniqueItems: true,
    });
    const updateEventsSchema =
      openApiSpec.paths['/webhook-endpoints/{endpointId}'].patch.requestBody.content[
        'application/json'
      ].schema.properties.events;
    expect(updateEventsSchema).toMatchObject({
      type: 'array',
      items: { $ref: '#/components/schemas/WebhookEventType' },
      minItems: 1,
      maxItems: 9,
      uniqueItems: true,
    });
  });

  it('documents whole-event webhook replay queued responses', () => {
    expect(openApiSpec.components.schemas.WebhookReplayQueued).toEqual({
      type: 'object',
      properties: {
        queued: { type: 'boolean' },
        eventId: { type: 'string' },
        endpoints: { type: 'integer' },
      },
      required: ['queued', 'eventId', 'endpoints'],
    });
    expect(
      openApiSpec.paths['/webhook-events/{eventId}/replay'].post.responses['202'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/WebhookReplayQueued' });
    const wholeReplay = openApiSpec.paths['/webhook-events/{eventId}/replay'].post;
    const endpointReplay =
      openApiSpec.paths['/webhook-endpoints/{endpointId}/events/{eventId}/replay'].post;
    expect(wholeReplay.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(wholeReplay.parameters).toContainEqual({
      name: 'eventId',
      in: 'path',
      required: true,
      schema: { type: 'string' },
    });
    expect(endpointReplay.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    for (const operation of [wholeReplay, endpointReplay]) {
      expect(operation['x-compatibility-breaking-change']).toContain('requires Idempotency-Key');
      for (const status of ['400', '401', '403', '404', '409', '503']) {
        expect(operation.responses).toHaveProperty(status);
      }
    }
    expect(wholeReplay.responses['503'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/WebhookReplayUnavailable',
    });
    expect(endpointReplay.responses['503'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/WebhookEndpointReplayUnavailable',
    });
    expect(openApiSpec.components.schemas.WebhookReplayRetryError.properties.code.enum).toEqual([
      'REPLAY_DISPATCH_INCOMPLETE',
      'REPLAY_FINALIZATION_UNAVAILABLE',
    ]);
  });

  it('documents the breaking message campaign idempotency-key grammar', () => {
    expect(openApiSpec.info.version).toBe('2026-08-30');
    expect(openApiSpec.components.parameters.MessageCampaignIdempotencyKey).toEqual({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
      },
      description:
        'Required for message campaigns. Use 1-255 safe token characters with no whitespace, and reuse the same key only for an identical event and request body.',
    });
    const operation = openApiSpec.paths['/events/{eventId}/messages'].post;
    expect(operation.parameters).toContainEqual({
      $ref: '#/components/parameters/MessageCampaignIdempotencyKey',
    });
    expect(operation.parameters).not.toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(operation['x-compatibility-breaking-change']).toContain(
      'API 2026-08-19 restricts message-campaign Idempotency-Key',
    );
    expect(operation.responses['400'].description).toContain('Idempotency-Key');
  });

  it('documents brand payment account binding on response schemas', () => {
    expect(openApiSpec.components.schemas.Brand.properties).toHaveProperty('paymentAccountId');
    expect(
      openApiSpec.paths['/brands/{brandId}'].patch.requestBody.content['application/json'].schema
        .properties,
    ).toHaveProperty('paymentAccountId');
  });

  it('documents brand sender identity list responses', () => {
    expect(openApiSpec.components.schemas.BrandSenderIdentity).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        tenantId: { type: 'string' },
        brandId: { type: 'string' },
        email: { type: 'string', format: 'email' },
        replyToEmail: { type: 'string', format: 'email' },
        verified: { type: 'boolean' },
        verifiedAt: { type: 'string', format: 'date-time' },
      }),
    });
    expect(openApiSpec.components.schemas.BrandSenderIdentity.required).toEqual([
      'id',
      'tenantId',
      'brandId',
      'email',
      'name',
      'verified',
      'createdAt',
      'updatedAt',
    ]);
    expect(
      openApiSpec.paths['/brands/{brandId}/email-sender-identities'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/BrandSenderIdentity' },
    });
  });

  it('documents order sales-channel attribution for box-office reporting', () => {
    expect(openApiSpec.components.schemas.Organization.properties.boxOfficeSettings).toEqual({
      $ref: '#/components/schemas/BoxOfficeSettings',
    });
    expect(openApiSpec.components.schemas.Organization.required).toContain('boxOfficeSettings');
    expect(openApiSpec.components.schemas.BoxOfficeSettings).toEqual({
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        allowedTenderTypes: {
          type: 'array',
          items: { type: 'string', enum: ['cash', 'manual_card', 'comp'] },
          minItems: 1,
          maxItems: 3,
          uniqueItems: true,
        },
        requireBuyerEmail: { type: 'boolean' },
        receiptMode: { type: 'string', enum: ['print', 'email', 'both'] },
      },
      required: ['enabled', 'allowedTenderTypes', 'requireBuyerEmail', 'receiptMode'],
    });
    expect(
      openApiSpec.paths['/organizations/{organizationId}'].patch.requestBody.content[
        'application/json'
      ].schema.properties.boxOfficeSettings,
    ).toEqual({ $ref: '#/components/schemas/BoxOfficeSettings' });
    expect(openApiSpec.components.schemas.Order.properties.salesChannel).toEqual({
      type: 'string',
      enum: ['online', 'box_office'],
    });
    expect(openApiSpec.components.schemas.Order.properties.operatorId).toEqual({
      type: 'string',
    });
    expect(openApiSpec.components.schemas.Order.properties.tenderType).toEqual({
      type: 'string',
      enum: ['comp', 'cash', 'manual_card'],
    });
    expect(openApiSpec.components.schemas.SalesReport.properties.grossSalesByChannelCents).toEqual({
      type: 'object',
      properties: {
        online: { type: 'integer' },
        boxOffice: { type: 'integer' },
      },
      required: ['online', 'boxOffice'],
    });
    expect(openApiSpec.components.schemas.SalesReport.required).toContain(
      'grossSalesByChannelCents',
    );
  });

  it('documents Stripe Connect onboarding URL responses', () => {
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty(
      'onboardingUrl',
    );
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty(
      'detailsSubmitted',
    );
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty(
      'chargesEnabled',
    );
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty(
      'payoutsEnabled',
    );
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty('requirements');
    expect(openApiSpec.components.schemas.PaymentAccount.properties).toHaveProperty(
      'disabledReason',
    );
    expect(
      openApiSpec.paths['/organizations/{organizationId}/payment-accounts/stripe-connect'].post
        .responses,
    ).toHaveProperty('201');
    expect(
      openApiSpec.paths['/organizations/{organizationId}/payment-accounts/stripe-connect'].post[
        'x-required-permissions'
      ],
    ).toEqual(['billing.write']);
    expect(
      openApiSpec.paths['/organizations/{organizationId}/payment-accounts'].get[
        'x-required-permissions'
      ],
    ).toEqual(['billing.write']);
    expect(
      openApiSpec.paths[
        '/organizations/{organizationId}/payment-accounts/{paymentAccountId}/stripe-connect/refresh'
      ].post.responses,
    ).toHaveProperty('200');
    expect(
      openApiSpec.paths[
        '/organizations/{organizationId}/payment-accounts/{paymentAccountId}/stripe-connect/refresh'
      ].post['x-required-permissions'],
    ).toEqual(['billing.write']);
  });

  it('documents signed QR payloads for online check-in scans', () => {
    const operation = openApiSpec.paths['/check-ins/scan'].post;
    const schema = operation.requestBody.content['application/json'].schema;
    expect(schema.required).toEqual(['checkInListId', 'qrPayload', 'scannedAt']);
    expect(schema.properties).toHaveProperty('qrPayload');
    expect(schema.properties).not.toHaveProperty('qrHash');
    expect(operation.security).toEqual([
      { ScannerDeviceAuth: [] },
      { BearerAuth: [] },
      { ApiKey: [] },
    ]);
    expect(operation.parameters).toContainEqual({
      $ref: '#/components/parameters/OptionalScannerDeviceSecret',
    });
    expect(operation.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(operation['x-required-permissions']).toEqual(['checkins.write']);
    expect(operation.description).toContain('checkins.write');
    expect(operation['x-compatibility-breaking-change']).toContain('requires Idempotency-Key');
    expect(operation.responses).toHaveProperty('400');
  });

  it('documents scanner manifest and check-in list contracts', () => {
    expect(openApiSpec.paths['/events/{eventId}/check-in-lists']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/check-in-lists'].get.security).toEqual([
      { ScannerDeviceAuth: [] },
      { BearerAuth: [] },
    ]);
    expect(openApiSpec.paths['/events/{eventId}/check-in-lists'].get.parameters).toContainEqual({
      $ref: '#/components/parameters/OptionalScannerDeviceSecret',
    });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/CheckInListPage' });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/manifest'].get.responses[
        '200'
      ].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/OfflineManifest' });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/manifest'].get.responses,
    ).toHaveProperty('400');
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/activity'].get.parameters,
    ).toContainEqual({
      name: 'afterId',
      in: 'query',
      schema: { type: 'string' },
    });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/activity/stream'].get
        .parameters,
    ).toContainEqual({
      name: 'Last-Event-ID',
      in: 'header',
      schema: { type: 'string' },
    });
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/activity/stream'].get
        .responses['200'].content,
    ).toHaveProperty('text/event-stream');
    expect(openApiSpec.components.schemas.OfflineManifest.oneOf).toEqual([
      { $ref: '#/components/schemas/OfflineManifestV1' },
      { $ref: '#/components/schemas/OfflineManifestV2' },
    ]);
    expect(openApiSpec.components.schemas.OfflineManifestV1.required).toContain('tickets');
    expect(openApiSpec.components.schemas.OfflineManifestV1.properties.tickets.maxItems).toBe(
      50_000,
    );
    expect(
      openApiSpec.components.schemas.OfflineManifestV1.properties.tickets.description,
    ).toContain('50,000 tickets');
    expect(openApiSpec.components.schemas.OfflineManifestTicket.properties).toHaveProperty(
      'eventOccurrenceId',
    );
    expect(openApiSpec.components.schemas.OfflineManifestTicket.required).not.toContain(
      'eventOccurrenceId',
    );
    expect(openApiSpec.components.schemas.OfflineManifestV2.required).toEqual(
      expect.arrayContaining(['version', 'algorithm', 'issuer', 'tenantId', 'signature']),
    );
    expect(openApiSpec.components.schemas.OfflineManifestV2.properties.tickets.items).toEqual({
      $ref: '#/components/schemas/OfflineManifestTicketV2',
    });
    expect(
      openApiSpec.components.schemas.OfflineManifestTicketV2.allOf[1].properties.status.enum,
    ).toEqual(['valid', 'checked_in', 'void', 'refunded', 'transferred']);
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/manifest'].get.parameters,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'eventId', in: 'path', required: true }),
        expect.objectContaining({ name: 'checkInListId', in: 'path', required: true }),
        expect.objectContaining({ name: 'version', in: 'query' }),
      ]),
    );
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-lists/{checkInListId}/manifest'].get[
        'x-required-permissions'
      ],
    ).toEqual(['checkins.read']);
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-manifest-keys'].get['x-required-permissions'],
    ).toEqual(['checkins.read']);
    expect(
      openApiSpec.paths['/events/{eventId}/check-in-manifest-keys'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/OfflineManifestVerificationKeySet' });
    expect(openApiSpec.paths['/check-ins/sync'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(
      openApiSpec.paths['/check-ins/sync'].post.requestBody.content['application/json'].schema
        .properties.scans.maxItems,
    ).toBe(100_000);
    expect(openApiSpec.paths['/check-ins/bulk-sync-jobs'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(
      openApiSpec.paths['/check-ins/bulk-sync-jobs'].post.requestBody.content['application/json']
        .schema.properties.totalScans.maximum,
    ).toBe(250_000);
    expect(
      openApiSpec.paths['/check-ins/bulk-sync-jobs/{jobId}/chunks/{sequence}'].put.requestBody
        .content['application/json'].schema.properties.scans.maxItems,
    ).toBe(50_000);
    expect(openApiSpec.paths['/check-ins/bulk-sync-jobs'].post.description).toContain(
      'checkins.write',
    );
    expect(
      openApiSpec.paths['/check-ins/bulk-sync-jobs/{jobId}/chunks/{sequence}'].put.description,
    ).toContain('checkins.write');
    expect(openApiSpec.paths['/check-ins/bulk-sync-jobs/{jobId}'].get.description).toContain(
      'checkins.read',
    );
    expect(openApiSpec.paths['/check-ins/bulk-sync-jobs/{jobId}/chunks'].get.description).toContain(
      'checkins.read',
    );
    expect(openApiSpec.components.schemas.BulkSyncJob.properties).not.toHaveProperty('results');
    expect(openApiSpec.components.schemas.BulkSyncJob.properties.sampleErrors.maxItems).toBe(25);
    expect(openApiSpec.components.schemas.BulkSyncErrorSample.properties).not.toHaveProperty(
      'qrHash',
    );
    expect(openApiSpec.components.schemas.BulkSyncErrorSample.required).not.toContain('qrHash');
  });

  it('documents remaining implemented backend route groups', () => {
    expect(openApiSpec.paths['/events/{eventId}/attendees']).toBeDefined();
    expect(openApiSpec.paths['/attendees/{attendeeId}']).toBeDefined();
    expect(openApiSpec.paths['/tickets/{ticketId}/transfer']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/resale-policy']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/resale-listings']).toBeDefined();
    expect(openApiSpec.paths['/public/events/{eventId}/resale-listings']).toBeDefined();
    expect(openApiSpec.paths['/tickets/{ticketId}/resale-listings']).toBeDefined();
    expect(openApiSpec.paths['/ticket-listings/{listingId}/delist']).toBeDefined();
    expect(openApiSpec.paths['/ticket-listings/{listingId}/complete']).toBeDefined();
    expect(openApiSpec.paths['/ticket-listings/{listingId}/settlement']).toBeDefined();
    expect(openApiSpec.paths['/ticket-listings/{listingId}/settlement/payouts']).toBeDefined();
    expect(openApiSpec.paths['/ticket-listings/{listingId}/settlement/reversals']).toBeDefined();
    expect(
      openApiSpec.paths['/checkout/sessions/{sessionId}/tickets/{ticketId}/resale-listing'],
    ).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/inventory-pools']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/product-categories']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/products']).toBeDefined();
    expect(openApiSpec.paths['/products/{productId}']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/ticket-types/batch']).toBeDefined();
    expect(openApiSpec.paths['/ticket-types/{ticketTypeId}/batch']).toBeDefined();
    expect(openApiSpec.paths['/ticket-types/{ticketTypeId}/access-rules']).toBeDefined();
    expect(openApiSpec.paths['/access-rules/{accessRuleId}']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/questions/reorder']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/reports/sales']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/reports/tax']).toBeDefined();
    expect(openApiSpec.paths['/exports']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/messages']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/messages/preview']).toBeDefined();
    expect(openApiSpec.paths['/content-documents']).toBeDefined();
    expect(openApiSpec.paths['/content-documents/{documentId}/duplicate']).toBeDefined();
    expect(openApiSpec.paths['/content-documents/{documentId}/versions']).toBeDefined();
    expect(openApiSpec.paths['/content-documents/{documentId}/preview']).toBeDefined();
    expect(openApiSpec.paths['/public/events/{eventId}/page']).toBeDefined();
    expect(openApiSpec.paths['/public/events/{eventId}/content-page']).toBeDefined();
    expect(openApiSpec.paths['/public/events/{eventId}/revision']).toBeDefined();
    expect(openApiSpec.paths['/public/events/by-slug/{slug}/page']).toBeDefined();
    expect(openApiSpec.paths['/public/events/{eventId}/discovery-card']).toBeDefined();
    expect(openApiSpec.paths['/public/brand-logos/{artifactId}']).toBeDefined();
    expect(openApiSpec.paths['/webhook-events/{eventId}/replay']).toBeDefined();
    expect(
      openApiSpec.paths['/webhook-endpoints/{endpointId}/events/{eventId}/replay'],
    ).toBeDefined();
    expect(openApiSpec.components.schemas.TicketTypeBatchResult.required).toEqual([
      'ticketType',
      'accessRules',
    ]);
    expect(openApiSpec.components.schemas.CreateTicketTypeBatch.required).toContain('ticketType');
  });

  it('documents type-specific permissions for export creation', () => {
    const postExport = openApiSpec.paths['/exports'].post;

    expect(postExport.description).toContain('reports.read');
    expect(postExport.description).toContain('attendees.read');
    expect(postExport.description).toContain('orders.read');
    expect(postExport.description).toContain('checkins.read');
    expect(postExport['x-required-permissions']).toEqual({
      base: ['reports.read'],
      byType: {
        attendees: ['attendees.read'],
        orders: ['orders.read'],
        sales: ['orders.read'],
        tax: ['orders.read'],
        tickets: ['checkins.read'],
        scan_logs: ['checkins.read'],
      },
    });
  });

  it('documents public event revisions and immutable brand logo streams', () => {
    expect(openApiSpec.components.schemas.PublicEventRevision).toEqual({
      type: 'object',
      properties: {
        revision: { type: 'string', nullable: true, format: 'date-time' },
      },
      required: ['revision'],
    });
    expect(
      openApiSpec.paths['/public/events/{eventId}/revision'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEventRevision' });
    expect(openApiSpec.paths['/public/events/{eventId}/revision'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'eventId',
          in: 'path',
          required: true,
        }),
      ]),
    );

    const brandLogoResponse =
      openApiSpec.paths['/public/brand-logos/{artifactId}'].get.responses['200'];
    expect(brandLogoResponse.content['application/octet-stream'].schema).toEqual({
      type: 'string',
      format: 'binary',
    });
    expect(brandLogoResponse.headers['Cache-Control'].description).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(openApiSpec.paths['/public/brand-logos/{artifactId}'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'artifactId',
          in: 'path',
          required: true,
        }),
      ]),
    );
  });

  it('documents live export job statuses separately from queued export responses', () => {
    expect(openApiSpec.components.schemas.ExportJobQueued.properties.status.enum).toEqual([
      'pending',
    ]);
    expect(openApiSpec.components.schemas.ExportJob.properties.status.enum).toEqual([
      'pending',
      'processing',
      'completed',
      'failed',
    ]);
    expect(
      openApiSpec.paths['/exports/{exportId}'].get.responses['200'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/ExportJob' });
  });

  it('documents public availability ticket and product rows', () => {
    const schemas = openApiSpec.components.schemas;
    expect(schemas.PublicAvailabilityItem).toEqual({
      oneOf: [
        { $ref: '#/components/schemas/PublicAvailabilityTicketItem' },
        { $ref: '#/components/schemas/PublicAvailabilityProductItem' },
      ],
    });

    expect(schemas.PublicAvailabilityTicketItem).toMatchObject({
      properties: {
        ticketTypeId: { type: 'string' },
        kind: { type: 'string', enum: ['free', 'paid', 'donation'] },
      },
    });
    expect(schemas.PublicAvailabilityTicketItem.required).toContain('ticketTypeId');

    expect(schemas.PublicAvailabilityProductItem).toMatchObject({
      properties: {
        type: { type: 'string', enum: ['product'] },
        productId: { type: 'string' },
        kind: { type: 'string', enum: ['product'] },
      },
    });
    expect(schemas.PublicAvailabilityProductItem.required).toContain('productId');
    expect(schemas.PublicAvailabilityProductItem.required).not.toContain('ticketTypeId');

    const parameters = openApiSpec.paths['/public/events/{eventId}/availability'].get.parameters;
    expect(parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'eventId',
          in: 'path',
          required: true,
        }),
        expect.objectContaining({
          name: 'products',
          in: 'query',
          required: false,
        }),
      ]),
    );
  });

  it('documents public resale listings without internal seller or ticket fields', () => {
    const schema = openApiSpec.components.schemas.PublicTicketListing;
    expect(schema.properties).toMatchObject({
      id: { type: 'string' },
      eventId: { type: 'string' },
      priceCents: { type: 'integer', minimum: 0 },
      currency: { type: 'string', minLength: 3, maxLength: 3 },
      faceValueCents: { type: 'integer', minimum: 0 },
    });
    expect(schema.properties).not.toHaveProperty('tenantId');
    expect(schema.properties).not.toHaveProperty('sellerId');
    expect(schema.properties).not.toHaveProperty('ticketId');
    expect(openApiSpec.components.schemas.OrderLineItem.properties).toHaveProperty(
      'resaleListingId',
    );
    expect(
      openApiSpec.paths['/public/events/{eventId}/resale-listings'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicTicketListingPage' });
    expect(openApiSpec.paths['/public/events/{eventId}/resale-listings'].get.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'eventId',
          in: 'path',
          required: true,
        }),
        expect.objectContaining({ name: 'cursor', in: 'query' }),
        expect.objectContaining({
          name: 'limit',
          in: 'query',
          schema: expect.objectContaining({ maximum: 50 }),
        }),
      ]),
    );
    const checkoutItemBranches =
      openApiSpec.paths['/checkout/sessions'].post.requestBody.content['application/json'].schema
        .properties.items.items.oneOf;
    const resaleCheckoutItemBranch = checkoutItemBranches.at(-1);
    expect(resaleCheckoutItemBranch).toBeDefined();
    expect(resaleCheckoutItemBranch!.not.anyOf).toEqual(
      expect.arrayContaining([
        { required: ['occurrenceId'] },
        { required: ['unitAmountCents'] },
        { required: ['attendeeFields'] },
      ]),
    );
  });

  it('binds resale listing and checkout requests to the exact current terms', () => {
    const terms = openApiSpec.components.schemas.ResaleTermsAcceptance;
    expect(terms).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        accepted: { type: 'boolean', const: true },
        termsVersion: { type: 'string', const: '2026-07-16' },
        settlementModel: { type: 'string', const: 'organizer_managed' },
        refundModel: { type: 'string', const: 'manual_coordinated_resolution' },
      },
      required: ['accepted', 'termsVersion', 'settlementModel', 'refundModel'],
    });

    const staffListing =
      openApiSpec.paths['/tickets/{ticketId}/resale-listings'].post.requestBody.content[
        'application/json'
      ].schema;
    const buyerListing =
      openApiSpec.paths['/checkout/sessions/{sessionId}/tickets/{ticketId}/resale-listing'].post
        .requestBody.content['application/json'].schema;
    for (const schema of [staffListing, buyerListing]) {
      expect(schema.required).toEqual(['priceCents', 'termsAcceptance']);
      expect(schema.properties.priceCents).toEqual({ type: 'integer', exclusiveMinimum: 0 });
      expect(schema.properties.termsAcceptance).toEqual({
        $ref: '#/components/schemas/ResaleTermsAcceptance',
      });
    }

    const checkout =
      openApiSpec.paths['/checkout/sessions'].post.requestBody.content['application/json'].schema;
    expect(checkout.properties.resaleTermsAcceptance).toEqual({
      $ref: '#/components/schemas/ResaleTermsAcceptance',
    });
    expect(checkout.allOf).toEqual(
      expect.arrayContaining([
        // oxlint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema conditional keyword.
        expect.objectContaining({ then: { required: ['resaleTermsAcceptance'] } }),
        expect.objectContaining({ if: { required: ['resaleTermsAcceptance'] } }),
      ]),
    );
  });

  it('documents organizer-managed resale settlement evidence and retired completion', () => {
    const settlement = openApiSpec.components.schemas.ResaleSettlement;
    expect(settlement.properties.state.enum).toEqual([
      'pending',
      'paid',
      'reversed',
      'recovery_required',
      'review_required',
    ]);
    expect(settlement.properties.entries.items).toEqual({
      $ref: '#/components/schemas/ResaleSettlementEntry',
    });
    expect(
      openApiSpec.components.schemas.ResaleSettlementEntry.properties.externalReferenceSha256,
    ).toMatchObject({ type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' });

    const read = openApiSpec.paths['/ticket-listings/{listingId}/settlement'].get;
    expect(read['x-required-permissions']).toEqual(['orders.read']);
    expect(read.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ResaleSettlement',
    });

    const payout = openApiSpec.paths['/ticket-listings/{listingId}/settlement/payouts'].post;
    const reversal = openApiSpec.paths['/ticket-listings/{listingId}/settlement/reversals'].post;
    const listingIdParameter = {
      name: 'listingId',
      in: 'path',
      required: true,
      schema: { type: 'string', minLength: 1 },
    };
    const settlementIdempotencyParameter = {
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        pattern: '^[\\s\\S]*\\S[\\s\\S]*$',
      },
    };
    expect(read.parameters).toContainEqual(listingIdParameter);
    for (const operation of [payout, reversal]) {
      expect(operation['x-required-permissions']).toEqual(['billing.write']);
      expect(operation.parameters).toContainEqual(listingIdParameter);
      expect(operation.parameters).toContainEqual(settlementIdempotencyParameter);
      expect(operation.responses['200'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/ResaleSettlement',
      });
      expect(operation.responses).toHaveProperty('400');
      expect(operation.responses).toHaveProperty('404');
    }
    const payoutSchema = payout.requestBody.content['application/json'].schema;
    const reversalSchema = reversal.requestBody.content['application/json'].schema;
    expect(
      exampleMatchesSchema(
        {
          amountCents: 5000,
          currency: 'usd',
          expectedVersion: 1,
          method: 'bank_transfer',
          externalReference: 'bank-1',
        },
        payoutSchema,
      ),
    ).toBe(false);
    expect(
      exampleMatchesSchema(
        {
          amountCents: 5000,
          currency: 'USD',
          expectedVersion: 1,
          method: 'bank_transfer',
          externalReference: '   ',
        },
        payoutSchema,
      ),
    ).toBe(false);
    expect(
      exampleMatchesSchema(
        {
          amountCents: 5000,
          currency: 'USD',
          expectedVersion: 1,
          method: 'accounting_adjustment',
          reason: 'Buyer refund approved',
        },
        reversalSchema,
      ),
    ).toBe(true);
    expect(
      exampleMatchesSchema(
        {
          amountCents: 5000,
          currency: 'USD',
          expectedVersion: 1,
          method: 'accounting_adjustment',
          reason: '\n\t',
        },
        reversalSchema,
      ),
    ).toBe(false);
    expect(
      payout.requestBody.content['application/json'].schema.properties.externalReference,
    ).toBeDefined();
    expect(reversal.requestBody.content['application/json'].schema.properties).not.toHaveProperty(
      'externalReference',
    );

    const retired = openApiSpec.paths['/ticket-listings/{listingId}/complete'].post;
    expect(retired['x-required-permissions']).toEqual(['tickets.write']);
    expect(retired.parameters).toContainEqual(listingIdParameter);
    expect(retired).not.toHaveProperty('requestBody');
    expect(retired.responses).not.toHaveProperty('200');
    expect(retired.responses['410'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ApiError',
    });
    expect(retired.responses['410'].headers).toMatchObject({
      Deprecation: { schema: { type: 'string', const: '@1784160000' } },
      Link: {
        schema: {
          type: 'string',
          const: '</v1/checkout/sessions>; rel="successor-version"',
        },
      },
    });
    expect(openApiSpec.components.schemas).not.toHaveProperty('TicketResaleCompletion');
  });

  it('documents split-key message campaign request and response contracts', () => {
    const messagePost = openApiSpec.paths['/events/{eventId}/messages'].post;
    const requestSchema = messagePost.requestBody.content['application/json'].schema;
    expect(messagePost.parameters).toContainEqual({
      $ref: '#/components/parameters/MessageCampaignIdempotencyKey',
    });
    expect(requestSchema.oneOf).toHaveLength(3);
    expect(requestSchema.oneOf.map((schema) => [...schema.required])).toEqual([
      ['emailTemplateKey', 'audience', 'channel'],
      ['smsTemplateKey', 'audience', 'channel'],
      ['emailTemplateKey', 'smsTemplateKey', 'audience', 'channel'],
    ]);
    expect(requestSchema.oneOf[0].properties).not.toHaveProperty('templateKey');
    expect(requestSchema.oneOf[0].properties.emailTemplateKey.maxLength).toBe(128);
    expect(requestSchema.oneOf[0].properties.scheduledAt).toEqual({
      type: 'string',
      format: 'date-time',
    });
    expect(requestSchema.oneOf[1].properties.smsTemplateKey.maxLength).toBe(128);
    expect(requestSchema.oneOf.every((schema) => 'scheduledAt' in schema.properties)).toBe(true);
    expect(requestSchema.oneOf.every((schema) => !('eventId' in schema.properties))).toBe(true);
    expect(messagePost.responses['202'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/MessageQueued',
    });

    const messageQueued = openApiSpec.components.schemas.MessageQueued;
    expect(messageQueued.properties).toMatchObject({
      campaignId: { type: 'string' },
      eventId: { type: 'string' },
      emailTemplateKey: { type: 'string' },
      smsTemplateKey: { type: 'string' },
      status: { type: 'string', enum: ['queued', 'failed', 'suppressed'] },
      queuedEmailJobs: { type: 'integer' },
      queuedSmsJobs: { type: 'integer' },
      startFailedEmailJobs: { type: 'integer' },
      startFailedSmsJobs: { type: 'integer' },
      scheduledAt: { type: 'string', format: 'date-time' },
    });
    expect(messageQueued.required).toEqual(
      expect.arrayContaining([
        'campaignId',
        'eventId',
        'channel',
        'status',
        'audienceCount',
        'queuedEmailJobs',
        'queuedSmsJobs',
        'startFailedEmailJobs',
        'startFailedSmsJobs',
        'emailJobIds',
        'smsJobIds',
      ]),
    );
    expect(messageQueued.properties).not.toHaveProperty('queued');
    expect(messageQueued.properties).not.toHaveProperty('jobIds');
    expect(openApiSpec.components.schemas.MessageJob.properties).not.toHaveProperty('to_email');
    expect(openApiSpec.components.schemas.MessageJob.properties).not.toHaveProperty('to_phone');
    expect(openApiSpec.components.schemas.MessageJob.properties).not.toHaveProperty('body');
    expect(openApiSpec.components.schemas.MessageJob.properties).not.toHaveProperty('variables');
    expect(openApiSpec.components.schemas.MessageProviderEvent.properties).not.toHaveProperty(
      'raw_payload',
    );

    const renderPreviewPost = openApiSpec.paths['/events/{eventId}/messages/render-preview'].post;
    expect(
      renderPreviewPost.requestBody.content['application/json'].schema.additionalProperties,
    ).toBe(false);
    expect(renderPreviewPost.responses).toHaveProperty('400');
  });

  it('documents message list envelopes and delivery-log schemas', () => {
    const messageListSchema =
      openApiSpec.paths['/events/{eventId}/messages'].get.responses['200'].content[
        'application/json'
      ].schema;
    expect(messageListSchema.required).toEqual(['items']);
    expect(messageListSchema.properties).not.toHaveProperty('nextCursor');
    expect(messageListSchema.properties).not.toHaveProperty('hasMore');

    const jobsSchema =
      openApiSpec.paths['/events/{eventId}/messages/{campaignId}/jobs'].get.responses['200']
        .content['application/json'].schema;
    expect(jobsSchema).toMatchObject({
      required: ['items'],
      properties: {
        items: { items: { $ref: '#/components/schemas/MessageJobEnvelope' } },
      },
    });
    expect(jobsSchema.properties).not.toHaveProperty('nextCursor');
    expect(jobsSchema.properties).not.toHaveProperty('hasMore');

    const deliveryLogsSchema =
      openApiSpec.paths['/events/{eventId}/messages/{campaignId}/delivery-logs'].get.responses[
        '200'
      ].content['application/json'].schema;
    expect(deliveryLogsSchema).toMatchObject({
      required: ['items'],
      properties: {
        items: {
          items: { $ref: '#/components/schemas/MessageDeliveryLogEnvelope' },
        },
      },
    });
    expect(
      openApiSpec.paths[
        '/events/{eventId}/messages/{campaignId}/delivery-logs/{channel}/{deliveryId}'
      ].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/MessageDeliveryLogEnvelope' });
    expect(openApiSpec.components.schemas.MessageDeliveryLogEnvelope.required).toEqual([
      'channel',
      'campaignId',
      'eventId',
      'delivery',
    ]);

    const providerEventsSchema =
      openApiSpec.paths['/events/{eventId}/messages/{campaignId}/provider-events'].get.responses[
        '200'
      ].content['application/json'].schema;
    expect(providerEventsSchema).toMatchObject({
      required: ['items'],
      properties: {
        items: {
          items: { $ref: '#/components/schemas/MessageProviderEventEnvelope' },
        },
      },
    });
    expect(providerEventsSchema.properties).not.toHaveProperty('nextCursor');
    expect(providerEventsSchema.properties).not.toHaveProperty('hasMore');
  });

  it('documents content-studio document lifecycle contracts', () => {
    expect(openApiSpec.components.schemas.ContentDocument.properties.channel.enum).toEqual([
      'event_page',
      'email',
      'sms',
      'imessage',
      'social_invite',
    ]);
    expect(openApiSpec.paths['/content-documents'].get.parameters).toEqual([
      { name: 'channel', in: 'query', schema: { type: 'string' } },
      { name: 'brandId', in: 'query', schema: { type: 'string' } },
      { name: 'eventId', in: 'query', schema: { type: 'string' } },
      {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100 },
      },
    ]);
    expect(openApiSpec.components.schemas.ContentDocumentVersion.properties.validation).toEqual({
      $ref: '#/components/schemas/ContentValidationResult',
    });
    expect(openApiSpec.components.schemas.ContentRenderOutput.properties.segments).toMatchObject({
      type: 'integer',
    });
    expect(openApiSpec.components.schemas.ContentPreview.properties.renderArtifact).toEqual({
      $ref: '#/components/schemas/ContentRenderArtifact',
    });
    expect(openApiSpec.components.schemas.ContentRenderArtifact.properties.outputType.enum).toEqual(
      ['preview', 'test_send', 'send'],
    );
    expect(openApiSpec.components.schemas.ContentRenderArtifact.required).toEqual([
      'id',
      'tenantId',
      'documentId',
      'versionId',
      'channel',
      'outputType',
      'artifactRef',
      'checksum',
      'createdAt',
    ]);
    expect(
      openApiSpec.components.schemas.EmailTemplateDocument.properties.editor.properties.provider
        .enum,
    ).toEqual(['@react-email/editor']);
    expect(openApiSpec.components.schemas.EmailTemplateDocument.example).toMatchObject({
      schemaVersion: 1,
      editor: { provider: '@react-email/editor' },
      settings: {
        templateKey: 'order-confirmed',
        category: 'transactional',
        sender: {
          fromEmail: 'tickets@example.test',
          replyToEmail: 'support@example.test',
        },
      },
      blocks: expect.arrayContaining([
        expect.objectContaining({ type: 'event_hero' }),
        expect.objectContaining({ type: 'ticket_summary' }),
        expect.objectContaining({ type: 'unsubscribe_footer' }),
      ]),
    });
    expect(
      openApiSpec.components.schemas.SmsTemplateDocument.properties.editor.properties.provider.enum,
    ).toEqual(['@tixkit/content-message/sms-composer']);
    expect(openApiSpec.components.schemas.SmsTemplateDocument.example).toMatchObject({
      schemaVersion: 1,
      editor: {
        provider: '@tixkit/content-message/sms-composer',
        body: expect.stringContaining('{{event.title}}'),
      },
      settings: {
        templateKey: 'event-reminder-sms',
        category: 'bulk',
        consentCategory: 'marketing',
        optOutText: 'Reply STOP to opt out',
      },
      shortLinks: [
        {
          originalUrl: '{{event.checkoutUrl}}',
          reason: 'long_url',
          field: 'editor.body',
        },
      ],
    });
    expect(
      openApiSpec.paths['/content-documents/{documentId}/versions'].post.requestBody.content[
        'application/json'
      ].schema.properties.contentJson.oneOf,
    ).toEqual([
      { $ref: '#/components/schemas/EventPageDocumentV2' },
      { $ref: '#/components/schemas/EmailTemplateDocument' },
      { $ref: '#/components/schemas/SmsTemplateDocument' },
      { type: 'object', additionalProperties: true },
    ]);
    expect(
      openApiSpec.paths['/content-documents/{documentId}/preview'].post.requestBody.content[
        'application/json'
      ].schema.properties.contentJson.oneOf,
    ).toEqual([
      { $ref: '#/components/schemas/EventPageDocumentV2' },
      { $ref: '#/components/schemas/EmailTemplateDocument' },
      { $ref: '#/components/schemas/SmsTemplateDocument' },
      { type: 'object', additionalProperties: true },
    ]);
    expect(openApiSpec.paths['/content-documents'].post.responses['400'].description).toContain(
      'unavailable',
    );
    expect(
      openApiSpec.paths['/content-documents/{documentId}/versions/{versionId}/publish'].post
        .responses['200'].content['application/json'].schema.required,
    ).toEqual(['document', 'version']);
    expect(
      openApiSpec.paths['/content-documents/{documentId}/duplicate'].post.responses['201'].content[
        'application/json'
      ].schema.required,
    ).toEqual(['document', 'versions']);
    expect(
      openApiSpec.paths['/content-documents/{documentId}/test-sends'].post.responses['202'].content[
        'application/json'
      ].schema.required,
    ).toEqual(['testSend', 'output', 'renderArtifact']);
    expect(
      openApiSpec.paths['/public/events/{eventId}/content-page'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicContentPage' });
    expect(
      openApiSpec.paths['/public/events/{eventId}/page'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicContentPage' });
    expect(
      openApiSpec.paths['/public/events/{eventId}/bootstrap'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicCheckoutBootstrap' });
    expect(
      openApiSpec.paths['/public/events/{eventId}/page-bootstrap'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEventPageBootstrap' });
    expect(
      openApiSpec.paths['/public/events/{eventId}'].get.responses['200'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEvent' });
    expect(
      openApiSpec.paths['/public/events/by-slug/{slug}'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEvent' });
    expect(openApiSpec.components.schemas.PublicCheckoutBootstrap.properties.event).toEqual({
      $ref: '#/components/schemas/PublicEvent',
    });
    expect(openApiSpec.components.schemas.PublicEventPageBootstrap.properties.event).toEqual({
      $ref: '#/components/schemas/PublicEvent',
    });
    expect(openApiSpec.components.schemas.PublicEvent.required).toEqual([
      'id',
      'slug',
      'title',
      'description',
      'status',
      'timezone',
      'startsAt',
      'endsAt',
      'venue',
      'brandId',
      'minimumAge',
      'marketingIntegrations',
    ]);
    expect(openApiSpec.components.schemas.PublicEvent.properties).not.toHaveProperty('currency');
    expect(openApiSpec.components.schemas.PublicEvent.properties).not.toHaveProperty('visibility');
    expect(openApiSpec.components.schemas.PublicEvent.properties).not.toHaveProperty(
      'resalePolicy',
    );
    expect(
      openApiSpec.components.schemas.PublicEvent.properties.marketingIntegrations.items,
    ).toEqual({
      $ref: '#/components/schemas/PublicMarketingIntegration',
    });
    expect(openApiSpec.components.schemas.PublicEvent.properties.mediaAssets.items).toEqual({
      $ref: '#/components/schemas/PublicEventMediaAsset',
    });
    expect(
      openApiSpec.components.schemas.PublicEventMediaAsset.properties.renditions.items,
    ).toEqual({ $ref: '#/components/schemas/PublicEventMediaRendition' });
    expect(openApiSpec.components.schemas.PublicMarketingIntegration.properties).not.toHaveProperty(
      'tenantId',
    );
    expect(
      openApiSpec.paths['/public/events/by-slug/{slug}/page-bootstrap'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEventPageBootstrap' });
    expect(
      openApiSpec.paths['/public/events/{eventId}/discovery-card'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicEventDiscoveryCard' });
    expect(openApiSpec.paths).not.toHaveProperty('/public/events/{eventId}/draft-preview');
    expect(openApiSpec.paths).not.toHaveProperty('/content-documents/{documentId}/preview-token');
    expect(openApiSpec.paths).toHaveProperty('/content-documents/migrate-event-page-puck');
    expect(openApiSpec.paths).toHaveProperty('/public/content-event-page-images/{artifactId}');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.document.properties,
    ).not.toHaveProperty('tenantId');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.version.properties,
    ).not.toHaveProperty('contentJson');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.version.properties,
    ).not.toHaveProperty('renderedHtml');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.version.properties,
    ).not.toHaveProperty('renderedText');
    expect(openApiSpec.components.schemas.PublicContentPage.properties.page.required).toEqual([
      'provider',
      'puckData',
      'settings',
      'discovery',
    ]);
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties.puckData,
    ).toEqual({ $ref: '#/components/schemas/PuckData' });
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties.provider.enum,
    ).toEqual(['@puckeditor/core']);
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties,
    ).not.toHaveProperty('html');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties,
    ).not.toHaveProperty('text');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties,
    ).not.toHaveProperty('headless');
    expect(
      openApiSpec.components.schemas.PublicContentPage.properties.page.properties,
    ).not.toHaveProperty('renderModel');
    expect(openApiSpec.components.schemas.EventPageDocumentV2.required).toEqual([
      'schemaVersion',
      'editor',
    ]);
    expect(openApiSpec.components.schemas.EventPageDocumentV2.properties.editor.required).toEqual([
      'provider',
      'data',
    ]);
    expect(
      openApiSpec.components.schemas.EventPageDocumentV2.properties.editor.properties.provider.enum,
    ).toEqual(['@puckeditor/core']);
    expect(openApiSpec.components.schemas.PuckData.required).toEqual(['content', 'root']);
    expect(openApiSpec.components.schemas.PuckData.properties.content.items).toEqual({
      $ref: '#/components/schemas/PuckComponentData',
    });
    expect(openApiSpec.components.schemas.PuckData.properties.zones.deprecated).toBe(true);
    expect(openApiSpec.components.schemas).not.toHaveProperty('PublicEventPageBlock');
    expect(openApiSpec.components.schemas).not.toHaveProperty('ResolvedEventPage');
    expect(openApiSpec.components.schemas).not.toHaveProperty('ResolvedEventPageBlock');
    expect(openApiSpec.components.schemas.DraftPreviewPage.required).toEqual([
      'document',
      'version',
      'contentJson',
      'context',
      'validation',
    ]);
    expect(openApiSpec.components.schemas.DraftPreviewPage.properties.document.required).toEqual([
      'eventId',
      'channel',
      'key',
      'name',
      'locale',
      'updatedAt',
    ]);
    expect(openApiSpec.components.schemas.DraftPreviewPage.properties.version.required).toEqual([
      'versionNumber',
      'status',
    ]);
    expect(openApiSpec.components.schemas.DraftPreviewPage.properties).not.toHaveProperty(
      'versionId',
    );
    expect(openApiSpec.components.schemas.DraftPreviewPage.properties.contentJson).toEqual({
      $ref: '#/components/schemas/EventPageDocumentV2',
    });
    expect(openApiSpec.components.schemas.DraftPreviewPage.properties).not.toHaveProperty(
      'renderModel',
    );
  });

  it('documents checkout tracking separately from affiliate attribution', () => {
    const checkoutSessionBody =
      openApiSpec.paths['/checkout/sessions'].post.requestBody.content['application/json'].schema;
    expect(checkoutSessionBody.properties.affiliateCode).toEqual({
      type: 'string',
    });
    expect(checkoutSessionBody.properties.trackingId).toEqual({
      type: 'string',
    });
  });

  it('documents report contracts from live route shapes', () => {
    expect(openApiSpec.components.schemas.SalesReport.properties.range).toEqual({
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
      },
      required: ['from', 'to'],
    });
    expect(openApiSpec.components.schemas.SalesReport.required).toContain('range');
    expect(
      openApiSpec.components.schemas.TaxReport.properties.breakdown.items.properties.rate,
    ).toEqual({
      type: ['number', 'null'],
    });
    expect(openApiSpec.paths['/events/{eventId}/reports/tax'].get.parameters).toEqual(
      expect.arrayContaining([
        {
          name: 'from',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'date-time' },
        },
        {
          name: 'to',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'date-time' },
        },
      ]),
    );
    expect(
      openApiSpec.paths['/events/{eventId}/reports/attendance'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/AttendanceReport' });
    expect(
      openApiSpec.paths['/events/{eventId}/reports/promo'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PromoReport' });
    expect(
      openApiSpec.paths['/organizations/{organizationId}/reports/affiliate'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/AffiliateReport' });
    expect(openApiSpec.components.schemas.AttendanceReport.required).toEqual([
      'eventId',
      'totalAttendees',
      'checkedIn',
      'notCheckedIn',
      'checkInRate',
      'breakdownByTicketType',
    ]);
    expect(openApiSpec.components.schemas.PromoReport.required).toEqual([
      'eventId',
      'discountCodes',
    ]);
    expect(openApiSpec.components.schemas.AffiliateReport.required).toEqual([
      'organizationId',
      'affiliates',
    ]);
  });

  it('documents box-office order creation as an idempotent admin mutation', () => {
    const route = openApiSpec.paths['/events/{eventId}/box-office/orders'].post;
    expect(route.security).toEqual([{ BearerAuth: [] }, { ApiKey: [] }]);
    expect(route.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(route.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/BoxOfficeOrderInput',
    });
    expect(route.responses['201'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/BoxOfficeOrderResult',
    });
    expect(openApiSpec.components.schemas.BoxOfficeOrderInput.properties.tenderType).toEqual({
      type: 'string',
      enum: ['comp', 'cash', 'manual_card'],
    });
  });

  it('documents checkout session recovery through token header or payment intent client secret', () => {
    expect(openApiSpec.components.parameters.OptionalCheckoutSessionToken).toMatchObject({
      name: 'X-Checkout-Session-Token',
      in: 'header',
      required: false,
    });
    expect(openApiSpec.components.parameters.PaymentIntentClientSecret).toMatchObject({
      name: 'payment_intent_client_secret',
      in: 'query',
      required: false,
    });
    expect(openApiSpec.paths['/checkout/sessions/{sessionId}'].get.parameters).toEqual(
      expect.arrayContaining([
        {
          name: 'sessionId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        { $ref: '#/components/parameters/OptionalCheckoutSessionToken' },
        { $ref: '#/components/parameters/PaymentIntentClientSecret' },
      ]),
    );
  });

  it('documents checkout session updates with their runtime request body', () => {
    const route = openApiSpec.paths['/checkout/sessions/{sessionId}'].patch;
    expect(route.parameters).toEqual(
      expect.arrayContaining([
        {
          name: 'sessionId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        { $ref: '#/components/parameters/CheckoutSessionToken' },
      ]),
    );
    expect(route.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CheckoutSessionUpdateInput',
    });
    expect(openApiSpec.components.schemas.CheckoutSessionUpdateInput.properties).toEqual({
      buyer: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          phone: { type: 'string' },
        },
      },
      successUrl: { type: 'string', format: 'uri' },
      cancelUrl: { type: 'string', format: 'uri' },
    });
  });

  it('documents attendee updates with their runtime request body', () => {
    const route = openApiSpec.paths['/attendees/{attendeeId}'].patch;
    expect(route.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/AttendeeUpdateInput',
    });
    expect(openApiSpec.components.schemas.AttendeeUpdateInput.properties).toEqual({
      firstName: { type: ['string', 'null'] },
      lastName: { type: ['string', 'null'] },
      email: { type: 'string', format: 'email' },
      phone: { type: ['string', 'null'] },
    });
    expect(route['x-required-permissions']).toEqual(['attendees.write']);
  });

  it('documents admin table query params and runtime page envelopes', () => {
    for (const [path, pageSchema] of [
      ['/events', 'EventPage'],
      ['/orders', 'OrderPage'],
      ['/events/{eventId}/attendees', 'AttendeePage'],
      ['/attendees', 'AttendeePage'],
      ['/audit-logs', 'AuditLogPage'],
      ['/privacy/requests', 'PrivacyRequestPage'],
    ] as const) {
      const params = openApiSpec.paths[path].get.parameters;
      expect(params).toEqual(
        expect.arrayContaining([
          { $ref: '#/components/parameters/AdminTableCursor' },
          { $ref: '#/components/parameters/AdminTableDirection' },
          { $ref: '#/components/parameters/AdminTableLimit' },
          { $ref: '#/components/parameters/AdminTableSearch' },
          { $ref: '#/components/parameters/AdminTableSort' },
          { $ref: '#/components/parameters/AdminTableIncludeFacets' },
          { $ref: '#/components/parameters/AdminTableIncludeTotal' },
        ]),
      );
      expect(
        openApiSpec.paths[path].get.responses['200'].content['application/json'].schema,
      ).toEqual({ $ref: `#/components/schemas/${pageSchema}` });
      const schema = openApiSpec.components.schemas[pageSchema];
      expect(schema.properties).toMatchObject({
        nextCursor: { type: ['string', 'null'] },
        prevCursor: { type: ['string', 'null'] },
        total: { type: 'integer' },
        filterTotal: { type: 'integer' },
        facets: {
          type: 'object',
          additionalProperties: {
            $ref: '#/components/schemas/AdminTableFacet',
          },
        },
        applied: { $ref: '#/components/schemas/AdminTableAppliedQuery' },
      });
      expect(schema.properties).not.toHaveProperty('hasMore');
      expect(schema.required).toEqual(['items']);
    }

    expect(openApiSpec.paths['/orders'].get.parameters).toEqual(
      expect.arrayContaining([
        { name: 'organizationId', in: 'query', schema: { type: 'string' } },
        { name: 'eventId', in: 'query', schema: { type: 'string' } },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: { type: 'string' },
        },
        {
          name: 'refundState',
          in: 'query',
          required: false,
          schema: { type: 'boolean' },
        },
      ]),
    );
  });

  it('documents conversion widget impressions as persisted counts', () => {
    const schema =
      openApiSpec.paths['/events/{eventId}/reports/conversion'].get.responses['200'].content[
        'application/json'
      ].schema;
    expect(schema.required).toContain('widgetViews');
    expect(schema.properties.widgetViews).toEqual({ type: 'number' });
  });

  it('documents public widget impression ingestion', () => {
    const path = openApiSpec.paths['/public/events/{eventId}/widget-impressions'];
    expect(path.post).toBeDefined();
    expect(path.post.responses['201']).toBeDefined();
    const body = path.post.requestBody.content['application/json'].schema;
    expect(body.properties.visitorId).toMatchObject({ type: 'string' });
  });

  it('documents marketing integration management and public exposure', () => {
    expect(openApiSpec.components.schemas.MarketingIntegration.properties.provider.enum).toEqual([
      'ga4',
      'meta_pixel',
      'generic_tag',
    ]);
    expect(
      openApiSpec.paths['/events/{eventId}/marketing-integrations'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/MarketingIntegrationPage' });
    expect(openApiSpec.paths['/events/{eventId}/marketing-integrations'].get.parameters).toEqual([
      {
        name: 'eventId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ]);

    const upsertOperation =
      openApiSpec.paths['/events/{eventId}/marketing-integrations/{provider}'].put;
    expect(upsertOperation.parameters).toEqual([
      {
        name: 'eventId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      {
        name: 'provider',
        in: 'path',
        required: true,
        schema: { type: 'string', enum: ['ga4', 'meta_pixel', 'generic_tag'] },
      },
    ]);
    const upsertBody = upsertOperation.requestBody.content['application/json'].schema;
    expect(upsertBody.required).toEqual(['config']);
    expect(upsertBody.additionalProperties).toBe(false);
    expect(Object.hasOwn(upsertBody.properties, 'provider')).toBe(false);
    expect(upsertBody.properties.config.oneOf).toEqual([
      { $ref: '#/components/schemas/Ga4MarketingIntegrationConfig' },
      { $ref: '#/components/schemas/MetaPixelMarketingIntegrationConfig' },
      { $ref: '#/components/schemas/GenericTagMarketingIntegrationConfig' },
    ]);
    expect(upsertOperation['x-tixkit-provider-config-correlation']).toEqual({
      pathParameter: 'provider',
      requestProperty: 'config',
      mappings: {
        ga4: '#/components/schemas/Ga4MarketingIntegrationConfig',
        meta_pixel: '#/components/schemas/MetaPixelMarketingIntegrationConfig',
        generic_tag: '#/components/schemas/GenericTagMarketingIntegrationConfig',
      },
    });
    expect(openApiSpec.components.schemas.GenericTagMarketingIntegrationConfig).toMatchObject({
      additionalProperties: false,
      required: ['pixelUrl'],
      properties: {
        pixelUrl: {
          pattern: '^[Hh][Tt][Tt][Pp][Ss]://(?![^/?#]*@)[^?#]+$',
          description: expect.stringContaining('without credentials'),
        },
      },
    });
    const genericConfig = openApiSpec.components.schemas.GenericTagMarketingIntegrationConfig;
    expect(
      exampleMatchesSchema({ pixelUrl: 'https://metrics.example.test/pixel.gif' }, genericConfig),
    ).toBe(true);
    for (const pixelUrl of [
      'https://user:password@metrics.example.test/pixel.gif',
      'https://metrics.example.test/pixel.gif?token=secret',
      'https://metrics.example.test/pixel.gif#secret',
    ]) {
      expect(exampleMatchesSchema({ pixelUrl }, genericConfig)).toBe(false);
    }
    for (const schema of [
      openApiSpec.components.schemas.MarketingIntegration,
      openApiSpec.components.schemas.PublicMarketingIntegration,
    ]) {
      expect(schema.additionalProperties).toBe(false);
      expect(schema.oneOf).toEqual([
        expect.objectContaining({
          properties: expect.objectContaining({ provider: { const: 'ga4' } }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({ provider: { const: 'meta_pixel' } }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({ provider: { const: 'generic_tag' } }),
        }),
      ]);
    }
    expect(
      openApiSpec.paths['/public/events/{eventId}/marketing-integrations'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/MarketingIntegrationPage' });
  });

  it('requires public upload completion tokens without requiring them for authenticated completion', () => {
    const createUpload = openApiSpec.components.schemas.CreateUploadArtifact;
    expect(createUpload).toMatchObject({
      type: 'object',
      required: ['purpose', 'fileName', 'contentType', 'sizeBytes'],
      properties: {
        organizationId: { type: 'string' },
        brandId: { type: 'string' },
        eventId: { type: 'string' },
      },
    });
    expect(createUpload.oneOf).toHaveLength(2);
    expect(createUpload.oneOf[0]).toMatchObject({
      required: ['organizationId'],
      properties: {
        purpose: { const: 'migration_import' },
        organizationId: { type: 'string', minLength: 1 },
        sizeBytes: { type: 'integer', minimum: 1, maximum: 52_428_800 },
      },
      not: { anyOf: [{ required: ['brandId'] }, { required: ['eventId'] }] },
    });
    expect(createUpload.oneOf[1].properties.purpose.enum).not.toContain('migration_import');
    expect(createUpload.oneOf[1].not).toEqual({ required: ['organizationId'] });

    expect(openApiSpec.components.schemas.PublicCreateUploadArtifact).toMatchObject({
      required: ['fileName', 'contentType', 'sizeBytes', 'questionId'],
      properties: {
        questionId: { type: 'string', minLength: 1 },
      },
    });

    expect(openApiSpec.components.schemas.PublicCompleteUploadArtifact).toMatchObject({
      required: ['token'],
      properties: {
        token: { type: 'string', minLength: 1 },
      },
    });

    expect(
      openApiSpec.paths['/public/upload-artifacts/{artifactId}/complete'].post.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicCompleteUploadArtifact' });
    expect(
      openApiSpec.paths['/upload-artifacts/{artifactId}/complete'].post.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/CompleteUploadArtifact' });
    expect(openApiSpec.components.schemas.CompleteUploadArtifact).not.toHaveProperty('required');
    expect(openApiSpec.components.schemas.CompleteUploadArtifact.properties).not.toHaveProperty(
      'token',
    );
    expect(
      openApiSpec.paths['/upload-artifacts/{artifactId}/complete'].post.requestBody.required,
    ).toBe(false);
  });

  it('documents durable upload artifact download responses', () => {
    expect(openApiSpec.components.schemas.UploadArtifactDownload).toMatchObject({
      required: ['downloadUrl'],
      properties: {
        downloadUrl: {
          type: 'string',
          description: expect.stringContaining('durable relative API path'),
        },
        durable: { type: 'boolean' },
      },
    });
    expect(
      openApiSpec.components.schemas.UploadArtifactDownload.properties.downloadUrl,
    ).not.toHaveProperty('format');
    expect(
      openApiSpec.paths['/upload-artifacts/{artifactId}/download'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/UploadArtifactDownload' });
  });

  it('documents human-only user-avatar lifecycle authorization', () => {
    const operations = [
      openApiSpec.paths['/upload-artifacts'].post,
      openApiSpec.paths['/upload-artifacts/{artifactId}/complete'].post,
      openApiSpec.paths['/upload-artifacts/{artifactId}/download'].get,
    ];

    for (const operation of operations) {
      expect(operation.description).toContain('human user principal');
      expect(operation['x-compatibility-breaking-change']).toContain('2026-08-16');
      expect(operation['x-principal-type-restrictions']).toEqual({
        byUploadPurpose: { user_avatar: ['user'] },
      });
      expect(operation.responses['403']).toBeDefined();
    }
  });

  it('keeps offline sync outcomes in the generated schema source of truth', () => {
    expect(openApiSpec.components.schemas.ScanResult.properties.outcome.enum).toEqual([
      'accepted',
      'duplicate',
      'invalid',
      'revoked',
      'not_found',
      'wrong_event',
      'wrong_list',
    ]);
  });

  it('documents the atomic checkout-question reorder contract', () => {
    const path = openApiSpec.paths['/events/{eventId}/questions/reorder'];
    expect(path.post).toBeDefined();
    expect(path.post.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ReorderQuestionsRequest',
    });
    expect(path.post.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/QuestionPage',
    });
    expect(openApiSpec.components.schemas.ReorderQuestionsRequest).toMatchObject({
      additionalProperties: false,
      required: ['questions'],
      properties: {
        questions: expect.objectContaining({
          minItems: 1,
          items: expect.objectContaining({ additionalProperties: false }),
        }),
      },
    });
  });

  it('documents supported question update fields', () => {
    const updateSchema =
      openApiSpec.paths['/questions/{questionId}'].patch.requestBody.content['application/json']
        .schema;

    expect(updateSchema.properties).toMatchObject({
      ticketTypeId: { type: ['string', 'null'] },
      conditionalVisibility: { type: ['object', 'null'] },
    });
  });

  it('documents validation patterns on public checkout questions', () => {
    expect(
      openApiSpec.paths['/public/events/{eventId}/questions'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicQuestionsResponse' });
    expect(openApiSpec.components.schemas.PublicQuestionsResponse.properties).toMatchObject({
      buyerQuestions: {
        type: 'array',
        items: { $ref: '#/components/schemas/Question' },
      },
      attendeeQuestions: {
        type: 'array',
        items: { $ref: '#/components/schemas/Question' },
      },
    });
    expect(openApiSpec.components.schemas.Question.properties.validationPattern).toEqual({
      type: 'string',
    });
  });

  it('documents audit logging and GDPR privacy request routes', () => {
    expect(
      openApiSpec.paths['/audit-logs'].get.responses['200'].content['application/json'].schema,
    ).toEqual({
      $ref: '#/components/schemas/AuditLogPage',
    });
    expect(openApiSpec.components.schemas.PrivacyRequestInput).toMatchObject({
      required: ['organizationId', 'subjectType'],
      anyOf: [{ required: ['subjectId'] }, { required: ['subjectEmail'] }],
      properties: {
        subjectId: { type: 'string' },
        subjectEmail: { type: 'string', format: 'email' },
      },
    });
    expect(openApiSpec.paths['/privacy/data-exports'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(openApiSpec.paths['/privacy/data-exports'].post['x-required-permissions']).toEqual([
      'settings.write',
    ]);
    expect(openApiSpec.paths['/privacy/erasures'].post['x-required-permissions']).toEqual([
      'settings.write',
    ]);
    expect(
      openApiSpec.paths['/privacy/erasures'].post.requestBody.content['application/json'].schema,
    ).toEqual({
      $ref: '#/components/schemas/PrivacyRequestInput',
    });
  });

  it('documents implemented status codes and required idempotency headers', () => {
    expect(
      openApiSpec.paths['/orders/{orderId}'].get.responses['200'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/OrderDetail' });
    expect(openApiSpec.components.schemas.Order.properties).not.toHaveProperty('attendees');
    expect(openApiSpec.components.schemas.Order.properties).not.toHaveProperty('refunds');
    const orderDetailProperties = openApiSpec.components.schemas.OrderDetail.allOf[1].properties;
    expect(orderDetailProperties).toMatchObject({
      attendees: {
        type: 'array',
        items: { $ref: '#/components/schemas/Attendee' },
      },
      refunds: {
        type: 'array',
        items: { $ref: '#/components/schemas/Refund' },
      },
      checkoutAnswers: {
        type: 'object',
        properties: {
          buyerFields: { type: 'object', additionalProperties: true },
          attendeeFields: { type: 'object', additionalProperties: true },
        },
        required: ['buyerFields', 'attendeeFields'],
      },
      consentSnapshots: { type: 'object', additionalProperties: true },
      deliveryStatus: {
        type: 'object',
        properties: {
          email: { type: 'string', enum: ['pending', 'not_applicable'] },
          tickets: { type: 'string', enum: ['issued', 'not_issued'] },
        },
        required: ['email', 'tickets'],
      },
    });
    expect(openApiSpec.paths['/orders/{orderId}/refunds'].post.responses).toHaveProperty('202');
    expect(openApiSpec.paths['/orders/{orderId}/refunds'].post.responses).not.toHaveProperty('201');
    expect(openApiSpec.paths['/orders/{orderId}/refunds'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(openApiSpec.paths['/orders/{orderId}/cancel'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(openApiSpec.paths['/checkout/sessions'].post.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
  });

  it('documents the durable organization invitation contract', () => {
    const operation = openApiSpec.paths['/organizations/{organizationId}/members/invitations'].post;
    const requestSchema = operation.requestBody.content['application/json'].schema;
    const responseSchema = operation.responses['201'].content['application/json'].schema;

    expect(operation.parameters).toContainEqual({
      $ref: '#/components/parameters/RequiredIdempotencyKey',
    });
    expect(requestSchema.properties.returnTo).toMatchObject({
      type: 'string',
      maxLength: 500,
    });
    expect(
      openApiSpec.paths['/api-keys'].post.requestBody.content['application/json'].schema.properties,
    ).not.toHaveProperty('returnTo');
    expect(responseSchema.properties).toMatchObject({
      brandIds: { type: 'array', items: { type: 'string' } },
      eventIds: { type: 'array', items: { type: 'string' } },
      invitationDelivery: { type: 'string', enum: ['queued'] },
      invitationProvider: { type: 'string' },
    });
  });

  it('keeps event create/update schemas aligned with backend currency and status contracts', () => {
    const eventSchema = openApiSpec.components.schemas.Event;
    expect(eventSchema.required).toContain('currency');
    expect(eventSchema.properties).toHaveProperty('currency');
    expect(eventSchema.properties).toHaveProperty('status');
    expect(eventSchema.required).toEqual(
      expect.arrayContaining([
        'tenantId',
        'organizationId',
        'brandId',
        'minimumAge',
        'grossSalesCents',
        'ticketsSold',
        'checkIns',
        'createdAt',
        'updatedAt',
      ]),
    );
    expect(eventSchema.properties.minimumAge).toEqual({
      type: ['integer', 'null'],
      minimum: 0,
      maximum: 120,
    });

    const createSchema =
      openApiSpec.paths['/events'].post.requestBody.content['application/json'].schema;
    expect(createSchema.required).toContain('currency');
    expect(createSchema.properties).toHaveProperty('currency');
    expect(createSchema.properties).toHaveProperty('minimumAge');
    expect(
      openApiSpec.paths['/events'].post.responses['201'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/Event' });
    expect(
      openApiSpec.paths['/events/{eventId}'].get.responses['200'].content['application/json']
        .schema,
    ).toEqual({ $ref: '#/components/schemas/Event' });

    const updateSchema =
      openApiSpec.paths['/events/{eventId}'].patch.requestBody.content['application/json'].schema;
    expect(updateSchema.properties).toHaveProperty('currency');
    expect(updateSchema.properties).toHaveProperty('minimumAge');
    expect(updateSchema.properties).not.toHaveProperty('status');
    expect(openApiSpec.paths['/events/{eventId}/publish'].post.responses['200']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/pause'].post.responses['200']).toBeDefined();
    expect(openApiSpec.paths['/events/{eventId}/archive'].post.responses['200']).toBeDefined();
  });

  it('assigns a unique stable operation ID and product tag to every operation', () => {
    const operations = Object.entries(openApiSpec.paths).flatMap(([path, pathItem]) =>
      Object.entries(pathItem)
        .filter(([method]) =>
          ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method),
        )
        .map(([method, operation]) => ({ path, method, operation })),
    );
    const operationIds = operations.map(({ operation }) => operation.operationId);
    expect(
      operationIds.every(
        (operationId) => typeof operationId === 'string' && operationId.length > 0,
      ),
    ).toBe(true);
    expect(new Set(operationIds).size).toBe(operations.length);
    expect(
      operations.every(
        ({ operation }) => Array.isArray(operation.tags) && operation.tags.length > 0,
      ),
    ).toBe(true);
    expect(openApiSpec.paths['/events/{eventId}'].get).toMatchObject({
      operationId: 'getEventsByEventId',
      tags: ['Events'],
    });
  });

  it('declares anonymous, authenticated, and provider-signature security explicitly', () => {
    expect(openApiSpec.paths['/public/events/{eventId}'].get.security).toEqual([]);
    expect(openApiSpec.paths['/checkout/sessions'].post.security).toEqual([]);
    expect(openApiSpec.paths['/events'].get.security).toEqual([{ BearerAuth: [] }, { ApiKey: [] }]);
    expect(openApiSpec.paths['/webhooks/stripe'].post.security).toEqual([{ StripeSignature: [] }]);
    expect(openApiSpec.paths['/webhooks/stripe'].post.responses).toMatchObject({
      '400': {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
        },
      },
      '503': {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
        },
      },
    });
    expect(openApiSpec.components.securitySchemes).toHaveProperty('SvixSignature');
    expect(openApiSpec.components.securitySchemes).toHaveProperty('TelnyxSignature');
    expect(openApiSpec.components.securitySchemes).toHaveProperty('EmailProviderSignature');
  });

  it('documents migration credential references as write-only and scoped revocation inputs', () => {
    const create = openApiSpec.paths['/migration-credentials'].post;
    const schema = create.requestBody.content['application/json'].schema;
    const secretReferencePattern = new RegExp(schema.properties.secretReference.pattern, 'u');
    expect(schema.properties.secretReference).toMatchObject({
      type: 'string',
      writeOnly: true,
      pattern: expect.stringContaining('secretmanager'),
    });
    expect(secretReferencePattern.test('vault://team/migrations/source_api')).toBe(true);
    expect(secretReferencePattern.test('vault://team//source_api')).toBe(false);
    expect(secretReferencePattern.test('vault://team/../source_api')).toBe(false);
    expect(secretReferencePattern.test('vault://team/source_api?version=1')).toBe(false);

    const revoke = openApiSpec.paths['/migration-credentials/{credentialId}'].delete;
    expect(revoke.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'credentialId',
          in: 'path',
          required: true,
        }),
        expect.objectContaining({
          name: 'organizationId',
          in: 'query',
          required: true,
        }),
      ]),
    );
  });

  it('publishes the ordered migration adapter catalog operation', () => {
    expect(openApiSpec.paths['/migration-adapters'].get).toMatchObject({
      operationId: 'listMigrationAdapters',
      'x-required-permissions': ['migrations.read'],
    });
  });

  it('publishes reusable typed migration schemas and complete mapping contracts', () => {
    expect(openApiSpec.components.schemas.MigrationPreparationConfiguration.oneOf).toHaveLength(5);
    expect(
      openApiSpec.components.schemas.MigrationPreparationConfiguration.oneOf[0].properties
        .sourceSystem.enum,
    ).not.toContain('tixkit-portable');
    expect(openApiSpec.components.schemas.MigrationJob).toMatchObject({
      type: 'object',
    });
    const createSchema =
      openApiSpec.paths['/migration-jobs'].post.requestBody.content['application/json'].schema;
    expect(createSchema.oneOf).toHaveLength(9);
    expect(createSchema.oneOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ required: ['credentialId'] }),
        expect.objectContaining({
          properties: expect.objectContaining({ credentialId: false }),
        }),
      ]),
    );
    expect(openApiSpec.paths['/portable-migration-jobs'].post).toMatchObject({
      operationId: 'createPortableMigrationJob',
      'x-required-permissions': ['migrations.write'],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              properties: {
                sourceSystem: { const: 'tixkit-portable' },
                adapterVersion: {
                  type: 'string',
                  enum: ['tixkit-portable-bundle-v2', 'tixkit-portable-bundle-v1'],
                  default: 'tixkit-portable-bundle-v2',
                },
                configuration: {
                  properties: { artifactIds: { minItems: 1, maxItems: 1 } },
                },
              },
            },
          },
        },
      },
    });
    const mappingPost = openApiSpec.paths['/migration-mappings'].post;
    expect(mappingPost.requestBody.content['application/json'].schema).toMatchObject({
      required: ['organizationId', 'sourceSystem', 'name', 'entityType', 'mapping'],
    });
    expect(mappingPost.responses['201'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/MigrationMapping',
    });
    expect(
      openApiSpec.paths['/migration-jobs/{jobId}/report/download'].get.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/MigrationReport' });
    expect(openApiSpec.components.schemas.PortableDryRunReceipt.required).toEqual(
      expect.arrayContaining(['inputSha256', 'artifactSha256', 'signature']),
    );
    expect(openApiSpec.paths['/migration-jobs/{jobId}/portable-rebindings'].get).toMatchObject({
      operationId: 'getPortableMigrationRebindings',
      'x-required-permissions': ['migrations.read'],
    });
    expect(
      openApiSpec.paths['/migration-jobs/{jobId}/portable-rebindings/{portableId}'].put,
    ).toMatchObject({
      operationId: 'bindPortableMigrationDestination',
      'x-required-permissions': ['migrations.write'],
    });
    const portableApproval = openApiSpec.paths['/migration-jobs/{jobId}/portable-approval'].post;
    expect(portableApproval).toMatchObject({
      operationId: 'approvePortableMigrationJob',
      'x-required-permissions': ['migrations.commit'],
    });
    expect(Object.keys(portableApproval.responses)).toEqual(
      expect.arrayContaining(['201', '400', '409', '503']),
    );
    expect(
      openApiSpec.paths['/migration-jobs/{jobId}/portable-approvals/{approvalId}/revoke'].post,
    ).toMatchObject({
      operationId: 'revokePortableMigrationApproval',
      'x-required-permissions': ['migrations.commit'],
    });
    const portableCommit = openApiSpec.paths['/migration-jobs/{jobId}/commit'].post;
    expect(portableCommit.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'jobId', in: 'path' })]),
    );
    expect(portableCommit.responses).toHaveProperty('503');
    expect(portableCommit['x-compatibility-breaking-change']).toMatchObject({
      id: 'portable-final-cutover-proof-required',
      previousVersion: '2026-07-14',
    });
    expect(portableCommit.requestBody.content['application/json'].schema).toMatchObject({
      required: ['cutoverProof'],
      properties: {
        cutoverProof: { $ref: '#/components/schemas/PortableCutoverProof' },
      },
    });
    expect(openApiSpec.components.schemas.PortableCutoverProof.required).toEqual(
      expect.arrayContaining(['manifestSha256', 'sourceChangeCursor', 'nonce', 'signature']),
    );
    expect(openApiSpec.paths['/migration-jobs/{jobId}/activate'].post).toMatchObject({
      operationId: 'activatePortableMigrationJob',
      'x-required-permissions': ['migrations.commit'],
    });
    expect(openApiSpec.components.parameters.MigrationLifecycleIdempotencyKey).toMatchObject({
      required: true,
      schema: {
        minLength: 1,
        maxLength: 255,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
      },
    });
    for (const action of ['pause', 'resume', 'cancel', 'rollback'] as const) {
      const operation = openApiSpec.paths[`/migration-jobs/{jobId}/${action}`].post;
      expect(operation.parameters).toEqual(
        expect.arrayContaining([
          { $ref: '#/components/parameters/MigrationLifecycleIdempotencyKey' },
        ]),
      );
      expect(operation['x-compatibility-breaking-change']).toContain('2026-08-20');
    }
    expect(openApiSpec.components.schemas.MigrationActionAccepted).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['commandId', 'lifecycleSequence']),
      properties: {
        commandId: { type: 'string' },
        lifecycleSequence: { type: 'integer', minimum: 1 },
      },
    });
  });

  it('gives every body-bearing successful migration response a JSON schema', () => {
    for (const [path, pathItem] of Object.entries(openApiSpec.paths)) {
      if (!path.startsWith('/migration-')) continue;
      for (const operation of Object.values(pathItem)) {
        if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!status.startsWith('2') || status === '204') continue;
          const typedResponse = response as {
            content?: { 'application/json'?: { schema?: unknown } };
          };
          expect(
            typedResponse.content?.['application/json']?.schema,
            `${path} ${operation.operationId} ${status}`,
          ).toBeDefined();
        }
      }
    }
  });
});

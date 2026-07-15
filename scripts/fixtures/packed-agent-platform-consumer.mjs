import { agentSha256, installAgentProtocolSchemaKeywords } from '@tixkit/agent-protocol';
import currentAgentSchema from '@tixkit/agent-protocol/schema' with { type: 'json' };
import retainedAgentSchema from '@tixkit/agent-protocol/schemas/2026-07-22' with { type: 'json' };
import currentActionContracts from '@tixkit/agent-protocol/schemas/agent-action-contracts/2026-08-04' with { type: 'json' };
import retainedCurrentActionContracts from '@tixkit/agent-protocol/schemas/agent-action-contracts/2026-08-03' with { type: 'json' };
import retainedActionContracts from '@tixkit/agent-protocol/schemas/agent-action-contracts/2026-07-27' with { type: 'json' };
import { runAgentPlatformContract } from '@tixkit/contract-tests';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

if (
  currentAgentSchema.$id !== 'https://tixkit.com/schemas/agent-protocol/2026-08-04' ||
  retainedAgentSchema.$id !== 'https://tixkit.com/schemas/agent-protocol/2026-07-22' ||
  !currentAgentSchema.allOf.some((entry) => entry.$ref === retainedAgentSchema.$id) ||
  !currentAgentSchema.allOf.some(
    (entry) => entry.then?.properties?.autonomy?.const === 'prepare',
  ) ||
  !currentAgentSchema.allOf.some(
    (entry) => entry.if?.properties?.kind?.const === 'content.prepare',
  ) ||
  !currentAgentSchema.allOf.some(
    (entry) => entry.if?.properties?.kind?.const === 'campaign.prepare',
  ) ||
  !currentAgentSchema.allOf.some((entry) => entry.if?.properties?.kind?.const === 'report.read')
)
  throw new Error('packed agent protocol schema exports do not enforce the current contract');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
installAgentProtocolSchemaKeywords(ajv);
ajv.addSchema(retainedAgentSchema);
ajv.addSchema(retainedActionContracts);
ajv.addSchema(retainedCurrentActionContracts);
ajv.addSchema(currentActionContracts);
const validateCurrentAction = ajv.compile(currentAgentSchema);
const validateEventPreparePayload = ajv.getSchema(
  `${currentActionContracts.$id}#/$defs/eventPrepareResolvedPayload`,
);
const validateEventUpdatePayload = ajv.getSchema(
  `${currentActionContracts.$id}#/$defs/eventUpdateResolvedPayload`,
);
const validateContentPreparePayload = ajv.getSchema(
  `${currentActionContracts.$id}#/$defs/contentPrepareResolvedPayload`,
);
const validateCampaignPreparePayload = ajv.getSchema(
  `${currentActionContracts.$id}#/$defs/campaignPrepareResolvedPayload`,
);
const validateReportReadPayload = ajv.getSchema(
  `${currentActionContracts.$id}#/$defs/reportReadResolvedPayload`,
);
const validateReportReadResult = ajv.getSchema(
  `${currentActionContracts.$id}#/$defs/reportReadResult`,
);
if (
  !validateEventPreparePayload ||
  !validateEventUpdatePayload ||
  !validateContentPreparePayload ||
  !validateCampaignPreparePayload ||
  !validateReportReadPayload ||
  !validateReportReadResult
)
  throw new Error('packed agent action contracts did not expose current typed action validation');

let mutation = process.argv[2] || 'none';
const actionId = `act_${'a'.repeat(48)}`;
const approvalId = `apr_${'b'.repeat(48)}`;
const executionId = `exec_${'c'.repeat(48)}`;
const eventUpdateActionId = `act_${'f'.repeat(48)}`;
const eventUpdateApprovalId = `apr_${'d'.repeat(48)}`;
const eventUpdateExecutionId = `exec_${'e'.repeat(48)}`;
const reportReadActionId = `act_${'6'.repeat(48)}`;
const agentPrincipalId = `agt_${'1'.repeat(48)}`;
const delegationGrantId = `dlg_${'2'.repeat(48)}`;
const base = {
  protocolVersion: '2026-07-22',
  agentPrincipalId: agentPrincipalId,
  sponsorPrincipalId: 'sponsor_primary',
  delegationGrantId: delegationGrantId,
  expectedPolicyVersion: 3,
};
const initialTarget = {
  tenantId: 'tenant_primary',
  resourceType: 'event',
  resourceId: 'event_primary',
  resourceVersion: 7,
};
const target = { ...initialTarget, resourceVersion: 8 };
const projection = {
  title: 'Packed conformance event',
  description: 'Organizer-authored content.',
  status: 'draft',
  currency: 'USD',
  timezone: 'America/Chicago',
  startsAt: '2026-07-14T12:00:00.000Z',
  endsAt: '2026-07-14T12:30:00.000Z',
  visibility: 'unlisted',
  capacity: 500,
  minimumAge: null,
};
const eventSnapshotSha256 = agentSha256(projection);
const eventAction = {
  id: `act_${'e'.repeat(48)}`,
  ...base,
  kind: 'event.read',
  autonomy: 'read',
  target: { ...initialTarget, apiOperation: 'events.get' },
  payload: { eventSnapshotSha256 },
  idempotencyKey: 'agent.conformance.packed.event.read',
  preparedAt: '2026-07-14T11:58:00.000Z',
};
const reportAggregate = {
  currency: 'USD',
  grossSalesCents: 12_000,
  grossSalesByChannelCents: { online: 10_000, boxOffice: 2_000 },
  netRevenueCents: 11_000,
  refundsCents: 1_000,
  feesCents: 600,
  taxCents: 400,
  ticketsSold: 12,
  checkIns: 8,
  ordersCount: 10,
  paidOrdersCount: 9,
};
const packedReportPayload = {
  reportType: 'event_sales',
  from: '1970-01-01T00:00:00.000Z',
  to: '2026-07-14T11:58:10.000Z',
  reportSnapshotSha256: agentSha256(reportAggregate),
};
const packedReportAction = {
  id: reportReadActionId,
  ...base,
  kind: 'report.read',
  autonomy: 'read',
  target: { ...initialTarget, apiOperation: 'reports.get' },
  payload: packedReportPayload,
  idempotencyKey: 'agent.conformance.packed.report.read',
  preparedAt: '2026-07-14T11:58:15.000Z',
};
const packedReportResult = {
  resourceId: initialTarget.resourceId,
  resourceVersion: initialTarget.resourceVersion,
  ...packedReportPayload,
  observedAt: '2026-07-14T11:58:15.000Z',
  report: reportAggregate,
  untrustedContentPaths: [],
};
if (
  !validateCurrentAction(packedReportAction) ||
  !validateReportReadPayload(packedReportPayload) ||
  !validateReportReadResult(packedReportResult)
)
  throw new Error('packed agent schemas rejected a valid aggregate-only report.read action');
if (
  validateReportReadResult({
    ...packedReportResult,
    report: { ...reportAggregate, buyerEmail: 'buyer@example.test' },
  })
)
  throw new Error('packed report.read result schema accepted buyer PII');
const eventPreparePreview = {
  resourceId: 'event_primary',
  resourceVersion: 7,
  changedFields: ['description', 'title'],
  before: { description: projection.description, title: projection.title },
  after: {
    description: 'Organizer-authored prepared description.',
    title: 'Contract-prepared event',
  },
};
const eventPrepareAction = {
  id: `act_${'d'.repeat(48)}`,
  ...base,
  kind: 'event.prepare',
  autonomy: 'prepare',
  target: { ...initialTarget, apiOperation: 'events.prepare' },
  payload: {
    changePreviewSha256: agentSha256(eventPreparePreview),
    changes: eventPreparePreview.after,
  },
  idempotencyKey: 'agent.conformance.packed.event.prepare',
  preparedAt: '2026-07-14T11:58:30.000Z',
};
if (!validateCurrentAction(eventPrepareAction))
  throw new Error(
    `packed current action schema rejected valid event.prepare: ${ajv.errorsText(validateCurrentAction.errors)}`,
  );
if (
  validateCurrentAction({
    ...eventPrepareAction,
    autonomy: 'execute_with_approval',
  })
)
  throw new Error('packed current action schema accepted event.prepare autonomy escalation');
if (!validateEventPreparePayload(eventPrepareAction.payload))
  throw new Error(
    `packed action contracts rejected resolved event.prepare payload: ${ajv.errorsText(validateEventPreparePayload.errors)}`,
  );
if (
  validateEventPreparePayload({
    ...eventPrepareAction.payload,
    changes: { coverImageUrl: 'https://unowned.example/cover.jpg' },
  })
)
  throw new Error('packed action contracts accepted unowned resolved event media');
const contentPrepareActionId = `act_${'4'.repeat(48)}`;
const preparedContentDocument = {
  schemaVersion: 2,
  editor: {
    provider: '@puckeditor/core',
    data: { root: { props: {} }, content: [] },
  },
  settings: {
    locale: 'en',
    publicPath: '/e/event_primary',
    discovery: { summary: projection.description, tags: [] },
  },
};
const contentPreparePreview = {
  provider: '@puckeditor/core',
  discovery: {
    title: projection.title,
    summary: projection.description,
    tags: [],
  },
};
const contentPrepareValidation = {
  valid: true,
  severity: 'warning',
  issueCodes: [],
};
const contentPreviewSha256 = agentSha256({
  channel: 'event_page',
  content: preparedContentDocument,
  preview: contentPreparePreview,
  validation: contentPrepareValidation,
});
const contentPrepareAction = {
  id: contentPrepareActionId,
  ...base,
  kind: 'content.prepare',
  autonomy: 'prepare',
  target: { ...initialTarget, apiOperation: 'content.prepare' },
  payload: {
    channel: 'event_page',
    content: preparedContentDocument,
    preview: contentPreparePreview,
    validation: contentPrepareValidation,
    contentPreviewSha256,
  },
  idempotencyKey: 'agent.conformance.packed.content.prepare',
  preparedAt: '2026-07-14T11:58:45.000Z',
};
if (
  !validateCurrentAction(contentPrepareAction) ||
  !validateContentPreparePayload(contentPrepareAction.payload)
)
  throw new Error('packed agent schemas rejected a valid content.prepare action');
if (
  validateCurrentAction({
    ...contentPrepareAction,
    autonomy: 'execute_with_approval',
  })
)
  throw new Error('packed current action schema accepted content.prepare autonomy escalation');
const campaignPreparePayload = {
  audience: 'all',
  channel: 'email',
  requestedAttendeeIds: [],
  templateVersions: [
    {
      channel: 'email',
      templateKey: 'event-announcement',
      versionId: 'template_version_primary',
      contentSha256: '1'.repeat(64),
    },
  ],
  contentVersionSha256: agentSha256([
    {
      channel: 'email',
      templateKey: 'event-announcement',
      versionId: 'template_version_primary',
      contentSha256: '1'.repeat(64),
    },
  ]),
  audienceSnapshotSha256: '3'.repeat(64),
  exclusionSnapshotSha256: '4'.repeat(64),
  complianceResultSha256: '5'.repeat(64),
  audienceCount: 3,
  eligibleRecipientCount: 1,
  eligibleDeliveryCount: 1,
  suppressedDeliveryCount: 1,
  consentExclusionCount: 1,
  missingContactCount: 1,
};
const campaignPrepareAction = {
  id: `act_${'5'.repeat(48)}`,
  ...base,
  kind: 'campaign.prepare',
  autonomy: 'prepare',
  target: { ...initialTarget, apiOperation: 'campaigns.prepare' },
  payload: campaignPreparePayload,
  idempotencyKey: 'agent.conformance.packed.campaign.prepare',
  preparedAt: '2026-07-14T11:58:50.000Z',
};
if (
  !validateCurrentAction(campaignPrepareAction) ||
  !validateCampaignPreparePayload(campaignPreparePayload)
)
  throw new Error('packed agent schemas rejected a valid campaign.prepare action');
const eventUpdateAfter = {
  description: 'Organizer-approved updated description.',
  title: 'Contract-updated event',
};
const eventUpdatePreviewMaterial = {
  resourceId: initialTarget.resourceId,
  resourceVersion: initialTarget.resourceVersion,
  changedFields: ['description', 'title'],
  before: { description: projection.description, title: projection.title },
  after: eventUpdateAfter,
};
const eventUpdatePreview = {
  ...eventUpdatePreviewMaterial,
  changePreviewSha256: agentSha256(eventUpdatePreviewMaterial),
  observedAt: '2026-07-14T11:59:00.000Z',
  untrustedContentPaths: ['before.description', 'after.description', 'before.title', 'after.title'],
};
const eventUpdateAction = {
  id: eventUpdateActionId,
  ...base,
  kind: 'event.update',
  autonomy: 'execute_with_approval',
  target: { ...initialTarget, apiOperation: 'events.update' },
  payload: {
    changePreviewSha256: eventUpdatePreview.changePreviewSha256,
    changes: eventUpdateAfter,
  },
  idempotencyKey: 'agent.conformance.packed.event.update',
  preparedAt: '2026-07-14T11:59:00.000Z',
};
const eventUpdateActionDigest = agentSha256(eventUpdateAction);
if (
  !validateCurrentAction(eventUpdateAction) ||
  !validateEventUpdatePayload(eventUpdateAction.payload)
)
  throw new Error('packed agent schemas rejected a valid approval-bound event.update action');
const readinessAction = {
  id: `act_${'r'.repeat(48)}`,
  ...base,
  kind: 'readiness.read',
  autonomy: 'read',
  target: { ...target, apiOperation: 'events.readiness.get' },
  payload: { readinessSnapshotSha256: 'f'.repeat(64) },
  idempotencyKey: 'agent.conformance.packed.readiness',
  preparedAt: '2026-07-14T11:59:00.000Z',
};
const publishAction = {
  id: actionId,
  ...base,
  kind: 'event.publish',
  autonomy: 'execute_with_approval',
  target: { ...target, apiOperation: 'events.publish' },
  payload: { readinessSnapshotSha256: 'f'.repeat(64) },
  idempotencyKey: 'agent.conformance.packed.prepare',
  preparedAt: '2026-07-14T12:00:00.000Z',
};
const actionDigest = agentSha256(publishAction);
let planSha256 = '';
let eventCalls = 0;
let reportReadCalls = 0;
let reportReadEnvelope;
let eventPrepareCalls = 0;
let contentPrepareCalls = 0;
let campaignPrepareCalls = 0;
let eventUpdateCalls = 0;
let eventUpdateExecutionCalls = 0;
const response = (status, body) => ({
  status,
  headers: { 'cache-control': 'no-store', 'content-type': 'application/json' },
  body,
});
const execute = async (request) => {
  if (request.path === '/v1/oauth/token')
    return response(200, {
      access_token: 'agent_access_token',
      token_type: 'Bearer',
      expires_in: 600,
      scope: 'agent.invoke',
    });
  if (request.path === '/v1/agent/session')
    return response(200, {
      principal: {
        id: agentPrincipalId,
        tenantId: initialTarget.tenantId,
        sponsorPrincipalId: 'sponsor_primary',
      },
      authentication: { grantType: 'client_credentials' },
      delegationRequired: true,
    });
  if (request.path === '/v1/agent/events') {
    eventCalls += 1;
    const result = {
      resourceId: 'event_primary',
      resourceVersion: 7,
      eventSnapshotSha256,
      observedAt:
        mutation === 'replay' && eventCalls === 2
          ? '2026-07-14T11:58:01.000Z'
          : '2026-07-14T11:58:00.000Z',
      event:
        mutation === 'projection'
          ? { ...projection, title: 'Substituted event content' }
          : projection,
      untrustedContentPaths:
        mutation === 'untrusted_paths'
          ? ['event.description', 'event.title']
          : ['event.title', 'event.description'],
    };
    return response(201, {
      action: eventAction,
      actionDigest: agentSha256(eventAction),
      expiresAt: '2026-07-14T12:08:00.000Z',
      authorization: { allowed: true },
      result,
      resultSha256: mutation === 'result_digest' ? '0'.repeat(64) : agentSha256(result),
    });
  }
  if (request.path === '/v1/agent/reports') {
    reportReadCalls += 1;
    const reportMutation = mutation.startsWith('report_') ? mutation.slice('report_'.length) : '';
    const payload = {
      ...packedReportPayload,
      from: request.body.from,
      to: request.body.to,
    };
    const returnedAction = {
      ...packedReportAction,
      agentPrincipalId:
        reportMutation === 'agent' ? 'agent_substituted' : packedReportAction.agentPrincipalId,
      sponsorPrincipalId:
        reportMutation === 'sponsor'
          ? 'sponsor_substituted'
          : packedReportAction.sponsorPrincipalId,
      delegationGrantId:
        reportMutation === 'delegation'
          ? 'delegation_substituted'
          : packedReportAction.delegationGrantId,
      target: {
        ...packedReportAction.target,
        tenantId:
          reportMutation === 'tenant' ? 'tenant_substituted' : packedReportAction.target.tenantId,
        resourceId:
          reportMutation === 'resource'
            ? 'event_substituted'
            : packedReportAction.target.resourceId,
      },
      idempotencyKey:
        reportMutation === 'idempotency'
          ? 'agent.conformance.packed.substituted.report.read'
          : packedReportAction.idempotencyKey,
      payload,
    };
    const returnedResult = {
      ...packedReportResult,
      resourceId:
        reportMutation === 'resource' ? 'event_substituted' : packedReportResult.resourceId,
      ...payload,
      from: reportMutation === 'range' ? '1970-01-01T00:00:01.000Z' : payload.from,
      reportSnapshotSha256:
        reportMutation === 'digest' ? '0'.repeat(64) : payload.reportSnapshotSha256,
      observedAt:
        reportMutation === 'replay' && reportReadCalls === 2
          ? '2026-07-14T11:58:16.000Z'
          : '2026-07-14T11:58:15.000Z',
      report:
        reportMutation === 'pii'
          ? { ...reportAggregate, buyerEmail: 'buyer@example.test' }
          : reportAggregate,
    };
    reportReadEnvelope = {
      action: returnedAction,
      actionDigest:
        reportMutation === 'action_digest' ? '0'.repeat(64) : agentSha256(returnedAction),
      expiresAt: '2026-07-14T12:08:15.000Z',
      authorization: { allowed: true },
      result: returnedResult,
      resultSha256: agentSha256(returnedResult),
    };
    return response(201, reportReadEnvelope);
  }
  if (request.path === `/v1/agent/reports/${reportReadActionId}`)
    return response(200, reportReadEnvelope ?? {});
  if (request.path === '/v1/agent/event-preparations') {
    eventPrepareCalls += 1;
    const prepareMutation = mutation.startsWith('prepare_')
      ? mutation.slice('prepare_'.length)
      : '';
    const preparedResult = {
      ...eventPreparePreview,
      changePreviewSha256: eventPrepareAction.payload.changePreviewSha256,
      observedAt:
        prepareMutation === 'replay' && eventPrepareCalls === 2
          ? '2026-07-14T11:58:31.000Z'
          : '2026-07-14T11:58:30.000Z',
      after:
        prepareMutation === 'preview'
          ? {
              ...eventPreparePreview.after,
              title: 'Substituted prepared title',
            }
          : eventPreparePreview.after,
      untrustedContentPaths:
        prepareMutation === 'untrusted_paths'
          ? ['after.description', 'before.description', 'before.title', 'after.title']
          : ['before.description', 'after.description', 'before.title', 'after.title'],
    };
    return response(201, {
      action: eventPrepareAction,
      actionDigest: agentSha256(eventPrepareAction),
      expiresAt: '2026-07-14T12:08:30.000Z',
      authorization: { allowed: true },
      result: preparedResult,
      resultSha256:
        prepareMutation === 'result_digest' ? '0'.repeat(64) : agentSha256(preparedResult),
    });
  }
  if (request.path === '/v1/agent/content-preparations') {
    contentPrepareCalls += 1;
    const contentMutation = mutation.startsWith('content_')
      ? mutation.slice('content_'.length)
      : '';
    const preparedResult = {
      resourceId: initialTarget.resourceId,
      resourceVersion: initialTarget.resourceVersion,
      channel: 'event_page',
      content:
        contentMutation === 'content'
          ? { ...preparedContentDocument, settings: { locale: 'substituted' } }
          : preparedContentDocument,
      preview:
        contentMutation === 'preview'
          ? {
              ...contentPreparePreview,
              discovery: { title: 'Substituted preview' },
            }
          : contentPreparePreview,
      validation:
        contentMutation === 'validation'
          ? { ...contentPrepareValidation, issueCodes: ['substituted.warning'] }
          : contentPrepareValidation,
      contentPreviewSha256,
      observedAt:
        contentMutation === 'replay' && contentPrepareCalls === 2
          ? '2026-07-14T11:58:46.000Z'
          : '2026-07-14T11:58:45.000Z',
      untrustedContentPaths:
        contentMutation === 'untrusted_paths'
          ? ['preview.discovery', 'content']
          : ['content', 'preview.discovery'],
    };
    return response(201, {
      action: contentPrepareAction,
      actionDigest:
        contentMutation === 'action_digest' ? '0'.repeat(64) : agentSha256(contentPrepareAction),
      expiresAt: '2026-07-14T12:08:45.000Z',
      authorization: { allowed: true },
      result: preparedResult,
      resultSha256:
        contentMutation === 'result_digest' ? '0'.repeat(64) : agentSha256(preparedResult),
    });
  }
  if (request.path === '/v1/agent/campaign-preparations') {
    campaignPrepareCalls += 1;
    const result = {
      resourceId: initialTarget.resourceId,
      resourceVersion: initialTarget.resourceVersion,
      ...campaignPreparePayload,
      ...(mutation === 'campaign_compliance' ? { complianceResultSha256: '6'.repeat(64) } : {}),
      observedAt:
        mutation === 'campaign_replay' && campaignPrepareCalls === 2
          ? '2026-07-14T11:58:51.000Z'
          : '2026-07-14T11:58:50.000Z',
      untrustedContentPaths: [],
    };
    return response(201, {
      action: campaignPrepareAction,
      actionDigest:
        mutation === 'campaign_action_digest' ? '0'.repeat(64) : agentSha256(campaignPrepareAction),
      expiresAt: '2026-07-14T12:08:50.000Z',
      authorization: { allowed: true },
      result,
      resultSha256: mutation === 'campaign_result_digest' ? '0'.repeat(64) : agentSha256(result),
    });
  }
  if (request.path === '/v1/agent/event-updates') {
    eventUpdateCalls += 1;
    const returnedPreview = {
      ...eventUpdatePreview,
      ...(mutation === 'update_preview'
        ? {
            after: { ...eventUpdatePreview.after, title: 'Substituted update' },
          }
        : {}),
      ...(mutation === 'update_replay' && eventUpdateCalls === 2
        ? { observedAt: '2026-07-14T11:59:01.000Z' }
        : {}),
    };
    return response(201, {
      action: eventUpdateAction,
      actionDigest: mutation === 'update_action_digest' ? '0'.repeat(64) : eventUpdateActionDigest,
      expiresAt:
        mutation === 'update_preparation_time'
          ? '2026-07-14T12:30:00.000Z'
          : '2026-07-14T12:04:00.000Z',
      authorization: {
        eligibleForApproval: true,
        reasons: ['approval_required'],
        snapshotSha256: mutation === 'update_authorization_digest' ? 'invalid' : 'a'.repeat(64),
        checkedAt:
          mutation === 'update_authorization_time'
            ? '2026-07-14T11:58:59.000Z'
            : mutation === 'update_authorization_after_approval'
              ? '2026-07-14T12:03:00.000Z'
              : '2026-07-14T11:59:00.000Z',
        ...(mutation === 'update_authorization_shape' ? { unsafe: true } : {}),
      },
      preview: returnedPreview,
      previewSha256:
        mutation === 'update_preview_digest' ? '0'.repeat(64) : agentSha256(returnedPreview),
      ...(mutation === 'update_extra' ? { unsafe: true } : {}),
    });
  }
  if (request.path === '/v1/agent/readiness') {
    const result = {
      resourceId: 'event_primary',
      resourceVersion: target.resourceVersion,
      status: 'ready',
      readinessSnapshotSha256: 'f'.repeat(64),
      generatedAt: '2026-07-14T11:59:00.000Z',
      published: false,
      blockerReasonCodes: [],
      warningReasonCodes: [],
    };
    return response(201, {
      action: readinessAction,
      actionDigest: agentSha256(readinessAction),
      expiresAt: '2026-07-14T12:09:00.000Z',
      authorization: { allowed: true },
      dryRun: {
        launchable: true,
        readinessSnapshotSha256: 'f'.repeat(64),
        blockingReasonCodes: [],
      },
      result,
      resultSha256: agentSha256(result),
    });
  }
  if (request.path === '/v1/agent/actions')
    return response(201, {
      action: publishAction,
      actionDigest,
      expiresAt: '2026-07-14T12:10:00.000Z',
      dryRun: {
        launchable: true,
        readinessSnapshotSha256: 'f'.repeat(64),
        blockingReasonCodes: [],
      },
    });
  if (request.path === '/v1/agent/plans' && request.method === 'POST') {
    const definition = request.body.definition;
    planSha256 = definition.planSha256;
    return response(201, {
      definition,
      state: { status: 'prepared', stateVersion: 1 },
      actionBindings: [{ stepId: 'publish_event', actionId }],
    });
  }
  if (request.path.endsWith('/transitions')) {
    const status = request.body.status;
    return response(200, {
      state: { status, stateVersion: status === 'awaiting_approval' ? 2 : 3 },
    });
  }
  if (request.path === `/v1/agent/event-updates/${eventUpdateActionId}/approvals`)
    return response(201, {
      id: eventUpdateApprovalId,
      tenantId: initialTarget.tenantId,
      actionDigest: eventUpdateActionDigest,
      approverPrincipalId: base.sponsorPrincipalId,
      approverPermissionSnapshot:
        mutation === 'update_approval' ? ['events:publish'] : ['events:write'],
      policyVersion: 3,
      approvedAt: '2026-07-14T11:59:15.000Z',
      expiresAt: '2026-07-14T12:03:00.000Z',
      ...(mutation === 'update_approval_extra' ? { planSha256: '9'.repeat(64) } : {}),
    });
  if (
    request.path === `/v1/agent/actions/${contentPrepareActionId}/approvals` ||
    request.path === `/v1/agent/actions/${contentPrepareActionId}/executions` ||
    request.path === `/v1/agent/actions/${reportReadActionId}/approvals` ||
    request.path === `/v1/agent/actions/${reportReadActionId}/executions` ||
    request.path === `/v1/agent/actions/${campaignPrepareAction.id}/approvals` ||
    request.path === `/v1/agent/actions/${campaignPrepareAction.id}/executions`
  )
    return response(404, { code: 'AGENT_ACTION_NOT_FOUND' });
  if (request.path.endsWith('/approvals'))
    return response(201, {
      id: approvalId,
      tenantId: target.tenantId,
      actionDigest,
      planSha256,
      approverPrincipalId: base.sponsorPrincipalId,
      approverPermissionSnapshot: ['events:publish'],
      policyVersion: 3,
      approvedAt: '2026-07-14T12:01:00.000Z',
      expiresAt: '2026-07-14T12:04:00.000Z',
    });
  if (request.path === `/v1/agent/event-updates/${eventUpdateActionId}/executions`) {
    eventUpdateExecutionCalls += 1;
    return response(200, {
      id: eventUpdateExecutionId,
      ...(mutation === 'update_execution_envelope' ? {} : { tenantId: initialTarget.tenantId }),
      state: 'succeeded',
      actionId: eventUpdateActionId,
      actionDigest: eventUpdateActionDigest,
      approvalId: eventUpdateApprovalId,
      agentPrincipalId: base.agentPrincipalId,
      sponsorPrincipalId: base.sponsorPrincipalId,
      delegationGrantId: base.delegationGrantId,
      idempotencyKey: '7'.repeat(64),
      requestFingerprint: '8'.repeat(64),
      resourceVersion: initialTarget.resourceVersion,
      policyVersion: base.expectedPolicyVersion,
      fenceToken: 1,
      result: {
        resourceId: initialTarget.resourceId,
        resourceVersion: 8,
        status: mutation === 'update_result' ? 'published' : 'updated',
      },
      createdAt:
        mutation === 'update_execution_time'
          ? '2026-07-14T11:59:14.000Z'
          : mutation === 'update_execution_at_expiry'
            ? '2026-07-14T12:03:00.000Z'
            : '2026-07-14T11:59:16.000Z',
      updatedAt:
        mutation === 'update_execution_replay' && eventUpdateExecutionCalls === 2
          ? '2026-07-14T11:59:18.000Z'
          : '2026-07-14T11:59:17.000Z',
      ...(mutation === 'update_execution_extra' ? { planSha256: '9'.repeat(64) } : {}),
    });
  }
  if (request.path.endsWith('/executions'))
    return response(200, {
      id: executionId,
      state: 'succeeded',
      planSha256,
      actionId,
      actionDigest,
      approvalId,
      ...base,
      result: {
        resourceId: 'event_primary',
        resourceVersion: 9,
        status: 'published',
      },
    });
  if (request.path.endsWith(`/${executionId}`)) {
    const binding = {
      planSha256,
      actionId,
      actionDigest,
      approvalId,
      agentPrincipalId: base.agentPrincipalId,
      sponsorPrincipalId: base.sponsorPrincipalId,
      delegationGrantId: base.delegationGrantId,
    };
    return response(200, {
      execution: { id: executionId, ...binding },
      audit: ['prepared', 'authorized', 'started', 'succeeded'].map((phase) => ({
        phase,
        ...binding,
      })),
    });
  }
  return response(404, {});
};

const contractInput = {
  apiVersion: '2026-08-08',
  sponsorAccessToken: 'sponsor_token',
  agentClientId: `tk_agent_${'e'.repeat(48)}`,
  agentClientSecret: 'secret_value',
  delegationGrantId: base.delegationGrantId,
  resourceId: target.resourceId,
  campaignEmailTemplateKey: 'event-announcement',
  planId: 'plan_conformance_packed',
  idempotencyPrefix: 'agent.conformance.packed',
  execute,
};
const reportMutationProofs = [];
if (mutation === 'none') {
  for (const reportMutation of [
    'agent',
    'sponsor',
    'delegation',
    'resource',
    'tenant',
    'idempotency',
    'action_digest',
    'digest',
    'range',
    'pii',
    'replay',
  ]) {
    mutation = `report_${reportMutation}`;
    eventCalls = 0;
    reportReadCalls = 0;
    reportReadEnvelope = undefined;
    const mutationResult = await runAgentPlatformContract(contractInput);
    if (
      mutationResult.ok !== false ||
      !mutationResult.findings.some(
        (finding) => finding.code === 'AGENT_PLATFORM_REPORT_READ_SCHEMA',
      )
    )
      throw new Error(`packed report.read ${reportMutation} mutation did not fail closed`);
    reportMutationProofs.push(reportMutation);
  }
  mutation = 'none';
  eventCalls = 0;
  reportReadCalls = 0;
  reportReadEnvelope = undefined;
}
const result = await runAgentPlatformContract(contractInput);
if (
  mutation === 'none' &&
  (result.ok !== true || reportReadCalls !== 2 || reportMutationProofs.length !== 11)
)
  throw new Error('packed report.read happy path or fail-closed mutation proof is incomplete');
process.stdout.write(
  JSON.stringify({
    result,
    eventCalls,
    reportReadCalls,
    reportMutationProofs,
    eventPrepareCalls,
    contentPrepareCalls,
    campaignPrepareCalls,
    eventUpdateCalls,
    eventUpdateExecutionCalls,
  }),
);

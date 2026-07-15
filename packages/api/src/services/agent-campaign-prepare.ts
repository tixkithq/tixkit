import { agentSha256 } from '@tixkit/agent-protocol';
import { ContentRepository, type Database } from '@tixkit/db';
import {
  resolveMessageAudience,
  type MessageAudience,
  type MessageChannel,
  type MessageChannelDecision,
} from './message-audience.js';

export interface AgentCampaignPrepareInput {
  db: Database;
  tenantId: string;
  event: {
    id: string;
    brandId: string;
  };
  audience: MessageAudience;
  attendeeIds?: readonly string[];
  channel: MessageChannel;
  emailTemplateKey?: string;
  smsTemplateKey?: string;
}

export interface AgentCampaignTemplateVersion extends Readonly<Record<string, unknown>> {
  channel: 'email' | 'sms';
  templateKey: string;
  versionId: string;
  contentSha256: string;
}

export interface AgentCampaignPrepareProjection extends Readonly<Record<string, unknown>> {
  audience: MessageAudience;
  channel: MessageChannel;
  requestedAttendeeIds: readonly string[];
  templateVersions: readonly AgentCampaignTemplateVersion[];
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
}

function assertTemplateKey(value: string | undefined, channel: 'email' | 'sms'): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))
    throw new Error(`AGENT_ACTION_CAMPAIGN_${channel.toUpperCase()}_TEMPLATE_INVALID`);
  return value;
}

function decisionProjection(channel: 'email' | 'sms', decision: MessageChannelDecision) {
  const reasonCodes =
    decision.status === 'eligible'
      ? []
      : decision.status === 'missing_contact'
        ? [`${channel}.missing_contact`]
        : [
            ...(decision.consentExcluded ? [`${channel}.consent_required`] : []),
            ...(decision.suppressionExcluded ? [`${channel}.suppressed`] : []),
          ].sort();
  return {
    attendeeId: decision.attendee.id,
    channel,
    status: decision.status,
    reasonCodes,
    consentEvidence: decision.consentEvidence,
    suppressionEvidence: decision.suppressionEvidence,
  } as const;
}

export async function prepareAgentCampaign(
  input: AgentCampaignPrepareInput,
): Promise<AgentCampaignPrepareProjection> {
  if (input.audience === 'specific' && (!input.attendeeIds || input.attendeeIds.length === 0))
    throw new Error('AGENT_ACTION_CAMPAIGN_AUDIENCE_INVALID');
  const requestedAttendeeIds = [...new Set(input.attendeeIds ?? [])].sort();
  if (
    requestedAttendeeIds.length > 1_000 ||
    requestedAttendeeIds.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/u.test(id))
  )
    throw new Error('AGENT_ACTION_CAMPAIGN_AUDIENCE_INVALID');

  const contentRepository = new ContentRepository(input.db);
  const templateVersions: AgentCampaignTemplateVersion[] = [];
  if (input.channel === 'email' || input.channel === 'both') {
    const templateKey = assertTemplateKey(input.emailTemplateKey, 'email');
    const published = await contentRepository.findPublishedEmailTemplate({
      tenantId: input.tenantId,
      brandId: input.event.brandId,
      eventId: input.event.id,
      key: templateKey,
    });
    if (!published?.version.id) throw new Error('AGENT_ACTION_CAMPAIGN_EMAIL_TEMPLATE_UNAVAILABLE');
    templateVersions.push({
      channel: 'email',
      templateKey,
      versionId: published.version.id,
      contentSha256: agentSha256(published.version.contentJson),
    });
  }
  if (input.channel === 'sms' || input.channel === 'both') {
    const templateKey = assertTemplateKey(input.smsTemplateKey, 'sms');
    const published = await contentRepository.findPublishedSmsTemplate({
      tenantId: input.tenantId,
      brandId: input.event.brandId,
      eventId: input.event.id,
      key: templateKey,
    });
    if (!published?.version.id) throw new Error('AGENT_ACTION_CAMPAIGN_SMS_TEMPLATE_UNAVAILABLE');
    templateVersions.push({
      channel: 'sms',
      templateKey,
      versionId: published.version.id,
      contentSha256: agentSha256(published.version.contentJson),
    });
  }
  templateVersions.sort((left, right) => left.channel.localeCompare(right.channel));

  const resolution = await resolveMessageAudience({
    db: input.db,
    tenantId: input.tenantId,
    eventId: input.event.id,
    audience: input.audience,
    attendeeIds: requestedAttendeeIds,
    channel: input.channel,
  });
  if (resolution.attendees.length === 0) throw new Error('AGENT_ACTION_CAMPAIGN_AUDIENCE_EMPTY');

  const decisions = [
    ...resolution.emailDecisions.map((decision) => decisionProjection('email', decision)),
    ...resolution.smsDecisions.map((decision) => decisionProjection('sms', decision)),
  ].sort(
    (left, right) =>
      left.attendeeId.localeCompare(right.attendeeId) || left.channel.localeCompare(right.channel),
  );
  const matchedAttendeeIds = resolution.attendees.map((attendee) => attendee.id).sort();
  const eligibleAttendeeIds = resolution.eligibleRecipients.map((attendee) => attendee.id).sort();
  const contentVersionSha256 = agentSha256(templateVersions);
  const audienceSnapshotSha256 = agentSha256({
    audience: input.audience,
    requestedAttendeeIds,
    matchedAttendeeIds,
  });
  const excludedDecisions = decisions.filter((decision) => decision.status !== 'eligible');
  const exclusionSnapshotSha256 = agentSha256(excludedDecisions);
  const complianceResultSha256 = agentSha256({
    policy: 'tixkit.campaign-consent-suppression.v1',
    channel: input.channel,
    audienceSnapshotSha256,
    exclusionSnapshotSha256,
    eligibleAttendeeIds,
    decisions,
  });

  return {
    audience: input.audience,
    channel: input.channel,
    requestedAttendeeIds,
    templateVersions,
    contentVersionSha256,
    audienceSnapshotSha256,
    exclusionSnapshotSha256,
    complianceResultSha256,
    audienceCount: resolution.attendees.length,
    eligibleRecipientCount: resolution.eligibleRecipients.length,
    eligibleDeliveryCount: decisions.filter((decision) => decision.status === 'eligible').length,
    suppressedDeliveryCount: decisions.filter((decision) => decision.status === 'suppressed')
      .length,
    consentExclusionCount: decisions.filter((decision) =>
      decision.reasonCodes.some((code) => code.endsWith('.consent_required')),
    ).length,
    missingContactCount: decisions.filter((decision) => decision.status === 'missing_contact')
      .length,
  };
}

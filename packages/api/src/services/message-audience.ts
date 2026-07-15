import { agentSha256 } from '@tixkit/agent-protocol';
import { EmailSuppressionRepository, MessageConsentRepository, type Database } from '@tixkit/db';

export type MessageAudience = 'all' | 'checked_in' | 'not_checked_in' | 'specific';
export type MessageChannel = 'email' | 'sms' | 'both';

export type MessageAttendee = {
  id: string;
  event_id?: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
};

export type MessageConsentEvidence = {
  recordId: string;
  consentVersion: string;
  consentedAt: string;
  consentTextSha256: string;
};

export type MessageSuppressionEvidence = {
  recordId: string;
  reason: string;
  bounceType: string | null;
  source: string;
  createdAt: string;
};

export type MessageChannelDecision = (
  | {
      status: 'eligible';
      attendee: MessageAttendee;
      consentExcluded: false;
      suppressionExcluded: false;
    }
  | {
      status: 'suppressed';
      attendee: MessageAttendee;
      consentExcluded: boolean;
      suppressionExcluded: boolean;
    }
  | {
      status: 'missing_contact';
      attendee: MessageAttendee;
      consentExcluded: false;
      suppressionExcluded: false;
    }
) & {
  consentEvidence: MessageConsentEvidence | null;
  suppressionEvidence: MessageSuppressionEvidence | null;
};

function canonicalTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('MESSAGE_COMPLIANCE_EVIDENCE_INVALID');
  return date.toISOString();
}

function consentEvidence(consent: {
  id: string;
  consent_version: string;
  consented_at: Date | string;
  consent_text: string;
}): MessageConsentEvidence {
  return {
    recordId: consent.id,
    consentVersion: consent.consent_version,
    consentedAt: canonicalTimestamp(consent.consented_at),
    consentTextSha256: agentSha256(consent.consent_text),
  };
}

function suppressionEvidence(suppression: {
  id: string;
  reason: string;
  bounce_type: string | null;
  source: string;
  created_at: Date | string;
}): MessageSuppressionEvidence {
  return {
    recordId: suppression.id,
    reason: suppression.reason,
    bounceType: suppression.bounce_type,
    source: suppression.source,
    createdAt: canonicalTimestamp(suppression.created_at),
  };
}

async function loadMessageAudienceAttendees(input: {
  db: Database;
  tenantId: string;
  eventId: string;
  audience: MessageAudience;
  attendeeIds?: string[];
}): Promise<MessageAttendee[]> {
  let attendeeQuery = input.db
    .selectFrom('attendees')
    .select(['id', 'tenant_id', 'event_id', 'first_name', 'last_name', 'email', 'phone', 'status'])
    .where('tenant_id', '=', input.tenantId)
    .where('event_id', '=', input.eventId)
    .where('status', 'in', ['confirmed', 'checked_in']);

  if (input.audience === 'checked_in') {
    attendeeQuery = attendeeQuery.where('status', '=', 'checked_in');
  } else if (input.audience === 'not_checked_in') {
    attendeeQuery = attendeeQuery.where('status', '=', 'confirmed');
  } else if (input.audience === 'specific') {
    attendeeQuery = attendeeQuery.where('id', 'in', input.attendeeIds ?? []);
  }

  const rows = await attendeeQuery.execute();
  const requested = new Set(input.attendeeIds ?? []);
  return rows
    .filter(
      (attendee) =>
        typeof attendee.id === 'string' &&
        (typeof attendee.tenant_id !== 'string' || attendee.tenant_id === input.tenantId) &&
        (typeof attendee.event_id !== 'string' || attendee.event_id === input.eventId) &&
        (attendee.status === 'confirmed' || attendee.status === 'checked_in') &&
        (input.audience !== 'specific' || requested.has(attendee.id)) &&
        (input.audience !== 'checked_in' || attendee.status === 'checked_in') &&
        (input.audience !== 'not_checked_in' || attendee.status === 'confirmed'),
    )
    .map((attendee) => ({
      id: attendee.id,
      event_id: attendee.event_id,
      first_name: attendee.first_name ?? null,
      last_name: attendee.last_name ?? null,
      email: attendee.email ?? null,
      phone: attendee.phone ?? null,
      status: attendee.status,
    }));
}

export async function resolveMessageAudience(input: {
  db: Database;
  tenantId: string;
  eventId: string;
  audience: MessageAudience;
  attendeeIds?: string[];
  channel: MessageChannel;
}) {
  const attendees = await loadMessageAudienceAttendees(input);
  const consents = await new MessageConsentRepository(input.db).findActiveByAttendeeIds(
    input.tenantId,
    attendees.map((attendee) => attendee.id),
  );
  const consentByAttendee = new Map<string, (typeof consents)[number]>();
  const consentsByAttendee = new Map<string, Array<(typeof consents)[number]>>();
  for (const consent of consents) {
    if (!consentByAttendee.has(consent.attendee_id)) {
      consentByAttendee.set(consent.attendee_id, consent);
    }
    const attendeeConsents = consentsByAttendee.get(consent.attendee_id) ?? [];
    attendeeConsents.push(consent);
    consentsByAttendee.set(consent.attendee_id, attendeeConsents);
  }

  const emailSuppressionByAttendee = new Map<
    string,
    NonNullable<Awaited<ReturnType<EmailSuppressionRepository['findByEmail']>>>
  >();
  if (input.channel === 'email' || input.channel === 'both') {
    const suppressionRepository = new EmailSuppressionRepository(input.db);
    const suppressions = await Promise.all(
      attendees.map(async (attendee) => {
        if (!attendee.email) return undefined;
        const suppression = await suppressionRepository.findByEmail(input.tenantId, attendee.email);
        return suppression ? { attendeeId: attendee.id, suppression } : undefined;
      }),
    );
    for (const result of suppressions) {
      if (result) emailSuppressionByAttendee.set(result.attendeeId, result.suppression);
    }
  }

  let skippedRecipients = 0;
  let suppressedRecipients = 0;
  let consentExclusions = 0;
  const eligibleRecipientIds = new Set<string>();
  const emailDecisions: MessageChannelDecision[] = [];
  const smsDecisions: MessageChannelDecision[] = [];
  for (const attendee of attendees) {
    const attendeeConsents = consentsByAttendee.get(attendee.id) ?? [];
    const emailConsent = attendee.email
      ? attendeeConsents.find(
          (consent) => consent.email.trim().toLowerCase() === attendee.email!.trim().toLowerCase(),
        )
      : undefined;
    const smsConsent = attendee.phone
      ? attendeeConsents.find((consent) => consent.phone?.trim() === attendee.phone!.trim())
      : undefined;
    const emailSuppression = emailSuppressionByAttendee.get(attendee.id);
    if (input.channel === 'email' || input.channel === 'both') {
      if (!attendee.email) {
        skippedRecipients += 1;
        emailDecisions.push({
          attendee,
          status: 'missing_contact',
          consentExcluded: false,
          suppressionExcluded: false,
          consentEvidence: null,
          suppressionEvidence: null,
        });
      } else if (!emailConsent?.email_opt_in || emailConsent.revoked_at || emailSuppression) {
        const consentExcluded = !emailConsent?.email_opt_in || Boolean(emailConsent.revoked_at);
        const suppressionExcluded = emailSuppressionByAttendee.has(attendee.id);
        suppressedRecipients += 1;
        consentExclusions += consentExcluded ? 1 : 0;
        emailDecisions.push({
          attendee,
          status: 'suppressed',
          consentExcluded,
          suppressionExcluded,
          consentEvidence: emailConsent ? consentEvidence(emailConsent) : null,
          suppressionEvidence: emailSuppression ? suppressionEvidence(emailSuppression) : null,
        });
      } else {
        eligibleRecipientIds.add(attendee.id);
        emailDecisions.push({
          attendee,
          status: 'eligible',
          consentExcluded: false,
          suppressionExcluded: false,
          consentEvidence: consentEvidence(emailConsent),
          suppressionEvidence: null,
        });
      }
    }
    if (input.channel === 'sms' || input.channel === 'both') {
      if (!attendee.phone) {
        skippedRecipients += 1;
        smsDecisions.push({
          attendee,
          status: 'missing_contact',
          consentExcluded: false,
          suppressionExcluded: false,
          consentEvidence: null,
          suppressionEvidence: null,
        });
      } else if (!smsConsent?.sms_opt_in || smsConsent.revoked_at) {
        suppressedRecipients += 1;
        consentExclusions += 1;
        smsDecisions.push({
          attendee,
          status: 'suppressed',
          consentExcluded: true,
          suppressionExcluded: false,
          consentEvidence: smsConsent ? consentEvidence(smsConsent) : null,
          suppressionEvidence: null,
        });
      } else {
        eligibleRecipientIds.add(attendee.id);
        smsDecisions.push({
          attendee,
          status: 'eligible',
          consentExcluded: false,
          suppressionExcluded: false,
          consentEvidence: consentEvidence(smsConsent),
          suppressionEvidence: null,
        });
      }
    }
  }

  return {
    attendees,
    consentByAttendee,
    emailSuppressionByAttendee,
    emailDecisions,
    smsDecisions,
    eligibleRecipients: attendees.filter((attendee) => eligibleRecipientIds.has(attendee.id)),
    skippedRecipients,
    suppressedRecipients,
    consentExclusions,
  };
}

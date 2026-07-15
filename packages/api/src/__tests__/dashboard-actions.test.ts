import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { DashboardAction } from '@tixkit/domain';
import {
  compareDashboardActions,
  decodeDashboardActionCursor,
} from '../services/dashboard-actions.js';

const cursorSigningKey = 'unit-dashboard-cursor-signing-key-32-bytes';

function signedCursor(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', cursorSigningKey).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function action(input: {
  id: string;
  severity: DashboardAction['severity'];
  deadlineAt: string | null;
  overdue?: boolean;
}): DashboardAction {
  return {
    id: input.id,
    sourceType: 'event_operations',
    resource: {
      type: 'event',
      organizationId: 'org_1',
      brandId: 'brd_1',
      eventId: 'evt_1',
      eventVersion: 1,
      eventTitle: 'Event',
    },
    severity: input.severity,
    owner: 'organizer',
    deadlineAt: input.deadlineAt,
    deadlinePolicy: input.deadlineAt === null ? 'none' : 'event_start',
    overdue: input.overdue ?? false,
    occurrenceCount: 1,
    reasonCode: 'event_sales_paused',
    remediation: {
      id: 'review_paused_event',
      readinessActionId: 'view_event',
      requiredPermission: 'events.write',
      canRemediate: true,
      availability: 'available',
    },
    staleness: {
      state: 'current',
      consistency: 'repeatable_read',
      evaluatedAt: '2027-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:05:00.000Z',
      sourceUpdatedAt: '2027-01-01T00:00:00.000Z',
      sourceVersion: 1,
      evidenceRevision: 'a'.repeat(64),
    },
  };
}

describe('dashboard action ordering and cursors', () => {
  it('orders by severity, overdue state, deadline, then stable id', () => {
    const actions = [
      action({ id: 'low', severity: 'low', deadlineAt: '2027-02-01T00:00:00.000Z' }),
      action({ id: 'high-no-deadline', severity: 'high', deadlineAt: null }),
      action({
        id: 'critical-future',
        severity: 'critical',
        deadlineAt: '2027-01-02T00:00:00.000Z',
      }),
      action({
        id: 'critical-overdue',
        severity: 'critical',
        deadlineAt: '2027-01-03T00:00:00.000Z',
        overdue: true,
      }),
    ];
    expect(actions.sort(compareDashboardActions).map((item) => item.id)).toEqual([
      'critical-overdue',
      'critical-future',
      'high-no-deadline',
      'low',
    ]);
  });

  it('rejects malformed and unsupported cursors', () => {
    expect(() => decodeDashboardActionCursor('not-base64-json', cursorSigningKey)).toThrow(
      'Dashboard action cursor is invalid',
    );
    const unsupported = signedCursor({ version: 2, asOf: new Date().toISOString() });
    expect(() => decodeDashboardActionCursor(unsupported, cursorSigningKey)).toThrow(
      'Dashboard action cursor is invalid',
    );
    const missingRevision = signedCursor({ version: 1, asOf: '2027-01-01T00:00:00.000Z' });
    expect(() => decodeDashboardActionCursor(missingRevision, cursorSigningKey)).toThrow(
      'Dashboard action cursor is invalid',
    );
  });

  it('decodes a versioned cursor bound to its source revision', () => {
    const encoded = signedCursor({
      version: 1,
      asOf: '2027-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:05:00.000Z',
      scopeDigest: 'b'.repeat(64),
      scopeRevision: 'a'.repeat(64),
      event: { startsAt: '2027-01-02T00:00:00.000Z', id: 'evt_1' },
      export: { id: 'evt_2' },
    });
    expect(decodeDashboardActionCursor(encoded, cursorSigningKey)).toMatchObject({
      version: 1,
      scopeDigest: 'b'.repeat(64),
      scopeRevision: 'a'.repeat(64),
      event: { id: 'evt_1' },
      export: { id: 'evt_2' },
    });
  });

  it('rejects payload and signature tampering', () => {
    const cursor = signedCursor({
      version: 1,
      asOf: '2027-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T00:05:00.000Z',
      scopeDigest: 'b'.repeat(64),
      scopeRevision: 'a'.repeat(64),
    });
    const [payload, signature] = cursor.split('.');
    expect(() => decodeDashboardActionCursor(`${payload}x.${signature}`, cursorSigningKey)).toThrow(
      'Dashboard action cursor is invalid',
    );
    expect(() =>
      decodeDashboardActionCursor(`${payload}.${signature?.slice(0, -1)}x`, cursorSigningKey),
    ).toThrow('Dashboard action cursor is invalid');
  });
});

import { describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { EventReadinessAcknowledgementRepository } from '../../repositories/readiness.js';

type Row = Record<string, unknown>;

function createDb(seed: Row[]) {
  const rows = [...seed];
  const matches = (row: Row, conditions: Array<[string, unknown]>) =>
    conditions.every(([column, value]) => row[column] === value);
  const db = {
    selectFrom() {
      const conditions: Array<[string, unknown]> = [];
      const query = {
        selectAll: () => query,
        where(column: string, _operator: string, value: unknown) {
          conditions.push([column, value]);
          return query;
        },
        execute: async () => rows.filter((row) => matches(row, conditions)),
      };
      return query;
    },
    deleteFrom() {
      const conditions: Array<[string, unknown]> = [];
      const query = {
        where(column: string, _operator: string, value: unknown) {
          conditions.push([column, value]);
          return query;
        },
        async executeTakeFirst() {
          const before = rows.length;
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (matches(rows[index]!, conditions)) rows.splice(index, 1);
          }
          return { numDeletedRows: BigInt(before - rows.length) };
        },
        async execute() {
          return [await query.executeTakeFirst()];
        },
      };
      return query;
    },
    insertInto() {
      return {
        values(value: Row) {
          const builder = {
            onConflict(callback: (conflict: unknown) => unknown) {
              const conflict = {
                columns: () => ({ doUpdateSet: () => conflict }),
              };
              callback(conflict);
              return builder;
            },
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => {
                const existing = rows.find(
                  (row) =>
                    row.tenant_id === value.tenant_id &&
                    row.organization_id === value.organization_id &&
                    row.brand_id === value.brand_id &&
                    row.event_id === value.event_id &&
                    row.step_id === value.step_id,
                );
                if (existing) {
                  Object.assign(existing, value, { id: existing.id });
                  return existing;
                }
                rows.push(value);
                return value;
              },
            }),
            execute: async () => {
              rows.push(value);
            },
          };
          return builder;
        },
      };
    },
    transaction() {
      return { execute: (callback: (trx: unknown) => unknown) => callback(db) };
    },
  };
  return { db: db as unknown as Database, rows };
}

describe('EventReadinessAcknowledgementRepository', () => {
  const scope = {
    tenantId: 'ten_1',
    organizationId: 'org_1',
    brandId: 'brd_1',
    eventId: 'evt_1',
  };

  it('replaces only the acknowledgement in the exact tenant/org/brand/event scope', async () => {
    const otherTenant = {
      id: 'era_other',
      tenant_id: 'ten_2',
      organization_id: 'org_2',
      brand_id: 'brd_2',
      event_id: 'evt_2',
      step_id: 'preview_review',
      step_version: 1,
      subject_fingerprint: 'a'.repeat(64),
      actor_id: 'usr_2',
      acknowledged_at: new Date(0),
    };
    const { db, rows } = createDb([
      otherTenant,
      {
        ...otherTenant,
        id: 'era_old',
        tenant_id: scope.tenantId,
        organization_id: scope.organizationId,
        brand_id: scope.brandId,
        event_id: scope.eventId,
        subject_fingerprint: 'b'.repeat(64),
      },
    ]);
    const repository = new EventReadinessAcknowledgementRepository(db);

    await repository.acknowledge(scope, {
      stepId: 'preview_review',
      stepVersion: 1,
      subjectFingerprint: 'c'.repeat(64),
      actorId: 'usr_1',
    });

    expect(rows).toContainEqual(otherTenant);
    expect(await repository.findByEvent(scope)).toEqual([
      expect.objectContaining({
        tenant_id: 'ten_1',
        event_id: 'evt_1',
        subject_fingerprint: 'c'.repeat(64),
      }),
    ]);
  });

  it('deletes only an exactly scoped step', async () => {
    const row = {
      id: 'era_1',
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      brand_id: scope.brandId,
      event_id: scope.eventId,
      step_id: 'checkout_consent',
      step_version: 1,
      subject_fingerprint: 'd'.repeat(64),
      actor_id: 'usr_1',
      acknowledged_at: new Date(0),
    };
    const { db } = createDb([row, { ...row, id: 'era_2', tenant_id: 'ten_2' }]);
    const repository = new EventReadinessAcknowledgementRepository(db);

    expect(await repository.delete(scope, 'checkout_consent')).toBe(true);
    expect(await repository.findByEvent(scope)).toEqual([]);
  });
});

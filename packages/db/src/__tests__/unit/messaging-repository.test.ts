import { describe, expect, it } from 'vitest';
import type { Database } from '../../client.js';
import { SmsProviderRouteRepository } from '../../repositories/messaging.js';

type Row = Record<string, unknown>;
type WhereCall = [string, string, unknown?];

function rowMatchesWhereCalls(row: Row, calls: WhereCall[]) {
  return calls.every(([column, op, value]) => {
    if (op === '=') return row[column] === value;
    if (op === 'is') return value === null ? row[column] === null : row[column] === value;
    return false;
  });
}

function createMessagingDb(input: { smsSenderIdentities: Row[] }) {
  const inserted: Record<string, Row[]> = {
    sms_provider_routes: [],
  };

  function rows(table: string) {
    if (table === 'sms_sender_identities') return input.smsSenderIdentities;
    if (table === 'sms_provider_routes') return inserted.sms_provider_routes;
    return [];
  }

  const db = {
    selectFrom(table: string) {
      const calls: WhereCall[] = [];
      const query = {
        selectAll() {
          return query;
        },
        where(column: string, op: string, value?: unknown) {
          calls.push([column, op, value]);
          return query;
        },
        async executeTakeFirst() {
          return rows(table).find((row) => rowMatchesWhereCalls(row, calls));
        },
        async executeTakeFirstOrThrow() {
          const row = await query.executeTakeFirst();
          if (!row) throw new Error(`No row for ${table}`);
          return row;
        },
      };
      return query;
    },
    insertInto(table: 'sms_provider_routes') {
      return {
        values(value: Row) {
          const row = { ...value };
          return {
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => {
                inserted[table].push(row);
                return row;
              },
            }),
            execute: async () => {
              inserted[table].push(row);
            },
          };
        },
      };
    },
  } as unknown as Database;

  return { db, inserted };
}

const routeInput = {
  tenantId: 'tnt_1',
  brandId: 'brd_1',
  providerType: 'capture',
  credentialsRef: 'secret://sms/capture',
  senderIdentityId: 'ssi_1',
  priority: 0,
  isFallback: false,
  allowedCategories: ['bulk'],
  webhookUrl: 'https://api.example.test/webhooks/sms',
};

describe('SmsProviderRouteRepository', () => {
  it('rejects route creation when the sender identity belongs to another brand', async () => {
    const { db, inserted } = createMessagingDb({
      smsSenderIdentities: [
        {
          id: 'ssi_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_other',
        },
      ],
    });
    const repo = new SmsProviderRouteRepository(db);

    await expect(repo.create(routeInput)).rejects.toThrow(
      'SMS provider route sender identity must belong to the same tenant and brand',
    );
    expect(inserted.sms_provider_routes).toHaveLength(0);
  });

  it('creates routes only when the sender identity matches the route tenant and brand', async () => {
    const { db, inserted } = createMessagingDb({
      smsSenderIdentities: [
        {
          id: 'ssi_1',
          tenant_id: 'tnt_1',
          brand_id: 'brd_1',
        },
      ],
    });
    const repo = new SmsProviderRouteRepository(db);

    const route = await repo.create(routeInput);

    expect(route).toMatchObject({
      tenant_id: 'tnt_1',
      brand_id: 'brd_1',
      sender_identity_id: 'ssi_1',
    });
    expect(inserted.sms_provider_routes).toHaveLength(1);
  });
});

import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@gatekit/domain';
import type { Database } from '@gatekit/db';
import type { AppContext } from '../app.js';
import { questionRoutes } from '../routes/modules/questions.js';

type QuestionRow = {
  id: string;
  event_id: string;
  ticket_type_id: string | null;
  type: string;
  label: string;
  description: string | null;
  required: boolean;
  applies_to: string;
  options: string | null;
  placeholder: string | null;
  validation_pattern: string | null;
  conditional_visibility: string | null;
  sort_order: number;
  is_consent_field: boolean;
  consent_text: string | null;
  consent_version: string | null;
  created_at: Date;
  updated_at: Date;
};

function question(id: string, sortOrder: number): QuestionRow {
  return {
    id,
    event_id: 'evt_1',
    ticket_type_id: null,
    type: 'text',
    label: id,
    description: null,
    required: false,
    applies_to: 'buyer',
    options: null,
    placeholder: null,
    validation_pattern: null,
    conditional_visibility: null,
    sort_order: sortOrder,
    is_consent_field: false,
    consent_text: null,
    consent_version: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
  };
}

function createQuestionReorderDb(rows: QuestionRow[], failOnQuestionId?: string) {
  const event = {
    id: 'evt_1',
    tenant_id: 'tnt_1',
    organization_id: 'org_1',
    brand_id: 'brd_1',
  };

  const createQuery = (table: string) => {
    const whereCalls: unknown[][] = [];
    const query = {
      selectAll: () => query,
      where: (...args: unknown[]) => {
        whereCalls.push(args);
        return query;
      },
      orderBy: () => query,
      async executeTakeFirst() {
        if (table !== 'events') return undefined;
        return whereCalls.some((call) => call[0] === 'id' && call[2] === event.id) ? event : undefined;
      },
      async execute() {
        if (table !== 'questions') return [];
        let result = [...rows];
        for (const call of whereCalls) {
          const [field, operator, value] = call;
          if (field === 'event_id' && operator === '=') {
            result = result.filter((row) => row.event_id === value);
          }
          if (field === 'id' && operator === 'in' && Array.isArray(value)) {
            result = result.filter((row) => value.includes(row.id));
          }
        }
        return result.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
      },
    };
    return query;
  };

  const createUpdate = (table: string) => ({
    set(values: Record<string, unknown>) {
      const whereCalls: unknown[][] = [];
      const update = {
        where: (...args: unknown[]) => {
          whereCalls.push(args);
          return update;
        },
        async execute() {
          if (table !== 'questions') return [];
          const questionId = whereCalls.find((call) => call[0] === 'id' && call[1] === '=')?.[2];
          if (questionId === failOnQuestionId) {
            throw new Error(`Simulated update failure for ${failOnQuestionId}`);
          }
          const row = rows.find((candidate) => candidate.id === questionId);
          if (row) {
            if (typeof values.sort_order === 'number') row.sort_order = values.sort_order;
            if (values.updated_at instanceof Date) row.updated_at = values.updated_at;
          }
          return [];
        },
      };
      return update;
    },
  });

  const mockDb = {
    selectFrom: createQuery,
    updateTable: createUpdate,
    transaction: () => ({
      execute: async (fn: (trx: typeof mockDb) => Promise<unknown>) => {
        const snapshot = rows.map((row) => ({ ...row }));
        try {
          return await fn(mockDb);
        } catch (error) {
          rows.splice(0, rows.length, ...snapshot);
          throw error;
        }
      },
    }),
  };
  return mockDb;
}

function makePrincipal(): Principal {
  return {
    type: 'user',
    id: 'usr_1',
    tenantId: 'tnt_1',
    organizationIds: ['org_1'],
    scopes: ['events.read', 'events.write'],
  };
}

async function buildQuestionApp(db: Database) {
  const app = Fastify();
  app.decorate('context', {
    db,
    pricingEngine: {},
    inventoryService: {},
    qrService: {},
    authService: {},
    temporalClient: {},
  } as unknown as AppContext);
  app.addHook('onRequest', async (request) => {
    request.principal = makePrincipal();
  });
  await app.register(questionRoutes);
  return app;
}

describe('question reorder route', () => {
  it('atomically reorders checkout questions and returns them in sort order', async () => {
    const rows = [question('q_first', 0), question('q_second', 1)];
    const app = await buildQuestionApp(createQuestionReorderDb(rows) as unknown as Database);

    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/questions/reorder',
      payload: {
        questions: [
          { id: 'q_second', sortOrder: 0 },
          { id: 'q_first', sortOrder: 1 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((item: { id: string; sortOrder: number }) => [item.id, item.sortOrder])).toEqual([
      ['q_second', 0],
      ['q_first', 1],
    ]);
    expect(rows.map((row) => [row.id, row.sort_order])).toEqual([
      ['q_first', 1],
      ['q_second', 0],
    ]);

    await app.close();
  });

  it('rolls back all sort-order changes if an update fails mid-transaction', async () => {
    const rows = [question('q_first', 0), question('q_second', 1)];
    const app = await buildQuestionApp(createQuestionReorderDb(rows, 'q_second') as unknown as Database);

    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/questions/reorder',
      payload: {
        questions: [
          { id: 'q_first', sortOrder: 1 },
          { id: 'q_second', sortOrder: 0 },
        ],
      },
    });

    expect(res.statusCode).toBe(500);
    expect(rows.map((row) => [row.id, row.sort_order])).toEqual([
      ['q_first', 0],
      ['q_second', 1],
    ]);

    await app.close();
  });

  it('rejects duplicate question IDs before updating any rows', async () => {
    const rows = [question('q_first', 0), question('q_second', 1)];
    const app = await buildQuestionApp(createQuestionReorderDb(rows) as unknown as Database);

    const res = await app.inject({
      method: 'POST',
      url: '/events/evt_1/questions/reorder',
      payload: {
        questions: [
          { id: 'q_first', sortOrder: 0 },
          { id: 'q_first', sortOrder: 1 },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(rows.map((row) => [row.id, row.sort_order])).toEqual([
      ['q_first', 0],
      ['q_second', 1],
    ]);

    await app.close();
  });
});

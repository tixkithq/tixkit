import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const AgentApprovalActionUniqueMigration: Migration = {
  async up(db): Promise<void> {
    if (process.env.DB_DRIVER === 'mysql') {
      await db.schema
        .createIndex('agent_approvals_action_unique')
        .unique()
        .on('agent_approvals')
        .columns(['tenant_id', 'action_id'])
        .execute();
      return;
    }
    await sql`create unique index agent_approvals_action_unique
      on agent_approvals (tenant_id, action_id) where action_id is not null`.execute(db);
  },

  async down(db): Promise<void> {
    if (process.env.DB_DRIVER === 'mysql' || process.env.DB_DRIVER === 'mssql') {
      await sql`drop index agent_approvals_action_unique on agent_approvals`.execute(db);
      return;
    }
    await sql`drop index if exists agent_approvals_action_unique`.execute(db);
  },
};

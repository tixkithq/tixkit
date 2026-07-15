import type { Migration } from 'kysely/migration';

export const AgentExecutionPlanBindingMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('agent_executions')
      .addColumn('plan_sha256', 'varchar(64)')
      .execute();
  },

  async down(db): Promise<void> {
    const populated = await db
      .selectFrom('agent_executions')
      .select((builder) => builder.fn.countAll<number>().as('count'))
      .where('plan_sha256', 'is not', null)
      .executeTakeFirst();
    if (Number(populated?.count ?? 0) > 0)
      throw new Error('agent execution plan binding rollback refused: bound evidence exists');
    await db.schema.alterTable('agent_executions').dropColumn('plan_sha256').execute();
  },
};

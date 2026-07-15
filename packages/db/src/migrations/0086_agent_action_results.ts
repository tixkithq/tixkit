import type { Migration } from 'kysely/migration';

export const AgentActionResultsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema.alterTable('agent_actions').addColumn('result_json', 'text').execute();
    await db.schema.alterTable('agent_actions').addColumn('result_sha256', 'varchar(64)').execute();
  },

  async down(db): Promise<void> {
    const populated = await db
      .selectFrom('agent_actions')
      .select((builder) => builder.fn.countAll<number>().as('count'))
      .where((builder) =>
        builder.or([
          builder('result_json', 'is not', null),
          builder('result_sha256', 'is not', null),
        ]),
      )
      .executeTakeFirst();
    if (Number(populated?.count ?? 0) > 0)
      throw new Error('agent action result rollback refused: durable result evidence exists');
    await db.schema.alterTable('agent_actions').dropColumn('result_sha256').execute();
    await db.schema.alterTable('agent_actions').dropColumn('result_json').execute();
  },
};

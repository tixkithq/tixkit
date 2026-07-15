import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

export const AgentOAuthCredentialsMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('oauth_applications')
      .addColumn('subject_type', 'varchar(32)', (column) =>
        column.notNull().defaultTo('resource_owner'),
      )
      .addColumn('agent_principal_id', 'varchar(64)')
      .execute();

    await db.schema
      .alterTable('oauth_access_tokens')
      .addColumn('subject_type', 'varchar(32)', (column) =>
        column.notNull().defaultTo('resource_owner'),
      )
      .addColumn('subject_id', 'varchar(64)')
      .execute();

    await db.schema
      .alterTable('oauth_applications')
      .addForeignKeyConstraint(
        'oauth_applications_agent_principal_fk',
        ['tenant_id', 'agent_principal_id'],
        'agent_principals',
        ['tenant_id', 'id'],
      )
      .execute();

    await db.schema
      .createIndex('oauth_applications_agent_principal_idx')
      .on('oauth_applications')
      .columns(['tenant_id', 'agent_principal_id', 'status'])
      .execute();
    await db.schema
      .createIndex('oauth_access_tokens_subject_idx')
      .on('oauth_access_tokens')
      .columns(['tenant_id', 'subject_type', 'subject_id', 'revoked_at'])
      .execute();

    await sql`
      update oauth_access_tokens
      set subject_id = id
      where subject_id is null
    `.execute(db);
  },

  async down(db): Promise<void> {
    const [agentApplication, agentToken] = await Promise.all([
      db
        .selectFrom('oauth_applications')
        .select('id')
        .where('subject_type', '=', 'agent')
        .limit(1)
        .executeTakeFirst(),
      db
        .selectFrom('oauth_access_tokens')
        .select('id')
        .where('subject_type', '=', 'agent')
        .limit(1)
        .executeTakeFirst(),
    ]);
    if (agentApplication || agentToken) {
      throw new Error('AGENT_OAUTH_CREDENTIALS_ROLLBACK_UNSAFE');
    }
    await db.schema
      .alterTable('oauth_applications')
      .dropConstraint('oauth_applications_agent_principal_fk')
      .execute();
    if (process.env.DB_DRIVER === 'mysql') {
      const accessTenantIndex = await sql<{ index_name: string }>`
        select index_name
        from information_schema.statistics
        where table_schema = database()
          and table_name = 'oauth_access_tokens'
          and index_name = 'oauth_access_tokens_tenant_idx'
        limit 1
      `.execute(db);
      if (accessTenantIndex.rows.length === 0)
        await sql`create index oauth_access_tokens_tenant_idx on oauth_access_tokens (tenant_id)`.execute(
          db,
        );
      const applicationTenantIndex = await sql<{ index_name: string }>`
        select index_name
        from information_schema.statistics
        where table_schema = database()
          and table_name = 'oauth_applications'
          and index_name = 'oauth_applications_tenant_idx'
        limit 1
      `.execute(db);
      if (applicationTenantIndex.rows.length === 0)
        await sql`create index oauth_applications_tenant_idx on oauth_applications (tenant_id)`.execute(
          db,
        );
      await sql`drop index oauth_access_tokens_subject_idx on oauth_access_tokens`.execute(db);
      await sql`drop index oauth_applications_agent_principal_idx on oauth_applications`.execute(
        db,
      );
    } else if (process.env.DB_DRIVER === 'mssql') {
      await db.schema
        .dropIndex('oauth_access_tokens_subject_idx')
        .on('oauth_access_tokens')
        .ifExists()
        .execute();
      await db.schema
        .dropIndex('oauth_applications_agent_principal_idx')
        .on('oauth_applications')
        .ifExists()
        .execute();
    } else {
      await sql`drop index if exists oauth_access_tokens_subject_idx`.execute(db);
      await sql`drop index if exists oauth_applications_agent_principal_idx`.execute(db);
    }
    await db.schema.alterTable('oauth_access_tokens').dropColumn('subject_id').execute();
    await db.schema.alterTable('oauth_access_tokens').dropColumn('subject_type').execute();
    await db.schema.alterTable('oauth_applications').dropColumn('agent_principal_id').execute();
    await db.schema.alterTable('oauth_applications').dropColumn('subject_type').execute();
  },
};

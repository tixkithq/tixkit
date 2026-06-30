import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

const defaultBoxOfficeSettingsJson = JSON.stringify({
  enabled: true,
  allowedTenderTypes: ['cash', 'manual_card', 'comp'],
  requireBuyerEmail: false,
  receiptMode: 'email',
});

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

function quoteMysqlIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function mysqlColumnExists(
  db: Parameters<Migration['up']>[0],
  tableName: string,
  columnName: string,
): Promise<boolean> {
  const result = await sql<{ column_exists: number }>`
    select count(*) as column_exists
    from information_schema.columns
    where table_schema = database()
      and table_name = ${tableName}
      and column_name = ${columnName}
  `.execute(db);
  return Number(result.rows[0]?.column_exists ?? 0) > 0;
}

export const OrganizationBoxOfficeSettingsMigration: Migration = {
  async up(db): Promise<void> {
    if (isMysql()) {
      if (!(await mysqlColumnExists(db, 'organizations', 'box_office_settings'))) {
        await sql
          .raw(
            `alter table ${quoteMysqlIdentifier('organizations')} add column ${quoteMysqlIdentifier('box_office_settings')} json null`,
          )
          .execute(db);
      }
      await sql`
        update organizations
        set box_office_settings = ${defaultBoxOfficeSettingsJson}
        where box_office_settings is null
      `.execute(db);
      await sql`
        alter table organizations
          modify column box_office_settings json not null
      `.execute(db);
      return;
    }

    if (isMssql()) {
      await sql`
        if col_length('organizations', 'box_office_settings') is null
          alter table organizations
            add box_office_settings nvarchar(max) not null
            constraint organizations_box_office_settings_default default ${sql.raw(
              sqlStringLiteral(defaultBoxOfficeSettingsJson),
            )};
      `.execute(db);
      await sql`
        if not exists (
          select 1
          from sys.check_constraints
          where name = 'organizations_box_office_settings_json'
        )
          alter table organizations
            add constraint organizations_box_office_settings_json
            check (isjson(box_office_settings) = 1);
      `.execute(db);
      return;
    }

    await sql`
      alter table organizations
        add column if not exists box_office_settings jsonb not null
        default ${sql.raw(`${sqlStringLiteral(defaultBoxOfficeSettingsJson)}::jsonb`)}
    `.execute(db);
  },

  async down(db): Promise<void> {
    if (isMysql()) {
      if (await mysqlColumnExists(db, 'organizations', 'box_office_settings')) {
        await sql`
          alter table organizations
            drop column box_office_settings
        `.execute(db);
      }
      return;
    }

    if (isMssql()) {
      await sql`
        if exists (
          select 1
          from sys.check_constraints
          where name = 'organizations_box_office_settings_json'
        )
          alter table organizations
            drop constraint organizations_box_office_settings_json;
        if exists (
          select 1
          from sys.default_constraints
          where name = 'organizations_box_office_settings_default'
        )
          alter table organizations
            drop constraint organizations_box_office_settings_default;
        if col_length('organizations', 'box_office_settings') is not null
          alter table organizations
            drop column box_office_settings;
      `.execute(db);
      return;
    }

    await sql`
      alter table organizations
        drop column if exists box_office_settings
    `.execute(db);
  },
};

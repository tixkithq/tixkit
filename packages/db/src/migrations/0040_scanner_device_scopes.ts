import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

const DEFAULT_SCANNER_DEVICE_SCOPES = JSON.stringify(['checkins.read', 'checkins.write']);
type MigrationDb = Parameters<Migration['up']>[0];

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function mysqlColumnExists(db: MigrationDb, table: string, column: string): Promise<boolean> {
  const result = await sql<{ count: number | string | bigint }>`
    select count(*) as count
    from information_schema.columns
    where table_schema = database()
      and table_name = ${table}
      and column_name = ${column}
  `.execute(db);

  return Number(result.rows[0]?.count ?? 0) > 0;
}

export const ScannerDeviceScopesMigration: Migration = {
  async up(db): Promise<void> {
    if (isMysql()) {
      if (!(await mysqlColumnExists(db, 'scanner_devices', 'scopes'))) {
        await sql`
          alter table scanner_devices
            add column scopes json
        `.execute(db);
      }
      await sql`
        update scanner_devices
        set scopes = cast(${DEFAULT_SCANNER_DEVICE_SCOPES} as json)
        where scopes is null
      `.execute(db);
      await sql`
        alter table scanner_devices
          modify column scopes json not null
      `.execute(db);
      return;
    }

    if (isMssql()) {
      await sql`
        if col_length('scanner_devices', 'scopes') is null
          alter table scanner_devices add scopes nvarchar(max) null;
        update scanner_devices
          set scopes = ${DEFAULT_SCANNER_DEVICE_SCOPES}
          where scopes is null;
        alter table scanner_devices alter column scopes nvarchar(max) not null;
      `.execute(db);
      return;
    }

    await sql`
      alter table scanner_devices
        add column if not exists scopes jsonb
    `.execute(db);
    await sql`
      update scanner_devices
      set scopes = ${sql.raw(`'${DEFAULT_SCANNER_DEVICE_SCOPES}'::jsonb`)}
      where scopes is null
    `.execute(db);
    await sql`
      alter table scanner_devices
        alter column scopes set default ${sql.raw(`'${DEFAULT_SCANNER_DEVICE_SCOPES}'::jsonb`)},
        alter column scopes set not null
    `.execute(db);
  },

  async down(db): Promise<void> {
    if (isMysql()) {
      await sql`
        alter table scanner_devices
          drop column scopes
      `.execute(db);
      return;
    }

    if (isMssql()) {
      await sql`
        if col_length('scanner_devices', 'scopes') is not null
          alter table scanner_devices drop column scopes;
      `.execute(db);
      return;
    }

    await sql`
      alter table scanner_devices
        drop column if exists scopes
    `.execute(db);
  },
};

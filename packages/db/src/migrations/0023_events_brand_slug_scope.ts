import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function ignoreAlreadyApplied(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const record = error as {
      code?: string;
      errno?: number | string;
      message?: string;
      number?: number;
    };
    const message = record.message ?? '';
    if (
      record.code === '42704' ||
      record.code === '42P07' ||
      record.code === 'ER_DUP_KEYNAME' ||
      record.code === 'ER_CANT_DROP_FIELD_OR_KEY' ||
      record.errno === 1061 ||
      record.errno === '1061' ||
      record.errno === 1091 ||
      record.errno === '1091' ||
      record.number === 2714 ||
      /does not exist|already exists|duplicate/i.test(message)
    ) {
      return;
    }
    throw error;
  }
}

async function dropConstraintOrIndex(db: Kysely<unknown>, name: string): Promise<void> {
  if (isMysql()) {
    await ignoreAlreadyApplied(() =>
      sql`alter table events drop index ${sql.id(name)}`.execute(db).then(() => undefined),
    );
    return;
  }

  if (isMssql()) {
    await sql`
      if exists (
        select 1
        from sys.key_constraints
        where parent_object_id = object_id('events')
          and name = ${name}
      )
      alter table events drop constraint ${sql.id(name)}
    `.execute(db);
    return;
  }

  await sql`alter table events drop constraint if exists ${sql.id(name)}`.execute(db);
}

async function addBrandSlugConstraint(db: Kysely<unknown>): Promise<void> {
  await ignoreAlreadyApplied(async () => {
    await db.schema
      .alterTable('events')
      .addUniqueConstraint('events_brand_slug_unique', ['brand_id', 'slug'])
      .execute();
  });
}

async function addTenantSlugConstraint(db: Kysely<unknown>): Promise<void> {
  await ignoreAlreadyApplied(async () => {
    await db.schema
      .alterTable('events')
      .addUniqueConstraint('events_slug_tenant_unique', ['tenant_id', 'slug'])
      .execute();
  });
}

export const EventsBrandSlugScopeMigration: Migration = {
  async up(db): Promise<void> {
    await dropConstraintOrIndex(db, 'events_slug_global_unique');
    await dropConstraintOrIndex(db, 'events_slug_tenant_unique');
    await addBrandSlugConstraint(db);
  },

  async down(db): Promise<void> {
    await dropConstraintOrIndex(db, 'events_brand_slug_unique');
    await addTenantSlugConstraint(db);
  },
};

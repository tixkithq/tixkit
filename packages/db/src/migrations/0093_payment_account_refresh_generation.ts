import { sql, type ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

const CONTROL_ID = 'singleton';

function timestampType(): ColumnDataType {
  if (process.env.DB_DRIVER === 'mssql') return 'datetime2';
  return process.env.DB_DRIVER === 'mysql' ? 'datetime' : 'timestamptz';
}

export const PaymentAccountRefreshGenerationMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('payment_account_refresh_control')
      .addColumn('id', 'varchar(32)', (column) => column.primaryKey())
      .addColumn('maintenance', 'integer', (column) => column.notNull().defaultTo(0))
      .addColumn('updated_at', timestampType(), (column) => column.notNull())
      .addCheckConstraint(
        'payment_account_refresh_control_singleton',
        sql`id = 'singleton' and maintenance in (0, 1)`,
      )
      .execute();
    await db
      .insertInto('payment_account_refresh_control')
      .values({ id: CONTROL_ID, maintenance: 0, updated_at: new Date() })
      .execute();
    await db.schema
      .alterTable('payment_accounts')
      .addColumn('refresh_generation', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();
    await db.schema
      .alterTable('payment_accounts')
      .addCheckConstraint(
        'payment_accounts_refresh_generation_nonnegative',
        sql`refresh_generation >= 0`,
      )
      .execute();
  },

  async down(db): Promise<void> {
    const claimed = await db.transaction().execute(async (trx) => {
      const control = await trx
        .selectFrom('payment_account_refresh_control')
        .selectAll()
        .where('id', '=', CONTROL_ID)
        .forUpdate()
        .executeTakeFirst();
      if (!control) {
        throw new Error('Payment account refresh maintenance control is missing');
      }
      await trx
        .updateTable('payment_account_refresh_control')
        .set({ maintenance: 1, updated_at: new Date() })
        .where('id', '=', CONTROL_ID)
        .execute();
      const durableClaim = await trx
        .selectFrom('payment_accounts')
        .select('id')
        .where('refresh_generation', '>', 0)
        .limit(1)
        .executeTakeFirst();
      if (durableClaim) {
        await trx
          .updateTable('payment_account_refresh_control')
          .set({ maintenance: 0, updated_at: new Date() })
          .where('id', '=', CONTROL_ID)
          .execute();
      }
      return durableClaim;
    });
    if (claimed) {
      throw new Error(
        'Cannot roll back payment account refresh generations while durable claims exist',
      );
    }
    await db.schema
      .alterTable('payment_accounts')
      .dropConstraint('payment_accounts_refresh_generation_nonnegative')
      .execute();
    await db.schema.alterTable('payment_accounts').dropColumn('refresh_generation').execute();
    await db.schema.dropTable('payment_account_refresh_control').execute();
  },
};

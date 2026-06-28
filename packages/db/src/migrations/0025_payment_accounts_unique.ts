import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function dedupePaymentAccounts(db: Kysely<unknown>): Promise<void> {
  if (isMysql()) {
    await sql`
      delete payment_accounts
      from payment_accounts
      inner join (
        select id
        from (
          select
            id,
            row_number() over (
              partition by organization_id, provider
              order by updated_at desc, id desc
            ) as duplicate_rank
          from payment_accounts
        ) ranked_payment_accounts
        where duplicate_rank > 1
      ) duplicate_payment_accounts
        on duplicate_payment_accounts.id = payment_accounts.id
    `.execute(db);
    return;
  }

  if (isMssql()) {
    await sql`
      with ranked_payment_accounts as (
        select
          id,
          row_number() over (
            partition by organization_id, provider
            order by updated_at desc, id desc
          ) as duplicate_rank
        from payment_accounts
      )
      delete from ranked_payment_accounts
      where duplicate_rank > 1
    `.execute(db);
    return;
  }

  await sql`
    delete from payment_accounts
    where id in (
      select id
      from (
        select
          id,
          row_number() over (
            partition by organization_id, provider
            order by updated_at desc, id desc
          ) as duplicate_rank
        from payment_accounts
      ) ranked_payment_accounts
      where duplicate_rank > 1
    )
  `.execute(db);
}

export const PaymentAccountsUniqueMigration: Migration = {
  async up(db): Promise<void> {
    await dedupePaymentAccounts(db);

    await db.schema
      .createIndex('uniq_payment_accounts_organization_provider')
      .on('payment_accounts')
      .columns(['organization_id', 'provider'])
      .unique()
      .execute();

    await db.schema
      .createIndex('uniq_payment_accounts_provider_account')
      .on('payment_accounts')
      .columns(['provider', 'provider_account_id'])
      .unique()
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .dropIndex('uniq_payment_accounts_provider_account')
      .on('payment_accounts')
      .ifExists()
      .execute();
    await db.schema
      .dropIndex('uniq_payment_accounts_organization_provider')
      .on('payment_accounts')
      .ifExists()
      .execute();
  },
};

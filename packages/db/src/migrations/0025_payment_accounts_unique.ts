import { sql, type Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function dedupePaymentAccounts(db: Kysely<unknown>): Promise<void> {
  await dedupeProviderAccountDuplicates(db);
  await dedupeOrganizationProviderDuplicates(db);
}

async function dedupeProviderAccountDuplicates(db: Kysely<unknown>): Promise<void> {
  if (isMysql()) {
    await sql`
      update brands
      inner join (
        select id, canonical_id
        from (
          select
            id,
            first_value(id) over (
              partition by provider, provider_account_id
              order by
                case
                  when exists (
                    select 1
                    from payment_intents
                    where payment_intents.payment_account_id = payment_accounts.id
                  ) then 1
                  else 0
                end desc,
                updated_at desc,
                id desc
            ) as canonical_id,
            row_number() over (
              partition by provider, provider_account_id
              order by
                case
                  when exists (
                    select 1
                    from payment_intents
                    where payment_intents.payment_account_id = payment_accounts.id
                  ) then 1
                  else 0
                end desc,
                updated_at desc,
                id desc
            ) as duplicate_rank
          from payment_accounts
        ) ranked_payment_accounts
        where duplicate_rank > 1
      ) duplicate_payment_accounts
        on duplicate_payment_accounts.id = brands.payment_account_id
      set brands.payment_account_id = duplicate_payment_accounts.canonical_id
    `.execute(db);

    await sql`
      delete payment_accounts
      from payment_accounts
      inner join (
        select id
        from (
          select
            id,
            row_number() over (
              partition by provider, provider_account_id
              order by
                case
                  when exists (
                    select 1
                    from payment_intents
                    where payment_intents.payment_account_id = payment_accounts.id
                  ) then 1
                  else 0
                end desc,
                updated_at desc,
                id desc
            ) as duplicate_rank
          from payment_accounts
        ) ranked_payment_accounts
        where duplicate_rank > 1
      ) duplicate_payment_accounts
        on duplicate_payment_accounts.id = payment_accounts.id
      where not exists (
        select 1
        from payment_intents
        where payment_intents.payment_account_id = payment_accounts.id
      )
    `.execute(db);
    return;
  }

  if (isMssql()) {
    await sql`
      with ranked_payment_accounts as (
        select
          id,
          first_value(id) over (
            partition by provider, provider_account_id
            order by
              case
                when exists (
                  select 1
                  from payment_intents
                  where payment_intents.payment_account_id = payment_accounts.id
                ) then 1
                else 0
              end desc,
              updated_at desc,
              id desc
          ) as canonical_id,
          row_number() over (
            partition by provider, provider_account_id
            order by
              case
                when exists (
                  select 1
                  from payment_intents
                  where payment_intents.payment_account_id = payment_accounts.id
                ) then 1
                else 0
              end desc,
              updated_at desc,
              id desc
          ) as duplicate_rank
        from payment_accounts
      ),
      duplicate_payment_accounts as (
        select id, canonical_id
        from ranked_payment_accounts
        where duplicate_rank > 1
      )
      update brands
      set payment_account_id = duplicate_payment_accounts.canonical_id
      from brands
      inner join duplicate_payment_accounts
        on duplicate_payment_accounts.id = brands.payment_account_id
    `.execute(db);

    await sql`
      with ranked_payment_accounts as (
        select
          id,
          row_number() over (
            partition by provider, provider_account_id
            order by
              case
                when exists (
                  select 1
                  from payment_intents
                  where payment_intents.payment_account_id = payment_accounts.id
                ) then 1
                else 0
              end desc,
              updated_at desc,
              id desc
          ) as duplicate_rank
        from payment_accounts
      ),
      duplicate_payment_accounts as (
        select id
        from ranked_payment_accounts
        where duplicate_rank > 1
      )
      delete payment_accounts
      from payment_accounts
      inner join duplicate_payment_accounts
        on duplicate_payment_accounts.id = payment_accounts.id
      where not exists (
        select 1
        from payment_intents
        where payment_intents.payment_account_id = payment_accounts.id
      )
    `.execute(db);
    return;
  }

  await sql`
    with ranked_payment_accounts as (
      select
        id,
        first_value(id) over (
          partition by provider, provider_account_id
          order by
            case
              when exists (
                select 1
                from payment_intents
                where payment_intents.payment_account_id = payment_accounts.id
              ) then 1
              else 0
            end desc,
            updated_at desc,
            id desc
        ) as canonical_id,
        row_number() over (
          partition by provider, provider_account_id
          order by
            case
              when exists (
                select 1
                from payment_intents
                where payment_intents.payment_account_id = payment_accounts.id
              ) then 1
              else 0
            end desc,
            updated_at desc,
            id desc
        ) as duplicate_rank
      from payment_accounts
    ),
    duplicate_payment_accounts as (
      select id, canonical_id
      from ranked_payment_accounts
      where duplicate_rank > 1
    )
    update brands
    set payment_account_id = (
      select canonical_id
      from duplicate_payment_accounts
      where duplicate_payment_accounts.id = brands.payment_account_id
    )
    where payment_account_id in (
      select id
      from duplicate_payment_accounts
    )
  `.execute(db);

  await sql`
    delete from payment_accounts
    where id in (
      select id
      from (
        select
          id,
          row_number() over (
            partition by provider, provider_account_id
            order by
              case
                when exists (
                  select 1
                  from payment_intents
                  where payment_intents.payment_account_id = payment_accounts.id
                ) then 1
                else 0
              end desc,
              updated_at desc,
              id desc
          ) as duplicate_rank
        from payment_accounts
      ) ranked_payment_accounts
      where duplicate_rank > 1
    )
    and not exists (
      select 1
      from payment_intents
      where payment_intents.payment_account_id = payment_accounts.id
    )
  `.execute(db);
}

async function dedupeOrganizationProviderDuplicates(db: Kysely<unknown>): Promise<void> {
  if (isMysql()) {
    await sql`
      update brands
      inner join (
        select id, canonical_id
        from (
          select
            id,
            first_value(id) over (
              partition by organization_id, provider
              order by
                case
                  when exists (
                    select 1
                    from payment_intents
                    where payment_intents.payment_account_id = payment_accounts.id
                  ) then 1
                  else 0
                end desc,
                updated_at desc,
                id desc
            ) as canonical_id,
            row_number() over (
              partition by organization_id, provider
              order by
                case
                  when exists (
                    select 1
                    from payment_intents
                    where payment_intents.payment_account_id = payment_accounts.id
                  ) then 1
                  else 0
                end desc,
                updated_at desc,
                id desc
            ) as duplicate_rank
          from payment_accounts
        ) ranked_payment_accounts
        where duplicate_rank > 1
      ) duplicate_payment_accounts
        on duplicate_payment_accounts.id = brands.payment_account_id
      set brands.payment_account_id = duplicate_payment_accounts.canonical_id
    `.execute(db);

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
              order by
                case
                  when exists (
                    select 1
                    from payment_intents
                    where payment_intents.payment_account_id = payment_accounts.id
                  ) then 1
                  else 0
                end desc,
                updated_at desc,
                id desc
            ) as duplicate_rank
          from payment_accounts
        ) ranked_payment_accounts
        where duplicate_rank > 1
      ) duplicate_payment_accounts
        on duplicate_payment_accounts.id = payment_accounts.id
      where not exists (
        select 1
        from payment_intents
        where payment_intents.payment_account_id = payment_accounts.id
      )
    `.execute(db);
    return;
  }

  if (isMssql()) {
    await sql`
      with ranked_payment_accounts as (
        select
          id,
          first_value(id) over (
            partition by organization_id, provider
            order by
              case
                when exists (
                  select 1
                  from payment_intents
                  where payment_intents.payment_account_id = payment_accounts.id
                ) then 1
                else 0
              end desc,
              updated_at desc,
              id desc
          ) as canonical_id,
          row_number() over (
            partition by organization_id, provider
            order by
              case
                when exists (
                  select 1
                  from payment_intents
                  where payment_intents.payment_account_id = payment_accounts.id
                ) then 1
                else 0
              end desc,
              updated_at desc,
              id desc
          ) as duplicate_rank
        from payment_accounts
      ),
      duplicate_payment_accounts as (
        select id, canonical_id
        from ranked_payment_accounts
        where duplicate_rank > 1
      )
      update brands
      set payment_account_id = duplicate_payment_accounts.canonical_id
      from brands
      inner join duplicate_payment_accounts
        on duplicate_payment_accounts.id = brands.payment_account_id
    `.execute(db);

    await sql`
      with ranked_payment_accounts as (
        select
          id,
          row_number() over (
            partition by organization_id, provider
            order by
              case
                when exists (
                  select 1
                  from payment_intents
                  where payment_intents.payment_account_id = payment_accounts.id
                ) then 1
                else 0
              end desc,
              updated_at desc,
              id desc
          ) as duplicate_rank
        from payment_accounts
      ),
      duplicate_payment_accounts as (
        select id
        from ranked_payment_accounts
        where duplicate_rank > 1
      )
      delete payment_accounts
      from payment_accounts
      inner join duplicate_payment_accounts
        on duplicate_payment_accounts.id = payment_accounts.id
      where not exists (
        select 1
        from payment_intents
        where payment_intents.payment_account_id = payment_accounts.id
      )
    `.execute(db);
    return;
  }

  await sql`
    with ranked_payment_accounts as (
      select
        id,
        first_value(id) over (
          partition by organization_id, provider
          order by
            case
              when exists (
                select 1
                from payment_intents
                where payment_intents.payment_account_id = payment_accounts.id
              ) then 1
              else 0
            end desc,
            updated_at desc,
            id desc
        ) as canonical_id,
        row_number() over (
          partition by organization_id, provider
          order by
            case
              when exists (
                select 1
                from payment_intents
                where payment_intents.payment_account_id = payment_accounts.id
              ) then 1
              else 0
            end desc,
            updated_at desc,
            id desc
        ) as duplicate_rank
      from payment_accounts
    ),
    duplicate_payment_accounts as (
      select id, canonical_id
      from ranked_payment_accounts
      where duplicate_rank > 1
    )
    update brands
    set payment_account_id = (
      select canonical_id
      from duplicate_payment_accounts
      where duplicate_payment_accounts.id = brands.payment_account_id
    )
    where payment_account_id in (
      select id
      from duplicate_payment_accounts
    )
  `.execute(db);

  await sql`
    delete from payment_accounts
    where id in (
      select id
      from (
        select
            id,
            row_number() over (
              partition by organization_id, provider
              order by
                case
                  when exists (
                    select 1
                    from payment_intents
                    where payment_intents.payment_account_id = payment_accounts.id
                  ) then 1
                  else 0
                end desc,
                updated_at desc,
                id desc
            ) as duplicate_rank
        from payment_accounts
      ) ranked_payment_accounts
      where duplicate_rank > 1
    )
    and not exists (
      select 1
      from payment_intents
      where payment_intents.payment_account_id = payment_accounts.id
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

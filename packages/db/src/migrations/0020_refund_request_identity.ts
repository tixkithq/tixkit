import type { ColumnDataType } from 'kysely';
import type { Migration } from 'kysely/migration';

function varchar(len: number): ColumnDataType {
  return `varchar(${len})`;
}

export const RefundRequestIdentityMigration: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .alterTable('refunds')
      .addColumn('request_idempotency_key', varchar(255))
      .addColumn('request_nonce', varchar(255))
      .execute();

    const existingRefunds = await db
      .selectFrom('refunds')
      .select(['id', 'provider', 'provider_refund_id'])
      .execute();
    for (const refund of existingRefunds) {
      // eslint-disable-next-line no-await-in-loop -- migration backfills stable per-row keys before adding the uniqueness constraint.
      await db
        .updateTable('refunds')
        .set({
          request_idempotency_key: `provider:${refund.provider}:${refund.provider_refund_id}`,
        })
        .where('id', '=', refund.id)
        .execute();
    }

    await db.schema
      .alterTable('refunds')
      .addUniqueConstraint('refunds_order_request_key_unique', [
        'tenant_id',
        'order_id',
        'request_idempotency_key',
      ])
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema
      .alterTable('refunds')
      .dropConstraint('refunds_order_request_key_unique')
      .execute();
    await db.schema.alterTable('refunds').dropColumn('request_nonce').execute();
    await db.schema.alterTable('refunds').dropColumn('request_idempotency_key').execute();
  },
};

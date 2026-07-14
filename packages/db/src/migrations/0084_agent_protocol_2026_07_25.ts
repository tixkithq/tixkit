import type { Migration } from 'kysely/migration';

export const AgentProtocol20260725Migration: Migration = {
  async up(db): Promise<void> {
    await db
      .updateTable('agent_principals')
      .set({ protocol_version: '2026-07-25' })
      .where('protocol_version', '=', '2026-07-22')
      .execute();
  },

  async down(db): Promise<void> {
    await db
      .updateTable('agent_principals')
      .set({ protocol_version: '2026-07-22' })
      .where('protocol_version', '=', '2026-07-25')
      .execute();
  },
};

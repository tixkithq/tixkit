import type { Migration } from 'kysely/migration';

export const EventsGlobalSlugUniqueMigration: Migration = {
  async up(): Promise<void> {
    // Historical migration name kept so databases that already recorded it
    // remain compatible with the current migration provider.
  },

  async down(): Promise<void> {
    // No-op by design; brand-scoped slug uniqueness is managed by 0023.
  },
};

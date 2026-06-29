import { sql } from 'kysely';
import type { Migration } from 'kysely/migration';

function isMysql(): boolean {
  return process.env.DB_DRIVER === 'mysql';
}

function isMssql(): boolean {
  return process.env.DB_DRIVER === 'mssql';
}

async function dropTemplateVersionForeignKey(db: Parameters<Migration['up']>[0]): Promise<void> {
  if (isMysql()) {
    await sql`alter table email_jobs drop foreign key email_jobs_template_version_fk`.execute(db);
    return;
  }

  if (isMssql()) {
    await sql`alter table email_jobs drop constraint email_jobs_template_version_fk`.execute(db);
    return;
  }

  await sql`alter table email_jobs drop constraint if exists email_jobs_template_version_fk`.execute(db);
}

async function addLegacyTemplateVersionForeignKey(db: Parameters<Migration['up']>[0]): Promise<void> {
  if (isMysql()) {
    await sql`
      alter table email_jobs
      add constraint email_jobs_template_version_fk
      foreign key (template_version_id)
      references notification_template_versions (id)
    `.execute(db);
    return;
  }

  if (isMssql()) {
    await sql`
      alter table email_jobs
      add constraint email_jobs_template_version_fk
      foreign key (template_version_id)
      references notification_template_versions (id)
    `.execute(db);
    return;
  }

  await sql`
    alter table email_jobs
    add constraint email_jobs_template_version_fk
    foreign key (template_version_id)
    references notification_template_versions (id)
  `.execute(db);
}

export const EmailJobsTemplateVersionForeignKeyMigration: Migration = {
  async up(db): Promise<void> {
    await dropTemplateVersionForeignKey(db);
  },

  async down(db): Promise<void> {
    await addLegacyTemplateVersionForeignKey(db);
  },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely, Selectable } from 'kysely';
import type { Database } from '../client.js';
import { getDriver } from '../client.js';
import type { DB } from '../types/db.js';

export abstract class BaseRepository {
  constructor(protected db: Database) {}

  protected generateId(prefix: string): string {
    const ts = BigInt(Date.now()).toString(36).toUpperCase().padStart(10, '0');
    const rand = Math.random().toString(36).substring(2, 12).toUpperCase().padStart(8, '0');
    return `${prefix}_${ts}${rand}`;
  }

  protected async insertReturning<T extends keyof DB>(
    table: T,
    values: unknown,
    id: string,
  ): Promise<Selectable<DB[T]>> {
    const dbAny = this.db as any;
    const qb = dbAny.insertInto(table).values(values);
    if (getDriver() === 'postgres') {
      return (await qb.returningAll().executeTakeFirstOrThrow()) as unknown as Selectable<DB[T]>;
    }
    await qb.execute();
    return (await dbAny.selectFrom(table).selectAll().where('id', '=', id).executeTakeFirstOrThrow()) as unknown as Selectable<DB[T]>;
  }

  protected async updateReturning<T extends keyof DB>(
    table: T,
    id: string,
    values: unknown,
  ): Promise<Selectable<DB[T]>> {
    const dbAny = this.db as any;
    const qb = dbAny.updateTable(table).set(values).where('id', '=', id);
    if (getDriver() === 'postgres') {
      return (await qb.returningAll().executeTakeFirstOrThrow()) as unknown as Selectable<DB[T]>;
    }
    await qb.execute();
    return (await dbAny.selectFrom(table).selectAll().where('id', '=', id).executeTakeFirstOrThrow()) as unknown as Selectable<DB[T]>;
  }
}

export async function insertReturning<T extends keyof DB>(
  db: Kysely<DB>,
  table: T,
  values: unknown,
  id: string,
): Promise<Selectable<DB[T]>> {
  const dbAny = db as any;
  const qb = dbAny.insertInto(table).values(values);
  if (getDriver() === 'postgres') {
    return (await qb.returningAll().executeTakeFirstOrThrow()) as unknown as Selectable<DB[T]>;
  }
  await qb.execute();
  return (await dbAny.selectFrom(table).selectAll().where('id', '=', id).executeTakeFirstOrThrow()) as unknown as Selectable<DB[T]>;
}

export async function updateReturning<T extends keyof DB>(
  db: Kysely<DB>,
  table: T,
  id: string,
  values: unknown,
): Promise<Selectable<DB[T]>> {
  const dbAny = db as any;
  const qb = dbAny.updateTable(table).set(values).where('id', '=', id);
  if (getDriver() === 'postgres') {
    return (await qb.returningAll().executeTakeFirstOrThrow()) as unknown as Selectable<DB[T]>;
  }
  await qb.execute();
  return (await dbAny.selectFrom(table).selectAll().where('id', '=', id).executeTakeFirstOrThrow()) as unknown as Selectable<DB[T]>;
}

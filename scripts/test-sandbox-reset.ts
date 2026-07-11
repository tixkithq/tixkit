import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createDb, readSandboxEnvironment } from '../packages/db/src/index.js';
import { initializeSandbox, resetSandbox } from '../packages/cli/src/sandbox-reset.js';

const root = new URL('..', import.meta.url).pathname;
const compose = (...args: string[]) =>
  execFileSync('docker', ['compose', '-f', 'infra/docker-compose.yml', ...args], {
    cwd: root,
    stdio: 'inherit',
  });

async function snapshot(url: string) {
  const db = createDb(url);
  try {
    const table = (name: Parameters<typeof db.selectFrom>[0]) =>
      db.selectFrom(name).selectAll().orderBy('id').execute();
    const [
      events,
      inventoryPools,
      ticketTypes,
      products,
      discounts,
      questions,
      checkInLists,
      accessRules,
      sessions,
      holds,
      orders,
      lineItems,
      attendees,
      tickets,
      environment,
    ] = await Promise.all([
      table('events'),
      table('inventory_pools'),
      table('ticket_types'),
      table('products'),
      table('discount_codes'),
      table('questions'),
      table('check_in_lists'),
      table('access_rules'),
      table('checkout_sessions'),
      table('checkout_holds'),
      table('orders'),
      table('order_line_items'),
      table('attendees'),
      table('tickets'),
      readSandboxEnvironment(db),
    ]);
    return {
      events,
      inventoryPools,
      ticketTypes,
      products,
      discounts,
      questions,
      checkInLists,
      accessRules,
      sessions,
      holds,
      orders,
      lineItems,
      attendees,
      tickets,
      fixtureVersion: environment?.fixtureVersion,
    };
  } finally {
    await db.destroy();
  }
}

async function run(driver: 'postgres' | 'mysql') {
  const name = `tixkit_sandbox_${driver}_test`;
  if (driver === 'postgres') {
    compose(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'tixkit',
      '-d',
      'postgres',
      '-c',
      `drop database if exists ${name}`,
    );
    compose(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'tixkit',
      '-d',
      'postgres',
      '-c',
      `create database ${name}`,
    );
  } else {
    compose(
      'exec',
      '-T',
      'mysql',
      'mysql',
      '-uroot',
      '-ptixkit',
      '-e',
      `drop database if exists ${name}; create database ${name}; grant all on ${name}.* to 'tixkit'@'%';`,
    );
  }
  const url =
    driver === 'postgres'
      ? `postgres://tixkit:tixkit@localhost:5432/${name}`
      : `mysql://tixkit:tixkit@localhost:3306/${name}`;
  process.env.DB_DRIVER = driver;
  const base = {
    TIXKIT_SANDBOX_DATABASE_URL: url,
    TIXKIT_SANDBOX_INITIALIZE_CONFIRM: `INITIALIZE ${name}`,
    TIXKIT_RUNTIME_MODE: 'sandbox',
    TIXKIT_SANDBOX_RESET_COORDINATION: 'STOPPED',
  };
  const initialized = await initializeSandbox(base);
  if (!initialized.ok) throw new Error(initialized.message);
  const first = await resetSandbox(base);
  if (!first.ok || !first.apiKey || !first.epoch) throw new Error(first.message);
  if (!/^tk_sandbox_[a-f0-9]{64}$/u.test(first.apiKey))
    throw new Error(`${driver} sandbox credential format is not environment-bound`);
  const firstSnapshot = await snapshot(url);
  const event = firstSnapshot.events.find((row) => row.id === first.eventId);
  if (!event || new Date(event.starts_at as Date).getTime() <= Date.now())
    throw new Error(`${driver} sandbox event is not in the future`);
  const paidOrder = firstSnapshot.orders.find((row) => row.id === 'ord_sample_data');
  if (!paidOrder || paidOrder.payment_provider !== 'local' || paidOrder.payment_intent_id !== null)
    throw new Error(`${driver} sandbox paid history is not capture-local`);
  const second = await resetSandbox(base);
  if (!second.ok || !second.apiKey || !second.epoch) throw new Error(second.message);
  if (!/^tk_sandbox_[a-f0-9]{64}$/u.test(second.apiKey))
    throw new Error(`${driver} rotated credential format is not environment-bound`);
  const secondSnapshot = await snapshot(url);
  if (JSON.stringify(firstSnapshot) !== JSON.stringify(secondSnapshot))
    throw new Error(`${driver} sandbox fixture changed across resets`);
  if (first.epoch === second.epoch || first.taskQueue === second.taskQueue)
    throw new Error(`${driver} sandbox epoch did not rotate`);
  const db = createDb(url);
  try {
    const oldHash = createHash('sha256').update(first.apiKey).digest('hex');
    const newHash = createHash('sha256').update(second.apiKey).digest('hex');
    if (
      await db
        .selectFrom('api_keys')
        .select('id')
        .where('hashed_key', '=', oldHash)
        .executeTakeFirst()
    )
      throw new Error(`${driver} old sandbox credential survived reset`);
    const current = await db
      .selectFrom('api_keys')
      .select(['id', 'expires_at'])
      .where('hashed_key', '=', newHash)
      .executeTakeFirst();
    if (!current || !current.expires_at || new Date(current.expires_at).getTime() <= Date.now())
      throw new Error(`${driver} rotated credential is missing or expired`);
  } finally {
    await db.destroy();
  }
  console.log(`${driver} sandbox reset-twice contract passed`);
}

compose('up', '-d', 'postgres', 'mysql');
await run('postgres');
await run('mysql');

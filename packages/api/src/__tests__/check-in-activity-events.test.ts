import { afterEach, describe, expect, it, vi } from 'vitest';

const redisDouble = vi.hoisted(() => {
  const instances: Array<{
    published: Array<[string, string]>;
    handlers: Map<string, Array<(...args: unknown[]) => void>>;
    disconnected: boolean;
    connectCalls: number;
  }> = [];
  let connectFailuresRemaining = 0;

  class FakeRedis {
    published: Array<[string, string]> = [];
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    disconnected = false;
    connectCalls = 0;

    constructor(..._args: unknown[]) {
      instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    async connect() {
      this.connectCalls += 1;
      if (connectFailuresRemaining > 0) {
        connectFailuresRemaining -= 1;
        throw new Error('transient Redis connection failure');
      }
    }

    async publish(channel: string, message: string) {
      this.published.push([channel, message]);
      return 1;
    }

    async subscribe(..._channels: string[]) {
      return 1;
    }

    async quit() {
      this.disconnected = true;
    }

    disconnect() {
      this.disconnected = true;
    }

    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  return {
    FakeRedis,
    instances,
    failNextConnect: () => {
      connectFailuresRemaining += 1;
    },
    reset: () => {
      instances.length = 0;
      connectFailuresRemaining = 0;
    },
  };
});

vi.mock('ioredis', () => ({ Redis: redisDouble.FakeRedis }));

import {
  checkInActivityChannel,
  closeCheckInActivityPublisher,
  createCheckInActivitySubscriber,
  publishCheckInActivityEvent,
} from '../services/check-in-activity-events.js';
import { config } from '../config/index.js';

const originalNodeEnv = config.nodeEnv;
const originalRedisUrl = config.redisUrl;

afterEach(async () => {
  await closeCheckInActivityPublisher();
  config.nodeEnv = originalNodeEnv;
  config.redisUrl = originalRedisUrl;
  redisDouble.reset();
  vi.restoreAllMocks();
});

describe('check-in activity redis fanout', () => {
  it('uses a stable per-list channel name', () => {
    expect(checkInActivityChannel('cil_123')).toBe('tixkit:check-in-list:cil_123:activity');
  });

  it('no-ops publish and subscribe in test env', async () => {
    config.nodeEnv = 'test';
    await expect(publishCheckInActivityEvent('cil_1', 'scan_1')).resolves.toBeUndefined();
    await expect(createCheckInActivitySubscriber('cil_1', async () => undefined)).resolves.toBe(
      undefined,
    );
  });

  it('falls back cleanly when Redis is not configured', async () => {
    config.nodeEnv = 'production';
    config.redisUrl = '';

    await expect(publishCheckInActivityEvent('cil_1', 'scan_1')).resolves.toBeUndefined();
    await expect(createCheckInActivitySubscriber('cil_1', async () => undefined)).resolves.toBe(
      undefined,
    );
  });

  it('publishes and dispatches only the subscribed list channel', async () => {
    config.nodeEnv = 'production';
    config.redisUrl = 'redis://redis.test:6379';
    const onEvent = vi.fn(async () => undefined);

    await publishCheckInActivityEvent('cil_1', 'scan_1');
    expect(redisDouble.instances[0]?.published).toEqual([
      ['tixkit:check-in-list:cil_1:activity', 'scan_1'],
    ]);

    const subscriber = await createCheckInActivitySubscriber('cil_1', onEvent);
    const fakeSubscriber = subscriber as unknown as InstanceType<typeof redisDouble.FakeRedis>;
    fakeSubscriber.emit('message', 'tixkit:check-in-list:other:activity', 'scan_other');
    await Promise.resolve();
    expect(onEvent).not.toHaveBeenCalled();

    fakeSubscriber.emit('message', 'tixkit:check-in-list:cil_1:activity', 'scan_1');
    await Promise.resolve();
    expect(onEvent).toHaveBeenCalledTimes(1);
    subscriber?.disconnect();
    expect(fakeSubscriber.disconnected).toBe(true);
  });

  it('recreates the singleton publisher after a transient connection failure', async () => {
    config.nodeEnv = 'production';
    config.redisUrl = 'redis://redis.test:6379';
    redisDouble.failNextConnect();

    await expect(publishCheckInActivityEvent('cil_1', 'scan_1')).resolves.toBeUndefined();
    expect(redisDouble.instances).toHaveLength(1);
    expect(redisDouble.instances[0]?.disconnected).toBe(true);

    await expect(publishCheckInActivityEvent('cil_1', 'scan_2')).resolves.toBeUndefined();
    await expect(publishCheckInActivityEvent('cil_1', 'scan_3')).resolves.toBeUndefined();

    expect(redisDouble.instances).toHaveLength(2);
    expect(redisDouble.instances[1]?.connectCalls).toBe(1);
    expect(redisDouble.instances[1]?.published).toEqual([
      ['tixkit:check-in-list:cil_1:activity', 'scan_2'],
      ['tixkit:check-in-list:cil_1:activity', 'scan_3'],
    ]);
  });
});

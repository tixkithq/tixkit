import { Redis } from 'ioredis';
import { config } from '../config/index.js';

/** Redis channel for live door/check-in activity fanout for a single check-in list. */
export const checkInActivityChannel = (checkInListId: string) =>
  `tixkit:check-in-list:${checkInListId}:activity`;

let publisher: InstanceType<typeof Redis> | undefined;
let publisherConnection: Promise<void> | undefined;

function activityPublisher(): InstanceType<typeof Redis> {
  if (publisher) return publisher;
  publisher = new Redis(config.redisUrl, {
    connectTimeout: 1_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  publisher.on('error', () => undefined);
  return publisher;
}

function discardActivityPublisher(redis: InstanceType<typeof Redis>): void {
  if (publisher !== redis) return;
  publisher = undefined;
  publisherConnection = undefined;
  redis.disconnect();
}

/**
 * Best-effort publish after a durable scan_log write.
 * DB remains the source of truth; SSE subscribers re-read on message.
 */
export function publishCheckInActivityEvent(
  checkInListId: string,
  scanLogId: string,
): Promise<void> {
  if (config.nodeEnv === 'test') return Promise.resolve();
  if (!config.redisUrl) return Promise.resolve();
  const redis = activityPublisher();
  publisherConnection ??= redis.connect().then(() => undefined);
  return publisherConnection
    .then(() => redis.publish(checkInActivityChannel(checkInListId), scanLogId))
    .then(() => undefined)
    .catch(() => {
      discardActivityPublisher(redis);
    });
}

export async function closeCheckInActivityPublisher(): Promise<void> {
  const redis = publisher;
  publisher = undefined;
  publisherConnection = undefined;
  if (!redis) return;
  await redis.quit().catch(() => redis.disconnect());
}

/**
 * Subscribe to check-in activity fanout. Returns undefined in tests or when Redis
 * is unavailable so callers can fall back to DB polling.
 */
export async function createCheckInActivitySubscriber(
  checkInListId: string,
  onEvent: () => Promise<void>,
): Promise<InstanceType<typeof Redis> | undefined> {
  if (config.nodeEnv === 'test') return undefined;
  if (!config.redisUrl) return undefined;

  const subscriber = new Redis(config.redisUrl, {
    connectTimeout: 1_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  subscriber.on('error', () => undefined);
  const channel = checkInActivityChannel(checkInListId);
  subscriber.on('message', (receivedChannel: string, _message: string) => {
    if (receivedChannel !== channel) return;
    void onEvent().catch(() => undefined);
  });

  try {
    await subscriber.connect();
    await subscriber.subscribe(channel);
    return subscriber;
  } catch {
    subscriber.disconnect();
    return undefined;
  }
}

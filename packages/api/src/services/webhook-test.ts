export const WEBHOOK_TEST_EVENT_TYPE = 'test.ping' as const;
export const WEBHOOK_TEST_API_VERSION = '2026-07-19' as const;
const SUPPORTED_WEBHOOK_TEST_API_VERSIONS = new Set(['2026-07-17', WEBHOOK_TEST_API_VERSION]);

export type WebhookTestPayload = {
  type: typeof WEBHOOK_TEST_EVENT_TYPE;
  test: true;
  apiVersion: '2026-07-17' | typeof WEBHOOK_TEST_API_VERSION;
  createdAt: string;
  data: { endpointId: string };
};

export function createWebhookTestPayload(endpointId: string, now = new Date()): WebhookTestPayload {
  return {
    type: WEBHOOK_TEST_EVENT_TYPE,
    test: true,
    apiVersion: WEBHOOK_TEST_API_VERSION,
    createdAt: now.toISOString(),
    data: { endpointId },
  };
}

export function isWebhookTestPayload(
  value: unknown,
  endpointId?: string,
): value is WebhookTestPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<WebhookTestPayload>;
  const topLevelKeys = Object.keys(payload).sort();
  const dataKeys =
    payload.data && typeof payload.data === 'object' ? Object.keys(payload.data).sort() : [];
  const createdAt = typeof payload.createdAt === 'string' ? new Date(payload.createdAt) : null;
  return (
    JSON.stringify(topLevelKeys) ===
      JSON.stringify(['apiVersion', 'createdAt', 'data', 'test', 'type']) &&
    JSON.stringify(dataKeys) === JSON.stringify(['endpointId']) &&
    payload.type === WEBHOOK_TEST_EVENT_TYPE &&
    payload.test === true &&
    typeof payload.apiVersion === 'string' &&
    SUPPORTED_WEBHOOK_TEST_API_VERSIONS.has(payload.apiVersion) &&
    createdAt !== null &&
    Number.isFinite(createdAt.getTime()) &&
    createdAt.toISOString() === payload.createdAt &&
    Boolean(payload.data) &&
    typeof payload.data?.endpointId === 'string' &&
    (!endpointId || payload.data.endpointId === endpointId)
  );
}

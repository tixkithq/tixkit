export const WEBHOOK_TEST_EVENT_TYPE = 'test.ping' as const;

export type WebhookTestPayload = {
  type: typeof WEBHOOK_TEST_EVENT_TYPE;
  test: true;
  apiVersion: '2026-07-17';
  createdAt: string;
  data: { endpointId: string };
};

export function createWebhookTestPayload(endpointId: string, now = new Date()): WebhookTestPayload {
  return {
    type: WEBHOOK_TEST_EVENT_TYPE,
    test: true,
    apiVersion: '2026-07-17',
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
    payload.apiVersion === '2026-07-17' &&
    createdAt !== null &&
    Number.isFinite(createdAt.getTime()) &&
    createdAt.toISOString() === payload.createdAt &&
    Boolean(payload.data) &&
    typeof payload.data?.endpointId === 'string' &&
    (!endpointId || payload.data.endpointId === endpointId)
  );
}

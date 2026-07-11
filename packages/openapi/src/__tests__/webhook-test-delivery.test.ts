import { describe, expect, it } from 'vitest';
import { openApiSpec } from '../index.js';

describe('synthetic webhook delivery contract', () => {
  it('documents a permissioned, rate-limited asynchronous test operation', () => {
    const operation = openApiSpec.paths['/webhook-endpoints/{endpointId}/test'].post;
    expect(operation.operationId).toBe('postWebhookEndpointsByEndpointIdTest');
    expect(operation['x-required-permissions']).toEqual(['developers.write']);
    expect(operation.responses['202'].content['application/json'].schema).toMatchObject({
      additionalProperties: false,
      required: ['queued', 'test', 'eventId', 'endpointId'],
    });
    expect(operation.responses).toHaveProperty('429');
    expect(operation.description).toContain('Never creates payment');
  });
});

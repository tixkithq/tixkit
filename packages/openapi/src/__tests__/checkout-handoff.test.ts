import { describe, expect, it } from 'vitest';
import { openApiSpec } from '../index.js';

describe('hosted checkout handoff contract', () => {
  it('documents the authenticated handoff creation and hosted exchange operations', () => {
    const create = openApiSpec.paths['/checkout/sessions/{sessionId}/handoff'].post;
    expect(create.operationId).toBe('postCheckoutSessionsBySessionIdHandoff');
    expect(create.parameters).toContainEqual({
      $ref: '#/components/parameters/CheckoutSessionToken',
    });
    expect(create.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CheckoutHostedHandoff',
    });

    const exchange = openApiSpec.paths['/checkout/sessions/{sessionId}/handoff/exchange'].post;
    expect(exchange.requestBody.content['application/json'].schema).toMatchObject({
      required: ['handoff'],
      additionalProperties: false,
    });
  });

  it('does not expose session or provider credentials in the handoff response schema', () => {
    const schema = openApiSpec.components.schemas.CheckoutHostedHandoff;
    expect(schema.required).toEqual(['url', 'expiresAt']);
    expect(Object.keys(schema.properties)).toEqual(['url', 'expiresAt']);
    expect(JSON.stringify(schema)).not.toMatch(/clientToken|clientSecret|paymentIntent/iu);
  });
});

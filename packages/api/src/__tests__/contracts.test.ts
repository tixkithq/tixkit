import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ValidationError } from '@tixkit/domain';
import { registerErrorHandler } from '../app.js';
import { pageEnvelope, parsePagination } from '../http/contracts.js';

describe('API contract helpers', () => {
  it('parses cursor pagination with documented defaults and max limit', () => {
    expect(parsePagination(undefined)).toEqual({ cursor: undefined, limit: 50 });
    expect(parsePagination({ limit: '25', cursor: 'evt_01' })).toEqual({
      cursor: 'evt_01',
      limit: 25,
    });
    expect(parsePagination({ limit: '001' })).toEqual({ cursor: undefined, limit: 1 });
    expect(parsePagination({ limit: '500' })).toEqual({ cursor: undefined, limit: 100 });
  });

  it('rejects invalid pagination limits with the shared validation error', () => {
    expect(() => parsePagination({ limit: '0' })).toThrow(ValidationError);
    expect(() => parsePagination({ limit: 'not-a-number' })).toThrow(ValidationError);
    expect(() => parsePagination({ limit: '1abc' })).toThrow(ValidationError);
    expect(() => parsePagination({ limit: '1.9' })).toThrow(ValidationError);
    expect(() => parsePagination({ limit: 1.9 })).toThrow(ValidationError);
  });

  it('returns the documented page envelope and cursor from the last emitted item', () => {
    expect(pageEnvelope([{ id: 'row_1' }, { id: 'row_2' }, { id: 'row_3' }], 2)).toEqual({
      items: [{ id: 'row_1' }, { id: 'row_2' }],
      nextCursor: 'row_2',
      hasMore: true,
    });

    expect(pageEnvelope([{ id: 'row_1' }], 2)).toEqual({
      items: [{ id: 'row_1' }],
      nextCursor: null,
      hasMore: false,
    });
  });
});

describe('API error envelope', () => {
  it('serializes domain errors with code, message, and requestId', async () => {
    const app = Fastify({ logger: false, genReqId: () => 'req_contract' });
    registerErrorHandler(app);
    app.get('/validation', async () => {
      throw new ValidationError('limit must be a positive integer');
    });

    const response = await app.inject({ method: 'GET', url: '/validation' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'limit must be a positive integer',
        requestId: 'req_contract',
      },
    });
    await app.close();
  });

  it('serializes unhandled errors without leaking details', async () => {
    const app = Fastify({ logger: false, genReqId: () => 'req_contract' });
    registerErrorHandler(app);
    app.get('/internal', async () => {
      throw new Error('database password leaked in stack');
    });

    const response = await app.inject({ method: 'GET', url: '/internal' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
        requestId: 'req_contract',
      },
    });
    await app.close();
  });
});

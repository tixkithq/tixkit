import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  executeProviderHttp,
  parseRetryAfter,
  PlivoMessagingClient,
  ProviderOperationError,
  ResendMessagingClient,
  sanitizeBodyPreview,
  TelnyxMessagingClient,
  TwilioMessagingClient,
  VonageMessagingClient,
  type ProviderHttpRequest,
  type ProviderIncidentScope,
  type SmsMessageInput,
} from '../index.js';

const baseRequest = (
  overrides: Partial<ProviderHttpRequest<Record<string, unknown>>> = {},
): ProviderHttpRequest<Record<string, unknown>> => ({
  dependency: 'example',
  operation: 'create-resource',
  method: 'POST',
  url: 'https://provider.test/resources',
  body: JSON.stringify({ value: true }),
  fetch: vi.fn(async () => Response.json({ id: 'resource_1' })),
  ...overrides,
});

async function operationError(promise: Promise<unknown>): Promise<ProviderOperationError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderOperationError);
    return error as ProviderOperationError;
  }
  throw new Error('Expected provider operation to fail');
}

describe('executeProviderHttp', () => {
  it('propagates idempotency and API version headers and emits bounded telemetry', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const telemetry: unknown[] = [];
    const diagnostics: unknown[] = [];
    const result = await executeProviderHttp(
      baseRequest({
        fetch: async (url, init) => {
          calls.push({ url: String(url), init: init ?? {} });
          return Response.json(
            { id: 'resource_1' },
            { status: 201, headers: { 'request-id': 'req_safe_1' } },
          );
        },
        idempotency: { key: 'idem_1' },
        apiVersion: { header: 'Provider-Version', value: '2026-07-16' },
        onTelemetry: (event) => telemetry.push(event),
        onDiagnostic: (event) => {
          diagnostics.push(event);
        },
      }),
    );

    const headers = new Headers(calls[0]?.init.headers);
    expect(calls).toHaveLength(1);
    expect(headers.get('idempotency-key')).toBe('idem_1');
    expect(headers.get('provider-version')).toBe('2026-07-16');
    expect(result.providerRequestId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(result.providerRequestId).not.toContain('req_safe_1');
    expect(result.diagnostic).toEqual({
      status: 201,
      statusText: 'Created',
      contentType: 'application/json',
      responseBytes: 19,
      responseClassification: 'json',
      bodyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      providerRequestId: result.providerRequestId,
    });
    expect(Object.isFrozen(result.diagnostic)).toBe(true);
    expect(diagnostics).toEqual([
      {
        dependency: 'example',
        operation: 'create-resource',
        method: 'POST',
        envelope: result.diagnostic,
      },
    ]);
    expect(Object.isFrozen(diagnostics[0])).toBe(true);
    expect(telemetry).toEqual([
      expect.objectContaining({
        dependency: 'example',
        operation: 'create-resource',
        method: 'POST',
        outcome: 'success',
        serviceOutcome: 'success',
        retryable: false,
        status: 201,
      }),
    ]);
    expect(Object.isFrozen(telemetry[0])).toBe(true);
    expect(JSON.stringify(telemetry)).not.toContain('provider.test');
    expect(JSON.stringify(telemetry)).not.toContain('idem_1');
  });

  it('exports an exact request ID only through an explicitly scoped incident callback', async () => {
    const incidents: unknown[] = [];
    const result = await executeProviderHttp(
      baseRequest({
        incidentScope: { tenantId: 'tenant_01', organizationId: 'org_01' },
        onExactRequestId: async (event) => {
          incidents.push(event);
        },
        fetch: async () =>
          Response.json(
            { id: 'resource_1' },
            { status: 200, headers: { 'request-id': 'req_exact_support_01' } },
          ),
      }),
    );

    expect(incidents).toEqual([
      {
        dependency: 'example',
        operation: 'create-resource',
        exactRequestId: 'req_exact_support_01',
        requestIdHash: result.providerRequestId,
        scope: { tenantId: 'tenant_01', organizationId: 'org_01' },
      },
    ]);
    expect(Object.isFrozen(incidents[0])).toBe(true);
    expect(Object.isFrozen((incidents[0] as { scope: object }).scope)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('req_exact_support_01');
    expect(JSON.stringify(result.diagnostic)).not.toContain('req_exact_support_01');
  });

  it.each([
    ['missing scope', 'req_exact_support_02', undefined],
    [
      'unsafe exact ID',
      'req exact support with buyer@example.com',
      { tenantId: 'tenant_01', organizationId: 'org_01' },
    ],
    [
      'oversized exact ID',
      `req_${'x'.repeat(256)}`,
      { tenantId: 'tenant_01', organizationId: 'org_01' },
    ],
  ] satisfies ReadonlyArray<[string, string, ProviderIncidentScope | undefined]>)(
    'does not export an exact request ID with %s',
    async (_label, requestId, incidentScope) => {
      const incident = vi.fn(async () => undefined);
      const result = await executeProviderHttp(
        baseRequest({
          incidentScope,
          onExactRequestId: incident,
          fetch: async () =>
            Response.json(
              { id: 'resource_1' },
              { status: 200, headers: { 'request-id': requestId } },
            ),
        }),
      );

      expect(incident).not.toHaveBeenCalled();
      expect(result.providerRequestId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    },
  );

  it.each([200, 503])('contains exact request-ID sink failures for HTTP %i', async (status) => {
    const request = baseRequest({
      incidentScope: { tenantId: 'tenant_01', organizationId: 'org_01' },
      onExactRequestId: async () => {
        throw new Error('exact incident sink failure with req_secret_support_value');
      },
      fetch: async () =>
        Response.json(
          { id: 'resource_1' },
          { status, headers: { 'request-id': 'req_exact_support_03' } },
        ),
    });

    if (status === 200) await executeProviderHttp(request);
    else await operationError(executeProviderHttp(request));
  });

  it('bounds a never-settling exact request-ID sink independently from provider execution', async () => {
    const startedAt = performance.now();
    const result = await executeProviderHttp(
      baseRequest({
        incidentScope: { tenantId: 'tenant_01', organizationId: 'org_01' },
        onExactRequestId: () => new Promise<void>(() => undefined),
        fetch: async () =>
          Response.json(
            { id: 'resource_1' },
            { status: 200, headers: { 'request-id': 'req_never_settles_01' } },
          ),
      }),
    );

    expect(result.data).toEqual({ id: 'resource_1' });
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  it.each(['', ' '.repeat(4), ' padded-key ', 'x'.repeat(256), 'safe-prefix\nunsafe-suffix'])(
    'rejects invalid idempotency key %j before dispatch',
    async (idempotencyKey) => {
      const fetchMock = vi.fn(async () => Response.json({ id: 'must_not_send' }));
      const error = await operationError(
        executeProviderHttp(
          baseRequest({
            fetch: fetchMock,
            idempotency: { key: idempotencyKey },
          }),
        ),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(error).toMatchObject({
        kind: 'validation',
        retryable: false,
        deliveryState: 'not-sent',
        safeToFailover: false,
        details: { providerCode: 'idempotency_invalid' },
      });
    },
  );

  it.each([
    ['invalid JSON', '{'],
    ['unexpected HTML', '<html><body>upstream proxy</body></html>'],
    ['empty body', ''],
  ])('rejects a successful %s response', async (_label, body) => {
    const error = await operationError(
      executeProviderHttp(baseRequest({ fetch: async () => new Response(body, { status: 200 }) })),
    );
    expect(error).toMatchObject({
      kind: 'malformed-response',
      retryable: false,
      deliveryState: 'accepted',
      safeToFailover: false,
    });
  });

  it('rejects a response before buffering beyond the configured limit', async () => {
    const error = await operationError(
      executeProviderHttp(
        baseRequest({
          fetch: async () => Response.json({ payload: 'x'.repeat(2_000) }),
          maxResponseBytes: 1_024,
        }),
      ),
    );
    expect(error.kind).toBe('malformed-response');
    expect(error.details.bodyPreview).toBeUndefined();
    expect(error.details.diagnostic).toBeUndefined();
  });

  it('classifies rate limits with Retry-After and a safe request identifier', async () => {
    const error = await operationError(
      executeProviderHttp(
        baseRequest({
          fetch: async () =>
            Response.json(
              { code: 'rate_limited', email: 'buyer@example.com' },
              {
                status: 429,
                headers: {
                  'retry-after': '2.5',
                  'x-provider-request-id': 'req_rate_1',
                },
              },
            ),
        }),
      ),
    );
    expect(error).toMatchObject({
      kind: 'rate-limit',
      retryable: true,
      deliveryState: 'rejected',
      safeToFailover: true,
      details: {
        status: 429,
        providerCode: undefined,
        retryAfterMs: 2_500,
      },
    });
    expect(error.details.providerRequestId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(error.details.providerRequestId).not.toContain('req_rate_1');
    expect(error.details.bodyPreview).not.toContain('buyer@example.com');
    expect(error.details.diagnostic).toEqual({
      status: 429,
      statusText: 'Too Many Requests',
      contentType: 'application/json',
      responseBytes: expect.any(Number),
      responseClassification: 'json',
      bodyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      retryAfterMs: 2_500,
      providerRequestId: error.details.providerRequestId,
    });
    const retryError = error.forRetry();
    expect(retryError).toMatchObject({
      safeToFailover: false,
      details: {
        status: 429,
        providerRequestId: error.details.providerRequestId,
        retryAfterMs: 2_500,
      },
    });
    expect(retryError.details.providerCode).toBeUndefined();
    expect(retryError.details.bodyPreview).toBeUndefined();
    expect(retryError.details.diagnostic).toEqual(error.details.diagnostic);
  });

  it('classifies support-safe wire evidence without retaining hostile status or content metadata', async () => {
    const rawBody = '<html><body>Alice buyer@example.com sk_live_secret</body></html>';
    const error = await operationError(
      executeProviderHttp(
        baseRequest({
          fetch: async () =>
            new Response(rawBody, {
              status: 502,
              statusText: 'Alice buyer@example.com sk_live_status_secret',
              headers: {
                'content-type': 'TEXT/HTML; charset=utf-8; secret=sk_live_parameter',
                'request-id': 'req_exact_secret_value',
              },
            }),
        }),
      ),
    );

    expect(error.details.diagnostic).toEqual({
      status: 502,
      statusText: 'Bad Gateway',
      contentType: 'text/html',
      responseBytes: Buffer.byteLength(rawBody),
      responseClassification: 'html',
      bodyDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      providerRequestId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(error.details.diagnostic)).not.toMatch(
      /Alice|buyer@example\.com|sk_live|req_exact_secret_value/u,
    );
    const retrySerialized = JSON.stringify(error.forRetry());
    expect(retrySerialized).not.toMatch(
      /Alice|buyer@example\.com|sk_live|req_exact_secret_value|charset|secret=/u,
    );
  });

  it.each([true, false])(
    'rejects invalid UTF-8 by digest and size when expectJson=%s',
    async (expectJson) => {
      const hostileBytes = new Uint8Array([
        0xff, 0xfe, 0x00, 0x73, 0x6b, 0x5f, 0x6c, 0x69, 0x76, 0x65,
      ]);
      const error = await operationError(
        executeProviderHttp(
          baseRequest({
            expectJson,
            fetch: async () =>
              new Response(hostileBytes, {
                status: 200,
                headers: { 'content-type': 'application/octet-stream' },
              }),
          }),
        ),
      );

      expect(error).toMatchObject({
        kind: 'malformed-response',
        deliveryState: 'accepted',
      });
      expect(error.details.diagnostic).toEqual({
        status: 200,
        statusText: 'OK',
        contentType: 'application/octet-stream',
        responseBytes: hostileBytes.byteLength,
        responseClassification: 'invalid-utf8',
        bodyDigest: `sha256:${createHash('sha256').update(hostileBytes).digest('hex')}`,
      });
      expect(JSON.stringify(error)).not.toContain('sk_live');
    },
  );

  it('decodes a UTF-8 code point split across response chunks', async () => {
    const bytes = new TextEncoder().encode('safe 🌍 response');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 7));
        controller.enqueue(bytes.subarray(7, 9));
        controller.enqueue(bytes.subarray(9));
        controller.close();
      },
    });
    const request: ProviderHttpRequest<string> = {
      dependency: 'example',
      operation: 'read-text',
      method: 'GET',
      url: 'https://provider.test/text',
      expectJson: false,
      fetch: async () => new Response(body, { status: 200 }),
    };
    const result = await executeProviderHttp(request);

    expect(result.data).toBe('safe 🌍 response');
    expect(result.diagnostic).toMatchObject({
      responseBytes: bytes.byteLength,
      responseClassification: 'text',
      bodyDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
  });

  it('keeps diagnostic exporter failures out of provider operation semantics', async () => {
    const result = await executeProviderHttp(
      baseRequest({
        onDiagnostic: () => {
          throw new Error('diagnostic sink unavailable with sk_live_sink_secret');
        },
      }),
    );

    expect(result.data).toEqual({ id: 'resource_1' });
    expect(result.diagnostic.responseClassification).toBe('json');
  });

  it.each([200, 503])(
    'contains rejected asynchronous diagnostic exporters for HTTP %i',
    async (status) => {
      const request = baseRequest({
        fetch: async () => Response.json({ id: 'resource_1' }, { status }),
        onDiagnostic: async () => {
          throw new Error('async diagnostic failure with sk_live_sink_secret');
        },
      });

      if (status === 200) await executeProviderHttp(request);
      else await operationError(executeProviderHttp(request));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  );

  it('strips hostile parser failures from normalized errors', async () => {
    const error = await operationError(
      executeProviderHttp(
        baseRequest({
          parse: () => {
            throw new Error('buyer@example.com sk_live_parser_secret');
          },
        }),
      ),
    );
    expect(error).toMatchObject({
      kind: 'malformed-response',
      retryable: false,
    });
    expect(error.cause).toBeUndefined();
    expect(`${error.message}${JSON.stringify(error)}`).not.toMatch(
      /buyer@example\.com|sk_live_parser_secret/u,
    );
  });

  it('strips hostile response-stream failures from normalized errors', async () => {
    const error = await operationError(
      executeProviderHttp(
        baseRequest({
          fetch: async () =>
            new Response(
              new ReadableStream({
                pull(controller) {
                  controller.error(new Error('Alice buyer@example.com sk_live_stream_secret'));
                },
              }),
              { status: 200 },
            ),
        }),
      ),
    );
    expect(error).toMatchObject({
      kind: 'malformed-response',
      retryable: false,
    });
    expect(error.cause).toBeUndefined();
    expect(`${error.message}${JSON.stringify(error)}`).not.toMatch(
      /Alice|buyer@example\.com|sk_live_stream_secret/u,
    );
    expect(error.details.diagnostic).toBeUndefined();
  });

  it.each([500, 502, 503, 504])(
    'classifies side-effecting HTTP %i as non-retryable with unknown delivery',
    async (status) => {
      const fetchMock = vi.fn(async () => Response.json({ code: 'upstream' }, { status }));
      const error = await operationError(executeProviderHttp(baseRequest({ fetch: fetchMock })));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(error).toMatchObject({
        kind: 'server',
        retryable: false,
        deliveryState: 'unknown',
        safeToFailover: false,
      });
    },
  );

  it.each([501, 507])(
    'classifies non-retryable HTTP %i as an ambiguous server failure',
    async (status) => {
      const fetchMock = vi.fn(async () => Response.json({ code: 'upstream' }, { status }));
      const error = await operationError(executeProviderHttp(baseRequest({ fetch: fetchMock })));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(error).toMatchObject({
        kind: 'server',
        retryable: false,
        deliveryState: 'unknown',
        safeToFailover: false,
        details: { status },
      });
    },
  );

  it('classifies permanent provider validation as rejected and non-retryable', async () => {
    const error = await operationError(
      executeProviderHttp(
        baseRequest({
          fetch: async () => Response.json({ code: 'invalid_request' }, { status: 422 }),
        }),
      ),
    );
    expect(error).toMatchObject({
      kind: 'validation',
      retryable: false,
      deliveryState: 'rejected',
      safeToFailover: true,
    });
  });

  it('classifies a deadline as an ambiguous timeout and performs one fetch', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const error = await operationError(
      executeProviderHttp(baseRequest({ fetch: fetchMock, deadlineMs: 5 })),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      kind: 'timeout',
      retryable: false,
      deliveryState: 'unknown',
      safeToFailover: false,
    });
  });

  it('enforces the deadline when an injected fetch ignores AbortSignal', async () => {
    const fetchMock = vi.fn(async (): Promise<Response> => new Promise(() => {}));
    const error = await operationError(
      executeProviderHttp(baseRequest({ fetch: fetchMock, deadlineMs: 5 })),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      kind: 'timeout',
      retryable: false,
      deliveryState: 'unknown',
      safeToFailover: false,
    });
  });

  it('classifies a deadline while reading a stalled body as an ambiguous timeout', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const error = await operationError(
      executeProviderHttp(baseRequest({ fetch: fetchMock, deadlineMs: 5 })),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      kind: 'timeout',
      retryable: false,
      deliveryState: 'unknown',
      safeToFailover: false,
    });
  });

  it('enforces the deadline when a response body ignores AbortSignal', async () => {
    let rejectLateRead: ((error: Error) => void) | undefined;
    let cancellations = 0;
    const telemetry: unknown[] = [];
    const body = new ReadableStream<Uint8Array>({
      pull: async () =>
        new Promise((_resolve, reject) => {
          rejectLateRead = reject;
        }),
      cancel() {
        cancellations += 1;
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const error = await operationError(
      executeProviderHttp(
        baseRequest({
          fetch: fetchMock,
          deadlineMs: 5,
          onTelemetry: (event) => telemetry.push(event),
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      kind: 'timeout',
      retryable: false,
      deliveryState: 'unknown',
      safeToFailover: false,
    });
    expect(cancellations).toBe(1);
    expect(body.locked).toBe(false);
    expect(telemetry).toEqual([
      expect.objectContaining({
        outcome: 'timeout',
        serviceOutcome: 'platform_failure',
      }),
    ]);
    rejectLateRead?.(new Error('late provider failure with buyer@example.com'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(telemetry).toHaveLength(1);
  });

  it('classifies caller cancellation while reading a body without claiming rejection', async () => {
    const owner = new AbortController();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      setTimeout(() => owner.abort('owner cancelled'), 0);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const error = await operationError(
      executeProviderHttp(
        baseRequest({
          fetch: fetchMock,
          signal: owner.signal,
          deadlineMs: 1_000,
        }),
      ),
    );

    expect(error).toMatchObject({
      kind: 'cancelled',
      retryable: false,
      deliveryState: 'unknown',
      safeToFailover: false,
    });
  });

  it('classifies DNS and connection failures without exposing the requested URL', async () => {
    const fetchMock = vi.fn(async () =>
      Promise.reject(new TypeError('getaddrinfo ENOTFOUND provider.test buyer@example.com')),
    );
    const error = await operationError(executeProviderHttp(baseRequest({ fetch: fetchMock })));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      kind: 'transport',
      retryable: false,
      safeToFailover: false,
    });
    expect(JSON.stringify(error)).not.toContain('provider.test');
    expect(error.cause).toBeUndefined();
  });

  it('keeps an idempotent GET transport failure retryable', async () => {
    const fetchMock = vi.fn(async () => Promise.reject(new TypeError('connection reset')));
    const error = await operationError(
      executeProviderHttp(baseRequest({ method: 'GET', body: undefined, fetch: fetchMock })),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      kind: 'transport',
      retryable: true,
      deliveryState: 'unknown',
      safeToFailover: false,
    });
  });

  it.each([301, 302, 303, 307, 308])(
    'rejects HTTP %i redirects without replaying credentials or body',
    async (status) => {
      for (const location of [
        'https://provider.test/other',
        'https://attacker.test/collect?customer=buyer@example.com',
      ]) {
        const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
          expect(init?.redirect).toBe('error');
          return new Response(null, { status, headers: { location } });
        });
        const error = await operationError(
          executeProviderHttp(
            baseRequest({
              fetch: fetchMock,
              headers: { Authorization: 'Bearer sk_test_never_log' },
              body: JSON.stringify({
                recipient: 'buyer@example.com',
                content: 'private',
              }),
            }),
          ),
        );
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(error).toMatchObject({
          kind: 'malformed-response',
          retryable: false,
          deliveryState: 'unknown',
          safeToFailover: false,
          details: { status },
        });
        expect(error.details.bodyPreview).toBeUndefined();
        const normalized = `${error.message}\n${JSON.stringify(error)}`;
        expect(normalized).not.toContain('attacker.test');
        expect(normalized).not.toContain('buyer@example.com');
        expect(normalized).not.toContain('sk_test_never_log');
      }
    },
  );

  it('normalizes fetch redirect rejection without retaining unsafe implementation details', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError(
        'redirect rejected to https://attacker.test/?recipient=buyer@example.com&token=sk_test_secret',
      );
    });
    const error = await operationError(executeProviderHttp(baseRequest({ fetch: fetchMock })));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      kind: 'transport',
      retryable: false,
      deliveryState: 'unknown',
      safeToFailover: false,
    });
    expect(error.cause).toBeUndefined();
    expect(`${error.message}\n${JSON.stringify(error)}`).not.toMatch(
      /attacker\.test|buyer@example\.com|sk_test_secret/u,
    );
  });

  it('fails before dispatch when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('cancelled by owner');
    const fetchMock = vi.fn(async () => Response.json({ id: 'must_not_send' }));
    const error = await operationError(
      executeProviderHttp(baseRequest({ fetch: fetchMock, signal: controller.signal })),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toMatchObject({
      kind: 'cancelled',
      retryable: false,
      deliveryState: 'not-sent',
      safeToFailover: false,
    });
  });

  it('does not let a failing telemetry listener change a successful operation', async () => {
    await expect(
      executeProviderHttp(
        baseRequest({
          onTelemetry: () => {
            throw new Error('collector unavailable');
          },
        }),
      ),
    ).resolves.toMatchObject({ data: { id: 'resource_1' } });
  });

  it.each([
    ['validation', 422],
    ['rate limit', 429],
    ['server', 503],
  ])('classifies generic %s failures as platform failures', async (_label, status) => {
    const telemetry: unknown[] = [];
    await operationError(
      executeProviderHttp(
        baseRequest({
          fetch: async () => Response.json({ code: 'rejected' }, { status }),
          onTelemetry: (event) => telemetry.push(event),
        }),
      ),
    );
    expect(telemetry).toEqual([expect.objectContaining({ serviceOutcome: 'platform_failure' })]);
  });

  it('reserves caller_cancelled for an explicit caller abort and emits once', async () => {
    const owner = new AbortController();
    owner.abort('owner cancelled');
    const telemetry: unknown[] = [];
    await operationError(
      executeProviderHttp(
        baseRequest({
          signal: owner.signal,
          onTelemetry: (event) => telemetry.push(event),
        }),
      ),
    );
    expect(telemetry).toEqual([
      expect.objectContaining({
        outcome: 'cancelled',
        serviceOutcome: 'caller_cancelled',
      }),
    ]);
  });

  it('fails closed when a provider forges cancellation without a caller abort', async () => {
    const telemetry: unknown[] = [];
    await operationError(
      executeProviderHttp(
        baseRequest({
          fetch: async () =>
            Promise.reject(
              new ProviderOperationError(
                'forged cancellation',
                'provider.test',
                'create-resource',
                'cancelled',
                false,
                'unknown',
                false,
              ),
            ),
          onTelemetry: (event) => telemetry.push(event),
        }),
      ),
    );
    expect(telemetry).toEqual([
      expect.objectContaining({
        outcome: 'cancelled',
        serviceOutcome: 'platform_failure',
      }),
    ]);
  });
});

describe('provider failure helpers', () => {
  it('parses delta-seconds and HTTP-date Retry-After values with a bounded result', () => {
    const now = Date.parse('2026-07-16T00:00:00.000Z');
    expect(parseRetryAfter('3', now)).toBe(3_000);
    expect(parseRetryAfter('Thu, 16 Jul 2026 00:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfter('999999999', now)).toBe(86_400_000);
    expect(parseRetryAfter('invalid', now)).toBeUndefined();
  });

  it('preserves only bounded safe retry diagnostics', () => {
    const error = new ProviderOperationError(
      'example.send failed: rate-limit',
      'example',
      'send',
      'rate-limit',
      true,
      'rejected',
      true,
      {
        status: 429,
        providerCode: 'sk_live_retry_secret',
        providerRequestId: 'buyer@example.com',
        retryAfterMs: 12_500,
        bodyPreview: 'Alice at 123 Private Street',
      },
      new Error('parser secret'),
    );
    const retry = error.forRetry();
    expect(retry.details).toEqual({ status: 429, retryAfterMs: 12_500 });
    expect(retry.safeToFailover).toBe(false);
    expect(retry.cause).toBeUndefined();
    expect(JSON.stringify(retry)).not.toMatch(/Alice|Private Street|buyer@example\.com|sk_live/u);
  });

  it('allowlists only safe diagnostic primitives from hostile structured payloads', () => {
    const preview = sanitizeBodyPreview(
      JSON.stringify({
        code: 'rate_limited',
        type: 'invalid_request',
        name: 'Buyer Name',
        message: 'Card declined for buyer@example.com',
        customer_name: 'Buyer Name',
        shipping_address: {
          line1: '123 Private Street',
          code: 'must_not_escape',
        },
        recipient: 'buyer@example.com',
        content: '<p>private message</p>',
        authorization: 'Bearer token-value',
        client_secret: 'sk_test_secret',
        email: 'buyer@example.com',
        phone: '+15551234567',
        error: {
          error_code: 'E_REJECTED',
          message: 'Bearer abcdef buyer@example.com +15551234567',
          customer: { code: 'customer_secret_code', name: 'Buyer Name' },
        },
        errors: [
          { code: 'invalid_recipient', message: 'buyer@example.com' },
          { name: 'Buyer Name', shipping_address: '123 Private Street' },
        ],
      }),
    );
    expect(JSON.parse(preview)).toEqual({
      code: '[REDACTED]',
      type: '[REDACTED]',
      error: { error_code: '[REDACTED]' },
      errors: [{ code: '[REDACTED]' }, {}],
    });
    expect(preview).not.toMatch(
      /Buyer Name|buyer@example\.com|Private Street|private message|token-value|sk_test_secret|customer_secret_code/u,
    );
  });

  it('rejects unsafe diagnostic values and bounds UTF-8 previews to the configured byte limit', () => {
    const preview = sanitizeBodyPreview(
      JSON.stringify({
        code: 'buyer@example.com',
        type: 'x'.repeat(129),
        errors: Array.from({ length: 20 }, (_, index) => ({
          code: `diagnostic_${index}`,
        })),
      }),
      64,
    );
    expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(64);
    expect(preview.endsWith('…')).toBe(true);
    expect(preview).not.toContain('buyer@example.com');
    expect(preview).not.toContain('x'.repeat(129));
  });

  it('hashes provider request identifiers instead of retaining provider-controlled values', async () => {
    const error = await operationError(
      executeProviderHttp(
        baseRequest({
          fetch: async () =>
            Response.json(
              { code: 'sk_live_SUPERSECRET123' },
              {
                status: 400,
                headers: {
                  'request-id': 'whsec_secret123 Alice ticket_ABC123 15551234567',
                },
              },
            ),
        }),
      ),
    );
    const serialized = JSON.stringify(error);
    expect(error.details.providerCode).toBeUndefined();
    expect(error.details.providerRequestId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(serialized).not.toMatch(
      /sk_live_SUPERSECRET123|whsec_secret123|Alice|ticket_ABC123|15551234567/u,
    );
  });

  it.each([
    '<html><body>Alice seat A4 buyer@example.com</body></html>',
    'Delivery failed for Alice at 123 Private Street',
    '{invalid JSON containing recipient +15551234567',
  ])('fully redacts unstructured provider payload %s', (payload) => {
    expect(sanitizeBodyPreview(payload)).toBe('[REDACTED]');
  });
});

const sms: SmsMessageInput = {
  from: '+15550000001',
  to: '+15550000002',
  body: 'Tixkit update',
  idempotencyKey: 'sms_idem_1',
  webhookUrl: 'https://hooks.test/status',
};

describe('messaging clients', () => {
  it('fails before dispatch when required provider credentials are absent', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'must_not_send' }));
    const client = new TelnyxMessagingClient({ apiKey: '' }, { fetch: fetchMock });
    const error = await operationError(client.sendSms(sms));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toMatchObject({
      kind: 'validation',
      retryable: false,
      deliveryState: 'not-sent',
      safeToFailover: false,
      details: { providerCode: 'configuration_missing' },
    });
  });

  it('rejects missing idempotency keys for every messaging client before dispatch', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'must_not_send' }));
    const invalidSms = { ...sms, idempotencyKey: '' };
    const attempts = [
      () => new TelnyxMessagingClient({ apiKey: 'key' }, { fetch: fetchMock }).sendSms(invalidSms),
      () =>
        new TwilioMessagingClient(
          { accountSid: 'AC123', authToken: 'secret' },
          { fetch: fetchMock },
        ).sendSms(invalidSms),
      () =>
        new VonageMessagingClient(
          { apiKey: 'key', apiSecret: 'secret' },
          { fetch: fetchMock },
        ).sendSms(invalidSms),
      () =>
        new PlivoMessagingClient(
          { authId: 'MA123', authToken: 'secret' },
          { fetch: fetchMock },
        ).sendSms(invalidSms),
      () =>
        new ResendMessagingClient({ apiKey: 're_key' }, { fetch: fetchMock }).sendEmail({
          from: 'sender@example.com',
          to: ['buyer@example.com'],
          subject: 'Tickets',
          html: '<p>Tickets</p>',
          idempotencyKey: '',
        }),
    ];
    for (const attempt of attempts) {
      const error = await operationError(attempt());
      expect(error).toMatchObject({
        kind: 'validation',
        retryable: false,
        deliveryState: 'not-sent',
        safeToFailover: false,
        details: { providerCode: 'idempotency_invalid' },
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects insecure or unexpected provider base URLs before dispatch', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'must_not_send' }));
    const attempts = [
      () =>
        new TelnyxMessagingClient(
          { apiKey: 'key', baseUrl: 'http://api.telnyx.com/v2' },
          { fetch: fetchMock },
        ).sendSms(sms),
      () =>
        new TwilioMessagingClient(
          {
            accountSid: 'AC123',
            authToken: 'secret',
            baseUrl: 'https://attacker.example/2010-04-01',
          },
          { fetch: fetchMock },
        ).sendSms(sms),
      () =>
        new VonageMessagingClient(
          {
            apiKey: 'key',
            apiSecret: 'secret',
            baseUrl: 'https://user:secret@rest.nexmo.com',
          },
          { fetch: fetchMock },
        ).sendSms(sms),
      () =>
        new PlivoMessagingClient(
          {
            authId: 'MA123',
            authToken: 'secret',
            baseUrl: 'https://api.plivo.com/v1?target=bad',
          },
          { fetch: fetchMock },
        ).sendSms(sms),
      () =>
        new ResendMessagingClient(
          { apiKey: 're_key', baseUrl: 'https://attacker.example' },
          { fetch: fetchMock },
        ).sendEmail({
          from: 'sender@example.com',
          to: ['buyer@example.com'],
          subject: 'Tickets',
          html: '<p>Tickets</p>',
          idempotencyKey: 'email_idem_invalid_base',
        }),
    ];
    for (const attempt of attempts) {
      const error = await operationError(attempt());
      expect(error).toMatchObject({
        kind: 'validation',
        retryable: false,
        deliveryState: 'not-sent',
        safeToFailover: false,
        details: { providerCode: 'configuration_invalid' },
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not permit the .test base-URL seam in a production runtime', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const fetchMock = vi.fn(async () => Response.json({ id: 'must_not_send' }));
      const client = new ResendMessagingClient(
        { apiKey: 're_key', baseUrl: 'https://resend.test' },
        { fetch: fetchMock },
      );
      const error = await operationError(
        client.sendEmail({
          from: 'sender@example.com',
          to: ['buyer@example.com'],
          subject: 'Tickets',
          html: '<p>Tickets</p>',
          idempotencyKey: 'email_idem_production_base',
        }),
      );
      expect(error).toMatchObject({
        kind: 'validation',
        deliveryState: 'not-sent',
        details: { providerCode: 'configuration_invalid' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('maps Telnyx v2 and Resend responses through the shared executor', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return String(url).includes('telnyx')
        ? Response.json({ data: { id: 'telnyx_1' } })
        : Response.json({ id: 'resend_1' });
    });
    const telnyx = new TelnyxMessagingClient(
      { apiKey: 'telnyx_key', baseUrl: 'https://telnyx.test/v2' },
      { fetch: fetchMock },
    );
    const resend = new ResendMessagingClient(
      { apiKey: 're_key', baseUrl: 'https://resend.test' },
      { fetch: fetchMock },
    );

    await expect(telnyx.sendSms(sms)).resolves.toEqual({
      providerMessageId: 'telnyx_1',
      accepted: true,
    });
    await expect(
      resend.sendEmail({
        from: 'Tixkit <sender@example.com>',
        to: ['buyer@example.com'],
        subject: 'Tickets',
        html: '<p>Tickets</p>',
        idempotencyKey: 'email_idem_1',
      }),
    ).resolves.toEqual({ providerMessageId: 'resend_1', accepted: true });
    expect(new Headers(requests[0]?.init.headers).get('idempotency-key')).toBe('sms_idem_1');
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      from: '+15550000001',
      to: '+15550000002',
      text: 'Tixkit update',
      type: 'SMS',
      webhook_url: 'https://hooks.test/status',
      use_profile_webhooks: false,
    });
    expect(new Headers(requests[1]?.init.headers).get('idempotency-key')).toBe('email_idem_1');
    expect(requests.map(({ init }) => init.redirect)).toEqual(['error', 'error']);
  });

  it('maps Twilio, Vonage, and Plivo wire contracts and requires provider IDs', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (String(url).includes('twilio')) return Response.json({ sid: 'twilio_1' });
      if (String(url).includes('vonage')) {
        return Response.json({
          messages: [{ status: '0', 'message-id': 'vonage_1' }],
        });
      }
      return Response.json({ message_uuid: ['plivo_1'] });
    });
    const twilio = new TwilioMessagingClient(
      {
        accountSid: 'AC123',
        authToken: 'secret',
        baseUrl: 'https://twilio.test/2010-04-01',
      },
      { fetch: fetchMock },
    );
    const vonage = new VonageMessagingClient(
      { apiKey: 'key', apiSecret: 'secret', baseUrl: 'https://vonage.test' },
      { fetch: fetchMock },
    );
    const plivo = new PlivoMessagingClient(
      {
        authId: 'MA123',
        authToken: 'secret',
        baseUrl: 'https://plivo.test/v1',
      },
      { fetch: fetchMock },
    );

    await expect(twilio.sendSms(sms)).resolves.toMatchObject({
      providerMessageId: 'twilio_1',
    });
    await expect(vonage.sendSms(sms)).resolves.toMatchObject({
      providerMessageId: 'vonage_1',
    });
    await expect(plivo.sendSms(sms)).resolves.toMatchObject({
      providerMessageId: 'plivo_1',
    });
    expect(requests).toHaveLength(3);
    expect(new Headers(requests[0]?.init.headers).get('idempotency-key')).toBeNull();
    expect(Object.fromEntries(new URLSearchParams(String(requests[0]?.init.body)))).toEqual({
      From: '+15550000001',
      To: '+15550000002',
      Body: 'Tixkit update',
      StatusCallback: 'https://hooks.test/status',
    });
    expect(new Headers(requests[1]?.init.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(Object.fromEntries(new URLSearchParams(String(requests[1]?.init.body)))).toEqual({
      api_key: 'key',
      api_secret: 'secret',
      from: '+15550000001',
      to: '+15550000002',
      text: 'Tixkit update',
      'client-ref': 'sms_idem_1',
      callback: 'https://hooks.test/status',
    });
    expect(new Headers(requests[2]?.init.headers).get('x-tixkit-idempotency-key')).toBe(
      'sms_idem_1',
    );
    expect(requests.map(({ init }) => init.redirect)).toEqual(['error', 'error', 'error']);
  });

  it('normalizes a successful Twilio response that already reports terminal rejection', async () => {
    const client = new TwilioMessagingClient(
      { accountSid: 'AC123', authToken: 'secret' },
      {
        fetch: async () =>
          Response.json({
            sid: 'SM123',
            status: 'failed',
            error_code: 21610,
            error_message: 'recipient details must not escape',
          }),
      },
    );

    const error = await operationError(client.sendSms(sms));
    expect(error).toMatchObject({
      dependency: 'twilio',
      operation: 'send-sms',
      kind: 'validation',
      retryable: false,
      deliveryState: 'rejected',
      safeToFailover: true,
    });
    expect(JSON.stringify(error)).not.toContain('recipient details');
  });

  it('records malformed accepted payloads as one failure for every messaging client', async () => {
    const cases: Array<{
      dependency: string;
      attempt: (telemetry: unknown[]) => Promise<unknown>;
    }> = [
      {
        dependency: 'telnyx',
        attempt: (telemetry) =>
          new TelnyxMessagingClient(
            { apiKey: 'key' },
            {
              fetch: async () => Response.json({}),
              onTelemetry: (event) => telemetry.push(event),
            },
          ).sendSms(sms),
      },
      {
        dependency: 'twilio',
        attempt: (telemetry) =>
          new TwilioMessagingClient(
            { accountSid: 'AC123', authToken: 'secret' },
            {
              fetch: async () => Response.json({}),
              onTelemetry: (event) => telemetry.push(event),
            },
          ).sendSms(sms),
      },
      {
        dependency: 'vonage',
        attempt: (telemetry) =>
          new VonageMessagingClient(
            { apiKey: 'key', apiSecret: 'secret' },
            {
              fetch: async () => Response.json({ messages: [{ status: '0' }] }),
              onTelemetry: (event) => telemetry.push(event),
            },
          ).sendSms(sms),
      },
      {
        dependency: 'plivo',
        attempt: (telemetry) =>
          new PlivoMessagingClient(
            { authId: 'MA123', authToken: 'secret' },
            {
              fetch: async () => Response.json({}),
              onTelemetry: (event) => telemetry.push(event),
            },
          ).sendSms(sms),
      },
      {
        dependency: 'resend',
        attempt: (telemetry) =>
          new ResendMessagingClient(
            { apiKey: 're_key' },
            {
              fetch: async () => Response.json({}),
              onTelemetry: (event) => telemetry.push(event),
            },
          ).sendEmail({
            from: 'sender@example.com',
            to: ['buyer@example.com'],
            subject: 'Tickets',
            html: '<p>Tickets</p>',
            idempotencyKey: 'email_idem_malformed',
          }),
      },
    ];
    for (const testCase of cases) {
      const telemetry: unknown[] = [];
      const error = await operationError(testCase.attempt(telemetry));
      expect(error).toMatchObject({
        dependency: testCase.dependency,
        kind: 'malformed-response',
        retryable: false,
        deliveryState: 'accepted',
        safeToFailover: false,
        details: { status: 200 },
      });
      expect(telemetry).toEqual([
        expect.objectContaining({
          dependency: testCase.dependency,
          outcome: 'malformed-response',
          serviceOutcome: 'platform_failure',
          status: 200,
        }),
      ]);
    }
  });

  it('normalizes a Vonage semantic rejection without cross-provider ambiguity', async () => {
    const telemetry: unknown[] = [];
    const client = new VonageMessagingClient(
      { apiKey: 'key', apiSecret: 'secret' },
      {
        fetch: async () => Response.json({ messages: [{ status: '3', 'error-text': 'bad' }] }),
        onTelemetry: (event) => telemetry.push(event),
      },
    );
    const error = await operationError(client.sendSms(sms));
    expect(error).toMatchObject({
      kind: 'validation',
      deliveryState: 'rejected',
      safeToFailover: true,
      details: { status: 200, providerCode: '3' },
    });
    expect(telemetry).toEqual([
      expect.objectContaining({
        dependency: 'vonage',
        outcome: 'validation',
        serviceOutcome: 'platform_failure',
        status: 200,
      }),
    ]);
  });

  it.each([
    ['1', 'rate-limit', true],
    ['5', 'server', true],
  ])(
    'normalizes documented Vonage status %s as %s with a clearly rejected delivery',
    async (status, kind, retryable) => {
      const telemetry: unknown[] = [];
      const fetchMock = vi.fn(async () =>
        Response.json({
          messages: [{ status, 'error-text': 'provider diagnostic' }],
        }),
      );
      const client = new VonageMessagingClient(
        { apiKey: 'key', apiSecret: 'secret' },
        { fetch: fetchMock, onTelemetry: (event) => telemetry.push(event) },
      );
      const error = await operationError(client.sendSms(sms));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(error).toMatchObject({
        kind,
        retryable,
        deliveryState: 'rejected',
        safeToFailover: true,
        details: { status: 200, providerCode: status },
      });
      expect(telemetry).toEqual([
        expect.objectContaining({
          dependency: 'vonage',
          outcome: kind,
          serviceOutcome: 'platform_failure',
          status: 200,
        }),
      ]);
    },
  );

  it.each([
    [{ 'message-id': 'accepted_maybe' }, 'missing status'],
    [{ status: 0, 'message-id': 'accepted_numeric' }, 'numeric status'],
    [{ status: 'sk_live_SECRET123', 'message-id': 'hostile' }, 'hostile status'],
  ])('fails closed for a Vonage response with %s (%s)', async (message, _label) => {
    const fetchMock = vi.fn(async () => Response.json({ messages: [message] }));
    const client = new VonageMessagingClient(
      { apiKey: 'key', apiSecret: 'secret' },
      { fetch: fetchMock },
    );
    const error = await operationError(client.sendSms(sms));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(error).toMatchObject({
      kind: 'malformed-response',
      retryable: false,
      deliveryState: 'accepted',
      safeToFailover: false,
      details: {},
    });
    expect(`${error.message}${JSON.stringify(error)}`).not.toContain('sk_live_SECRET123');
  });
});

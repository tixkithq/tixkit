import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { request, requestBlob, resolveAdminApiUrl } from './api-http';
import { installTestRuntimeConfig } from '@/test/runtime-config';
import {
  initializeBrowserRuntimeConfig,
  resetBrowserRuntimeConfigForTests,
} from './runtime-config-browser';
import { RuntimeConfigProvider } from '@/context/runtime-config-provider';

describe('request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    delete window.Clerk;
  });

  it('accepts same-origin absolute API targets and rejects authority changes', () => {
    expect(resolveAdminApiUrl('http://localhost:4000/v1/upload-artifacts/upl_1/complete')).toBe(
      'http://localhost:4000/v1/upload-artifacts/upl_1/complete',
    );
    expect(resolveAdminApiUrl('https://evil.example.test/v1/upload-artifacts/upl_1/complete')).toBe(
      undefined,
    );
    expect(resolveAdminApiUrl('http://localhost:4000@evil.example.test/v1/me')).toBe(undefined);
    expect(resolveAdminApiUrl('http://localhost:4000/not-v1')).toBe(undefined);
  });

  it('does not send a JSON content type for empty-body requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await request<{ ok: boolean }>('/v1/test', {
      method: 'POST',
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('sends a JSON content type for string request bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await request<{ ok: boolean }>('/v1/test', {
      method: 'POST',
      body: JSON.stringify({ name: 'Example' }),
    });

    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('preserves backend request IDs on API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'validation_failed',
              message: 'Invalid request',
              details: { field: 'name' },
              requestId: 'req_admin_123',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const result = await request<{ ok: boolean }>('/v1/test');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'validation_failed',
        message: 'Invalid request',
        status: 400,
        details: { field: 'name' },
        requestId: 'req_admin_123',
      });
    }
  });

  it('retries transient GET failures once', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = request<{ ok: boolean }>('/v1/test');
    await vi.advanceTimersByTimeAsync(250);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry transient POST failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await request<{ ok: boolean }>('/v1/test', {
      method: 'POST',
      body: JSON.stringify({ name: 'Example' }),
    });

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves two runtime snapshots at call time without a stale deployment origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserRuntimeConfigForTests();
    initializeBrowserRuntimeConfig(
      installTestRuntimeConfig({
        apiBaseUrl: 'https://one.example.test',
        platformApiBaseUrl: 'https://one.example.test/v1',
        checkoutUrl: 'https://checkout.example.test',
        uploadOrigin: 'https://media.example.test',
      }),
    );
    await request('/v1/events', { method: 'POST' });
    resetBrowserRuntimeConfigForTests();
    initializeBrowserRuntimeConfig(
      installTestRuntimeConfig({
        apiBaseUrl: 'https://two.example.test',
        platformApiBaseUrl: 'https://two.example.test/v1',
        checkoutUrl: 'https://checkout.example.test',
        uploadOrigin: 'https://media.example.test',
      }),
    );
    await request('/v1/events', { method: 'POST' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://one.example.test/v1/events',
      'https://two.example.test/v1/events',
    ]);
  });

  it('ignores mutated or removed diagnostic attributes when routing a Clerk bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserRuntimeConfigForTests();
    const config = installTestRuntimeConfig({
      apiBaseUrl: 'https://admin.example.test',
      platformApiBaseUrl: 'https://admin.example.test/v1',
      checkoutUrl: 'https://checkout.example.test',
      uploadOrigin: 'https://media.example.test',
      authProvider: 'clerk',
      clerkPublishableKey: 'pk_test_example',
    });
    vi.stubEnv('NODE_ENV', 'production');
    render(createElement(RuntimeConfigProvider, { config }, 'ready'));
    window.Clerk = {
      loaded: true,
      session: { getToken: vi.fn().mockResolvedValue('clerk_jwt') },
    };
    document.documentElement.setAttribute(
      'data-tixkit-api-base-url',
      'https://checkout.example.test',
    );
    document.documentElement.removeAttribute('data-tixkit-runtime-schema');
    const result = await request('/v1/events', { method: 'POST' });
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://admin.example.test/v1/events');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer clerk_jwt');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' });
  });

  it.each([
    'https://attacker.example/v1/events',
    '//attacker.example/v1/events',
    '/v1/@attacker.example/events',
    '/v1/events#https://attacker.example',
    '/v1/events\nhttps://attacker.example',
    '/events',
  ])('rejects hostile bearer target %s before token acquisition or fetch', async (path) => {
    const getToken = vi.fn().mockResolvedValue('clerk_jwt');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    resetBrowserRuntimeConfigForTests();
    initializeBrowserRuntimeConfig(
      installTestRuntimeConfig({
        apiBaseUrl: 'https://admin.example.test',
        platformApiBaseUrl: 'https://admin.example.test/v1',
        authProvider: 'clerk',
        clerkPublishableKey: 'pk_test_example',
      }),
    );
    window.Clerk = { loaded: true, session: { getToken } };

    const result = await request(path, { method: 'POST' });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_api_path',
        message: 'The authenticated API path is invalid',
      },
    });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('requestBlob', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads binary media without ambient credentials or redirects and does not parse JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('event-thumbnail', {
        status: 200,
        headers: { 'Content-Type': 'image/webp' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestBlob('/v1/events/evt_1/media/renditions/emr_1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.size).toBe(15);
      expect(result.data.type).toBe('image/webp');
    }
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/v1/events/evt_1/media/renditions/emr_1');
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
  });

  it('fails closed when a private rendition is denied', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    const result = await requestBlob('/v1/events/evt_1/media/renditions/emr_other');

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'http_error',
        message: 'Image request failed with status 404',
        status: 404,
      },
    });
  });

  it('rejects cross-origin media before calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestBlob(
      'https://attacker.example/v1/events/evt_1/media/renditions/emr_1',
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_media_url',
        message: 'The authenticated event media URL is invalid',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects same-origin paths outside the authenticated rendition surface', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await requestBlob('/v1/agent/sessions?redirect=https://attacker.example');

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

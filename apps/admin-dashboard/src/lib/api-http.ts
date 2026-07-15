import { hasClerkKey } from '@/lib/auth';
import type { AdminApiError, ApiResult } from './api';

declare global {
  interface Window {
    Clerk?: {
      loaded?: boolean;
      load?: () => Promise<void>;
      session?: {
        getToken: () => Promise<string | null>;
      };
    };
  }
}

const API_BASE_URL = (
  process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  'http://localhost:4000'
).replace(/\/$/, '');
const DEFAULT_TIMEOUT_MS = 15_000;
const CLERK_TOKEN_WAIT_MS = 5_000;
const TRANSIENT_RETRY_DELAY_MS = 250;
const FIXTURES_ALLOWED = process.env.NODE_ENV === 'test';

function apiError(
  code: string,
  message: string,
  status?: number,
  details?: unknown,
  requestId?: string,
): AdminApiError {
  return { code, message, status, details, requestId };
}

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function err<T>(error: AdminApiError): ApiResult<T> {
  return { ok: false, error };
}

async function getClerkToken(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  // When no Clerk publishable key is configured, skip polling entirely.
  // This prevents the 5-second wait on every request in local dev mode.
  if (!hasClerkKey()) return null;

  // Clerk is configured. Wait briefly for it to load if it hasn't yet.
  const startedAt = Date.now();
  while (!window.Clerk && Date.now() - startedAt < CLERK_TOKEN_WAIT_MS) {
    // Intentional sequential wait: we need Clerk to load before proceeding.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }

  const clerk = window.Clerk;
  if (!clerk) return null;

  if (!clerk.loaded && typeof clerk.load === 'function') {
    const timeout = new Promise<void>((resolve) => {
      window.setTimeout(resolve, CLERK_TOKEN_WAIT_MS);
    });
    await Promise.race([clerk.load().catch(() => undefined), timeout]);
  }

  return clerk.session?.getToken() ?? null;
}

export function getAdminApiBaseUrl(): string {
  return API_BASE_URL;
}

function requestMethod(options: RequestInit): string {
  return (options.method ?? 'GET').toUpperCase();
}

function canRetryRequest(options: RequestInit): boolean {
  const method = requestMethod(options);
  return method === 'GET' || method === 'HEAD';
}

function isTransientErrorCode(code: string): boolean {
  return code === 'network_error' || code === 'timeout';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getAdminApiAuthHeaders(
  headers: Record<string, string> = {},
): Promise<Record<string, string>> {
  const resolvedHeaders = { ...headers };
  if (!resolvedHeaders.Authorization && typeof window !== 'undefined') {
    const clerkToken = await getClerkToken();
    if (clerkToken) {
      resolvedHeaders.Authorization = `Bearer ${clerkToken}`;
    }
  }
  return resolvedHeaders;
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<ApiResult<T>> {
  const retryable = canRetryRequest(options);
  for (let attempt = 0; attempt < (retryable ? 2 : 1); attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await requestOnce<T>(path, options);
    if (!retryable || result.ok || !isTransientErrorCode(result.error.code) || attempt > 0) {
      return result;
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(TRANSIENT_RETRY_DELAY_MS);
  }
  return requestOnce<T>(path, options);
}

function authenticatedEventMediaUrl(path: string): string | undefined {
  try {
    const base = new URL(API_BASE_URL);
    const resolved = new URL(path, `${API_BASE_URL}/`);
    if (
      resolved.origin !== base.origin ||
      resolved.username ||
      resolved.password ||
      resolved.search ||
      resolved.hash ||
      !/^\/v1\/events\/[^/]+\/media\/renditions\/[^/]+$/u.test(resolved.pathname)
    )
      return undefined;
    return resolved.toString();
  } catch {
    return undefined;
  }
}

export async function requestBlob(
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<ApiResult<Blob>> {
  const url = authenticatedEventMediaUrl(path);
  if (!url) {
    return err<Blob>(apiError('invalid_media_url', 'The authenticated event media URL is invalid'));
  }
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers = new Headers(await getAdminApiAuthHeaders());
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      credentials: 'include',
    });
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
    if (!response.ok) {
      return err<Blob>(
        apiError(
          'http_error',
          `Image request failed with status ${response.status}`,
          response.status,
        ),
      );
    }
    return ok(await response.blob());
  } catch (cause) {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
    if (cause instanceof Error && cause.name === 'AbortError') {
      return err<Blob>(
        apiError(
          options.signal?.aborted ? 'cancelled' : 'timeout',
          options.signal?.aborted
            ? 'The image request was cancelled'
            : 'The image request timed out',
        ),
      );
    }
    return err<Blob>(
      apiError('network_error', cause instanceof Error ? cause.message : 'Unable to load image'),
    );
  }
}

async function requestOnce<T>(path: string, options: RequestInit = {}): Promise<ApiResult<T>> {
  const url = `${API_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const headers = new Headers(options.headers);
    if (!headers.has('Content-Type') && typeof options.body === 'string') {
      headers.set('Content-Type', 'application/json');
    }

    if (!headers.has('Authorization') && typeof window !== 'undefined') {
      const clerkToken = await getClerkToken();
      if (clerkToken) {
        headers.set('Authorization', `Bearer ${clerkToken}`);
      }
    }

    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
      credentials: 'include',
    });

    clearTimeout(timeout);

    if (res.status === 204) {
      return ok(undefined as T);
    }

    const json = await res.json().catch(() => null);

    if (!res.ok) {
      const body = json as {
        error?: {
          code?: string;
          message?: string;
          details?: unknown;
          requestId?: string;
        };
      } | null;
      return err<T>(
        apiError(
          body?.error?.code ?? 'http_error',
          body?.error?.message ?? `Request failed with status ${res.status}`,
          res.status,
          body?.error?.details,
          body?.error?.requestId,
        ),
      );
    }

    return ok(json as T);
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error) {
      if (e.name === 'AbortError') {
        return err<T>(apiError('timeout', 'The request timed out'));
      }
      return err<T>(apiError('network_error', e.message));
    }
    return err<T>(apiError('unknown', 'An unknown error occurred'));
  }
}

/**
 * Uses fixture providers only under the test runner. Browser/runtime code must
 * call the configured API and surface real failures.
 */
export async function withFixture<T>(
  call: () => Promise<ApiResult<T>>,
  fixture: () => Promise<ApiResult<T>> | ApiResult<T>,
): Promise<ApiResult<T>> {
  if (FIXTURES_ALLOWED) {
    return Promise.resolve(fixture()).then((f) => f);
  }
  return call();
}

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
const FIXTURES_ALLOWED = process.env.NODE_ENV === 'test';

function apiError(
  code: string,
  message: string,
  status?: number,
  details?: unknown,
): AdminApiError {
  return { code, message, status, details };
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
  const url = `${API_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> | undefined),
    };

    if (!headers.Authorization && typeof window !== 'undefined') {
      const clerkToken = await getClerkToken();
      if (clerkToken) {
        headers.Authorization = `Bearer ${clerkToken}`;
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
        error?: { code?: string; message?: string; details?: unknown };
      } | null;
      return err<T>(
        apiError(
          body?.error?.code ?? 'http_error',
          body?.error?.message ?? `Request failed with status ${res.status}`,
          res.status,
          body?.error?.details,
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

import type { ApiResult, TixkitPrincipal } from './api';
import { parseAdminServerRuntimeConfig } from './runtime-config-server';

export async function getServerPrincipal(token: string): Promise<ApiResult<TixkitPrincipal>> {
  const config = parseAdminServerRuntimeConfig();
  try {
    const response = await fetch(`${config.internalApiBaseUrl}/v1/me`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => null)) as
      | TixkitPrincipal
      | { error?: { code?: string; message?: string; details?: unknown; requestId?: string } }
      | null;
    if (!response.ok) {
      const error = body && 'error' in body ? body.error : undefined;
      return {
        ok: false,
        error: {
          code: error?.code ?? 'http_error',
          message: error?.message ?? `Request failed with status ${response.status}`,
          status: response.status,
          details: error?.details,
          requestId: error?.requestId,
        },
      };
    }
    if (
      !body ||
      !('tenantId' in body) ||
      typeof body.tenantId !== 'string' ||
      !Array.isArray(body.organizationIds) ||
      !Array.isArray(body.permissions)
    ) {
      return {
        ok: false,
        error: { code: 'invalid_response', message: 'The principal response is invalid' },
      };
    }
    return { ok: true, data: body as TixkitPrincipal };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: cause instanceof Error && cause.name === 'TimeoutError' ? 'timeout' : 'network_error',
        message:
          cause instanceof Error && cause.name === 'TimeoutError'
            ? 'The principal request timed out'
            : cause instanceof Error
              ? cause.message
              : 'Unable to reach the admin API',
      },
    };
  }
}

export function getServerAdminApiBaseUrl(): string {
  return parseAdminServerRuntimeConfig().publicConfig.apiBaseUrl;
}

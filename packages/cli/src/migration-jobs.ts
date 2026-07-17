import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { MigrationPreparationConfiguration } from '@tixkit/migration-core';

export type MigrationJobAction =
  | 'prepare'
  | 'dry-run'
  | 'commit'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'rollback';

export type MigrationJobClientOptions = {
  apiBaseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
};

export type MigrationCreateRequest = {
  organizationId: string;
  sourceSystem: MigrationPreparationConfiguration['sourceSystem'];
  adapterVersion: string;
  mode?: 'dry-run' | 'commit';
  configuration: MigrationPreparationConfiguration;
  credentialId?: string;
};

export type MigrationMappingRequest = {
  organizationId: string;
  sourceSystem: string;
  name: string;
  entityType: string;
  mapping: Record<string, string | number | boolean | null | string[]>;
};

export type MigrationCommandResult = {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
};

const JOB_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u;

export class MigrationJobClient {
  readonly #apiBaseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: MigrationJobClientOptions) {
    this.#apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
    this.#apiKey = options.apiKey.trim();
    if (!this.#apiKey) throw new Error('A Tixkit API key is required.');
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  create(request: MigrationCreateRequest): Promise<MigrationCommandResult> {
    if (!request.sourceSystem?.trim()) throw new Error('sourceSystem is required.');
    if (!request.organizationId?.trim()) throw new Error('organizationId is required.');
    if (!request.adapterVersion?.trim()) throw new Error('adapterVersion is required.');
    const body = JSON.stringify(request);
    return this.#request('migration-jobs', {
      method: 'POST',
      body,
      headers: {
        'idempotency-key': `cli:${createHash('sha256').update(body).digest('hex')}`,
      },
    });
  }

  adapters(): Promise<MigrationCommandResult> {
    return this.#request('migration-adapters');
  }

  registerFile(jobId: string, uploadArtifactId: string): Promise<MigrationCommandResult> {
    if (!uploadArtifactId.trim()) throw new Error('uploadArtifactId is required.');
    return this.#request(`migration-jobs/${encodeJobId(jobId)}/files`, {
      method: 'POST',
      body: JSON.stringify({ uploadArtifactId }),
    });
  }

  saveMapping(request: MigrationMappingRequest): Promise<MigrationCommandResult> {
    return this.#request('migration-mappings', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  get(jobId: string): Promise<MigrationCommandResult> {
    return this.#request(`migration-jobs/${encodeJobId(jobId)}`);
  }

  report(jobId: string): Promise<MigrationCommandResult> {
    return this.#request(`migration-jobs/${encodeJobId(jobId)}/report/download`);
  }

  rollbackAssessment(jobId: string): Promise<MigrationCommandResult> {
    return this.#request(`migration-jobs/${encodeJobId(jobId)}/rollback-assessment`);
  }

  action(jobId: string, action: MigrationJobAction): Promise<MigrationCommandResult> {
    return this.#request(`migration-jobs/${encodeJobId(jobId)}/${action}`, {
      method: 'POST',
      headers:
        action === 'commit' || action === 'rollback'
          ? { 'x-tixkit-confirmation': `${action}:${encodeJobId(jobId)}` }
          : undefined,
    });
  }

  async #request(path: string, init: RequestInit = {}): Promise<MigrationCommandResult> {
    let response: Response;
    try {
      response = await this.#fetch(issueMigrationJobRequestUrl(this.#apiBaseUrl, path), {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return { ok: false, status: 0, error: safeErrorMessage(error) };
    }

    const text = await response.text();
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { message: text.slice(0, 2_000) };
      }
    }
    if (response.ok) return { ok: true, status: response.status, data };
    return {
      ok: false,
      status: response.status,
      data,
      error: extractError(data) ?? `Migration API returned HTTP ${response.status}.`,
    };
  }
}

export function requireMigrationConfirmation(
  action: 'commit' | 'rollback',
  jobId: string,
  confirmation?: string,
): void {
  const expected = `${action.toUpperCase()} ${jobId}`;
  if (confirmation !== expected) {
    throw new Error(
      `Refusing ${action}: pass --confirm "${expected}" after reviewing ${
        action === 'rollback' ? 'the live rollback assessment' : 'the job report'
      }.`,
    );
  }
}

export async function readMigrationCreateRequest(
  filePath: string,
): Promise<MigrationCreateRequest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Unable to read migration request JSON: ${safeErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(value) || typeof value.sourceSystem !== 'string' || !value.sourceSystem.trim()) {
    throw new Error('Migration request JSON must contain a non-empty sourceSystem.');
  }
  return value as MigrationCreateRequest;
}

export function formatMigrationResult(result: MigrationCommandResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  if (!result.ok) return `Migration request failed: ${result.error ?? `HTTP ${result.status}`}`;
  if (isRecord(result.data) && typeof result.data.message === 'string') return result.data.message;
  return JSON.stringify(result.data ?? { ok: true, status: result.status }, null, 2);
}

export function issueMigrationJobRequestUrl(apiBaseUrl: string, path: string): string {
  if (containsControlCharacter(apiBaseUrl) || containsControlCharacter(path)) {
    throw new Error('Migration API URLs must not contain control characters.');
  }
  if (!path || path.startsWith('/') || path.includes('\\')) {
    throw new Error('Migration API path must be relative to the configured API base.');
  }
  const url = new URL(apiBaseUrl);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('API base URL must use HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('API base URL must not contain credentials.');
  if (
    url.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  ) {
    throw new Error('Remote API base URL must use HTTPS.');
  }
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  const basePath = url.pathname;
  const target = new URL(path, url);
  if (target.origin !== url.origin || !target.pathname.startsWith(basePath)) {
    throw new Error('Migration API path escapes the configured API base.');
  }
  return target.toString();
}

function normalizeApiBaseUrl(value: string): string {
  return issueMigrationJobRequestUrl(value, '.').replace(/\.$/u, '');
}

function encodeJobId(jobId: string): string {
  if (!JOB_ID_PATTERN.test(jobId)) throw new Error('Invalid migration job ID.');
  return encodeURIComponent(jobId);
}

function extractError(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['message', 'error', 'detail']) {
    if (typeof value[key] === 'string') return value[key];
  }
  return undefined;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]');
  return String(error).replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

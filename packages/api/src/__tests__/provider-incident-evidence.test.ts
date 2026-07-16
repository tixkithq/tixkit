import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  hashExactProviderRequestId,
  type ProviderExactRequestIdEvent,
} from '@tixkit/provider-clients';
import {
  loadProviderIncidentEvidenceConfiguration,
  createBoundedProviderIncidentCaptureHandler,
  createProviderIncidentEvidenceRuntime,
  ProviderIncidentEvidenceService,
  ProviderIncidentEvidenceUnavailableError,
  type ProviderIncidentEvidenceStore,
} from '../services/provider-incident-evidence.js';

const now = Date.UTC(2026, 6, 16, 12);
const key = randomBytes(32);

function enabledEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PROVIDER_INCIDENT_SINK_ENABLED: 'true',
    PROVIDER_INCIDENT_CAPTURE_UNTIL: new Date(now + 60 * 60 * 1_000).toISOString(),
    PROVIDER_INCIDENT_RETENTION_MINUTES: '60',
    PROVIDER_INCIDENT_MAX_ACTIVE_PER_TENANT: '100',
    PROVIDER_INCIDENT_ACTIVE_KEY_ID: 'incident-2026-07',
    PROVIDER_INCIDENT_KEYRING_JSON: JSON.stringify({
      'incident-2026-07': key.toString('base64'),
    }),
    ...overrides,
  };
}

const event: ProviderExactRequestIdEvent = {
  dependency: 'resend',
  operation: 'send-email',
  exactRequestId: 'req_exact_support_01',
  requestIdHash: hashExactProviderRequestId('req_exact_support_01'),
  scope: { tenantId: 'tenant_01', organizationId: 'org_01' },
};

describe('provider incident evidence configuration', () => {
  it.each([{}, { PROVIDER_INCIDENT_SINK_ENABLED: 'false' }])(
    'is disabled without requiring key material',
    (environment) => {
      expect(loadProviderIncidentEvidenceConfiguration(environment, now)).toEqual({
        enabled: false,
      });
    },
  );

  it('does not install an exact request-ID callback while the sink is disabled', () => {
    const disabled = createProviderIncidentEvidenceRuntime({} as never, {}, () => now);
    const enabled = createProviderIncidentEvidenceRuntime(
      {} as never,
      enabledEnvironment(),
      () => now,
    );

    expect(disabled.providerClientRuntime.onExactRequestId).toBeUndefined();
    expect(enabled.providerClientRuntime.onExactRequestId).toEqual(expect.any(Function));
  });

  it.each([
    ['invalid enable flag', { PROVIDER_INCIDENT_SINK_ENABLED: 'yes' }],
    ['missing capture window', { PROVIDER_INCIDENT_CAPTURE_UNTIL: '' }],
    [
      'capture window beyond 24 hours',
      { PROVIDER_INCIDENT_CAPTURE_UNTIL: new Date(now + 24 * 60 * 60 * 1_000 + 1).toISOString() },
    ],
    ['zero retention', { PROVIDER_INCIDENT_RETENTION_MINUTES: '0' }],
    ['excessive retention', { PROVIDER_INCIDENT_RETENTION_MINUTES: '1441' }],
    ['missing key', { PROVIDER_INCIDENT_KEYRING_JSON: '{}' }],
    ['short key', { PROVIDER_INCIDENT_KEYRING_JSON: JSON.stringify({ bad: 'YQ==' }) }],
  ])('fails startup for %s', (_label, override) => {
    expect(() =>
      loadProviderIncidentEvidenceConfiguration(enabledEnvironment(override), now),
    ).toThrow();
  });

  it('loads an elapsed capture window for reveal-only restart without accepting new evidence', async () => {
    const configuration = loadProviderIncidentEvidenceConfiguration(
      enabledEnvironment({
        PROVIDER_INCIDENT_CAPTURE_UNTIL: new Date(now - 1).toISOString(),
      }),
      now,
    );
    const capture = vi.fn();
    const store = {
      capture,
      revealWithAudit: vi.fn(async () => 'req_retained_01'),
    } as unknown as ProviderIncidentEvidenceStore;
    const service = new ProviderIncidentEvidenceService(store, configuration, () => now);

    await service.capture(event);

    expect(capture).not.toHaveBeenCalled();
    await expect(
      service.reveal({
        evidenceId: 'pie_01HZZZZZZZZZZZZZZZZZZZZZZZ',
        tenantId: 'tenant_01',
        organizationId: 'org_01',
        audit: { actorType: 'user', actorId: 'user_01', reason: 'Provider support' },
      }),
    ).resolves.toBe('req_retained_01');
  });
});

describe('ProviderIncidentEvidenceService', () => {
  it('bounds concurrent best-effort capture work without queuing provider operations', async () => {
    const releases: Array<() => void> = [];
    const capture = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const handler = createBoundedProviderIncidentCaptureHandler({ capture }, 2);

    const first = handler(event);
    const second = handler({ ...event, exactRequestId: 'req_second' });
    expect(handler({ ...event, exactRequestId: 'req_dropped_at_capacity' })).toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(2);
    releases.splice(0).forEach((release) => release());
    await Promise.all([first, second]);
  });

  it('persists ciphertext only and reveals through the transactional decrypt callback', async () => {
    let row: Record<string, unknown> | undefined;
    const store = {
      capture: vi.fn(async (input) => {
        row = {
          id: input.id!,
          tenant_id: input.tenantId,
          organization_id: input.organizationId ?? null,
          provider: input.provider,
          operation: input.operation,
          correlation_sha256: input.correlationSha256,
          key_id: input.encrypted.keyId,
          iv_b64: input.encrypted.ivB64,
          tag_b64: input.encrypted.tagB64,
          ciphertext_b64: input.encrypted.ciphertextB64,
          captured_at: input.capturedAt,
          expires_at: input.expiresAt,
        };
        return row;
      }),
      revealWithAudit: vi.fn(async (input) => input.decrypt(row as never)),
    } as unknown as ProviderIncidentEvidenceStore;
    const service = new ProviderIncidentEvidenceService(
      store,
      loadProviderIncidentEvidenceConfiguration(enabledEnvironment(), now),
      () => now,
    );

    await service.capture(event);
    expect(JSON.stringify(row)).not.toContain(event.exactRequestId);
    const requestId = await service.reveal({
      evidenceId: String(row?.id),
      tenantId: event.scope.tenantId,
      organizationId: event.scope.organizationId,
      audit: { actorType: 'user', actorId: 'user_01', reason: 'Provider support escalation' },
    });
    expect(requestId).toBe(event.exactRequestId);
    expect(store.revealWithAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_01',
        organizationId: 'org_01',
        audit: expect.objectContaining({ reason: 'Provider support escalation' }),
      }),
    );
  });

  it('does not capture when disabled or after the explicit capture window', async () => {
    const capture = vi.fn();
    const store = { capture, revealWithAudit: vi.fn() } as unknown as ProviderIncidentEvidenceStore;
    await new ProviderIncidentEvidenceService(store, { enabled: false }, () => now).capture(event);
    const configuration = loadProviderIncidentEvidenceConfiguration(enabledEnvironment(), now);
    await new ProviderIncidentEvidenceService(store, configuration, () =>
      configuration.enabled ? configuration.captureUntil + 1 : now,
    ).capture(event);
    expect(capture).not.toHaveBeenCalled();
  });

  it('fails reveal closed when disabled', async () => {
    const store = {
      capture: vi.fn(),
      revealWithAudit: vi.fn(),
    } as unknown as ProviderIncidentEvidenceStore;
    const service = new ProviderIncidentEvidenceService(store, { enabled: false }, () => now);
    await expect(
      service.reveal({
        evidenceId: 'pie_01HZZZZZZZZZZZZZZZZZZZZZZZ',
        tenantId: 'tenant_01',
        organizationId: 'org_01',
        audit: { actorType: 'user', actorId: 'user_01', reason: 'Support' },
      }),
    ).rejects.toBeInstanceOf(ProviderIncidentEvidenceUnavailableError);
  });
});

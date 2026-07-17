import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemporalClient } from '../services/temporal.js';

const temporalClientMocks = vi.hoisted(() => ({
  connect: vi.fn(async () => ({ connection: 'temporal' })),
  client: vi.fn(),
}));

const temporalOtelMocks = vi.hoisted(() => ({
  failConstructor: false,
  OpenTelemetryWorkflowClientInterceptor: vi.fn(function OpenTelemetryWorkflowClientInterceptor() {
    if (temporalOtelMocks.failConstructor) {
      throw new TypeError("Cannot read properties of undefined (reading 'AlwaysOn')");
    }
    return { interceptor: 'otel' };
  }),
}));

vi.mock('@temporalio/client', () => ({
  Connection: { connect: temporalClientMocks.connect },
  Client: temporalClientMocks.client,
}));

vi.mock('@temporalio/interceptors-opentelemetry', () => ({
  OpenTelemetryWorkflowClientInterceptor: temporalOtelMocks.OpenTelemetryWorkflowClientInterceptor,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  temporalClientMocks.connect.mockClear();
  temporalClientMocks.client.mockClear();
  temporalOtelMocks.failConstructor = false;
  temporalOtelMocks.OpenTelemetryWorkflowClientInterceptor.mockClear();
});

describe('TemporalClient connection', () => {
  it('does not create OpenTelemetry workflow interceptors when tracing is disabled', async () => {
    vi.stubEnv('OTEL_SDK_DISABLED', 'true');

    await TemporalClient.connect();

    expect(temporalClientMocks.connect).toHaveBeenCalledWith({
      address: 'localhost:7233',
    });
    expect(temporalClientMocks.client).toHaveBeenCalledWith(
      expect.not.objectContaining({
        interceptors: expect.anything(),
      }),
    );
  });

  it('continues without workflow tracing when the local OpenTelemetry interceptor fails', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    temporalOtelMocks.failConstructor = true;

    await TemporalClient.connect();

    expect(temporalOtelMocks.OpenTelemetryWorkflowClientInterceptor).toHaveBeenCalledTimes(1);
    expect(temporalClientMocks.client).toHaveBeenCalledWith(
      expect.not.objectContaining({
        interceptors: expect.anything(),
      }),
    );
  });

  it('fails startup when the production OpenTelemetry interceptor fails', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    temporalOtelMocks.failConstructor = true;

    await expect(TemporalClient.connect()).rejects.toThrow(
      "Cannot read properties of undefined (reading 'AlwaysOn')",
    );
  });
});

describe('TemporalClient checkout', () => {
  it('starts new checkout histories with finalization recovery version 2', async () => {
    const client = {
      workflow: {
        start: vi.fn(async (_workflow: unknown, options: { workflowId: string }) => ({
          workflowId: options.workflowId,
        })),
      },
    };
    const temporalClient = new TemporalClient(client as never);

    await temporalClient.startCheckoutSession({
      checkoutSessionId: 'cs_1',
      tenantId: 'tnt_1',
      organizationId: 'org_1',
      eventId: 'evt_1',
      brandId: 'brd_1',
      holdId: 'hld_1',
      currency: 'USD',
      amountCents: 10_000,
      feeCents: 500,
      buyerEmail: 'buyer@example.test',
      isFreeOrder: false,
    });

    expect(client.workflow.start).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        workflowId: 'checkout-session:cs_1',
        args: [expect.objectContaining({ version: 2, checkoutSessionId: 'cs_1' })],
      }),
    );
  });
});

describe('TemporalClient payment reconciliation', () => {
  it('returns the existing workflow handle when reconciliation was already started', async () => {
    const existingHandle = { workflowId: 'payment-reconciliation:evt_1' };
    const client = {
      workflow: {
        start: vi.fn(async () => {
          const err = new Error('Workflow execution already started');
          err.name = 'WorkflowExecutionAlreadyStartedError';
          throw err;
        }),
        getHandle: vi.fn(() => existingHandle),
      },
    };
    const temporalClient = new TemporalClient(client as never);

    const result = await temporalClient.startPaymentReconciliation({
      providerEventId: 'evt_1',
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      data: { id: 'pi_1' },
    });

    expect(result).toBe(existingHandle);
    expect(client.workflow.getHandle).toHaveBeenCalledWith('payment-reconciliation:evt_1');
  });
});

describe('TemporalClient migration rollback', () => {
  it('starts preparation on its dedicated tenant and organization scoped workflow ID', async () => {
    const client = {
      workflow: {
        start: vi.fn(async (_workflow: unknown, options: { workflowId: string }) => ({
          workflowId: options.workflowId,
        })),
      },
    };
    const temporalClient = new TemporalClient(client as never);
    await expect(
      temporalClient.startMigrationPreparation({
        tenantId: 'tenant_1',
        organizationId: 'org_1',
        jobId: 'imp_1',
      }),
    ).resolves.toEqual({ workflowId: 'migration-prepare:tenant_1:org_1:imp_1' });
    expect(client.workflow.start).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        workflowId: 'migration-prepare:tenant_1:org_1:imp_1',
        args: [expect.objectContaining({ version: 2 })],
      }),
    );
  });

  it('starts rollback with an ID distinct from the completed commit workflow', async () => {
    const client = {
      workflow: {
        start: vi.fn(async (_workflow: unknown, options: { workflowId: string }) => ({
          workflowId: options.workflowId,
        })),
      },
    };
    const temporalClient = new TemporalClient(client as never);
    const result = await temporalClient.startMigrationRollback({
      tenantId: 'tenant_1',
      organizationId: 'org_1',
      jobId: 'imp_1',
      commandId: 'mlc_1',
      lifecycleSequence: 1,
    });
    expect(result).toMatchObject({
      workflowId: 'migration-rollback:tenant_1:org_1:imp_1:mlc_1',
    });
    expect(client.workflow.start).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        workflowId: 'migration-rollback:tenant_1:org_1:imp_1:mlc_1',
        args: [
          expect.objectContaining({
            version: 2,
            tenantId: 'tenant_1',
            organizationId: 'org_1',
            jobId: 'imp_1',
            commandId: 'mlc_1',
            lifecycleSequence: 1,
          }),
        ],
      }),
    );
  });
});

describe('TemporalClient Clerk identity sync', () => {
  it('scopes workflow IDs by provider event ID instead of Clerk subject ID', async () => {
    const client = {
      workflow: {
        start: vi.fn(async (_workflow: unknown, options: { workflowId: string }) => ({
          workflowId: options.workflowId,
        })),
      },
    };
    const temporalClient = new TemporalClient(client as never);

    await temporalClient.startClerkIdentitySync({
      providerEventId: 'msg_clerk_1',
      eventType: 'user.updated',
      clerkUserId: 'user_same',
      email: 'user@example.com',
    });
    await temporalClient.startClerkIdentitySync({
      providerEventId: 'msg_clerk_2',
      eventType: 'user.updated',
      clerkUserId: 'user_same',
      email: 'user@example.com',
    });

    expect(client.workflow.start).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      expect.objectContaining({ workflowId: 'clerk-identity-sync:msg_clerk_1' }),
    );
    expect(client.workflow.start).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      expect.objectContaining({ workflowId: 'clerk-identity-sync:msg_clerk_2' }),
    );
  });

  it('returns the existing workflow handle when identity sync was already started', async () => {
    const existingHandle = { workflowId: 'clerk-identity-sync:msg_clerk_1' };
    const client = {
      workflow: {
        start: vi.fn(async () => {
          const err = new Error('Workflow execution already started');
          err.name = 'WorkflowExecutionAlreadyStartedError';
          throw err;
        }),
        getHandle: vi.fn(() => existingHandle),
      },
    };
    const temporalClient = new TemporalClient(client as never);

    const result = await temporalClient.startClerkIdentitySync({
      providerEventId: 'msg_clerk_1',
      eventType: 'user.updated',
      clerkUserId: 'user_1',
      email: 'user@example.com',
    });

    expect(result).toBe(existingHandle);
    expect(client.workflow.getHandle).toHaveBeenCalledWith('clerk-identity-sync:msg_clerk_1');
  });
});

describe('TemporalClient webhook delivery', () => {
  it('starts replay webhook deliveries with a replay-scoped workflow id', async () => {
    const handle = { workflowId: 'webhook-delivery:whe_1:wh_1:replay:rpl_1' };
    const client = {
      workflow: {
        start: vi.fn(async () => handle),
      },
    };
    const temporalClient = new TemporalClient(client as never);

    const result = await temporalClient.startWebhookDelivery({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      replayNonce: 'rpl_1',
      payload: { orderId: 'ord_1' },
      maxAttempts: 5,
    });

    expect(result).toBe(handle);
    expect(client.workflow.start).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        workflowId: 'webhook-delivery:whe_1:wh_1:replay:rpl_1',
      }),
    );
    const [, startOptions] = client.workflow.start.mock.calls[0] as unknown as [
      unknown,
      { args: unknown[] },
    ];
    expect(startOptions.args[0]).toMatchObject({ replayNonce: 'rpl_1' });
    expect(startOptions.args[0]).not.toHaveProperty('secret');
  });

  it('recovers an ambiguously accepted replay start by returning the stable workflow handle', async () => {
    const existingHandle = { workflowId: 'webhook-delivery:whe_1:wh_1:replay:whr_1' };
    const client = {
      workflow: {
        start: vi.fn(async () => {
          const error = new Error('Workflow execution already started');
          error.name = 'WorkflowExecutionAlreadyStartedError';
          throw error;
        }),
        getHandle: vi.fn(() => existingHandle),
      },
    };
    const temporalClient = new TemporalClient(client as never);

    const result = await temporalClient.startWebhookDelivery({
      endpointId: 'wh_1',
      eventId: 'whe_1',
      replayNonce: 'whr_1',
      payload: { orderId: 'ord_1' },
      maxAttempts: 5,
    });

    expect(result).toBe(existingHandle);
    expect(client.workflow.getHandle).toHaveBeenCalledWith(
      'webhook-delivery:whe_1:wh_1:replay:whr_1',
    );
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const temporalMock = vi.hoisted(() => ({
  connectionClose: vi.fn(async () => undefined),
  connectionConnect: vi.fn(async () => ({ close: temporalMock.connectionClose })),
  workflowStart: vi.fn(async () => undefined),
  clientConstructor: vi.fn(function Client() {
    return { workflow: { start: temporalMock.workflowStart } };
  }),
}));

const dbMock = vi.hoisted(() => ({
  destroy: vi.fn(async () => undefined),
  createDb: vi.fn(() => ({ destroy: dbMock.destroy })),
}));

vi.mock('@temporalio/client', () => ({
  Connection: { connect: temporalMock.connectionConnect },
  Client: temporalMock.clientConstructor,
}));

vi.mock('@tixkit/db', () => ({
  createDb: dbMock.createDb,
}));

vi.mock('../workflows/notification.js', () => ({
  notificationDeliveryWorkflow: vi.fn(),
}));

function notificationInput(jobId: string) {
  return {
    jobId,
    tenantId: 'tnt_1',
    brandId: 'brd_1',
    templateKey: 'order-confirmed',
    templateVersionId: 'ntv_1',
    toEmail: 'buyer@test.com',
    variables: { notificationType: 'transactional' },
    providerRouteId: 'epr_1',
    notificationType: 'transactional' as const,
  };
}

describe('activity Temporal clients', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    temporalMock.connectionConnect.mockResolvedValue({ close: temporalMock.connectionClose });
    temporalMock.workflowStart.mockResolvedValue(undefined);
    dbMock.createDb.mockClear();
    dbMock.destroy.mockClear();
    delete process.env.TEMPORAL_ADDRESS;
    delete process.env.TEMPORAL_NAMESPACE;
    delete process.env.TEMPORAL_TASK_QUEUE;
  });

  it('reuses one Temporal client for repeated notification workflow starts', async () => {
    const { startNotificationDeliveryWorkflow, closeActivityClients } =
      await import('../activities/activity-clients.js');

    await startNotificationDeliveryWorkflow(notificationInput('emj_1'));
    await startNotificationDeliveryWorkflow(notificationInput('emj_2'));

    expect(temporalMock.connectionConnect).toHaveBeenCalledTimes(1);
    expect(temporalMock.clientConstructor).toHaveBeenCalledTimes(1);
    expect(temporalMock.workflowStart).toHaveBeenCalledTimes(2);
    expect(temporalMock.workflowStart).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        taskQueue: 'tixkit',
        workflowId: 'notification:emj_1',
        args: [
          expect.objectContaining({
            version: 1,
            jobId: 'emj_1',
          }),
        ],
      }),
    );

    await closeActivityClients();
  });

  it('closes the cached Temporal connection and reconnects on later use', async () => {
    const { startNotificationDeliveryWorkflow, closeActivityClients } =
      await import('../activities/activity-clients.js');

    await startNotificationDeliveryWorkflow(notificationInput('emj_1'));
    await closeActivityClients();
    await startNotificationDeliveryWorkflow(notificationInput('emj_2'));

    expect(temporalMock.connectionConnect).toHaveBeenCalledTimes(2);
    expect(temporalMock.clientConstructor).toHaveBeenCalledTimes(2);
    expect(temporalMock.connectionClose).toHaveBeenCalledTimes(1);

    await closeActivityClients();
  });

  it('does not throw when notification workflow start reports an existing workflow', async () => {
    const { startNotificationDeliveryWorkflow, closeActivityClients } =
      await import('../activities/activity-clients.js');
    temporalMock.workflowStart.mockRejectedValue(
      Object.assign(new Error('Workflow execution already started'), {
        name: 'WorkflowExecutionAlreadyStartedError',
      }),
    );

    await expect(startNotificationDeliveryWorkflow(notificationInput('emj_1'))).resolves.toBe(
      undefined,
    );

    await closeActivityClients();
  });

  it('reuses one DB client for repeated activity DB access', async () => {
    const { getActivityDb, closeActivityClients } =
      await import('../activities/activity-clients.js');

    const first = getActivityDb();
    const second = getActivityDb();

    expect(first).toBe(second);
    expect(dbMock.createDb).toHaveBeenCalledTimes(1);
    expect(dbMock.destroy).not.toHaveBeenCalled();

    await closeActivityClients();
  });

  it('destroys the cached DB client and reconnects on later use', async () => {
    const { getActivityDb, closeActivityClients } =
      await import('../activities/activity-clients.js');

    const first = getActivityDb();
    await closeActivityClients();
    const second = getActivityDb();

    expect(second).not.toBe(first);
    expect(dbMock.createDb).toHaveBeenCalledTimes(2);
    expect(dbMock.destroy).toHaveBeenCalledTimes(1);

    await closeActivityClients();
  });
});

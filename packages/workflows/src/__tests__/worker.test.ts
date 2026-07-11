import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerRunPromise = new Promise<void>(() => {});
const workerRun = vi.fn(() => workerRunPromise);
const workerCreate = vi.fn(async () => ({ run: workerRun }));
const nativeConnectionConnect = vi.fn(async () => ({}));
const schedulerConnectionClose = vi.fn(async () => {});
const schedulerConnectionConnect = vi.fn(async () => ({ close: schedulerConnectionClose }));
const workflowStart = vi.fn(async () => undefined);
const clientConstructor = vi.fn(function Client() {
  return { workflow: { start: workflowStart } };
});
const startWorkerObservability = vi.fn(async () => ({ metrics: {} }));
const createTelemetryResource = vi.fn();
const createTraceExporter = vi.fn();
const createWorkflowExporterSink = vi.fn();
const destroyStartupDb = vi.fn(async () => undefined);
const assertSandboxRuntimeBinding = vi.fn(async () => undefined);

vi.mock('@tixkit/db', () => ({
  createDb: vi.fn(() => ({ destroy: destroyStartupDb })),
  assertSandboxRuntimeBinding,
}));

vi.mock('@temporalio/worker', () => ({
  NativeConnection: { connect: nativeConnectionConnect },
  Worker: { create: workerCreate },
}));

vi.mock('@temporalio/client', () => ({
  Client: clientConstructor,
  Connection: { connect: schedulerConnectionConnect },
}));

vi.mock('@tixkit/shared', () => ({
  createTelemetryResource,
  createTraceExporter,
}));

vi.mock('../observability.js', () => ({
  TixkitActivityMetricsInterceptor: class TixkitActivityMetricsInterceptor {
    readonly mocked = true;
  },
  startWorkerObservability,
}));

vi.mock('../otel-workflow-exporter.js', () => ({
  createWorkflowExporterSink,
}));

describe('ensureHoldExpirationScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowStart.mockResolvedValue(undefined);
  });

  it('starts the scheduled hold-expiration workflow and closes the scheduler connection', async () => {
    const { ensureHoldExpirationScheduler } = await import('../worker.js');

    await expect(ensureHoldExpirationScheduler()).resolves.toBe('started');

    expect(workflowStart).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        taskQueue: 'tixkit',
        workflowId: 'hold-expiration:scheduled',
        args: [{ version: 1 }],
      }),
    );
    expect(schedulerConnectionClose).toHaveBeenCalledTimes(1);
  });

  it('treats an already-started hold-expiration workflow as ready and closes the connection', async () => {
    const { ensureHoldExpirationScheduler } = await import('../worker.js');
    workflowStart.mockRejectedValue(
      Object.assign(new Error('Workflow execution already started'), {
        name: 'WorkflowExecutionAlreadyStartedError',
      }),
    );

    await expect(ensureHoldExpirationScheduler()).resolves.toBe('already_started');

    expect(schedulerConnectionClose).toHaveBeenCalledTimes(1);
  });

  it('surfaces scheduler start failures and closes the connection', async () => {
    const { ensureHoldExpirationScheduler } = await import('../worker.js');
    const failure = new Error('Temporal unavailable');
    workflowStart.mockRejectedValue(failure);

    await expect(ensureHoldExpirationScheduler()).rejects.toThrow('Temporal unavailable');

    expect(schedulerConnectionClose).toHaveBeenCalledTimes(1);
  });
});

describe('runWorker', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    workflowStart.mockResolvedValue(undefined);
    process.env.OTEL_SDK_DISABLED = 'true';
    delete process.env.TEMPORAL_EXPORT_TASK_QUEUE;
    delete process.env.TEMPORAL_PDF_TASK_QUEUE;
    delete process.env.TEMPORAL_WALLET_TASK_QUEUE;
    delete process.env.TEMPORAL_WORKER_MAX_CACHED_WORKFLOWS;
    delete process.env.TEMPORAL_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS;
    delete process.env.TEMPORAL_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS;
    delete process.env.TEMPORAL_WORKER_TASK_QUEUES;
    delete process.env.TEMPORAL_TASK_QUEUE;
    delete process.env.TIXKIT_RUNTIME_MODE;
    delete process.env.TIXKIT_SANDBOX_EPOCH;
  });

  it('emits readiness only after all recovery schedulers are ensured', async () => {
    const { runWorker } = await import('../worker.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const operations: string[] = [];
    workflowStart.mockImplementation(async () => {
      operations.push('scheduler-started');
    });
    workerRun.mockImplementation(() => {
      operations.push('worker-run');
      return workerRunPromise;
    });
    log.mockImplementation((message) => {
      if (String(message).startsWith('TIXKIT_WORKER_READY')) operations.push('ready-log');
    });

    const started = runWorker({ workflowsPath: 'test-workflows.js' });
    await vi.waitFor(() =>
      expect(operations).toEqual([
        'scheduler-started',
        'scheduler-started',
        'worker-run',
        'ready-log',
      ]),
    );

    expect(log).toHaveBeenCalledWith('TIXKIT_WORKER_READY taskQueues=tixkit');
    await expect(Promise.race([started, Promise.resolve('running')])).resolves.toBe('running');
    log.mockRestore();
  });

  it('passes configured concurrency limits into Worker.create', async () => {
    process.env.TEMPORAL_WORKER_MAX_CONCURRENT_ACTIVITY_TASK_EXECUTIONS = '7';
    process.env.TEMPORAL_WORKER_MAX_CONCURRENT_WORKFLOW_TASK_EXECUTIONS = '3';
    process.env.TEMPORAL_WORKER_MAX_CACHED_WORKFLOWS = '11';
    const { runWorker } = await import('../worker.js');

    const started = runWorker({ workflowsPath: 'test-workflows.js' });
    await vi.waitFor(() => expect(workerCreate).toHaveBeenCalled());

    expect(workerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        maxConcurrentActivityTaskExecutions: 7,
        maxConcurrentWorkflowTaskExecutions: 3,
        maxCachedWorkflows: 11,
      }),
    );
    await expect(Promise.race([started, Promise.resolve('running')])).resolves.toBe('running');
  });

  it('starts both recovery schedulers with the sandbox epoch on the rotated queue', async () => {
    process.env.TIXKIT_RUNTIME_MODE = 'sandbox';
    process.env.TIXKIT_SANDBOX_EPOCH = 'epoch_2';
    process.env.TEMPORAL_TASK_QUEUE = 'tixkit-sandbox-epoch_2';
    process.env.TEMPORAL_WORKER_TASK_QUEUES = 'tixkit-sandbox-epoch_2';
    const { runWorker } = await import('../worker.js');

    const started = runWorker({ workflowsPath: 'test-workflows.js' });
    await vi.waitFor(() => expect(workflowStart).toHaveBeenCalledTimes(2));

    expect(assertSandboxRuntimeBinding).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runtimeMode: 'sandbox',
        epoch: 'epoch_2',
        taskQueues: ['tixkit-sandbox-epoch_2'],
      }),
    );
    expect(
      workflowStart.mock.calls.map(
        (call) => (call as unknown as [unknown, Record<string, unknown>])[1],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskQueue: 'tixkit-sandbox-epoch_2',
          workflowId: 'hold-expiration:scheduled:epoch_2',
        }),
        expect.objectContaining({
          taskQueue: 'tixkit-sandbox-epoch_2',
          workflowId: 'provider-event-recovery:scheduled:epoch_2',
        }),
      ]),
    );
    await expect(Promise.race([started, Promise.resolve('running')])).resolves.toBe('running');
  });
});

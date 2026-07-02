import { proxyActivities, sleep } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const {
  generateExportActivity,
  uploadFileActivity,
  markExportFailedActivity,
  notifyExportCompleteActivity,
} = proxyActivities<{
  generateExportActivity(input: {
    exportId: string;
    type: string;
    format: string;
  }): Promise<WorkflowActivityResult<{ data: string; rowCount: number }>>;
  uploadFileActivity(input: {
    exportId: string;
    data: string;
    format: string;
  }): Promise<WorkflowActivityResult<{ fileUrl: string }>>;
  markExportFailedActivity(input: {
    exportId: string;
    reason?: string;
  }): Promise<WorkflowActivityResult<{ failed: boolean }>>;
  notifyExportCompleteActivity(input: {
    exportId: string;
    fileUrl: string;
    requestedBy: string;
    tenantId?: string;
  }): Promise<WorkflowActivityResult<{ notified: boolean }>>;
}>({
  startToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '10 seconds',
    backoffCoefficient: 2,
  },
});

export type ExportWorkflowInput = {
  version: number;
  exportId: string;
  type: string;
  format: string;
  requestedBy: string;
  tenantId?: string;
};

const EXPORT_RETRY_BACKOFFS = ['10 seconds', '20 seconds'] as const;

async function runExportStep<T>(
  runActivity: () => Promise<WorkflowActivityResult<T>>,
): Promise<WorkflowActivityResult<T>> {
  let result: WorkflowActivityResult<T> | undefined;

  for (let attempt = 0; attempt <= EXPORT_RETRY_BACKOFFS.length; attempt += 1) {
    result = await runActivity();
    if (result.ok || !result.retryable) return result;
    if (attempt < EXPORT_RETRY_BACKOFFS.length) {
      await sleep(EXPORT_RETRY_BACKOFFS[attempt]);
    }
  }

  return result!;
}

export async function exportWorkflow(
  input: ExportWorkflowInput,
): Promise<{ status: string; fileUrl?: string }> {
  const genResult = await runExportStep(() =>
    generateExportActivity({
      exportId: input.exportId,
      type: input.type,
      format: input.format,
    }),
  );

  if (!genResult.ok) {
    await markExportFailedActivity({ exportId: input.exportId, reason: genResult.message });
    return { status: 'failed' };
  }

  const uploadResult = await runExportStep(() =>
    uploadFileActivity({
      exportId: input.exportId,
      data: genResult.value.data,
      format: input.format,
    }),
  );

  if (!uploadResult.ok) {
    await markExportFailedActivity({ exportId: input.exportId, reason: uploadResult.message });
    return { status: 'failed' };
  }

  const notifyResult = await runExportStep(() =>
    notifyExportCompleteActivity({
      exportId: input.exportId,
      fileUrl: uploadResult.value.fileUrl,
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
    }),
  );

  if (!notifyResult.ok) {
    await markExportFailedActivity({ exportId: input.exportId, reason: notifyResult.message });
    return { status: 'failed' };
  }

  return { status: 'completed', fileUrl: uploadResult.value.fileUrl };
}

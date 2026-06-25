import { proxyActivities } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const { generateExportActivity, uploadFileActivity, markExportFailedActivity, notifyExportCompleteActivity } = proxyActivities<{
  generateExportActivity(input: { exportId: string; type: string; format: string }): Promise<WorkflowActivityResult<{ data: string; rowCount: number }>>;
  uploadFileActivity(input: { exportId: string; data: string; format: string }): Promise<WorkflowActivityResult<{ fileUrl: string }>>;
  markExportFailedActivity(input: { exportId: string; reason?: string }): Promise<WorkflowActivityResult<{ failed: boolean }>>;
  notifyExportCompleteActivity(input: { exportId: string; fileUrl: string; requestedBy: string; tenantId?: string }): Promise<WorkflowActivityResult<{ notified: boolean }>>;
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

export async function exportWorkflow(input: ExportWorkflowInput): Promise<{ status: string; fileUrl?: string }> {
  try {
    const genResult = await generateExportActivity({
      exportId: input.exportId,
      type: input.type,
      format: input.format,
    });

    if (!genResult.ok) {
      await markExportFailedActivity({ exportId: input.exportId, reason: genResult.message });
      return { status: 'failed' };
    }

    const uploadResult = await uploadFileActivity({
      exportId: input.exportId,
      data: genResult.value.data,
      format: input.format,
    });

    if (!uploadResult.ok) {
      await markExportFailedActivity({ exportId: input.exportId, reason: uploadResult.message });
      return { status: 'failed' };
    }

    await notifyExportCompleteActivity({
      exportId: input.exportId,
      fileUrl: uploadResult.value.fileUrl,
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
    });

    return { status: 'completed', fileUrl: uploadResult.value.fileUrl };
  } catch (err) {
    await markExportFailedActivity({
      exportId: input.exportId,
      reason: err instanceof Error ? err.message : 'Unknown export workflow failure',
    });
    return { status: 'failed' };
  }
}

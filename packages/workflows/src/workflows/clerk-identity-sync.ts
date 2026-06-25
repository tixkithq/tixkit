import { proxyActivities } from '@temporalio/workflow';
import type { WorkflowActivityResult } from '../shared/types.js';

const { syncUserActivity, syncOrganizationActivity, deleteUserActivity } = proxyActivities<{
  syncUserActivity(input: { clerkUserId: string; email: string; firstName?: string; lastName?: string; avatarUrl?: string }): Promise<WorkflowActivityResult<{ userId: string; created: boolean }>>;
  syncOrganizationActivity(input: { clerkOrgId: string; name: string }): Promise<WorkflowActivityResult<{ orgId: string; created: boolean }>>;
  deleteUserActivity(input: { clerkUserId: string }): Promise<WorkflowActivityResult<{ suspended: boolean }>>;
}>({
  startToCloseTimeout: '30 seconds',
  retry: {
    maximumAttempts: 3,
    initialInterval: '2 seconds',
    backoffCoefficient: 2,
  },
});

export type ClerkIdentitySyncWorkflowInput = {
  version: number;
  eventType: string;
  clerkUserId?: string;
  clerkOrgId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
  orgName?: string;
};

export async function clerkIdentitySyncWorkflow(input: ClerkIdentitySyncWorkflowInput): Promise<{ status: string }> {
  switch (input.eventType) {
    case 'user.created':
    case 'user.updated': {
      if (!input.clerkUserId || !input.email) return { status: 'skipped' };
      const result = await syncUserActivity({
        clerkUserId: input.clerkUserId,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        avatarUrl: input.avatarUrl,
      });
      return result.ok ? { status: 'synced' } : { status: 'failed' };
    }
    case 'user.deleted': {
      if (!input.clerkUserId) return { status: 'skipped' };
      const result = await deleteUserActivity({ clerkUserId: input.clerkUserId });
      return result.ok ? { status: 'synced' } : { status: 'failed' };
    }
    case 'organization.created':
    case 'organization.updated': {
      if (!input.clerkOrgId || !input.orgName) return { status: 'skipped' };
      const result = await syncOrganizationActivity({
        clerkOrgId: input.clerkOrgId,
        name: input.orgName,
      });
      return result.ok ? { status: 'synced' } : { status: 'failed' };
    }
    default:
      return { status: 'unhandled' };
  }
}

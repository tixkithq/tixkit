import { UserProfileRepository, OrganizationRepository } from '@tixkit/db';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';
import { getActivityDb } from './activity-clients.js';

export async function syncUserActivity(input: {
  clerkUserId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
}): Promise<WorkflowActivityResult<{ userId: string; created: boolean }>> {
  const db = getActivityDb();
  try {
    const repo = new UserProfileRepository(db);
    const existing = await repo.findByClerkUserId('system', input.clerkUserId);
    if (existing) {
      await repo.update(existing.id, {
        email: input.email,
        first_name: input.firstName ?? null,
        last_name: input.lastName ?? null,
        avatar_url: input.avatarUrl ?? null,
      });
      return okResult({ userId: existing.id, created: false });
    }

    const record = await repo.create({
      tenantId: 'system',
      clerkUserId: input.clerkUserId,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      avatarUrl: input.avatarUrl,
    });
    return okResult({ userId: record.id, created: true });
  } catch (err) {
    return errResult(
      'USER_SYNC_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

export async function syncOrganizationActivity(input: {
  clerkOrgId: string;
  name: string;
}): Promise<WorkflowActivityResult<{ orgId: string; created: boolean }>> {
  const db = getActivityDb();
  try {
    const repo = new OrganizationRepository(db);
    const existing = await db
      .selectFrom('organizations')
      .selectAll()
      .where('clerk_organization_id', '=', input.clerkOrgId)
      .executeTakeFirst();
    if (existing) {
      await repo.update(existing.id, { name: input.name });
      return okResult({ orgId: existing.id, created: false });
    }
    const record = await repo.create({
      tenantId: 'system',
      name: input.name,
      slug: input.clerkOrgId,
      clerkOrganizationId: input.clerkOrgId,
    });
    return okResult({ orgId: record.id, created: true });
  } catch (err) {
    return errResult('ORG_SYNC_FAILED', err instanceof Error ? err.message : 'Unknown error', true);
  }
}

export async function deleteUserActivity(input: {
  clerkUserId: string;
}): Promise<WorkflowActivityResult<{ suspended: boolean }>> {
  const db = getActivityDb();
  try {
    const repo = new UserProfileRepository(db);
    // Suspend every profile across all tenants; never delete history.
    const profiles = await repo.findAllByClerkUserId(input.clerkUserId);
    await Promise.all(
      profiles
        .filter((profile) => profile.status !== 'suspended')
        .map((profile) => repo.suspend(profile.id)),
    );
    return okResult({ suspended: profiles.length > 0 });
  } catch (err) {
    return errResult(
      'USER_DELETE_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      true,
    );
  }
}

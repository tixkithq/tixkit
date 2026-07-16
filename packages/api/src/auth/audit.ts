import type { FastifyRequest } from 'fastify';
import type { Principal } from '@tixkit/domain';
import type { AuditLogRepository } from '@tixkit/db';

export type AuditEntry = {
  action: string;
  organizationId?: string | null;
  brandId?: string | null;
  resourceType: string;
  resourceId: string;
  diffSummary?: Record<string, unknown>;
};

/**
 * Writes an audit log entry for a privileged mutation, capturing the actor,
 * resource, diff summary, IP, and user agent. The default mode is best-effort
 * for legacy callers. Consequential credential mutations use `failClosed`
 * inside their database transaction so an audit failure rolls back the change.
 */
export async function writeAuditLog(
  repo: AuditLogRepository,
  request: FastifyRequest,
  principal: Principal,
  entry: AuditEntry,
  options: { failClosed?: boolean } = {},
): Promise<void> {
  try {
    await repo.create({
      tenantId: principal.tenantId,
      organizationId: entry.organizationId,
      brandId: entry.brandId,
      actorType: principal.type,
      actorId: principal.id,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      diffSummary: entry.diffSummary,
      requestId: request.id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  } catch (err) {
    request.log.warn({ err, action: entry.action }, 'Failed to write audit log');
    if (options.failClosed) throw err;
  }
}

import type { FastifyRequest } from 'fastify';
import type { Principal } from '@gatekit/domain';
import type { AuditLogRepository } from '@gatekit/db';

export type AuditEntry = {
  action: string;
  resourceType: string;
  resourceId: string;
  diffSummary?: Record<string, unknown>;
};

/**
 * Writes an audit log entry for a privileged mutation, capturing the actor,
 * resource, diff summary, IP, and user agent. Audit logging must never block
 * the underlying mutation, so failures are swallowed after being logged.
 */
export async function writeAuditLog(
  repo: AuditLogRepository,
  request: FastifyRequest,
  principal: Principal,
  entry: AuditEntry,
): Promise<void> {
  try {
    await repo.create({
      tenantId: principal.tenantId,
      actorType: principal.type,
      actorId: principal.id,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      diffSummary: entry.diffSummary,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  } catch (err) {
    request.log.warn({ err, action: entry.action }, 'Failed to write audit log');
  }
}

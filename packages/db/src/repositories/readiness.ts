import { ulid } from 'ulid';
import type { EventLaunchReadinessStepId } from '@tixkit/domain';
import { getDriver, type Database } from '../client.js';
import { insertReturning } from './base.js';

export interface ReadinessScope {
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
}

export class EventReadinessAcknowledgementRepository {
  constructor(private readonly db: Database) {}

  async findByEvent(scope: ReadinessScope) {
    return this.db
      .selectFrom('event_readiness_acknowledgements')
      .selectAll()
      .where('tenant_id', '=', scope.tenantId)
      .where('organization_id', '=', scope.organizationId)
      .where('brand_id', '=', scope.brandId)
      .where('event_id', '=', scope.eventId)
      .execute();
  }

  async acknowledge(
    scope: ReadinessScope,
    input: {
      stepId: EventLaunchReadinessStepId;
      stepVersion: number;
      subjectFingerprint: string;
      actorId: string;
    },
  ) {
    const id = `era_${ulid()}`;
    const values = {
      id,
      tenant_id: scope.tenantId,
      organization_id: scope.organizationId,
      brand_id: scope.brandId,
      event_id: scope.eventId,
      step_id: input.stepId,
      step_version: input.stepVersion,
      subject_fingerprint: input.subjectFingerprint,
      actor_id: input.actorId,
      acknowledged_at: new Date(),
    };
    const updates = {
      step_version: values.step_version,
      subject_fingerprint: values.subject_fingerprint,
      actor_id: values.actor_id,
      acknowledged_at: values.acknowledged_at,
    };

    if (getDriver() === 'postgres') {
      return this.db
        .insertInto('event_readiness_acknowledgements')
        .values(values)
        .onConflict((conflict) =>
          conflict
            .columns(['tenant_id', 'organization_id', 'brand_id', 'event_id', 'step_id'])
            .doUpdateSet(updates),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    if (getDriver() === 'mysql') {
      await this.db
        .insertInto('event_readiness_acknowledgements')
        .values(values)
        .onDuplicateKeyUpdate(updates)
        .execute();
      return this.db
        .selectFrom('event_readiness_acknowledgements')
        .selectAll()
        .where('tenant_id', '=', scope.tenantId)
        .where('organization_id', '=', scope.organizationId)
        .where('brand_id', '=', scope.brandId)
        .where('event_id', '=', scope.eventId)
        .where('step_id', '=', input.stepId)
        .executeTakeFirstOrThrow();
    }

    return this.db.transaction().execute(async (trx) => {
      await trx
        .deleteFrom('event_readiness_acknowledgements')
        .where('tenant_id', '=', scope.tenantId)
        .where('organization_id', '=', scope.organizationId)
        .where('brand_id', '=', scope.brandId)
        .where('event_id', '=', scope.eventId)
        .where('step_id', '=', input.stepId)
        .execute();
      return insertReturning(trx, 'event_readiness_acknowledgements', values, id);
    });
  }

  async delete(scope: ReadinessScope, stepId: EventLaunchReadinessStepId): Promise<boolean> {
    const result = await this.db
      .deleteFrom('event_readiness_acknowledgements')
      .where('tenant_id', '=', scope.tenantId)
      .where('organization_id', '=', scope.organizationId)
      .where('brand_id', '=', scope.brandId)
      .where('event_id', '=', scope.eventId)
      .where('step_id', '=', stepId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}

import type { FastifyPluginAsync } from 'fastify';
import { ulid } from 'ulid';
import { ClerkAuthService } from '../../auth/clerk.js';
import {
  AuditLogRepository,
  EventRepository,
  bumpEventPublicRevision,
  getDriver,
  type Database,
} from '@tixkit/db';
import { writeAuditLog } from '../../auth/audit.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  validateQuestionDefinition,
  type Principal,
  type QuestionType,
} from '@tixkit/domain';
import { parseJsonValue, parsePagination, pageEnvelope } from '../../http/contracts.js';
import {
  createQuestionSchema,
  reorderQuestionsSchema,
  updateQuestionSchema,
  parseBody,
} from '../../http/schemas.js';

type QuestionDefinitionInput = {
  id?: string;
  type: QuestionType;
  options?: string[] | null;
  validationPattern?: string | null;
  conditionalVisibility?: {
    field: string;
    operator: 'equals' | 'not_equals' | 'contains';
    value: string;
  } | null;
  sortOrder?: number;
  isConsentField?: boolean;
  consentText?: string | null;
  consentVersion?: string | null;
};

function requireEventAccess(principal: Principal, event: Record<string, unknown>, eventId: string) {
  ClerkAuthService.requireResourceTenant(principal, event, 'Event', eventId);
  ClerkAuthService.requireOrganizationScope(principal, event.organization_id as string | undefined);
  ClerkAuthService.requireBrandScope(principal, event.brand_id as string | undefined);
  ClerkAuthService.requireEventScope(principal, eventId);
}

function assertQuestionDefinition(input: QuestionDefinitionInput) {
  const errors = validateQuestionDefinition(input);
  if (errors.length > 0) {
    throw new ValidationError(errors[0], { errors });
  }
}

function isRetryableQuestionUpdateConflict(error: unknown): boolean {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  while (pending.length > 0 && visited.size < 20) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    const databaseError = current as {
      cause?: unknown;
      code?: string;
      errno?: number;
      number?: number;
      originalError?: unknown;
    };
    if (
      databaseError.code === '40001' ||
      databaseError.code === '40P01' ||
      databaseError.code === 'ER_LOCK_DEADLOCK' ||
      databaseError.code === 'ER_LOCK_WAIT_TIMEOUT' ||
      databaseError.errno === 1213 ||
      databaseError.errno === 1205 ||
      databaseError.number === 1205
    ) {
      return true;
    }
    pending.push(databaseError.cause, databaseError.originalError);
  }
  return false;
}

async function executeQuestionUpdateWithRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableQuestionUpdateConflict(error) || attempt === 3) throw error;
    }
  }
  throw new Error('QUESTION_UPDATE_TRANSACTION_RETRY_EXHAUSTED');
}

function questionMaterialSnapshot(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.event_id,
    ticketTypeId: row.ticket_type_id ?? null,
    type: row.type,
    label: row.label,
    description: row.description ?? null,
    required: row.required === true || row.required === 1,
    appliesTo: row.applies_to,
    options: parseJsonValue(row.options, null),
    placeholder: row.placeholder ?? null,
    validationPattern: row.validation_pattern ?? null,
    conditionalVisibility: parseJsonValue(row.conditional_visibility, null),
    sortOrder: row.sort_order,
    isConsentField: row.is_consent_field === true || row.is_consent_field === 1,
    consentText: row.consent_text ?? null,
    consentVersion: row.consent_version ?? null,
  };
}

function questionMaterialChangedFields(
  before: ReturnType<typeof questionMaterialSnapshot>,
  after: ReturnType<typeof questionMaterialSnapshot>,
) {
  const changedFields = (Object.keys(before) as Array<keyof typeof before>).filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  );
  return changedFields;
}

function questionUpdateAuditSnapshot(row: Record<string, unknown>) {
  const material = questionMaterialSnapshot(row);
  return {
    id: material.id,
    eventId: material.eventId,
    ticketTypeId: material.ticketTypeId,
    type: material.type,
    label: material.label,
    required: material.required,
    appliesTo: material.appliesTo,
    conditionalVisibility: material.conditionalVisibility,
    sortOrder: material.sortOrder,
    isConsentField: material.isConsentField,
    consentVersion: material.consentVersion,
  };
}

function questionUpdateAuditDiff(
  before: ReturnType<typeof questionUpdateAuditSnapshot>,
  after: ReturnType<typeof questionUpdateAuditSnapshot>,
  changedFields: readonly string[],
) {
  return {
    before,
    after,
    changedFields,
    noOp: changedFields.length === 0,
    sensitiveChanges: {
      consentTextChanged: changedFields.includes('consentText'),
      contentChanged: changedFields.some((field) =>
        ['description', 'options', 'placeholder', 'validationPattern'].includes(field),
      ),
    },
  };
}

export const questionRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  const loadEvent = async (eventId: string) => {
    const eventRepo = new EventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    return event;
  };

  const loadScopedTicketType = async (
    database: Database,
    eventId: string,
    ticketTypeId?: string | null,
    options?: { lock?: boolean },
  ) => {
    if (!ticketTypeId) return;
    const ticketType = options?.lock
      ? (
          await database
            .selectFrom('ticket_types')
            .selectAll()
            .where('event_id', '=', eventId)
            .forUpdate()
            .execute()
        ).find((candidate) => candidate.id === ticketTypeId)
      : await (async () => {
          const preflight = await database
            .selectFrom('ticket_types')
            .selectAll()
            .where('id', '=', ticketTypeId)
            .where('event_id', '=', eventId)
            .executeTakeFirst();
          return preflight;
        })();
    if (!ticketType) throw new NotFoundError('TicketType', ticketTypeId);
  };

  const requireConditionalReference = async (
    database: Database,
    eventId: string,
    conditionalVisibility?: { field: string } | null,
    options?: { lock?: boolean },
  ) => {
    if (!conditionalVisibility) return;
    const source = options?.lock
      ? (
          await database
            .selectFrom('questions')
            .selectAll()
            .where('event_id', '=', eventId)
            .forUpdate()
            .execute()
        ).find((candidate) => candidate.id === conditionalVisibility.field)
      : await (async () => {
          const preflight = await database
            .selectFrom('questions')
            .selectAll()
            .where('id', '=', conditionalVisibility.field)
            .where('event_id', '=', eventId)
            .executeTakeFirst();
          return preflight;
        })();
    if (!source) {
      throw new ValidationError('Conditional visibility source question must belong to this event');
    }
    if (isHiddenQuestion(source)) {
      throw new ValidationError('Conditional visibility source question must be active');
    }
  };

  const requireNoActiveConditionalDependents = async (
    database: Database,
    eventId: string,
    sourceQuestionId: string,
  ) => {
    const questions = await database
      .selectFrom('questions')
      .selectAll()
      .where('event_id', '=', eventId)
      .forUpdate()
      .execute();
    const dependent = questions.find(
      (candidate) =>
        candidate.id !== sourceQuestionId &&
        !isHiddenQuestion(candidate) &&
        questionDependsOn(candidate, sourceQuestionId),
    );
    if (dependent) {
      throw new ConflictError(
        'Question has active conditional dependents and cannot be hidden or deleted',
      );
    }
  };

  app.post('/events/:eventId/questions', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createQuestionSchema, request.body);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    const isConsentField = body.type === 'waiver' ? true : (body.isConsentField ?? false);
    const consentVersion = isConsentField ? (body.consentVersion ?? '1') : null;
    const options = normalizeOptions(body.options);
    assertQuestionDefinition({
      type: body.type,
      options,
      validationPattern: body.validationPattern,
      conditionalVisibility: body.conditionalVisibility,
      sortOrder: body.sortOrder,
      isConsentField,
      consentText: body.consentText,
      consentVersion,
    });

    const id = `q_${ulid()}`;
    const now = new Date();
    const question = await db.transaction().execute(async (trx) => {
      const lockedEvent = await trx
        .selectFrom('events')
        .selectAll()
        .where('id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!lockedEvent) throw new NotFoundError('Event', eventId);
      requireEventAccess(principal, lockedEvent, eventId);
      await loadScopedTicketType(trx, eventId, body.ticketTypeId);
      await requireConditionalReference(trx, eventId, body.conditionalVisibility);
      const insertQuestion = trx.insertInto('questions').values({
        id,
        event_id: eventId,
        ticket_type_id: body.ticketTypeId ?? null,
        type: body.type,
        label: body.label,
        description: body.description ?? null,
        required: body.required ?? false,
        applies_to: body.appliesTo ?? 'attendee',
        options: options ? JSON.stringify(options) : null,
        placeholder: body.placeholder ?? null,
        validation_pattern: body.validationPattern ?? null,
        conditional_visibility: body.conditionalVisibility
          ? JSON.stringify(body.conditionalVisibility)
          : null,
        sort_order: body.sortOrder ?? 0,
        is_consent_field: isConsentField,
        consent_text: body.consentText ?? null,
        consent_version: consentVersion,
        created_at: now,
        updated_at: now,
      });
      const created =
        getDriver() === 'postgres'
          ? await insertQuestion.returningAll().executeTakeFirstOrThrow()
          : await insertQuestion
              .execute()
              .then(() =>
                trx
                  .selectFrom('questions')
                  .selectAll()
                  .where('id', '=', id)
                  .executeTakeFirstOrThrow(),
              );
      await bumpEventPublicRevision(trx, eventId, now);
      return created;
    });

    return reply.status(201).send(serializeQuestion(question));
  });

  app.get('/events/:eventId/questions', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.read');
    const { eventId } = request.params as { eventId: string };
    const pagination = parsePagination(request.query);
    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    let query = db
      .selectFrom('questions')
      .selectAll()
      .where('event_id', '=', eventId)
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .limit(pagination.limit + 1);
    if (pagination.cursor) query = query.where('id', '>', pagination.cursor);
    const rows = await query.execute();
    return pageEnvelope(
      rows.filter((row) => !isHiddenQuestion(row)).map((row) => serializeQuestion(row)),
      pagination.limit,
    );
  });

  app.post('/events/:eventId/questions/reorder', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(reorderQuestionsSchema, request.body);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);

    const questionIds = body.questions.map((question) => question.id);
    if (new Set(questionIds).size !== questionIds.length) {
      throw new ValidationError('Duplicate question IDs are not allowed in a reorder request');
    }

    await app.context.questionReorderCheckpoint?.({ stage: 'before_transaction', eventId });

    const rows = await db.transaction().execute(async (trx) => {
      const currentEvent = await trx
        .selectFrom('events')
        .selectAll()
        .where('id', '=', eventId)
        .forUpdate()
        .executeTakeFirst();
      if (!currentEvent) throw new NotFoundError('Event', eventId);
      requireEventAccess(principal, currentEvent, eventId);
      const existing = await trx
        .selectFrom('questions')
        .selectAll()
        .where('event_id', '=', eventId)
        .where('id', 'in', questionIds)
        .forUpdate()
        .execute();
      if (existing.length !== questionIds.length) {
        throw new NotFoundError(
          'Question',
          questionIds.find((id) => !existing.some((question) => question.id === id)) ?? eventId,
        );
      }
      const before = existing
        .map((question) => ({ id: question.id, sortOrder: Number(question.sort_order) }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const revision = new Date();
      for (const question of body.questions) {
        // eslint-disable-next-line no-await-in-loop -- reorder updates run sequentially on one transaction connection for deterministic rollback behavior.
        await trx
          .updateTable('questions')
          .set({ sort_order: question.sortOrder, updated_at: revision })
          .where('event_id', '=', eventId)
          .where('id', '=', question.id)
          .execute();
      }
      const updatedEvent = await new EventRepository(trx).update(eventId, {});
      const reordered = await trx
        .selectFrom('questions')
        .selectAll()
        .where('event_id', '=', eventId)
        .where('id', 'in', questionIds)
        .orderBy('sort_order', 'asc')
        .orderBy('id', 'asc')
        .execute();
      await writeAuditLog(
        new AuditLogRepository(trx),
        request,
        principal,
        {
          action: 'event.questions.reordered',
          organizationId: currentEvent.organization_id,
          brandId: currentEvent.brand_id,
          resourceType: 'Event',
          resourceId: eventId,
          diffSummary: {
            before,
            after: reordered
              .map((question) => ({ id: question.id, sortOrder: Number(question.sort_order) }))
              .sort((left, right) => left.id.localeCompare(right.id)),
            previousVersion: Number(currentEvent.version),
            newVersion: Number(updatedEvent.version),
          },
        },
        { failClosed: true },
      );
      return reordered;
    });

    return pageEnvelope(
      rows.filter((row) => !isHiddenQuestion(row)).map((row) => serializeQuestion(row)),
      rows.length,
    );
  });

  app.patch('/questions/:questionId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { questionId } = request.params as { questionId: string };
    const preflightQuestion = await db
      .selectFrom('questions')
      .selectAll()
      .where('id', '=', questionId)
      .executeTakeFirst();
    if (!preflightQuestion) throw new NotFoundError('Question', 'concealed');
    const preflightEvent = await db
      .selectFrom('events')
      .selectAll()
      .where('tenant_id', '=', principal.tenantId)
      .where('id', '=', preflightQuestion.event_id)
      .executeTakeFirst();
    if (!preflightEvent) throw new NotFoundError('Question', 'concealed');
    try {
      requireEventAccess(principal, preflightEvent, preflightQuestion.event_id);
    } catch (error) {
      if (error instanceof NotFoundError) throw new NotFoundError('Question', 'concealed');
      throw error;
    }
    const body = parseBody(updateQuestionSchema, request.body);
    if (Object.keys(body).length === 0)
      throw new ValidationError('Question update requires a field');
    // MySQL SERIALIZABLE reads can wait behind a foreign row lock even without
    // FOR UPDATE. Verify a newly supplied dependency before entering the
    // transaction; the same-event locked revalidation below remains authoritative.
    if (body.ticketTypeId !== undefined) {
      await loadScopedTicketType(db, preflightQuestion.event_id, body.ticketTypeId);
    }
    if (body.conditionalVisibility !== undefined) {
      await requireConditionalReference(db, preflightQuestion.event_id, body.conditionalVisibility);
    }

    const updated = await executeQuestionUpdateWithRetry(() =>
      db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async (trx) => {
          await app.context.questionUpdateCheckpoint?.({
            stage: 'before_event_lock',
            questionId,
            eventId: preflightQuestion.event_id,
          });
          const event = await trx
            .selectFrom('events')
            .selectAll()
            .where('tenant_id', '=', principal.tenantId)
            .where('id', '=', preflightQuestion.event_id)
            .forUpdate()
            .executeTakeFirst();
          if (!event) throw new NotFoundError('Question', 'concealed');
          await app.context.questionUpdateCheckpoint?.({
            stage: 'after_event_lock',
            questionId,
            eventId: preflightQuestion.event_id,
          });
          const question = (
            await trx
              .selectFrom('questions')
              .selectAll()
              .where('event_id', '=', event.id)
              .forUpdate()
              .execute()
          ).find((candidate) => candidate.id === questionId);
          if (!question) throw new NotFoundError('Question', 'concealed');
          await app.context.questionUpdateCheckpoint?.({
            stage: 'after_question_lock',
            questionId,
            eventId: question.event_id,
          });
          try {
            ClerkAuthService.requirePermission(principal, 'events.write');
            requireEventAccess(principal, event, question.event_id);
          } catch (error) {
            if (error instanceof NotFoundError) throw new NotFoundError('Question', 'concealed');
            throw error;
          }

          const existingOptions = parseJsonValue<string[] | undefined>(question.options, undefined);
          const finalType = (body.type ?? question.type) as QuestionType;
          let finalOptions =
            body.options !== undefined
              ? body.options === null
                ? undefined
                : normalizeOptions(body.options)
              : existingOptions;
          if (
            body.type !== undefined &&
            !isOptionBearingQuestionType(finalType) &&
            body.options === undefined
          ) {
            finalOptions = undefined;
          }
          const finalConditionalVisibility =
            body.conditionalVisibility !== undefined
              ? body.conditionalVisibility
              : parseJsonValue<typeof body.conditionalVisibility | undefined>(
                  question.conditional_visibility,
                  undefined,
                );
          const finalTicketTypeId =
            body.ticketTypeId !== undefined ? body.ticketTypeId : question.ticket_type_id;
          const finalIsConsentField =
            finalType === 'waiver' ? true : (body.isConsentField ?? question.is_consent_field);
          const finalConsentText =
            body.consentText !== undefined ? body.consentText : question.consent_text;
          let finalConsentVersion =
            body.consentVersion !== undefined ? body.consentVersion : question.consent_version;
          if (
            finalIsConsentField &&
            !finalConsentVersion &&
            (body.isConsentField === true || finalType === 'waiver')
          ) {
            finalConsentVersion = '1';
          }
          if (
            finalIsConsentField &&
            body.consentText !== undefined &&
            body.consentText !== question.consent_text &&
            (body.consentVersion === undefined || body.consentVersion === question.consent_version)
          ) {
            throw new ValidationError('Changing consent text requires a new consent version');
          }
          await loadScopedTicketType(trx, question.event_id, finalTicketTypeId, { lock: true });
          await requireConditionalReference(trx, question.event_id, finalConditionalVisibility, {
            lock: true,
          });
          assertQuestionDefinition({
            id: questionId,
            type: finalType,
            options: finalOptions,
            validationPattern:
              body.validationPattern !== undefined
                ? body.validationPattern
                : question.validation_pattern,
            conditionalVisibility: finalConditionalVisibility,
            sortOrder: body.sortOrder ?? question.sort_order,
            isConsentField: finalIsConsentField,
            consentText: finalConsentText,
            consentVersion: finalConsentVersion,
          });

          const updateData: Record<string, unknown> = {};
          if (body.ticketTypeId !== undefined) updateData.ticket_type_id = finalTicketTypeId;
          if (body.type !== undefined) updateData.type = finalType;
          if (body.label !== undefined) updateData.label = body.label;
          if (body.description !== undefined) updateData.description = body.description;
          if (body.required !== undefined) updateData.required = body.required;
          if (body.appliesTo !== undefined) updateData.applies_to = body.appliesTo;
          if (
            body.options !== undefined ||
            (body.type !== undefined && !isOptionBearingQuestionType(finalType))
          ) {
            updateData.options = finalOptions ? JSON.stringify(finalOptions) : null;
          }
          if (body.placeholder !== undefined) updateData.placeholder = body.placeholder;
          if (body.validationPattern !== undefined)
            updateData.validation_pattern = body.validationPattern;
          if (body.conditionalVisibility !== undefined) {
            updateData.conditional_visibility = finalConditionalVisibility
              ? JSON.stringify(finalConditionalVisibility)
              : null;
          }
          if (body.sortOrder !== undefined) updateData.sort_order = body.sortOrder;
          if (
            body.isConsentField !== undefined ||
            (finalType === 'waiver' && !question.is_consent_field)
          ) {
            updateData.is_consent_field = finalIsConsentField;
          }
          if (finalIsConsentField && !question.consent_version && finalConsentVersion) {
            updateData.consent_version = finalConsentVersion;
          }
          if (body.consentText !== undefined) updateData.consent_text = finalConsentText;
          if (body.consentVersion !== undefined) updateData.consent_version = finalConsentVersion;

          const beforeMaterial = questionMaterialSnapshot(
            question as unknown as Record<string, unknown>,
          );
          const projected = { ...question, ...updateData } as Record<string, unknown>;
          const changedFields = questionMaterialChangedFields(
            beforeMaterial,
            questionMaterialSnapshot(projected),
          );
          await app.context.questionUpdateCheckpoint?.({
            stage: 'before_update',
            questionId,
            eventId: question.event_id,
          });
          let persisted = question;
          const now = new Date();
          if (changedFields.length > 0) {
            await trx
              .updateTable('questions')
              .set({ ...updateData, updated_at: now })
              .where('id', '=', questionId)
              .where('event_id', '=', question.event_id)
              .execute();
            persisted = await trx
              .selectFrom('questions')
              .selectAll()
              .where('id', '=', questionId)
              .where('event_id', '=', question.event_id)
              .executeTakeFirstOrThrow();
            await bumpEventPublicRevision(trx, question.event_id, now);
          }
          await writeAuditLog(
            new AuditLogRepository(trx as Database),
            request,
            principal,
            {
              action: 'question.updated',
              organizationId: event.organization_id as string,
              brandId: event.brand_id as string | null,
              resourceType: 'Question',
              resourceId: questionId,
              diffSummary: questionUpdateAuditDiff(
                questionUpdateAuditSnapshot(question as unknown as Record<string, unknown>),
                questionUpdateAuditSnapshot(persisted as unknown as Record<string, unknown>),
                changedFields,
              ),
            },
            { failClosed: true },
          );
          return persisted;
        }),
    );
    return serializeQuestion(updated);
  });

  app.delete('/questions/:questionId', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { questionId } = request.params as { questionId: string };
    await app.context.questionDeleteCheckpoint?.({ stage: 'before_transaction', questionId });
    const candidate = await db
      .selectFrom('questions')
      .select(['event_id'])
      .where('id', '=', questionId)
      .executeTakeFirst();
    if (!candidate) throw new NotFoundError('Question', questionId);

    await db.transaction().execute(async (trx) => {
      const event = await trx
        .selectFrom('events')
        .selectAll()
        .where('id', '=', candidate.event_id)
        .forUpdate()
        .executeTakeFirst();
      if (!event) throw new NotFoundError('Question', questionId);
      const question = await trx
        .selectFrom('questions')
        .selectAll()
        .where('id', '=', questionId)
        .where('event_id', '=', candidate.event_id)
        .forUpdate()
        .executeTakeFirst();
      if (!question) throw new NotFoundError('Question', questionId);
      try {
        requireEventAccess(principal, event, question.event_id);
      } catch (error) {
        if (error instanceof NotFoundError) throw new NotFoundError('Question', questionId);
        throw error;
      }

      await requireNoActiveConditionalDependents(trx, question.event_id, questionId);
      const hasHistoricalAnswers = await questionHasHistoricalAnswers(
        trx,
        question.event_id,
        questionId,
      );
      const revision = new Date();
      if (hasHistoricalAnswers) {
        const softDeleteData = softDeleteQuestionData(question);
        if (!softDeleteData) {
          throw new ConflictError(
            'Question has historical answers and cannot be hard deleted until question hiding is supported by the schema',
          );
        }
        const result = await trx
          .updateTable('questions')
          .set(softDeleteData)
          .where('id', '=', questionId)
          .where('event_id', '=', question.event_id)
          .executeTakeFirst();
        if (Number(result.numUpdatedRows) !== 1) throw new NotFoundError('Question', questionId);
      } else {
        const result = await trx
          .deleteFrom('questions')
          .where('id', '=', questionId)
          .where('event_id', '=', question.event_id)
          .executeTakeFirst();
        if (Number(result.numDeletedRows) !== 1) throw new NotFoundError('Question', questionId);
      }
      await bumpEventPublicRevision(trx, question.event_id, revision);
      await app.context.questionDeleteCheckpoint?.({ stage: 'before_audit', questionId });
      await writeAuditLog(
        new AuditLogRepository(trx),
        request,
        principal,
        {
          action: 'event.question.deleted',
          organizationId: event.organization_id,
          brandId: event.brand_id,
          resourceType: 'Question',
          resourceId: questionId,
          diffSummary: {
            deletion: hasHistoricalAnswers ? 'soft' : 'hard',
            eventId: question.event_id,
          },
        },
        { failClosed: true },
      );
    });

    return reply.status(204).send();
  });
};

function normalizeOptions(options?: string[] | null): string[] | undefined {
  if (!options) return undefined;
  return options.map((option) => option.trim());
}

function isOptionBearingQuestionType(type: QuestionType): boolean {
  return type === 'select' || type === 'multiselect';
}

function isHiddenQuestion(row: Record<string, unknown>): boolean {
  return (
    row.status === 'hidden' ||
    row.status === 'deleted' ||
    row.is_hidden === true ||
    row.is_hidden === 1 ||
    row.hidden_at != null ||
    row.deleted_at != null
  );
}

function softDeleteQuestionData(row: Record<string, unknown>): Record<string, unknown> | null {
  const updateData: Record<string, unknown> = { updated_at: new Date() };
  if ('status' in row) updateData.status = 'hidden';
  if ('is_hidden' in row) updateData.is_hidden = true;
  if ('hidden_at' in row) updateData.hidden_at = new Date();
  if ('deleted_at' in row) updateData.deleted_at = new Date();
  return Object.keys(updateData).length > 1 ? updateData : null;
}

function questionDependsOn(row: Record<string, unknown>, sourceQuestionId: string): boolean {
  const conditionalVisibility = parseJsonValue<{ field?: unknown } | undefined>(
    row.conditional_visibility,
    undefined,
  );
  return conditionalVisibility?.field === sourceQuestionId;
}

async function questionHasHistoricalAnswers(
  db: Database,
  eventId: string,
  questionId: string,
): Promise<boolean> {
  const attendees = await db
    .selectFrom('attendees')
    .select(['custom_answers'])
    .where('event_id', '=', eventId)
    .forUpdate()
    .execute();
  if (attendees.some((attendee) => containsQuestionAnswer(attendee.custom_answers, questionId))) {
    return true;
  }

  const checkoutSessions = await db
    .selectFrom('checkout_sessions')
    .select(['cart'])
    .where('event_id', '=', eventId)
    .forUpdate()
    .execute();
  return checkoutSessions.some((session) => containsQuestionAnswer(session.cart, questionId));
}

function containsQuestionAnswer(value: unknown, questionId: string): boolean {
  if (value == null) return false;
  if (typeof value === 'string') {
    try {
      return containsQuestionAnswer(JSON.parse(value), questionId);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsQuestionAnswer(item, questionId));
  }
  if (typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, questionId)) return true;
  return Object.values(record).some((item) => containsQuestionAnswer(item, questionId));
}

function serializeQuestion(row: Record<string, unknown>) {
  return {
    id: row.id,
    eventId: row.event_id,
    ticketTypeId: row.ticket_type_id ?? undefined,
    type: row.type,
    label: row.label,
    description: row.description ?? undefined,
    required: row.required === true || row.required === 1,
    appliesTo: row.applies_to,
    options: parseJsonValue<string[] | undefined>(row.options, undefined),
    placeholder: row.placeholder ?? undefined,
    validationPattern: row.validation_pattern ?? undefined,
    conditionalVisibility: parseJsonValue(row.conditional_visibility, undefined),
    sortOrder: row.sort_order,
    isConsentField: row.is_consent_field === true || row.is_consent_field === 1,
    consentText: row.consent_text ?? undefined,
    consentVersion: row.consent_version ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

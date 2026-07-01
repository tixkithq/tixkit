import type { FastifyPluginAsync } from 'fastify';
import { ulid } from 'ulid';
import { ClerkAuthService } from '../../auth/clerk.js';
import { EventRepository, type Database } from '@tixkit/db';
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

export const questionRoutes: FastifyPluginAsync = async (app) => {
  const db = app.context.db;

  const loadEvent = async (eventId: string) => {
    const eventRepo = new EventRepository(db);
    const event = await eventRepo.findById(eventId);
    if (!event) throw new NotFoundError('Event', eventId);
    return event;
  };

  const loadScopedTicketType = async (eventId: string, ticketTypeId?: string | null) => {
    if (!ticketTypeId) return;
    const ticketType = await db
      .selectFrom('ticket_types')
      .selectAll()
      .where('id', '=', ticketTypeId)
      .executeTakeFirst();
    if (!ticketType || ticketType.event_id !== eventId) {
      throw new NotFoundError('TicketType', ticketTypeId);
    }
  };

  const requireConditionalReference = async (
    eventId: string,
    conditionalVisibility?: { field: string } | null,
  ) => {
    if (!conditionalVisibility) return;
    const source = await db
      .selectFrom('questions')
      .selectAll()
      .where('id', '=', conditionalVisibility.field)
      .executeTakeFirst();
    if (!source || source.event_id !== eventId) {
      throw new ValidationError('Conditional visibility source question must belong to this event');
    }
  };

  app.post('/events/:eventId/questions', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { eventId } = request.params as { eventId: string };
    const body = parseBody(createQuestionSchema, request.body);

    const event = await loadEvent(eventId);
    requireEventAccess(principal, event, eventId);
    await loadScopedTicketType(eventId, body.ticketTypeId);
    await requireConditionalReference(eventId, body.conditionalVisibility);

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
    const question = await db
      .insertInto('questions')
      .values({
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
      })
      .returningAll()
      .executeTakeFirstOrThrow();

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

    const existing = await db
      .selectFrom('questions')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('id', 'in', questionIds)
      .execute();
    if (existing.length !== questionIds.length) {
      throw new NotFoundError(
        'Question',
        questionIds.find((id) => !existing.some((question) => question.id === id)) ?? eventId,
      );
    }

    await db.transaction().execute(async (trx) => {
      for (const question of body.questions) {
        // eslint-disable-next-line no-await-in-loop -- reorder updates run sequentially on one transaction connection for deterministic rollback behavior.
        await trx
          .updateTable('questions')
          .set({ sort_order: question.sortOrder, updated_at: new Date() })
          .where('event_id', '=', eventId)
          .where('id', '=', question.id)
          .execute();
      }
    });

    const rows = await db
      .selectFrom('questions')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('id', 'in', questionIds)
      .orderBy('sort_order', 'asc')
      .orderBy('id', 'asc')
      .execute();

    return pageEnvelope(
      rows.filter((row) => !isHiddenQuestion(row)).map((row) => serializeQuestion(row)),
      rows.length,
    );
  });

  app.patch('/questions/:questionId', async (request) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { questionId } = request.params as { questionId: string };
    const body = parseBody(updateQuestionSchema, request.body);

    const question = await db
      .selectFrom('questions')
      .selectAll()
      .where('id', '=', questionId)
      .executeTakeFirst();
    if (!question) throw new NotFoundError('Question', questionId);
    const event = await loadEvent(question.event_id);
    requireEventAccess(principal, event, question.event_id);

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

    await loadScopedTicketType(question.event_id, finalTicketTypeId);
    await requireConditionalReference(question.event_id, finalConditionalVisibility);
    assertQuestionDefinition({
      id: questionId,
      type: finalType,
      options: finalOptions,
      validationPattern:
        body.validationPattern !== undefined ? body.validationPattern : question.validation_pattern,
      conditionalVisibility: finalConditionalVisibility,
      sortOrder: body.sortOrder ?? question.sort_order,
      isConsentField: finalIsConsentField,
      consentText: finalConsentText,
      consentVersion: finalConsentVersion,
    });

    const updateData: Record<string, unknown> = {};
    if (body.ticketTypeId !== undefined) updateData.ticket_type_id = body.ticketTypeId;
    if (body.type !== undefined) updateData.type = body.type;
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
      updateData.conditional_visibility = body.conditionalVisibility
        ? JSON.stringify(body.conditionalVisibility)
        : null;
    }
    if (body.sortOrder !== undefined) updateData.sort_order = body.sortOrder;
    if (
      body.isConsentField !== undefined ||
      (finalType === 'waiver' && question.is_consent_field !== true)
    ) {
      updateData.is_consent_field = finalIsConsentField;
    }
    if (finalIsConsentField && !question.consent_version && finalConsentVersion) {
      updateData.consent_version = finalConsentVersion;
    }
    if (body.consentText !== undefined) updateData.consent_text = body.consentText;
    if (body.consentVersion !== undefined) updateData.consent_version = body.consentVersion;
    updateData.updated_at = new Date();

    const updated = await db
      .updateTable('questions')
      .set(updateData)
      .where('id', '=', questionId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return serializeQuestion(updated);
  });

  app.delete('/questions/:questionId', async (request, reply) => {
    const principal = request.principal!;
    ClerkAuthService.requirePermission(principal, 'events.write');
    const { questionId } = request.params as { questionId: string };
    const question = await db
      .selectFrom('questions')
      .selectAll()
      .where('id', '=', questionId)
      .executeTakeFirst();
    if (!question) throw new NotFoundError('Question', questionId);
    const event = await loadEvent(question.event_id);
    requireEventAccess(principal, event, question.event_id);

    const hasHistoricalAnswers = await questionHasHistoricalAnswers(
      db,
      question.event_id,
      questionId,
    );
    if (hasHistoricalAnswers) {
      const softDeleteData = softDeleteQuestionData(question);
      if (!softDeleteData) {
        throw new ConflictError(
          'Question has historical answers and cannot be hard deleted until question hiding is supported by the schema',
        );
      }
      await db.updateTable('questions').set(softDeleteData).where('id', '=', questionId).execute();
      return reply.status(204).send();
    }

    await db.deleteFrom('questions').where('id', '=', questionId).execute();
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

async function questionHasHistoricalAnswers(
  db: Database,
  eventId: string,
  questionId: string,
): Promise<boolean> {
  const attendees = await db
    .selectFrom('attendees')
    .selectAll()
    .where('event_id', '=', eventId)
    .execute();
  if (
    attendees.some(
      (attendee) =>
        attendee.event_id === eventId &&
        containsQuestionAnswer(attendee.custom_answers, questionId),
    )
  ) {
    return true;
  }

  const checkoutSessions = await db
    .selectFrom('checkout_sessions')
    .selectAll()
    .where('event_id', '=', eventId)
    .execute();
  return checkoutSessions.some(
    (session) => session.event_id === eventId && containsQuestionAnswer(session.cart, questionId),
  );
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
    required: row.required,
    appliesTo: row.applies_to,
    options: parseJsonValue<string[] | undefined>(row.options, undefined),
    placeholder: row.placeholder ?? undefined,
    validationPattern: row.validation_pattern ?? undefined,
    conditionalVisibility: parseJsonValue(row.conditional_visibility, undefined),
    sortOrder: row.sort_order,
    isConsentField: row.is_consent_field,
    consentText: row.consent_text ?? undefined,
    consentVersion: row.consent_version ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

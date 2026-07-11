import { createHash } from 'node:crypto';
import type {
  EventLaunchReadiness,
  EventLaunchReadinessStepId,
  Permission,
  ReadinessReasonCode,
  ReadinessStep,
  WorkspaceReadiness,
  WorkspaceReadinessStepId,
} from '@tixkit/domain';
import {
  finalizeEventLaunchReadiness,
  humanAcknowledgementStepVersions,
  permissionAwareStep,
} from '@tixkit/domain';
import type { Database } from '@tixkit/db';

export const WORKSPACE_READINESS_QUERY_BUDGET = 6;
export const EVENT_READINESS_QUERY_BUDGET = 12;

export type PaymentMode = 'capture' | 'provider_test' | 'provider';

export function resolvePaymentMode(): PaymentMode {
  if (!process.env.STRIPE_SECRET_KEY) return 'capture';
  return process.env.PAYMENT_PROVIDER_TEST_MODE === '1' ? 'provider_test' : 'provider';
}

export function evaluateEventPaymentReadiness(input: {
  requiresPayment: boolean;
  paymentMode: PaymentMode;
  account?: {
    id: string | null;
    status: string | null;
    chargesEnabled: boolean | null;
    defaultCurrency: string | null;
  };
  eventCurrency: string;
}): {
  status: 'complete' | 'blocked' | 'not_applicable';
  reasonCode: ReadinessReasonCode;
} {
  if (!input.requiresPayment) {
    return { status: 'not_applicable', reasonCode: 'payment_not_required' };
  }
  if (input.paymentMode === 'capture') {
    return {
      status: 'blocked',
      reasonCode: 'payment_capture_mode_paid_unsupported',
    };
  }
  if (!input.account?.id) {
    return { status: 'blocked', reasonCode: 'payment_path_missing' };
  }
  if (input.account.status !== 'active') {
    return { status: 'blocked', reasonCode: 'payment_account_inactive' };
  }
  if (!input.account.chargesEnabled) {
    return { status: 'blocked', reasonCode: 'payment_charges_disabled' };
  }
  if (input.account.defaultCurrency !== input.eventCurrency) {
    return { status: 'blocked', reasonCode: 'payment_currency_mismatch' };
  }
  return { status: 'complete', reasonCode: 'payment_ready' };
}

export function eventRequiresPayment(input: {
  tickets: readonly {
    kind: string;
    priceCents: number;
    minimumPriceCents: number | null;
  }[];
  products: readonly { status: string; priceCents: number }[];
}): boolean {
  return (
    input.tickets.some(
      (ticket) =>
        ticket.kind === 'donation' || ticket.priceCents > 0 || (ticket.minimumPriceCents ?? 0) > 0,
    ) || input.products.some((product) => product.status === 'active' && product.priceCents > 0)
  );
}

export function evaluateAcknowledgement(input: {
  stepId: keyof typeof humanAcknowledgementStepVersions;
  currentFingerprint: string;
  acknowledgement?: {
    stepVersion: number;
    subjectFingerprint: string;
    acknowledgedAt: Date | string;
  };
}): {
  complete: boolean;
  reason: ReadinessReasonCode;
  acknowledgedAt: string | null;
  acknowledgementValid: boolean | null;
} {
  if (!input.acknowledgement) {
    return {
      complete: false,
      reason:
        input.stepId === 'checkout_consent'
          ? 'checkout_review_required'
          : 'preview_review_required',
      acknowledgedAt: null,
      acknowledgementValid: null,
    };
  }
  const valid =
    input.acknowledgement.stepVersion === humanAcknowledgementStepVersions[input.stepId] &&
    input.acknowledgement.subjectFingerprint === input.currentFingerprint;
  return {
    complete: valid,
    reason: valid
      ? input.stepId === 'checkout_consent'
        ? 'checkout_reviewed'
        : 'preview_reviewed'
      : 'acknowledgement_stale',
    acknowledgedAt: iso(input.acknowledgement.acknowledgedAt),
    acknowledgementValid: valid,
  };
}

export function evaluateSellableTickets(
  tickets: ReadonlyArray<{
    status: string;
    totalCapacity: number;
    reservedCount: number;
    soldCount: number;
    salesStartAt: Date | string | null;
    salesEndAt: Date | string | null;
  }>,
  now = new Date(),
): { status: 'complete' | 'incomplete'; reasonCode: ReadinessReasonCode } {
  const active = tickets.filter((ticket) => ticket.status === 'active');
  if (active.length === 0) {
    return { status: 'incomplete', reasonCode: 'sellable_ticket_missing' };
  }
  if (
    active.some(
      (ticket) =>
        ticket.totalCapacity <= 0 ||
        ticket.reservedCount < 0 ||
        ticket.soldCount < 0 ||
        ticket.reservedCount + ticket.soldCount > ticket.totalCapacity,
    )
  ) {
    return { status: 'incomplete', reasonCode: 'inventory_invalid' };
  }
  if (
    active.some(
      (ticket) =>
        (ticket.salesStartAt !== null && Number.isNaN(new Date(ticket.salesStartAt).getTime())) ||
        (ticket.salesEndAt !== null && Number.isNaN(new Date(ticket.salesEndAt).getTime())) ||
        (ticket.salesStartAt !== null &&
          ticket.salesEndAt !== null &&
          new Date(ticket.salesEndAt) <= new Date(ticket.salesStartAt)),
    )
  ) {
    return { status: 'incomplete', reasonCode: 'sales_window_invalid' };
  }
  const available = active.some(
    (ticket) =>
      ticket.totalCapacity - ticket.reservedCount - ticket.soldCount > 0 &&
      (ticket.salesEndAt === null || new Date(ticket.salesEndAt) > now),
  );
  return available
    ? { status: 'complete', reasonCode: 'sellable_ticket_available' }
    : { status: 'incomplete', reasonCode: 'ticket_inventory_unavailable' };
}

export function evaluateLifecycleContent(
  documents: ReadonlyArray<{
    eventId: string | null;
    channel: string;
    key: string;
    status: string;
    publishedVersionId: string | null;
    publishedVersionStatus: string | null;
  }>,
  eventId: string,
): { publicContent: boolean; confirmationContent: boolean } {
  const published = (document: (typeof documents)[number]) =>
    document.status === 'published' &&
    document.publishedVersionId !== null &&
    document.publishedVersionStatus === 'published';
  return {
    publicContent: documents.some(
      (document) =>
        document.eventId === eventId && document.channel === 'event_page' && published(document),
    ),
    confirmationContent: documents.some(
      (document) =>
        (document.eventId === eventId || document.eventId === null) &&
        document.channel === 'email' &&
        document.key === 'order-confirmed' &&
        published(document),
    ),
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function latestIso(values: ReadonlyArray<Date | string | null | undefined>): string | null {
  let latest: Date | null = null;
  for (const value of values) {
    if (!value) continue;
    const candidate = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(candidate.getTime())) continue;
    if (!latest || candidate > latest) latest = candidate;
  }
  return latest?.toISOString() ?? null;
}

function jsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function actionStep<StepId extends string>(
  permissions: ReadonlySet<Permission>,
  input: Omit<ReadinessStep<StepId>, 'actionId' | 'acknowledgementValid'> & {
    actionId: NonNullable<ReadinessStep<StepId>['actionId']>;
    acknowledgementValid?: boolean | null;
  },
): ReadinessStep<StepId> {
  return permissionAwareStep(input, permissions);
}

function requiredStepComplete(step: ReadinessStep<string>): boolean {
  return (
    step.priority !== 'required' || step.status === 'complete' || step.status === 'not_applicable'
  );
}

export class ReadinessService {
  constructor(
    private readonly db: Database,
    private readonly paymentMode: PaymentMode,
  ) {}

  async getWorkspaceReadiness(input: {
    tenantId: string;
    organizationId: string;
    brandId: string;
    permissions: ReadonlySet<Permission>;
  }): Promise<WorkspaceReadiness> {
    const [organization, brand] = await Promise.all([
      this.db
        .selectFrom('organizations')
        .selectAll()
        .where('id', '=', input.organizationId)
        .where('tenant_id', '=', input.tenantId)
        .executeTakeFirst(),
      this.db
        .selectFrom('brands')
        .selectAll()
        .where('id', '=', input.brandId)
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .executeTakeFirst(),
    ]);

    if (!organization || !brand) {
      throw new Error('Workspace readiness scope was not found');
    }

    const [paymentAccount, members, senderIdentities] = await Promise.all([
      brand.payment_account_id
        ? this.db
            .selectFrom('payment_accounts')
            .selectAll()
            .where('id', '=', brand.payment_account_id)
            .where('tenant_id', '=', input.tenantId)
            .where('organization_id', '=', input.organizationId)
            .executeTakeFirst()
        : Promise.resolve(undefined),
      this.db
        .selectFrom('organization_members')
        .select(['id', 'accepted_at', 'updated_at'])
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .execute(),
      this.db
        .selectFrom('brand_sender_identities')
        .innerJoin('brands', 'brands.id', 'brand_sender_identities.brand_id')
        .select([
          'brand_sender_identities.id',
          'brand_sender_identities.verified',
          'brand_sender_identities.updated_at',
        ])
        .where('brand_sender_identities.tenant_id', '=', input.tenantId)
        .where('brand_sender_identities.brand_id', '=', input.brandId)
        .where('brands.tenant_id', '=', input.tenantId)
        .where('brands.organization_id', '=', input.organizationId)
        .execute(),
    ]);

    const theme = jsonRecord(brand.theme);
    const legalUrls = jsonRecord(brand.legal_urls);
    const brandConfigured = Boolean(brand.name.trim()) && Object.keys(theme).length > 0;
    const legalConfigured = Object.values(legalUrls).some(
      (value) => typeof value === 'string' && value.length > 0,
    );
    const paymentReady =
      this.paymentMode === 'capture' ||
      Boolean(
        paymentAccount && paymentAccount.status === 'active' && paymentAccount.charges_enabled,
      );
    const acceptedMembers = members.filter((member) => member.accepted_at !== null);
    const senderReady = senderIdentities.some((identity) => identity.verified);
    const steps: Array<ReadinessStep<WorkspaceReadinessStepId>> = [
      actionStep(input.permissions, {
        id: 'workspace_selection',
        status:
          organization.status === 'active' && brand.status === 'active' ? 'complete' : 'blocked',
        priority: 'required',
        reasonCodes:
          organization.status !== 'active'
            ? ['organization_inactive']
            : brand.status !== 'active'
              ? ['brand_inactive']
              : ['workspace_selected'],
        actionId: 'select_workspace',
        requiredPermission: null,
        updatedAt: iso(brand.updated_at),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'brand_identity',
        status: brandConfigured ? 'complete' : 'incomplete',
        priority: 'required',
        reasonCodes: [brandConfigured ? 'brand_identity_configured' : 'brand_identity_incomplete'],
        actionId: 'configure_brand',
        requiredPermission: 'settings.write',
        updatedAt: iso(brand.updated_at),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'payment_path',
        status: paymentReady ? 'complete' : 'blocked',
        priority: 'required',
        reasonCodes: [
          this.paymentMode === 'capture'
            ? 'payment_capture_mode'
            : paymentReady
              ? 'payment_path_ready'
              : 'payment_path_missing',
        ],
        actionId: 'configure_payments',
        requiredPermission: 'billing.write',
        updatedAt: iso(paymentAccount?.updated_at),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'team_access',
        status: acceptedMembers.length > 1 ? 'complete' : 'incomplete',
        priority: 'recommended',
        reasonCodes: [
          acceptedMembers.length > 1 ? 'team_access_configured' : 'team_access_single_member',
        ],
        actionId: 'manage_team',
        requiredPermission: 'settings.write',
        updatedAt: latestIso(members.map((member) => member.updated_at)),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'legal_configuration',
        status: legalConfigured ? 'complete' : 'incomplete',
        priority: 'recommended',
        reasonCodes: [
          legalConfigured ? 'legal_configuration_complete' : 'legal_configuration_missing',
        ],
        actionId: 'configure_legal',
        requiredPermission: 'settings.write',
        updatedAt: iso(brand.updated_at),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'sender_identity',
        status: senderReady ? 'complete' : 'incomplete',
        priority: 'recommended',
        reasonCodes: [senderReady ? 'sender_identity_verified' : 'sender_identity_missing'],
        actionId: 'configure_sender',
        requiredPermission: 'messages.write',
        updatedAt: latestIso(senderIdentities.map((identity) => identity.updated_at)),
        acknowledgedAt: null,
      }),
    ];

    return {
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      brandId: input.brandId,
      generatedAt: new Date().toISOString(),
      paymentMode: this.paymentMode,
      complete: steps.every(requiredStepComplete),
      steps,
    };
  }

  async getEventLaunchReadiness(input: {
    tenantId: string;
    organizationId: string;
    brandId: string;
    eventId: string;
    permissions: ReadonlySet<Permission>;
  }): Promise<EventLaunchReadiness> {
    const scopeEvent = () =>
      this.db
        .selectFrom('events')
        .selectAll()
        .where('id', '=', input.eventId)
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('brand_id', '=', input.brandId);

    const [
      event,
      tickets,
      products,
      questions,
      feeRules,
      contentDocuments,
      paymentAccount,
      acknowledgements,
      operational,
    ] = await Promise.all([
      scopeEvent().executeTakeFirst(),
      this.db
        .selectFrom('ticket_types')
        .innerJoin('events', 'events.id', 'ticket_types.event_id')
        .innerJoin('inventory_pools', 'inventory_pools.id', 'ticket_types.inventory_pool_id')
        .select([
          'ticket_types.id',
          'ticket_types.kind',
          'ticket_types.status',
          'ticket_types.currency',
          'ticket_types.price_cents',
          'ticket_types.minimum_price_cents',
          'ticket_types.sales_start_at',
          'ticket_types.sales_end_at',
          'ticket_types.visibility',
          'ticket_types.min_per_order',
          'ticket_types.max_per_order',
          'ticket_types.inventory_pool_id',
          'ticket_types.updated_at',
          'inventory_pools.total_capacity',
          'inventory_pools.reserved_count',
          'inventory_pools.sold_count',
        ])
        .where('ticket_types.event_id', '=', input.eventId)
        .where('events.tenant_id', '=', input.tenantId)
        .where('events.organization_id', '=', input.organizationId)
        .where('events.brand_id', '=', input.brandId)
        .orderBy('ticket_types.id')
        .execute(),
      this.db
        .selectFrom('products')
        .innerJoin('events', 'events.id', 'products.event_id')
        .select([
          'products.id',
          'products.name',
          'products.currency',
          'products.price_cents',
          'products.max_per_order',
          'products.available_from',
          'products.available_until',
          'products.status',
          'products.updated_at',
        ])
        .where('products.event_id', '=', input.eventId)
        .where('events.tenant_id', '=', input.tenantId)
        .where('events.organization_id', '=', input.organizationId)
        .where('events.brand_id', '=', input.brandId)
        .orderBy('products.id')
        .execute(),
      this.db
        .selectFrom('questions')
        .innerJoin('events', 'events.id', 'questions.event_id')
        .select([
          'questions.id',
          'questions.type',
          'questions.required',
          'questions.is_consent_field',
          'questions.consent_text',
          'questions.consent_version',
          'questions.status',
          'questions.is_hidden',
          'questions.updated_at',
        ])
        .where('questions.event_id', '=', input.eventId)
        .where('events.tenant_id', '=', input.tenantId)
        .where('events.organization_id', '=', input.organizationId)
        .where('events.brand_id', '=', input.brandId)
        .orderBy('questions.id')
        .execute(),
      this.db
        .selectFrom('fee_rules')
        .innerJoin('events', 'events.id', 'fee_rules.event_id')
        .selectAll('fee_rules')
        .where('fee_rules.event_id', '=', input.eventId)
        .where('events.tenant_id', '=', input.tenantId)
        .where('events.organization_id', '=', input.organizationId)
        .where('events.brand_id', '=', input.brandId)
        .orderBy('fee_rules.id')
        .execute(),
      this.db
        .selectFrom('content_documents')
        .leftJoin(
          'content_document_versions as published_version',
          'published_version.id',
          'content_documents.published_version_id',
        )
        .select([
          'content_documents.id',
          'content_documents.event_id',
          'content_documents.channel',
          'content_documents.key',
          'content_documents.status',
          'content_documents.published_version_id',
          'content_documents.current_draft_version_id',
          'content_documents.updated_at',
          'published_version.status as published_version_status',
        ])
        .where('content_documents.tenant_id', '=', input.tenantId)
        .where('content_documents.organization_id', '=', input.organizationId)
        .where('content_documents.brand_id', '=', input.brandId)
        .where((eb) =>
          eb.or([
            eb('content_documents.event_id', '=', input.eventId),
            eb('content_documents.event_id', 'is', null),
          ]),
        )
        .orderBy('content_documents.id')
        .execute(),
      this.db
        .selectFrom('brands')
        .leftJoin('payment_accounts', (join) =>
          join
            .onRef('payment_accounts.id', '=', 'brands.payment_account_id')
            .onRef('payment_accounts.tenant_id', '=', 'brands.tenant_id')
            .onRef('payment_accounts.organization_id', '=', 'brands.organization_id'),
        )
        .select([
          'payment_accounts.id',
          'payment_accounts.status',
          'payment_accounts.charges_enabled',
          'payment_accounts.default_currency',
          'payment_accounts.updated_at',
        ])
        .where('brands.id', '=', input.brandId)
        .where('brands.tenant_id', '=', input.tenantId)
        .where('brands.organization_id', '=', input.organizationId)
        .executeTakeFirst(),
      this.db
        .selectFrom('event_readiness_acknowledgements')
        .selectAll()
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('brand_id', '=', input.brandId)
        .where('event_id', '=', input.eventId)
        .execute(),
      Promise.all([
        this.db
          .selectFrom('check_in_lists')
          .innerJoin('events', 'events.id', 'check_in_lists.event_id')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('check_in_lists.event_id', '=', input.eventId)
          .where('events.tenant_id', '=', input.tenantId)
          .where('events.organization_id', '=', input.organizationId)
          .where('events.brand_id', '=', input.brandId)
          .executeTakeFirstOrThrow(),
        this.db
          .selectFrom('orders')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('tenant_id', '=', input.tenantId)
          .where('organization_id', '=', input.organizationId)
          .where('brand_id', '=', input.brandId)
          .where('event_id', '=', input.eventId)
          .where('is_test', '=', true)
          .executeTakeFirstOrThrow(),
        this.db
          .selectFrom('event_pages')
          .innerJoin('events', 'events.id', 'event_pages.event_id')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('event_pages.event_id', '=', input.eventId)
          .where('events.tenant_id', '=', input.tenantId)
          .where('events.organization_id', '=', input.organizationId)
          .where('events.brand_id', '=', input.brandId)
          .executeTakeFirstOrThrow(),
      ]),
    ]);

    if (!event) throw new Error('Event readiness scope was not found');

    const activeTickets = tickets.filter((ticket) => ticket.status === 'active');
    const sellableTickets = evaluateSellableTickets(
      tickets.map((ticket) => ({
        status: ticket.status,
        totalCapacity: Number(ticket.total_capacity),
        reservedCount: Number(ticket.reserved_count),
        soldCount: Number(ticket.sold_count),
        salesStartAt: ticket.sales_start_at,
        salesEndAt: ticket.sales_end_at,
      })),
    );
    const ticketCurrencyCoherent = activeTickets.every(
      (ticket) => ticket.currency === event.currency,
    );
    const productCurrencyCoherent = products
      .filter((product) => product.status === 'active')
      .every((product) => product.currency === event.currency);
    const pricingValid =
      activeTickets.every(
        (ticket) =>
          Number(ticket.price_cents) >= 0 &&
          (ticket.minimum_price_cents === null || Number(ticket.minimum_price_cents) >= 0),
      ) &&
      feeRules.every(
        (rule) =>
          Number(rule.value) >= 0 && (rule.type !== 'percentage' || Number(rule.value) <= 10_000),
      );
    const requiresPayment = eventRequiresPayment({
      tickets: activeTickets.map((ticket) => ({
        kind: ticket.kind,
        priceCents: Number(ticket.price_cents),
        minimumPriceCents:
          ticket.minimum_price_cents === null ? null : Number(ticket.minimum_price_cents),
      })),
      products: products.map((product) => ({
        status: product.status,
        priceCents: Number(product.price_cents),
      })),
    });
    const eventPaymentReadiness = evaluateEventPaymentReadiness({
      requiresPayment,
      paymentMode: this.paymentMode,
      account: paymentAccount
        ? {
            id: paymentAccount.id,
            status: paymentAccount.status,
            chargesEnabled: paymentAccount.charges_enabled,
            defaultCurrency: paymentAccount.default_currency,
          }
        : undefined,
      eventCurrency: event.currency,
    });
    const [checkInCount, testOrderCount, legacyPageCount] = operational;
    const lifecycleContent = evaluateLifecycleContent(
      contentDocuments.map((document) => ({
        eventId: document.event_id,
        channel: document.channel,
        key: document.key,
        status: document.status,
        publishedVersionId: document.published_version_id,
        publishedVersionStatus: document.published_version_status,
      })),
      input.eventId,
    );
    const publicContent = Number(legacyPageCount.count) > 0 || lifecycleContent.publicContent;
    const confirmationContent = lifecycleContent.confirmationContent;
    const basicsValid =
      event.title.trim().length > 0 &&
      event.timezone.trim().length > 0 &&
      new Date(event.starts_at).getTime() > 0 &&
      (event.ends_at === null || new Date(event.ends_at) > new Date(event.starts_at));
    const startValid = new Date(event.starts_at).getTime() > 0;
    const checkoutFingerprint = fingerprint(
      questions.map((question) => ({
        id: question.id,
        type: question.type,
        required: question.required,
        consent: question.is_consent_field,
        consentText: question.consent_text,
        consentVersion: question.consent_version,
        status: question.status,
        hidden: question.is_hidden,
      })),
    );
    const previewFingerprint = fingerprint({
      event: {
        title: event.title,
        description: event.description,
        currency: event.currency,
        timezone: event.timezone,
        startsAt: iso(event.starts_at),
        endsAt: iso(event.ends_at),
        venue: event.venue,
        visibility: event.visibility,
        seo: event.seo,
        coverImageUrl: event.cover_image_url,
        coverImageAlt: event.cover_image_alt,
        seoUseCoverImage: event.seo_use_cover_image,
      },
      tickets: tickets.map(({ updated_at: _updatedAt, ...ticket }) => ticket),
      products: products.map(({ updated_at: _updatedAt, ...product }) => product),
      content: contentDocuments.map((document) => [
        document.id,
        document.event_id,
        document.status,
        document.current_draft_version_id,
        document.published_version_id,
        document.published_version_status,
      ]),
    });
    const ackByStep = new Map(acknowledgements.map((ack) => [ack.step_id, ack]));
    const acknowledgementState = (
      stepId: keyof typeof humanAcknowledgementStepVersions,
      currentFingerprint: string,
    ): {
      complete: boolean;
      reason: ReadinessReasonCode;
      acknowledgedAt: string | null;
      acknowledgementValid: boolean | null;
    } => {
      const ack = ackByStep.get(stepId);
      return evaluateAcknowledgement({
        stepId,
        currentFingerprint,
        acknowledgement: ack
          ? {
              stepVersion: ack.step_version,
              subjectFingerprint: ack.subject_fingerprint,
              acknowledgedAt: ack.acknowledged_at,
            }
          : undefined,
      });
    };
    const checkoutAck = acknowledgementState('checkout_consent', checkoutFingerprint);
    const previewAck = acknowledgementState('preview_review', previewFingerprint);

    const steps: Array<ReadinessStep<EventLaunchReadinessStepId>> = [
      actionStep(input.permissions, {
        id: 'basics_schedule',
        status: basicsValid ? 'complete' : 'incomplete',
        priority: 'required',
        reasonCodes: basicsValid
          ? ['event_basics_valid']
          : [
              ...(event.title.trim() ? [] : (['event_title_missing'] as const)),
              ...(event.timezone.trim() ? [] : (['event_timezone_missing'] as const)),
              ...(startValid ? [] : (['event_start_invalid'] as const)),
              ...(!event.ends_at || new Date(event.ends_at) > new Date(event.starts_at)
                ? []
                : (['event_schedule_invalid'] as const)),
            ],
        actionId: 'edit_event_basics',
        requiredPermission: 'events.write',
        updatedAt: iso(event.updated_at),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'sellable_tickets',
        status: sellableTickets.status,
        priority: 'required',
        reasonCodes: [sellableTickets.reasonCode],
        actionId: 'manage_tickets',
        requiredPermission: 'tickets.write',
        updatedAt: latestIso(tickets.map((ticket) => ticket.updated_at)),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'currency_coherence',
        status: ticketCurrencyCoherent && productCurrencyCoherent ? 'complete' : 'blocked',
        priority: 'required',
        reasonCodes:
          ticketCurrencyCoherent && productCurrencyCoherent
            ? ['currency_coherent']
            : [
                ...(ticketCurrencyCoherent ? [] : (['ticket_currency_mismatch'] as const)),
                ...(productCurrencyCoherent ? [] : (['product_currency_mismatch'] as const)),
              ],
        actionId: ticketCurrencyCoherent ? 'manage_products' : 'manage_tickets',
        requiredPermission: ticketCurrencyCoherent ? 'events.write' : 'tickets.write',
        updatedAt: iso(event.updated_at),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'fee_pricing',
        status: pricingValid ? 'complete' : 'blocked',
        priority: 'required',
        reasonCodes: [pricingValid ? 'pricing_valid' : 'pricing_invalid'],
        actionId: 'review_fees',
        requiredPermission: 'events.write',
        updatedAt: latestIso([
          ...feeRules.map((rule) => rule.updated_at),
          ...tickets.map((ticket) => ticket.updated_at),
        ]),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'checkout_consent',
        status: checkoutAck.complete ? 'complete' : 'incomplete',
        priority: 'required',
        reasonCodes: [checkoutAck.reason],
        actionId: 'review_checkout',
        requiredPermission: 'events.write',
        updatedAt: latestIso(questions.map((question) => question.updated_at)),
        acknowledgedAt: checkoutAck.acknowledgedAt,
        acknowledgementValid: checkoutAck.acknowledgementValid,
      }),
      actionStep(input.permissions, {
        id: 'public_content',
        status: publicContent ? 'complete' : 'incomplete',
        priority: 'required',
        reasonCodes: [publicContent ? 'public_content_published' : 'public_content_missing'],
        actionId: 'edit_event_content',
        requiredPermission: 'events.write',
        updatedAt: latestIso(contentDocuments.map((document) => document.updated_at)),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'confirmation_content',
        status: confirmationContent ? 'complete' : 'incomplete',
        priority: 'required',
        reasonCodes: [
          confirmationContent ? 'confirmation_content_valid' : 'confirmation_content_missing',
        ],
        actionId: 'edit_confirmation_content',
        requiredPermission: 'messages.write',
        updatedAt: latestIso(
          contentDocuments
            .filter((document) => document.channel === 'email')
            .map((document) => document.updated_at),
        ),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'payment_readiness',
        status: eventPaymentReadiness.status,
        priority: 'required',
        reasonCodes: [eventPaymentReadiness.reasonCode],
        actionId: 'configure_payments',
        requiredPermission: 'billing.write',
        updatedAt: iso(paymentAccount?.updated_at),
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'preview_review',
        status: previewAck.complete ? 'complete' : 'incomplete',
        priority: 'recommended',
        reasonCodes: [previewAck.reason],
        actionId: 'review_preview',
        requiredPermission: 'events.write',
        updatedAt: iso(event.updated_at),
        acknowledgedAt: previewAck.acknowledgedAt,
        acknowledgementValid: previewAck.acknowledgementValid,
      }),
      actionStep(input.permissions, {
        id: 'test_order',
        status:
          this.paymentMode === 'provider'
            ? 'not_applicable'
            : Number(testOrderCount.count) > 0
              ? 'complete'
              : 'incomplete',
        priority: 'recommended',
        reasonCodes: [
          this.paymentMode === 'provider'
            ? 'test_order_not_applicable'
            : Number(testOrderCount.count) > 0
              ? 'test_order_complete'
              : 'test_order_recommended',
        ],
        actionId: 'run_test_order',
        requiredPermission: 'orders.write',
        updatedAt: null,
        acknowledgedAt: null,
      }),
      actionStep(input.permissions, {
        id: 'check_in_configuration',
        status: Number(checkInCount.count) > 0 ? 'complete' : 'incomplete',
        priority: 'recommended',
        reasonCodes: [
          Number(checkInCount.count) > 0 ? 'check_in_configured' : 'check_in_configuration_missing',
        ],
        actionId: 'configure_check_in',
        requiredPermission: 'checkins.write',
        updatedAt: null,
        acknowledgedAt: null,
      }),
    ];
    if (this.paymentMode === 'provider') {
      const testOrderIndex = steps.findIndex((step) => step.id === 'test_order');
      const testOrder = steps[testOrderIndex];
      if (testOrder) steps[testOrderIndex] = { ...testOrder, actionId: null };
    }
    const prePublishable = steps.every(requiredStepComplete);
    steps.push(
      {
        id: 'publishability',
        status: prePublishable ? 'complete' : 'blocked',
        priority: 'required',
        reasonCodes: [prePublishable ? 'required_steps_complete' : 'required_steps_incomplete'],
        actionId: prePublishable && input.permissions.has('events.write') ? 'publish_event' : null,
        requiredPermission: 'events.write',
        updatedAt: iso(event.updated_at),
        acknowledgedAt: null,
        acknowledgementValid: null,
      },
      actionStep(input.permissions, {
        id: 'publication_status',
        status: event.status === 'published' ? 'complete' : 'incomplete',
        priority: 'recommended',
        reasonCodes: [event.status === 'published' ? 'event_published' : 'event_unpublished'],
        actionId: event.status === 'published' ? 'view_event' : 'publish_event',
        requiredPermission: event.status === 'published' ? 'events.read' : 'events.write',
        updatedAt: iso(event.updated_at),
        acknowledgedAt: null,
      }),
    );

    return finalizeEventLaunchReadiness({
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      brandId: input.brandId,
      eventId: input.eventId,
      eventVersion: Number(event.version),
      generatedAt: new Date().toISOString(),
      paymentMode: this.paymentMode,
      published: event.status === 'published',
      steps,
    });
  }

  async acknowledgementSubject(input: {
    tenantId: string;
    organizationId: string;
    brandId: string;
    eventId: string;
    stepId: keyof typeof humanAcknowledgementStepVersions;
  }): Promise<string> {
    if (input.stepId === 'checkout_consent') {
      const questions = await this.db
        .selectFrom('questions')
        .innerJoin('events', 'events.id', 'questions.event_id')
        .select([
          'questions.id',
          'questions.type',
          'questions.required',
          'questions.is_consent_field',
          'questions.consent_text',
          'questions.consent_version',
          'questions.status',
          'questions.is_hidden',
        ])
        .where('questions.event_id', '=', input.eventId)
        .where('events.tenant_id', '=', input.tenantId)
        .where('events.organization_id', '=', input.organizationId)
        .where('events.brand_id', '=', input.brandId)
        .orderBy('questions.id')
        .execute();
      return fingerprint(
        questions.map((question) => ({
          id: question.id,
          type: question.type,
          required: question.required,
          consent: question.is_consent_field,
          consentText: question.consent_text,
          consentVersion: question.consent_version,
          status: question.status,
          hidden: question.is_hidden,
        })),
      );
    }
    const [event, tickets, products, content] = await Promise.all([
      this.db
        .selectFrom('events')
        .select([
          'id',
          'version',
          'title',
          'description',
          'currency',
          'timezone',
          'starts_at',
          'ends_at',
          'venue',
          'visibility',
          'seo',
          'cover_image_url',
          'cover_image_alt',
          'seo_use_cover_image',
        ])
        .where('id', '=', input.eventId)
        .where('tenant_id', '=', input.tenantId)
        .where('organization_id', '=', input.organizationId)
        .where('brand_id', '=', input.brandId)
        .executeTakeFirstOrThrow(),
      this.db
        .selectFrom('ticket_types')
        .innerJoin('events', 'events.id', 'ticket_types.event_id')
        .innerJoin('inventory_pools', 'inventory_pools.id', 'ticket_types.inventory_pool_id')
        .select([
          'ticket_types.id',
          'ticket_types.kind',
          'ticket_types.status',
          'ticket_types.currency',
          'ticket_types.price_cents',
          'ticket_types.minimum_price_cents',
          'ticket_types.sales_start_at',
          'ticket_types.sales_end_at',
          'ticket_types.visibility',
          'ticket_types.min_per_order',
          'ticket_types.max_per_order',
          'ticket_types.inventory_pool_id',
          'inventory_pools.total_capacity',
          'inventory_pools.reserved_count',
          'inventory_pools.sold_count',
        ])
        .where('ticket_types.event_id', '=', input.eventId)
        .where('events.tenant_id', '=', input.tenantId)
        .where('events.organization_id', '=', input.organizationId)
        .where('events.brand_id', '=', input.brandId)
        .orderBy('ticket_types.id')
        .execute(),
      this.db
        .selectFrom('products')
        .innerJoin('events', 'events.id', 'products.event_id')
        .select([
          'products.id',
          'products.name',
          'products.currency',
          'products.price_cents',
          'products.max_per_order',
          'products.available_from',
          'products.available_until',
          'products.status',
        ])
        .where('products.event_id', '=', input.eventId)
        .where('events.tenant_id', '=', input.tenantId)
        .where('events.organization_id', '=', input.organizationId)
        .where('events.brand_id', '=', input.brandId)
        .orderBy('products.id')
        .execute(),
      this.db
        .selectFrom('content_documents')
        .leftJoin(
          'content_document_versions as published_version',
          'published_version.id',
          'content_documents.published_version_id',
        )
        .select([
          'content_documents.id',
          'content_documents.event_id',
          'content_documents.status',
          'content_documents.current_draft_version_id',
          'content_documents.published_version_id',
          'published_version.status as published_version_status',
        ])
        .where('content_documents.tenant_id', '=', input.tenantId)
        .where('content_documents.organization_id', '=', input.organizationId)
        .where('content_documents.brand_id', '=', input.brandId)
        .where((eb) =>
          eb.or([
            eb('content_documents.event_id', '=', input.eventId),
            eb('content_documents.event_id', 'is', null),
          ]),
        )
        .orderBy('content_documents.id')
        .execute(),
    ]);
    return fingerprint({
      event: {
        title: event.title,
        description: event.description,
        currency: event.currency,
        timezone: event.timezone,
        startsAt: iso(event.starts_at),
        endsAt: iso(event.ends_at),
        venue: event.venue,
        visibility: event.visibility,
        seo: event.seo,
        coverImageUrl: event.cover_image_url,
        coverImageAlt: event.cover_image_alt,
        seoUseCoverImage: event.seo_use_cover_image,
      },
      tickets,
      products,
      content: content.map((row) => [
        row.id,
        row.event_id,
        row.status,
        row.current_draft_version_id,
        row.published_version_id,
        row.published_version_status,
      ]),
    });
  }
}

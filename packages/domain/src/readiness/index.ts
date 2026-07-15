import type { Permission } from '../identity/permissions.js';

export const readinessStatuses = ['complete', 'incomplete', 'blocked', 'not_applicable'] as const;
export type ReadinessStatus = (typeof readinessStatuses)[number];

export const readinessPriorities = ['required', 'recommended'] as const;
export type ReadinessPriority = (typeof readinessPriorities)[number];

export const dashboardActionSeverities = ['critical', 'high', 'medium', 'low'] as const;
export type DashboardActionSeverity = (typeof dashboardActionSeverities)[number];

export const dashboardActionOwners = [
  'organizer',
  'finance',
  'marketing',
  'support',
  'door_operations',
] as const;
export type DashboardActionOwner = (typeof dashboardActionOwners)[number];

export const workspaceReadinessStepIds = [
  'workspace_selection',
  'brand_identity',
  'payment_path',
  'team_access',
  'legal_configuration',
  'sender_identity',
] as const;
export type WorkspaceReadinessStepId = (typeof workspaceReadinessStepIds)[number];

export const eventLaunchReadinessStepIds = [
  'basics_schedule',
  'sellable_tickets',
  'currency_coherence',
  'fee_pricing',
  'checkout_consent',
  'public_content',
  'confirmation_content',
  'payment_readiness',
  'preview_review',
  'test_order',
  'check_in_configuration',
  'publishability',
  'publication_status',
] as const;
export type EventLaunchReadinessStepId = (typeof eventLaunchReadinessStepIds)[number];

export const readinessReasonCodes = [
  'workspace_selected',
  'organization_inactive',
  'brand_inactive',
  'brand_identity_configured',
  'brand_identity_incomplete',
  'payment_capture_mode',
  'payment_capture_mode_paid_unsupported',
  'payment_path_ready',
  'payment_path_missing',
  'payment_account_inactive',
  'payment_currency_mismatch',
  'team_access_configured',
  'team_access_single_member',
  'legal_configuration_complete',
  'legal_configuration_missing',
  'sender_identity_verified',
  'sender_identity_missing',
  'event_basics_valid',
  'event_title_missing',
  'event_schedule_invalid',
  'event_start_invalid',
  'event_timezone_missing',
  'sellable_ticket_available',
  'sellable_ticket_missing',
  'ticket_inventory_unavailable',
  'inventory_invalid',
  'sales_window_invalid',
  'currency_coherent',
  'ticket_currency_mismatch',
  'product_currency_mismatch',
  'pricing_valid',
  'pricing_invalid',
  'checkout_reviewed',
  'checkout_review_required',
  'public_content_published',
  'public_content_missing',
  'confirmation_content_valid',
  'confirmation_content_missing',
  'payment_not_required',
  'payment_ready',
  'payment_charges_disabled',
  'preview_reviewed',
  'preview_review_required',
  'test_order_complete',
  'test_order_stale',
  'test_order_recommended',
  'test_order_not_applicable',
  'check_in_configured',
  'check_in_configuration_missing',
  'required_steps_complete',
  'required_steps_incomplete',
  'event_published',
  'event_unpublished',
  'acknowledgement_stale',
  'permission_required',
] as const;
export type ReadinessReasonCode = (typeof readinessReasonCodes)[number];

export const readinessReasonCodeStepIds = {
  workspace_selected: ['workspace_selection'],
  organization_inactive: ['workspace_selection'],
  brand_inactive: ['workspace_selection'],
  brand_identity_configured: ['brand_identity'],
  brand_identity_incomplete: ['brand_identity'],
  payment_capture_mode: ['payment_path'],
  payment_capture_mode_paid_unsupported: ['payment_readiness'],
  payment_path_ready: ['payment_path'],
  payment_path_missing: ['payment_path', 'payment_readiness'],
  payment_account_inactive: ['payment_readiness'],
  payment_charges_disabled: ['payment_readiness'],
  payment_currency_mismatch: ['payment_readiness'],
  team_access_configured: ['team_access'],
  team_access_single_member: ['team_access'],
  legal_configuration_complete: ['legal_configuration'],
  legal_configuration_missing: ['legal_configuration'],
  sender_identity_verified: ['sender_identity'],
  sender_identity_missing: ['sender_identity'],
  event_basics_valid: ['basics_schedule'],
  event_title_missing: ['basics_schedule'],
  event_schedule_invalid: ['basics_schedule'],
  event_start_invalid: ['basics_schedule'],
  event_timezone_missing: ['basics_schedule'],
  sellable_ticket_available: ['sellable_tickets'],
  sellable_ticket_missing: ['sellable_tickets'],
  ticket_inventory_unavailable: ['sellable_tickets'],
  inventory_invalid: ['sellable_tickets'],
  sales_window_invalid: ['sellable_tickets'],
  currency_coherent: ['currency_coherence'],
  ticket_currency_mismatch: ['currency_coherence'],
  product_currency_mismatch: ['currency_coherence'],
  pricing_valid: ['fee_pricing'],
  pricing_invalid: ['fee_pricing'],
  checkout_reviewed: ['checkout_consent'],
  checkout_review_required: ['checkout_consent'],
  public_content_published: ['public_content'],
  public_content_missing: ['public_content'],
  confirmation_content_valid: ['confirmation_content'],
  confirmation_content_missing: ['confirmation_content'],
  payment_not_required: ['payment_readiness'],
  payment_ready: ['payment_readiness'],
  preview_reviewed: ['preview_review'],
  preview_review_required: ['preview_review'],
  test_order_complete: ['test_order'],
  test_order_stale: ['test_order'],
  test_order_recommended: ['test_order'],
  test_order_not_applicable: ['test_order'],
  check_in_configured: ['check_in_configuration'],
  check_in_configuration_missing: ['check_in_configuration'],
  required_steps_complete: ['publishability'],
  required_steps_incomplete: ['publishability'],
  event_published: ['publication_status'],
  event_unpublished: ['publication_status'],
  acknowledgement_stale: ['checkout_consent', 'preview_review'],
  permission_required: [...workspaceReadinessStepIds, ...eventLaunchReadinessStepIds],
} as const satisfies Record<
  ReadinessReasonCode,
  ReadonlyArray<WorkspaceReadinessStepId | EventLaunchReadinessStepId>
>;

export const readinessActionIds = [
  'select_workspace',
  'configure_brand',
  'configure_payments',
  'manage_team',
  'configure_legal',
  'configure_sender',
  'edit_event_basics',
  'manage_tickets',
  'manage_products',
  'review_fees',
  'review_checkout',
  'edit_event_content',
  'edit_confirmation_content',
  'review_preview',
  'run_test_order',
  'configure_check_in',
  'publish_event',
  'view_event',
] as const;
export type ReadinessActionId = (typeof readinessActionIds)[number];

export interface ReadinessStep<StepId extends string> {
  id: StepId;
  status: ReadinessStatus;
  priority: ReadinessPriority;
  reasonCodes: ReadonlyArray<ReadinessReasonCode>;
  actionId: ReadinessActionId | null;
  requiredPermission: Permission | null;
  updatedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgementValid: boolean | null;
}

export interface WorkspaceReadiness {
  tenantId: string;
  organizationId: string;
  brandId: string;
  generatedAt: string;
  paymentMode: 'capture' | 'provider_test' | 'provider';
  complete: boolean;
  steps: ReadonlyArray<ReadinessStep<WorkspaceReadinessStepId>>;
  actionFeed: ReadonlyArray<WorkspaceDashboardAction>;
}

export interface WorkspaceDashboardAction {
  id: `workspace:${WorkspaceReadinessStepId}`;
  stepId: WorkspaceReadinessStepId;
  severity: DashboardActionSeverity;
  owner: DashboardActionOwner;
  deadlineAt: string | null;
  status: Extract<ReadinessStatus, 'incomplete' | 'blocked'>;
  reasonCodes: ReadonlyArray<
    Extract<
      ReadinessReasonCode,
      | 'organization_inactive'
      | 'brand_inactive'
      | 'brand_identity_incomplete'
      | 'payment_path_missing'
      | 'team_access_single_member'
      | 'legal_configuration_missing'
      | 'sender_identity_missing'
      | 'permission_required'
    >
  >;
  actionId: ReadinessActionId | null;
  requiredPermission: Permission | null;
  updatedAt: string | null;
}

export interface EventLaunchReadiness {
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  eventVersion: number;
  generatedAt: string;
  paymentMode: 'capture' | 'provider_test' | 'provider';
  launchable: boolean;
  published: boolean;
  requiredBlockers: ReadonlyArray<ReadinessStep<EventLaunchReadinessStepId>>;
  recommendedWarnings: ReadonlyArray<ReadinessStep<EventLaunchReadinessStepId>>;
  steps: ReadonlyArray<ReadinessStep<EventLaunchReadinessStepId>>;
}

export interface ReadinessAcknowledgement {
  tenantId: string;
  organizationId: string;
  brandId: string;
  eventId: string;
  stepId: EventLaunchReadinessStepId;
  stepVersion: number;
  subjectFingerprint: string;
  actorId: string;
  acknowledgedAt: string;
}

export const humanAcknowledgementStepVersions = {
  checkout_consent: 1,
  preview_review: 1,
} as const satisfies Partial<Record<EventLaunchReadinessStepId, number>>;

export function isHumanAcknowledgementStep(
  stepId: EventLaunchReadinessStepId,
): stepId is keyof typeof humanAcknowledgementStepVersions {
  return Object.prototype.hasOwnProperty.call(humanAcknowledgementStepVersions, stepId);
}

type StepInput<StepId extends string> = Omit<
  ReadinessStep<StepId>,
  'actionId' | 'acknowledgementValid'
> & {
  actionId: ReadinessActionId;
  acknowledgementValid?: boolean | null;
};

export function permissionAwareStep<StepId extends string>(
  step: StepInput<StepId>,
  permissions: ReadonlySet<Permission>,
): ReadinessStep<StepId> {
  const actionAllowed =
    step.requiredPermission === null || permissions.has(step.requiredPermission);
  return {
    ...step,
    acknowledgementValid: step.acknowledgementValid ?? (step.acknowledgedAt === null ? null : true),
    actionId: actionAllowed ? step.actionId : null,
    reasonCodes:
      actionAllowed || step.status === 'complete' || step.status === 'not_applicable'
        ? step.reasonCodes
        : [...step.reasonCodes, 'permission_required'],
  };
}

export function finalizeEventLaunchReadiness(
  input: Omit<EventLaunchReadiness, 'launchable' | 'requiredBlockers' | 'recommendedWarnings'>,
): EventLaunchReadiness {
  const requiredBlockers = input.steps.filter(
    (step) =>
      step.id !== 'publishability' &&
      step.priority === 'required' &&
      step.status !== 'complete' &&
      step.status !== 'not_applicable',
  );
  const recommendedWarnings = input.steps.filter(
    (step) =>
      step.id !== 'publishability' &&
      step.priority === 'recommended' &&
      step.status !== 'complete' &&
      step.status !== 'not_applicable',
  );
  return {
    ...input,
    launchable: requiredBlockers.length === 0,
    requiredBlockers,
    recommendedWarnings,
  };
}

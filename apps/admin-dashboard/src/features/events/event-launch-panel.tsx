'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Circle, LockKeyhole, Rocket } from 'lucide-react';
import type {
  EventLaunchReadinessStepId,
  ReadinessReasonCode,
  readinessReasonCodeStepIds,
} from '@tixkit/domain';
import type { AdminEventLaunchReadiness, AdminReadinessStep } from '@/lib/api';
import { routes } from '@/lib/routes';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/context/permission-provider';

const stepLabels: Record<string, string> = {
  basics_schedule: 'Event basics and schedule',
  sellable_tickets: 'Sellable tickets',
  currency_coherence: 'Currency coherence',
  fee_pricing: 'Fees and pricing',
  checkout_consent: 'Checkout and consent review',
  public_content: 'Public event content',
  confirmation_content: 'Confirmation content',
  payment_readiness: 'Payment readiness',
  preview_review: 'Preview review',
  test_order: 'Test order',
  check_in_configuration: 'Check-in configuration',
  publishability: 'Publish preflight',
  publication_status: 'Publication',
};

type EventReadinessReasonCode = {
  [Code in ReadinessReasonCode]: Extract<
    (typeof readinessReasonCodeStepIds)[Code][number],
    EventLaunchReadinessStepId
  > extends never
    ? never
    : Code;
}[ReadinessReasonCode];

export const eventReadinessReasonCopy: Readonly<Record<EventReadinessReasonCode, string>> = {
  event_basics_valid: 'Event basics and schedule are valid.',
  sellable_ticket_available: 'At least one active ticket has inventory available for sale.',
  currency_coherent: 'Event, ticket, and product currencies are coherent.',
  pricing_valid: 'Ticket pricing and fee handling are valid.',
  checkout_reviewed: 'Checkout questions and consent language have been reviewed.',
  public_content_published: 'Public event-page content is published.',
  confirmation_content_valid: 'Order-confirmation content is published and valid.',
  payment_not_required: 'This event does not require a payment account.',
  payment_ready: 'The payment path is ready for this event.',
  preview_reviewed: 'The current buyer preview has been reviewed.',
  test_order_complete: 'A current test order proves this checkout configuration.',
  test_order_not_applicable: 'Test orders are not applicable in the current payment mode.',
  check_in_configured: 'A usable check-in configuration is ready.',
  required_steps_complete: 'Every required launch step is complete.',
  event_published: 'The event is published.',
  event_title_missing:
    'Guests cannot identify this event. Add a clear event title in event settings.',
  event_schedule_invalid:
    'The event cannot be published with this schedule. Set an end time after the start time.',
  event_start_invalid:
    'The event start is missing, invalid, or too close to safely launch. Choose a valid future start time.',
  event_timezone_missing:
    'Times cannot be shown reliably without a timezone. Choose the event timezone in settings.',
  sellable_ticket_missing: 'Add at least one active ticket with available inventory.',
  ticket_inventory_unavailable: 'Increase inventory or reopen the ticket sales window.',
  inventory_invalid:
    'Ticket capacity or occurrence scope is inconsistent. Repair the linked inventory in Tickets.',
  sales_window_invalid:
    'Guests cannot buy during the configured window. Set sales dates in order and around the event schedule.',
  ticket_currency_mismatch:
    'Ticket prices use a different currency from the event. Update ticket or event currency before launch.',
  product_currency_mismatch:
    'An add-on uses a different currency from the event. Update the product currency before launch.',
  pricing_invalid:
    'Buyer totals or fee handling are inconsistent. Review ticket prices and the event fee policy.',
  payment_capture_mode_paid_unsupported:
    'Paid events cannot launch while payments are in capture-only mode.',
  payment_path_missing: 'Connect a payment account for paid or donation tickets.',
  payment_account_inactive:
    'Paid checkout cannot settle funds because the connected account is inactive. Reconnect or activate it.',
  payment_charges_disabled: 'Resolve the payment provider restriction before launching.',
  payment_currency_mismatch:
    'The connected payment account cannot accept this event currency. Change the currency or payment account.',
  public_content_missing: 'Publish event-page content so guests have a complete public experience.',
  confirmation_content_missing: 'Publish an order-confirmation email for attendees.',
  checkout_review_required: 'Review the real checkout questions and consent language.',
  preview_review_required: 'Open the authenticated preview and explicitly mark it reviewed.',
  test_order_recommended:
    'Checkout has not been proven for this configuration. Run a safe test order before publishing.',
  check_in_configuration_missing:
    'Door staff do not yet have a usable check-in setup. Configure check-in lists and access.',
  required_steps_incomplete:
    'Publishing is blocked until every required launch check is complete. Continue with the next action above.',
  event_unpublished:
    'The event is still a draft. Complete the launch checks and run publish preflight.',
  acknowledgement_stale:
    'Configuration changed after this review. Review the updated preview or checkout and acknowledge it again.',
  permission_required: 'A teammate with the required permission must complete this step.',
};

export function eventReadinessReasonText(
  step: AdminReadinessStep,
  reason: ReadinessReasonCode,
): string {
  if (reason === 'acknowledgement_stale') {
    if (step.id === 'checkout_consent') {
      return 'Checkout questions or consent language changed after the last review. Review the current checkout and acknowledge it again.';
    }
    if (step.id === 'preview_review') {
      return 'Event details, tickets, add-ons, or published content changed after the last preview review. Review the current buyer experience and acknowledge it again.';
    }
  }
  return Object.hasOwn(eventReadinessReasonCopy, reason)
    ? eventReadinessReasonCopy[reason as EventReadinessReasonCode]
    : 'This launch check needs attention. Open its settings to review and correct the current configuration.';
}

function actionHref(eventId: string, step: AdminReadinessStep): string | undefined {
  switch (step.actionId) {
    case 'edit_event_basics':
      return routes.eventSettings(eventId);
    case 'manage_tickets':
      return routes.eventTickets(eventId);
    case 'manage_products':
      return routes.eventProducts(eventId);
    case 'review_fees':
      return `${routes.eventSettings(eventId)}#sales`;
    case 'review_checkout':
      return routes.eventCheckoutForm(eventId);
    case 'edit_event_content':
      return routes.eventContentEventPage(eventId);
    case 'edit_confirmation_content':
      return routes.eventContentEmail(eventId);
    case 'configure_payments':
      return routes.settingsPayments;
    case 'review_preview':
      return routes.eventPreview(eventId);
    case 'run_test_order':
      return routes.eventPreview(eventId);
    case 'configure_check_in':
      return routes.eventCheckIn(eventId);
    case 'view_event':
      return routes.eventDetail(eventId);
    default:
      return undefined;
  }
}

export function EventLaunchPanel({
  eventId,
  readiness,
}: {
  eventId: string;
  readiness: AdminEventLaunchReadiness;
}) {
  const { can, loading: permissionsLoading, error: permissionsError } = usePermissions();
  const canRemediate = (step: AdminReadinessStep) =>
    step.requiredPermission === null ||
    (!permissionsLoading && !permissionsError && can(step.requiredPermission));
  const required = readiness.steps.filter(
    (step) => step.priority === 'required' && step.id !== 'publishability',
  );
  const complete = required.filter(
    (step) => step.status === 'complete' || step.status === 'not_applicable',
  ).length;
  const progress = required.length === 0 ? 100 : Math.round((complete / required.length) * 100);
  const next = readiness.steps.find(
    (step) =>
      step.id !== 'publishability' &&
      step.id !== 'publication_status' &&
      step.status !== 'complete' &&
      step.status !== 'not_applicable' &&
      step.actionId !== null &&
      canRemediate(step),
  );
  return (
    <Card className="border-primary/30 bg-primary/[0.03]" aria-busy={permissionsLoading}>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Rocket className="size-5 text-primary" aria-hidden="true" />
            Launch center
          </CardTitle>
          <span className="text-sm font-medium">{progress}% required setup complete</span>
        </div>
        <progress
          className="h-2 overflow-hidden rounded-full bg-muted"
          aria-label="Required launch setup"
          max={100}
          value={progress}
        />
      </CardHeader>
      <CardContent className="space-y-5">
        {next ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background p-4">
            <div>
              <p className="text-sm font-semibold">Next setup action</p>
              <p className="text-sm text-foreground/80">
                {stepLabels[next.id] ?? next.id.replaceAll('_', ' ')}
              </p>
            </div>
            {actionHref(eventId, next) ? (
              <Button asChild className="font-semibold">
                <Link href={actionHref(eventId, next)!}>Continue setup</Link>
              </Button>
            ) : null}
          </div>
        ) : readiness.launchable ? (
          <div className="rounded-lg border bg-background p-4">
            <p className="font-semibold">Ready for publish preflight</p>
            <p className="text-sm text-foreground/80">
              All required checks pass. Use Review and publish above to confirm the audited
              transition.
            </p>
          </div>
        ) : null}
        <ul className="divide-y" aria-label="Event launch readiness">
          {readiness.steps
            .filter((step) => step.id !== 'publishability' && step.id !== 'publication_status')
            .map((step) => {
              const done = step.status === 'complete' || step.status === 'not_applicable';
              const href = actionHref(eventId, step);
              const remediationAllowed = canRemediate(step);
              return (
                <li key={step.id} className="flex items-start gap-3 py-3">
                  {done ? (
                    <CheckCircle2
                      className="mt-0.5 size-5 shrink-0 text-emerald-600"
                      aria-hidden="true"
                    />
                  ) : step.status === 'blocked' ? (
                    <AlertTriangle
                      className="mt-0.5 size-5 shrink-0 text-destructive"
                      aria-hidden="true"
                    />
                  ) : step.actionId === null || !remediationAllowed ? (
                    <LockKeyhole
                      className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <Circle
                      className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{stepLabels[step.id] ?? step.id}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">
                        {step.priority}
                      </span>
                      <span className="text-xs capitalize text-foreground/80">
                        {step.status.replaceAll('_', ' ')}
                      </span>
                    </div>
                    {!done ? (
                      <>
                        <p className="mt-1 text-sm text-foreground/80">
                          {step.reasonCodes
                            .map((reason) => eventReadinessReasonText(step, reason))
                            .join(' ')}
                        </p>
                        {href && !remediationAllowed ? (
                          <p
                            className="mt-1 text-sm font-medium text-foreground"
                            role={permissionsLoading ? 'status' : permissionsError ? 'alert' : undefined}
                          >
                            {permissionsLoading
                              ? 'Checking access for this action…'
                              : permissionsError
                                ? 'Access could not be verified for this action.'
                                : 'A teammate with the required permission must complete this action.'}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  {!done && href && remediationAllowed ? (
                    <Link
                      className="text-sm font-medium text-primary hover:underline"
                      href={href}
                      aria-label={`Open ${stepLabels[step.id] ?? step.id}`}
                    >
                      Open
                    </Link>
                  ) : null}
                </li>
              );
            })}
        </ul>
      </CardContent>
    </Card>
  );
}

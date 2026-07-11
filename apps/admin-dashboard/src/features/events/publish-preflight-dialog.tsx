"use client";

import * as React from "react";
import Link from "next/link";
import {
  adminApi,
  isAdminLaunchReadinessFailure,
  type AdminEventLaunchReadiness,
} from "@/lib/api";
import { routes } from "@/lib/routes";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function href(eventId: string, actionId: string | null): string | undefined {
  if (actionId === "manage_tickets") return routes.eventTickets(eventId);
  if (actionId === "manage_products") return routes.eventProducts(eventId);
  if (actionId === "review_checkout") return routes.eventCheckoutForm(eventId);
  if (actionId === "edit_event_content")
    return routes.eventContentEventPage(eventId);
  if (actionId === "edit_confirmation_content")
    return routes.eventContentEmail(eventId);
  if (actionId === "configure_payments") return routes.settingsPayments;
  if (actionId === "configure_check_in") return routes.eventCheckIn(eventId);
  if (actionId === "review_preview") return routes.eventPreview(eventId);
  if (actionId === "run_test_order") return routes.eventPreview(eventId);
  if (actionId === "edit_event_basics" || actionId === "review_fees")
    return routes.eventSettings(eventId);
  return undefined;
}

function readableReason(code: string): string {
  const known: Record<string, string> = {
    sellable_ticket_missing:
      "Add at least one active ticket with available inventory.",
    payment_path_missing:
      "Connect a usable payment account for paid or donation tickets.",
    payment_charges_disabled:
      "Resolve the payment account restriction before publishing.",
    checkout_review_required: "Review checkout questions and consent language.",
    preview_review_required:
      "Review the authenticated event-page and checkout preview.",
    public_content_missing: "Add public event-page content.",
    confirmation_content_missing: "Add valid confirmation content.",
    permission_required:
      "A teammate with the required permission must complete this step.",
  };
  return (
    known[code] ??
    code.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())
  );
}

export function PublishPreflightDialog({
  open,
  onOpenChange,
  eventId,
  readiness,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  readiness: AdminEventLaunchReadiness;
  onPublished: () => void;
}) {
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [currentReadiness, setCurrentReadiness] = React.useState(readiness);
  React.useEffect(() => setCurrentReadiness(readiness), [readiness]);
  const publish = async () => {
    if (!currentReadiness.launchable) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await adminApi.publishEvent(eventId);
      if (!result.ok) {
        if (isAdminLaunchReadinessFailure(result.error)) {
          setCurrentReadiness({
            ...currentReadiness,
            launchable: false,
            requiredBlockers: result.error.details.requiredBlockers,
            recommendedWarnings: result.error.details.recommendedWarnings,
          });
          setError(
            "Readiness changed. Review the current server blockers below.",
          );
        } else {
          setError(
            result.error.code === "stale_event_version"
              ? "The event changed. Close this dialog, refresh readiness, and review again."
              : result.error.message,
          );
        }
        return;
      }
      onOpenChange(false);
      onPublished();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to publish. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Publish preflight</AlertDialogTitle>
          <AlertDialogDescription>
            {currentReadiness.launchable
              ? "All required launch checks pass. Review recommendations, then confirm publication."
              : "Complete every required blocker before this event can be published."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {currentReadiness.requiredBlockers.length ? (
          <section>
            <h3 className="font-semibold">Required blockers</h3>
            <ul className="mt-2 space-y-2">
              {currentReadiness.requiredBlockers.map((step) => (
                <li
                  key={step.id}
                  className="rounded-md border border-destructive/30 p-3 text-sm"
                >
                  <p className="font-medium">{step.id.replaceAll("_", " ")}</p>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {step.reasonCodes.map((code) => (
                      <li key={code}>{readableReason(code)}</li>
                    ))}
                  </ul>
                  {href(eventId, step.actionId) ? (
                    <Link
                      className="mt-1 inline-block font-medium text-primary"
                      href={href(eventId, step.actionId)!}
                    >
                      Open the required editor
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {currentReadiness.recommendedWarnings.length ? (
          <section>
            <h3 className="font-semibold">Recommended warnings</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {currentReadiness.recommendedWarnings.map((step) => (
                <li key={step.id}>
                  {step.id.replaceAll("_", " ")} —{" "}
                  {step.reasonCodes.map(readableReason).join(" ")}
                  {href(eventId, step.actionId) ? (
                    <Link
                      className="ml-2 font-medium text-primary"
                      href={href(eventId, step.actionId)!}
                    >
                      Open recommended editor
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Close</AlertDialogCancel>
          <Button
            onClick={publish}
            disabled={!currentReadiness.launchable || submitting}
          >
            {submitting ? "Publishing…" : "Confirm publish"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

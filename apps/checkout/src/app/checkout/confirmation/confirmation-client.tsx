'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  CheckCircle2Icon,
  MailIcon,
  TicketIcon,
  AlertCircleIcon,
  HomeIcon,
  ClockIcon,
  XCircleIcon,
  RefreshCwIcon,
  LoaderCircleIcon,
  WalletCardsIcon,
  DownloadIcon,
  ExternalLinkIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { BrandFooter } from '@/components/checkout/brand-footer';
import {
  checkoutApi,
  publicApi,
  userFacingMessage,
  type CheckoutPaymentCompensation,
  type CheckoutSession,
  type CheckoutWalletPassTicket,
  type PublicEvent,
} from '@/lib/api';
import { brandThemeStyle, type ResolvedBrand } from '@/lib/brand';
import { useResolvedBrand } from '@/lib/use-brand';
import { getSessionToken } from '@/lib/session-token';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { trackMarketingEvent } from '@/lib/marketing';
import { deriveState, type ConfirmationState } from './confirmation-state';

// Re-export so consumers can import the single source of truth from the
// component module without duplicating the derivation logic.
export { deriveState, type ConfirmationState } from './confirmation-state';

function emitOrderCompleted(detail: Record<string, unknown>) {
  if (typeof window === 'undefined') return;
  const message = {
    source: 'tixkit-checkout',
    event: 'order_completed',
    type: 'order_completed',
    ...detail,
  };
  window.parent?.postMessage(message, '*');
  window.opener?.postMessage(message, '*');
}

export default function ConfirmationClient() {
  const params = useSearchParams();
  const sessionId = params.get('sessionId') ?? '';
  const orderId = params.get('orderId') ?? '';
  const orderNumber = params.get('orderNumber') ?? '';
  const redirectStatus = params.get('redirect_status') ?? '';
  const paymentIntentClientSecret = params.get('payment_intent_client_secret') ?? undefined;

  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [walletPasses, setWalletPasses] = useState<CheckoutWalletPassTicket[]>([]);
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setPollCount] = useState(0);
  const pollCountRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const brand: ResolvedBrand = useResolvedBrand(
    useMemo(
      () => ({
        brandId: session?.brandId ?? undefined,
      }),
      [session],
    ),
  );

  const loadSession = useCallback(
    async (id: string, token?: string, stripeClientSecret?: string) => {
      const loaded = await checkoutApi.getSession(
        id,
        token,
        token ? undefined : stripeClientSecret,
      );
      setSession(loaded);
      if (loaded.eventId) {
        try {
          const evt = await publicApi.getEvent(loaded.eventId);
          setEvent(evt);
        } catch {
          // Event load failure is non-fatal on confirmation.
        }
      }
      return loaded;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    // Reset the backoff counter for each new confirmation load cycle.
    pollCountRef.current = 0;
    setPollCount(0);

    async function load() {
      if (!sessionId) {
        setLoading(false);
        return;
      }
      // Resolve the token from sessionStorage (not from the URL).
      // The backend may also support public scoped reads without a token.
      const token = getSessionToken(sessionId);

      try {
        const loaded = await loadSession(sessionId, token, paymentIntentClientSecret);
        if (cancelled) return;
        // If the session is pending, start polling.
        const state = deriveState(loaded, redirectStatus || null);
        if (state === 'pending') {
          startPolling(sessionId, token, paymentIntentClientSecret);
        }
      } catch (err) {
        if (!cancelled) setError(userFacingMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    function startPolling(id: string, token?: string, stripeClientSecret?: string) {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      // Use a ref so the recursive closure always sees the latest count.
      // The stale `pollCount` state captured by this closure previously
      // pinned every delay to 2s. The ref drives the real backoff.
      const count = pollCountRef.current;
      pollCountRef.current += 1;
      setPollCount(count + 1);

      // Exponential backoff: 2s, 4s, 8s, 16s, capped at 30s.
      const delay = Math.min(2000 * Math.pow(2, count), 30000);
      pollTimerRef.current = setTimeout(async () => {
        if (cancelled) return;
        try {
          const loaded = await loadSession(id, token, stripeClientSecret);
          if (cancelled) return;
          const state = deriveState(loaded, null);
          if (state === 'pending') {
            startPolling(id, token, stripeClientSecret);
          }
        } catch (err) {
          if (!cancelled) setError(userFacingMessage(err));
        }
      }, delay);
    }

    void load();
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, redirectStatus]);

  const confirmationState: ConfirmationState = loading
    ? 'loading'
    : error
      ? 'error'
      : deriveState(session, redirectStatus || null);

  useEffect(() => {
    if (confirmationState !== 'confirmed' || !sessionId) return;
    if (session) {
      trackMarketingEvent(event?.marketingIntegrations, 'purchase', {
        eventId: session.eventId,
        sessionId,
        orderId: orderId || session.orderId || undefined,
        currency: session.currency,
        valueCents: session.quote.totalCents,
      });
    }
    emitOrderCompleted({
      sessionId,
      orderId: orderId || session?.orderId,
      eventId: session?.eventId,
    });
  }, [confirmationState, event, sessionId, orderId, session]);

  useEffect(() => {
    let cancelled = false;
    async function loadWalletPasses() {
      if (confirmationState !== 'confirmed' || !sessionId) {
        setWalletPasses([]);
        return;
      }
      const token = getSessionToken(sessionId);
      try {
        const result = await checkoutApi.getWalletPasses(sessionId, token);
        if (!cancelled) setWalletPasses(result.tickets);
      } catch {
        if (!cancelled) setWalletPasses([]);
      }
    }

    void loadWalletPasses();
    return () => {
      cancelled = true;
    };
  }, [confirmationState, sessionId]);

  const total = session?.quote.totalCents ?? 0;
  const currency = session?.currency ?? 'USD';
  const startsAt = event ? formatDateTime(event.startsAt, event.timezone) : null;
  const compensationMessage = paymentCompensationMessage(session?.paymentCompensation);

  if (loading) {
    return (
      <Surface brand={brand}>
        <main className="mx-auto w-full max-w-xl space-y-6 px-4 py-16 sm:px-6">
          <Skeleton className="mx-auto size-16 rounded-full" />
          <Skeleton className="h-8 w-64 mx-auto" />
          <Skeleton className="h-40 w-full" />
        </main>
      </Surface>
    );
  }

  return (
    <Surface brand={brand}>
      <main className="mx-auto w-full max-w-xl space-y-8 px-4 py-12 sm:px-6">
        <ConfirmationHeader state={confirmationState} />

        {(orderNumber || orderId) && confirmationState !== 'error' ? (
          <div className="flex justify-center">
            <Badge variant="secondary" className="font-mono">
              {orderNumber || orderId}
            </Badge>
          </div>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertCircleIcon />
            <AlertTitle>Could not load order details</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {confirmationState === 'pending' ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <ClockIcon className="size-8 text-amber-500" />
              <h2 className="text-lg font-semibold">Processing your payment</h2>
              <p className="text-sm text-muted-foreground">
                We are confirming your payment with the processor. This page will update
                automatically once your payment is confirmed.
              </p>
              <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
            </CardContent>
          </Card>
        ) : null}

        {confirmationState === 'expired' ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <ClockIcon className="size-8 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Checkout expired</h2>
              <p className="text-sm text-muted-foreground">
                Your checkout session has expired. Please start a new order.
              </p>
              {compensationMessage ? (
                <p className="text-sm font-medium text-foreground">{compensationMessage}</p>
              ) : null}
              <Button asChild variant="outline" className="gap-1.5">
                <a href={event ? `/e/${event.id}` : '/'}>
                  <RefreshCwIcon className="size-4" />
                  Start new order
                </a>
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {confirmationState === 'cancelled' ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <XCircleIcon className="size-8 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Order cancelled</h2>
              <p className="text-sm text-muted-foreground">
                This order was cancelled. You can start a new order below.
              </p>
              <Button asChild variant="outline" className="gap-1.5">
                <a href={event ? `/e/${event.id}` : '/'}>
                  <RefreshCwIcon className="size-4" />
                  Start new order
                </a>
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {confirmationState === 'failed' ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <XCircleIcon className="size-8 text-destructive" />
              <h2 className="text-lg font-semibold">Payment failed</h2>
              <p className="text-sm text-muted-foreground">
                Your payment could not be processed. Please try again or contact support.
              </p>
              {compensationMessage ? (
                <p className="text-sm font-medium text-foreground">{compensationMessage}</p>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button asChild variant="outline" className="gap-1.5">
                  <a href={event ? `/e/${event.id}` : '/'}>
                    <RefreshCwIcon className="size-4" />
                    Try again
                  </a>
                </Button>
                {brand.supportUrl ? (
                  <Button asChild variant="ghost" className="gap-1.5">
                    <a href={brand.supportUrl} target="_blank" rel="noreferrer">
                      Contact support
                    </a>
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ) : null}

        {confirmationState === 'confirmed' ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>What happens next</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <DeliveryStep
                  icon={MailIcon}
                  title="Confirmation email sent"
                  description="A receipt and tickets were emailed to the buyer."
                  done
                />
                <DeliveryStep
                  icon={TicketIcon}
                  title="Ticket delivery"
                  description="Each ticket includes a unique QR code for check-in at the venue."
                  done
                />
              </CardContent>
            </Card>

            {walletPasses.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <WalletCardsIcon className="size-5" />
                    Add to Wallet
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {walletPasses.map((ticket) => (
                    <div
                      key={ticket.ticketId}
                      className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-sm font-medium">
                          {ticket.ticketCode}
                        </p>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        {ticket.appleUrl ? (
                          <Button asChild size="sm" className="gap-1.5">
                            <a href={ticket.appleUrl}>
                              <DownloadIcon className="size-4" />
                              Apple Wallet
                            </a>
                          </Button>
                        ) : null}
                        {ticket.googleUrl ? (
                          <Button asChild size="sm" variant="outline" className="gap-1.5">
                            <a href={ticket.googleUrl} target="_blank" rel="noreferrer">
                              <ExternalLinkIcon className="size-4" />
                              Google Wallet
                            </a>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            {event ? (
              <Card>
                <CardHeader>
                  <CardTitle>{event.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {startsAt ? (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>{startsAt}</span>
                    </div>
                  ) : null}
                  {event.venue?.name ? (
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span>{event.venue.name}</span>
                    </div>
                  ) : null}
                  {total > 0 ? (
                    <div className="flex items-center justify-between pt-2">
                      <span className="text-muted-foreground">Total paid</span>
                      <span className="font-semibold">{formatCurrency(total, currency)}</span>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}
          </>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button variant="outline" asChild className="gap-1.5">
            <a href="/">
              <HomeIcon className="size-4" />
              Back to home
            </a>
          </Button>
        </div>

        <BrandFooter brand={brand} />
      </main>
    </Surface>
  );
}

function paymentCompensationMessage(compensation?: CheckoutPaymentCompensation): string | null {
  if (!compensation) return null;

  if (compensation.status === 'succeeded') {
    if (compensation.action === 'cancel') {
      return 'Any pending payment authorization was automatically cancelled.';
    }
    if (compensation.action === 'refund') {
      return 'Any captured payment was automatically refunded.';
    }
    if (compensation.action === 'local_noop') {
      return 'This payment was closed without issuing tickets.';
    }
    return 'This payment was compensated without issuing tickets.';
  }

  if (compensation.status === 'manual_review') {
    return 'Your payment is under review and no tickets were issued.';
  }

  if (compensation.status === 'pending') {
    return 'We are reversing this payment and no tickets were issued.';
  }

  if (compensation.status === 'failed') {
    return 'No tickets were issued. Contact support if a payment appears on your statement.';
  }

  return null;
}

function ConfirmationHeader({ state }: { state: ConfirmationState }) {
  if (state === 'confirmed') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950/60">
          <CheckCircle2Icon className="size-8 text-emerald-600" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Order confirmed</h1>
          <p className="text-sm text-muted-foreground">Thank you. Your tickets are on the way.</p>
        </div>
      </div>
    );
  }

  if (state === 'pending') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-950/60">
          <ClockIcon className="size-8 text-amber-600" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Processing your order</h1>
          <p className="text-sm text-muted-foreground">
            Please wait while we confirm your payment.
          </p>
        </div>
      </div>
    );
  }

  if (state === 'expired' || state === 'cancelled') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-muted">
          <ClockIcon className="size-8 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {state === 'expired' ? 'Checkout expired' : 'Order cancelled'}
          </h1>
        </div>
      </div>
    );
  }

  if (state === 'failed') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10">
          <XCircleIcon className="size-8 text-destructive" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Payment failed</h1>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircleIcon className="size-8 text-destructive" />
        </div>
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Could not load your order</h1>
        </div>
      </div>
    );
  }

  // unknown
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-muted">
        <TicketIcon className="size-8 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Order details</h1>
      </div>
    </div>
  );
}

function DeliveryStep({
  icon: Icon,
  title,
  description,
  done,
}: {
  icon: typeof MailIcon;
  title: string;
  description: string;
  done: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={
          done
            ? 'flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
            : 'flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground'
        }
      >
        <Icon className="size-4" />
      </div>
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function Surface({ brand, children }: { brand: ResolvedBrand; children: React.ReactNode }) {
  return (
    <div className="min-h-svh bg-background text-foreground" style={brandThemeStyle(brand)}>
      {children}
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import type { Stripe, StripeElements, StripePaymentElementOptions } from '@stripe/stripe-js';
import { ShieldCheckIcon, LoaderCircleIcon, AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useRuntimeConfig } from '@/context/runtime-config-provider';

type Props = {
  clientSecret: string;
  currency: string;
  totalCents: number;
  returnUrl: string;
  billingDetails?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  onError: (message: string) => void;
};

// Stripe.js is loaded lazily and only when a payment is actually in flight.
let stripePromise: Promise<Stripe | null> | null = null;
let stripePromiseKey: string | null = null;
async function getStripe(
  publishableKey: string | undefined,
  options?: { reset?: boolean },
): Promise<Stripe | null> {
  if (!publishableKey) {
    stripePromise = null;
    stripePromiseKey = null;
    return null;
  }

  if (options?.reset || stripePromiseKey !== publishableKey) {
    stripePromise = null;
    stripePromiseKey = publishableKey;
  }

  if (!stripePromise) {
    const { loadStripe } = await import('@stripe/stripe-js');
    stripePromise = loadStripe(publishableKey);
    stripePromiseKey = publishableKey;
  }

  const stripe = await stripePromise;
  if (!stripe) stripePromise = null;
  return stripe;
}

type PaymentElementLike = {
  mount(el: HTMLElement): void;
  unmount(): void;
  on(event: 'ready', cb: () => void): void;
  on(event: 'change', cb: (e: { error?: { message?: string } | null }) => void): void;
};

function stripeRedirectStatus(status?: string): string {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'processing') return 'processing';
  return 'failed';
}

function isLocalCaptureClientSecret(value: string): boolean {
  return value.startsWith('pi_capture_') && value.endsWith('_secret');
}

function localCaptureIntentId(value: string): string {
  return value.slice(0, -'_secret'.length);
}

export function PaymentHandoff({
  clientSecret,
  currency,
  totalCents,
  returnUrl,
  billingDetails,
  onError,
}: Props) {
  const { stripePublishableKey } = useRuntimeConfig();
  const containerRef = useRef<HTMLDivElement>(null);
  const paymentElementRef = useRef<PaymentElementLike | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const stripeRef = useRef<Stripe | null>(null);
  const [status, setStatus] = useState<'mounting' | 'ready' | 'error'>('mounting');
  const [mountError, setMountError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [mountAttempt, setMountAttempt] = useState(0);
  const isLocalCapture = isLocalCaptureClientSecret(clientSecret);

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      setMountError(null);
      setSubmitting(false);
      setStatus('mounting');
      stripeRef.current = null;
      elementsRef.current = null;

      if (isLocalCapture) {
        setStatus('ready');
        return;
      }

      const container = containerRef.current;
      if (!container) return;
      try {
        const stripe = await getStripe(stripePublishableKey, { reset: mountAttempt > 0 });
        if (!stripe || cancelled) {
          if (!cancelled) {
            setMountError('Payment processor could not be loaded. Please try again.');
            setStatus('error');
          }
          return;
        }
        stripeRef.current = stripe;
        const elements = stripe.elements({
          appearance: { theme: 'stripe' },
          clientSecret,
        });
        elementsRef.current = elements;
        const paymentOptions: StripePaymentElementOptions = {
          defaultValues: billingDetails ? { billingDetails } : undefined,
          wallets: { link: 'never' },
        };
        const paymentElement = elements.create(
          'payment',
          paymentOptions,
        ) as unknown as PaymentElementLike;
        paymentElementRef.current = paymentElement;
        if (cancelled) return;
        paymentElement.mount(container);
        paymentElement.on('ready', () => {
          if (!cancelled) setStatus('ready');
        });
        paymentElement.on('change', (event) => {
          if (event.error?.message) onError(event.error.message);
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Failed to load payment form.';
        setMountError(message);
        setStatus('error');
      }
    }

    void mount();
    return () => {
      cancelled = true;
      try {
        paymentElementRef.current?.unmount();
      } catch {
        // ignore unmount errors on cleanup
      }
      paymentElementRef.current = null;
      elementsRef.current = null;
    };
  }, [billingDetails, clientSecret, isLocalCapture, mountAttempt, onError, stripePublishableKey]);

  function handleRetryMount() {
    setMountError(null);
    setStatus('mounting');
    setMountAttempt((attempt) => attempt + 1);
  }

  async function handlePay() {
    if (submitting) return;

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      onError('You appear to be offline. Reconnect, then try payment again.');
      return;
    }

    if (isLocalCapture) {
      setSubmitting(true);
      const url = new URL(returnUrl);
      url.searchParams.set('payment_intent', localCaptureIntentId(clientSecret));
      url.searchParams.set('payment_intent_client_secret', clientSecret);
      // Local capture is a synthetic test harness only. It must never be treated
      // as proof of real card authentication success outside local capture mode.
      url.searchParams.set('redirect_status', 'succeeded');
      window.location.assign(url.toString());
      return;
    }

    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (!stripe || !elements) {
      onError('Payment form is still loading. Please try again.');
      return;
    }
    setSubmitting(true);
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        onError(submitError.message ?? 'Could not submit payment details.');
        return;
      }
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: 'if_required',
      });
      if (error) {
        // Prefer Stripe's message; authentication/cancel/decline all surface here.
        onError(error.message ?? 'Payment failed.');
        return;
      }
      let confirmedIntent = paymentIntent;
      if (!confirmedIntent) {
        const retrieved = await stripe.retrievePaymentIntent(clientSecret);
        if (retrieved.error) {
          onError(retrieved.error.message ?? 'Payment status could not be verified.');
          return;
        }
        confirmedIntent = retrieved.paymentIntent;
      }
      if (confirmedIntent) {
        const url = new URL(returnUrl);
        url.searchParams.set('payment_intent', confirmedIntent.id);
        // client_secret is required by Stripe return handling; confirmation page
        // strips it from the address bar immediately and never logs it.
        url.searchParams.set('payment_intent_client_secret', clientSecret);
        url.searchParams.set('redirect_status', stripeRedirectStatus(confirmedIntent.status));
        window.location.assign(url.toString());
        return;
      }
      onError('Payment confirmation did not return a payment intent.');
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'Payment failed due to a network error. Check your connection and try again.';
      onError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldCheckIcon className="size-4" />
        {isLocalCapture
          ? 'Payment is ready for local capture'
          : 'Secure payment processed by Stripe'}
      </div>

      {mountError ? (
        <Alert variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Payment unavailable</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{mountError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={handleRetryMount}
            >
              Retry payment form
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <div
        ref={containerRef}
        className="min-h-[120px] rounded-md border bg-card p-3"
        aria-busy={status === 'mounting'}
      />

      <Button
        type="button"
        size="lg"
        className="w-full gap-2"
        disabled={status !== 'ready' || submitting}
        onClick={handlePay}
      >
        {submitting ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
        Pay{' '}
        {new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency,
        }).format(totalCents / 100)}
      </Button>
    </div>
  );
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { loadStripe, type Stripe, type StripeElements } from '@stripe/stripe-js'
import {
  ShieldCheckIcon,
  LoaderCircleIcon,
  AlertCircleIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

type Props = {
  clientSecret: string
  currency: string
  totalCents: number
  returnUrl: string
  onError: (message: string) => void
}

// Stripe.js is loaded lazily and only when a payment is actually in flight.
let stripePromise: Promise<Stripe | null> | null = null
function getStripe(): Promise<Stripe | null> {
  if (!stripePromise) {
    const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
    stripePromise = publishableKey ? loadStripe(publishableKey) : loadStripe('')
  }
  return stripePromise
}

type PaymentElementLike = {
  mount(el: HTMLElement): void
  unmount(): void
  on(event: 'ready', cb: () => void): void
  on(
    event: 'change',
    cb: (e: { error?: { message?: string } | null }) => void,
  ): void
}

export function PaymentHandoff({
  clientSecret,
  currency,
  totalCents,
  returnUrl,
  onError,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const paymentElementRef = useRef<PaymentElementLike | null>(null)
  const elementsRef = useRef<StripeElements | null>(null)
  const stripeRef = useRef<Stripe | null>(null)
  const [status, setStatus] = useState<'mounting' | 'ready' | 'error'>(
    'mounting',
  )
  const [mountError, setMountError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function mount() {
      const container = containerRef.current
      if (!container) return
      try {
        const stripe = await getStripe()
        if (!stripe || cancelled) {
          if (!cancelled) {
            setMountError(
              'Payment processor could not be loaded. Please try again.',
            )
            setStatus('error')
          }
          return
        }
        stripeRef.current = stripe
        const elements = stripe.elements({
          appearance: { theme: 'stripe' },
          clientSecret,
        })
        elementsRef.current = elements
        const paymentElement = elements.create(
          'payment',
        ) as unknown as PaymentElementLike
        paymentElementRef.current = paymentElement
        if (cancelled) return
        paymentElement.mount(container)
        paymentElement.on('ready', () => {
          if (!cancelled) setStatus('ready')
        })
        paymentElement.on('change', (event) => {
          if (event.error?.message) onError(event.error.message)
        })
      } catch (err) {
        if (cancelled) return
        const message =
          err instanceof Error ? err.message : 'Failed to load payment form.'
        setMountError(message)
        setStatus('error')
      }
    }

    void mount()
    return () => {
      cancelled = true
      try {
        paymentElementRef.current?.unmount()
      } catch {
        // ignore unmount errors on cleanup
      }
      paymentElementRef.current = null
      elementsRef.current = null
    }
  }, [clientSecret, onError])

  async function handlePay() {
    const stripe = stripeRef.current
    const elements = elementsRef.current
    if (!stripe || !elements) return
    setSubmitting(true)
    try {
      const { error: submitError } = await elements.submit()
      if (submitError) {
        onError(submitError.message ?? 'Could not submit payment details.')
        return
      }
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
      })
      if (error) {
        onError(error.message ?? 'Payment failed.')
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Payment failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className='space-y-4'>
      <div className='flex items-center gap-2 text-sm text-muted-foreground'>
        <ShieldCheckIcon className='size-4' />
        Secure payment processed by Stripe
      </div>

      {mountError ? (
        <Alert variant='destructive'>
          <AlertCircleIcon />
          <AlertTitle>Payment unavailable</AlertTitle>
          <AlertDescription>{mountError}</AlertDescription>
        </Alert>
      ) : null}

      <div
        ref={containerRef}
        className='min-h-[120px] rounded-md border bg-card p-3'
        aria-busy={status === 'mounting'}
      />

      <Button
        type='button'
        size='lg'
        className='w-full gap-2'
        disabled={status !== 'ready' || submitting}
        onClick={handlePay}
      >
        {submitting ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : null}
        Pay {new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency,
        }).format(totalCents / 100)}
      </Button>
    </div>
  )
}

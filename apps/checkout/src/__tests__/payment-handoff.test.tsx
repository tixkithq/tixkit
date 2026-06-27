import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { loadStripe } from '@stripe/stripe-js'
import { PaymentHandoff } from '@/components/checkout/payment-handoff'

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(async () => null),
}))

afterEach(() => {
  vi.clearAllMocks()
  delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
})

describe('PaymentHandoff local capture mode', () => {
  it('does not load Stripe.js for synthetic local capture client secrets', async () => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_present'

    render(
      <PaymentHandoff
        clientSecret='pi_capture_cs_1_secret'
        currency='USD'
        totalCents={2500}
        returnUrl='http://localhost:3000/checkout/complete'
        onError={() => {}}
      />,
    )

    await screen.findByText('Payment is ready for local capture')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pay/ })).toBeEnabled()
    })
    expect(loadStripe).not.toHaveBeenCalled()
  })
})

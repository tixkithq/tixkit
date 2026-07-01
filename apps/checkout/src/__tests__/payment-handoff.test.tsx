import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { loadStripe } from '@stripe/stripe-js';
import React from 'react';
import { PaymentHandoff } from '@/components/checkout/payment-handoff';

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(async () => null),
}));

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
});

function createReadyStripe() {
  const paymentElement = {
    mount: vi.fn(),
    unmount: vi.fn(),
    on: vi.fn((event: string, callback: () => void) => {
      if (event === 'ready') setTimeout(callback, 0);
    }),
  };
  const elements = {
    create: vi.fn(() => paymentElement),
    submit: vi.fn(async () => ({})),
  };
  const stripe = {
    elements: vi.fn(() => elements),
    confirmPayment: vi.fn(),
    retrievePaymentIntent: vi.fn(),
  };
  return { stripe, elements, paymentElement };
}

describe('PaymentHandoff local capture mode', () => {
  it('does not load Stripe.js for synthetic local capture client secrets', async () => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_present';

    render(
      React.createElement(PaymentHandoff, {
        clientSecret: 'pi_capture_cs_1_secret',
        currency: 'USD',
        totalCents: 2500,
        returnUrl: 'http://localhost:3000/checkout/complete',
        onError: () => {},
      }),
    );

    await screen.findByText('Payment is ready for local capture');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pay/ })).toBeEnabled();
    });
    expect(loadStripe).not.toHaveBeenCalled();
  });
});

describe('PaymentHandoff Stripe mount recovery', () => {
  it('retries Stripe.js load failures without changing the client secret', async () => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_retry_load';
    const { stripe, paymentElement } = createReadyStripe();
    vi.mocked(loadStripe)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stripe as never);

    render(
      React.createElement(PaymentHandoff, {
        clientSecret: 'pi_live_cs_retry_secret',
        currency: 'USD',
        totalCents: 2500,
        returnUrl: 'http://localhost:3000/checkout/confirmation?sessionId=cs_retry',
        onError: () => {},
      }),
    );

    await screen.findByText('Payment unavailable');
    expect(
      screen.getByText('Payment processor could not be loaded. Please try again.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /Pay/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry payment form' }));

    await waitFor(() => expect(loadStripe).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay/ })).toBeEnabled());
    expect(stripe.elements).toHaveBeenCalledWith({
      appearance: { theme: 'stripe' },
      clientSecret: 'pi_live_cs_retry_secret',
    });
    expect(paymentElement.mount).toHaveBeenCalledTimes(1);
  });

  it('retries payment element mount failures in place', async () => {
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = 'pk_test_retry_mount';
    const throwingPaymentElement = {
      mount: vi.fn(() => {
        throw new Error('Stripe element failed to mount');
      }),
      unmount: vi.fn(),
      on: vi.fn(),
    };
    const throwingElements = {
      create: vi.fn(() => throwingPaymentElement),
      submit: vi.fn(async () => ({})),
    };
    const throwingStripe = {
      elements: vi.fn(() => throwingElements),
      confirmPayment: vi.fn(),
      retrievePaymentIntent: vi.fn(),
    };
    const { stripe, paymentElement } = createReadyStripe();
    vi.mocked(loadStripe)
      .mockResolvedValueOnce(throwingStripe as never)
      .mockResolvedValueOnce(stripe as never);

    render(
      React.createElement(PaymentHandoff, {
        clientSecret: 'pi_live_cs_mount_secret',
        currency: 'USD',
        totalCents: 2500,
        returnUrl: 'http://localhost:3000/checkout/confirmation?sessionId=cs_mount',
        onError: () => {},
      }),
    );

    await screen.findByText('Payment unavailable');
    expect(screen.getByText('Stripe element failed to mount')).toBeVisible();
    expect(screen.getByRole('button', { name: /Pay/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry payment form' }));

    await waitFor(() => expect(loadStripe).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay/ })).toBeEnabled());
    expect(stripe.elements).toHaveBeenCalledWith({
      appearance: { theme: 'stripe' },
      clientSecret: 'pi_live_cs_mount_secret',
    });
    expect(paymentElement.mount).toHaveBeenCalledTimes(1);
  });
});

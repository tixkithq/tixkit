import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { loadStripe } from '@stripe/stripe-js';
import React from 'react';
import { PaymentHandoff } from '@/components/checkout/payment-handoff';
import { RuntimeConfigProvider } from '@/context/runtime-config-provider';
import { resetBrowserRuntimeConfigForTests } from '@/lib/runtime-config-browser';

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: vi.fn(async () => null),
}));

const assignMock = vi.fn();
let paymentKeySequence = 0;

beforeEach(() => {
  assignMock.mockReset();
  assignMock.mockImplementation(() => undefined);
  // jsdom's location.assign is often non-configurable; replace the location object.
  const current = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ancestorOrigins: current.ancestorOrigins,
      hash: current.hash,
      host: current.host,
      hostname: current.hostname,
      href: current.href || 'http://localhost:3000/checkout',
      origin: current.origin || 'http://localhost:3000',
      pathname: current.pathname,
      port: current.port,
      protocol: current.protocol,
      search: current.search,
      assign: assignMock,
      reload: current.reload?.bind(current) ?? vi.fn(),
      replace: current.replace?.bind(current) ?? vi.fn(),
      toString: () => current.href || 'http://localhost:3000/checkout',
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadStripe).mockReset();
  vi.mocked(loadStripe).mockResolvedValue(null);
  resetBrowserRuntimeConfigForTests();
});

function renderPayment(
  key: string | undefined,
  props: React.ComponentProps<typeof PaymentHandoff>,
) {
  return render(
    <RuntimeConfigProvider
      config={{
        schemaVersion: '1',
        deploymentProfile: 'test',
        apiBaseUrl: 'http://localhost:4000',
        platformApiBaseUrl: 'http://localhost:4000/v1',
        checkoutUrl: 'http://localhost:3000',
        mediaOrigin: 'http://localhost:9000',
        ...(key ? { stripePublishableKey: key } : {}),
        buildRevision: 'test',
        configFingerprint: `sha256:${(key ?? 'none').padEnd(64, '0').slice(0, 64)}`,
      }}
    >
      <PaymentHandoff {...props} />
    </RuntimeConfigProvider>,
  );
}

function createReadyStripe(options?: {
  confirmPayment?: ReturnType<typeof vi.fn>;
  submit?: ReturnType<typeof vi.fn>;
  retrievePaymentIntent?: ReturnType<typeof vi.fn>;
}) {
  const paymentElement = {
    mount: vi.fn(),
    unmount: vi.fn(),
    on: vi.fn((event: string, callback: () => void) => {
      if (event === 'ready') setTimeout(callback, 0);
    }),
  };
  const elements = {
    create: vi.fn(() => paymentElement),
    submit: options?.submit ?? vi.fn(async () => ({})),
  };
  const stripe = {
    elements: vi.fn(() => elements),
    confirmPayment: options?.confirmPayment ?? vi.fn(async () => ({ paymentIntent: null })),
    retrievePaymentIntent:
      options?.retrievePaymentIntent ?? vi.fn(async () => ({ paymentIntent: null })),
  };
  return { stripe, elements, paymentElement };
}

async function mountReadyPayment(
  stripe: ReturnType<typeof createReadyStripe>['stripe'],
  props: Partial<React.ComponentProps<typeof PaymentHandoff>> = {},
) {
  const onError = vi.fn();
  // Unique publishable key per mount so PaymentHandoff's module-level Stripe
  // cache cannot leak confirmPayment mocks across tests.
  const publishableKey = `pk_test_pay_${++paymentKeySequence}`;
  vi.mocked(loadStripe).mockResolvedValue(stripe as never);
  renderPayment(publishableKey, {
    clientSecret: 'pi_live_cs_pay_secret',
    currency: 'USD',
    totalCents: 2500,
    returnUrl: 'http://localhost:3000/checkout/confirmation?sessionId=cs_pay',
    onError,
    ...props,
  });
  await waitFor(() => expect(screen.getByRole('button', { name: /Pay \$25\.00/ })).toBeEnabled());
  expect(loadStripe).toHaveBeenCalledWith(publishableKey);
  return { onError, publishableKey };
}

describe('PaymentHandoff local capture mode', () => {
  it('does not load Stripe.js for synthetic local capture client secrets', async () => {
    renderPayment('pk_test_present', {
      clientSecret: 'pi_capture_cs_1_secret',
      currency: 'USD',
      totalCents: 2500,
      returnUrl: 'http://localhost:3000/checkout/complete',
      onError: () => {},
    });

    await screen.findByText('Payment is ready for local capture');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pay/ })).toBeEnabled();
    });
    expect(loadStripe).not.toHaveBeenCalled();
  });
});

describe('PaymentHandoff Stripe mount recovery', () => {
  it('retries Stripe.js load failures without changing the client secret', async () => {
    const { stripe, paymentElement } = createReadyStripe();
    vi.mocked(loadStripe)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(stripe as never);

    renderPayment('pk_test_retry_load', {
      clientSecret: 'pi_live_cs_retry_secret',
      currency: 'USD',
      totalCents: 2500,
      returnUrl: 'http://localhost:3000/checkout/confirmation?sessionId=cs_retry',
      onError: () => {},
    });

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

    renderPayment('pk_test_retry_mount', {
      clientSecret: 'pi_live_cs_mount_secret',
      currency: 'USD',
      totalCents: 2500,
      returnUrl: 'http://localhost:3000/checkout/confirmation?sessionId=cs_mount',
      onError: () => {},
    });

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

describe('PaymentHandoff Stripe authentication outcomes', () => {
  it('surfaces card authentication decline without redirecting as succeeded', async () => {
    const confirmPayment = vi.fn(async () => ({
      error: {
        type: 'card_error',
        code: 'card_declined',
        message: 'Your card was declined.',
      },
    }));
    const { stripe } = createReadyStripe({ confirmPayment });
    const { onError } = await mountReadyPayment(stripe);

    fireEvent.click(screen.getByRole('button', { name: /Pay \$25\.00/ }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Your card was declined.'));
    expect(confirmPayment).toHaveBeenCalledTimes(1);
    expect(assignMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: /Pay \$25\.00/ })).toBeEnabled());
  });

  it('redirects with processing status when Stripe reports processing (not succeeded)', async () => {
    const confirmPayment = vi.fn(async () => ({
      paymentIntent: {
        id: 'pi_processing_1',
        status: 'processing',
      },
    }));
    const { stripe } = createReadyStripe({ confirmPayment });
    await mountReadyPayment(stripe);

    fireEvent.click(screen.getByRole('button', { name: /Pay \$25\.00/ }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    const redirected = new URL(String(assignMock.mock.calls[0]![0]));
    expect(redirected.pathname).toBe('/checkout/confirmation');
    expect(redirected.searchParams.get('sessionId')).toBe('cs_pay');
    expect(redirected.searchParams.get('payment_intent')).toBe('pi_processing_1');
    expect(redirected.searchParams.get('redirect_status')).toBe('processing');
    expect(redirected.searchParams.get('redirect_status')).not.toBe('succeeded');
  });

  it('treats buyer cancellation as a failed redirect_status, never succeeded', async () => {
    const confirmPayment = vi.fn(async () => ({
      paymentIntent: {
        id: 'pi_canceled_1',
        status: 'canceled',
      },
    }));
    const { stripe } = createReadyStripe({ confirmPayment });
    await mountReadyPayment(stripe);

    fireEvent.click(screen.getByRole('button', { name: /Pay \$25\.00/ }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    const redirected = new URL(String(assignMock.mock.calls[0]![0]));
    expect(redirected.searchParams.get('payment_intent')).toBe('pi_canceled_1');
    expect(redirected.searchParams.get('redirect_status')).toBe('failed');
    expect(redirected.searchParams.get('redirect_status')).not.toBe('succeeded');
  });

  it('maps requires_payment_method after failed auth to failed, not succeeded', async () => {
    const confirmPayment = vi.fn(async () => ({
      paymentIntent: {
        id: 'pi_requires_method',
        status: 'requires_payment_method',
      },
    }));
    const { stripe } = createReadyStripe({ confirmPayment });
    await mountReadyPayment(stripe);

    fireEvent.click(screen.getByRole('button', { name: /Pay \$25\.00/ }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    const redirected = new URL(String(assignMock.mock.calls[0]![0]));
    expect(redirected.searchParams.get('redirect_status')).toBe('failed');
  });

  it('ignores duplicate Pay clicks while confirmation is in flight', async () => {
    let releaseConfirm!: (value: { paymentIntent: { id: string; status: string } }) => void;
    const confirmPayment = vi.fn(
      () =>
        new Promise<{ paymentIntent: { id: string; status: string } }>((resolve) => {
          releaseConfirm = resolve;
        }),
    );
    const { stripe } = createReadyStripe({ confirmPayment });
    await mountReadyPayment(stripe);

    const pay = screen.getByRole('button', { name: /Pay \$25\.00/ });
    fireEvent.click(pay);
    fireEvent.click(pay);
    fireEvent.click(pay);

    await waitFor(() => expect(confirmPayment).toHaveBeenCalledTimes(1));
    expect(pay).toBeDisabled();

    await act(async () => {
      releaseConfirm({
        paymentIntent: { id: 'pi_once', status: 'succeeded' },
      });
    });
    await waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    expect(confirmPayment).toHaveBeenCalledTimes(1);
  });

  it('surfaces element submit cancellation without calling confirmPayment', async () => {
    const submit = vi.fn(async () => ({
      error: { message: 'Payment details incomplete.' },
    }));
    const confirmPayment = vi.fn();
    const { stripe } = createReadyStripe({ submit, confirmPayment });
    const { onError } = await mountReadyPayment(stripe);

    fireEvent.click(screen.getByRole('button', { name: /Pay \$25\.00/ }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Payment details incomplete.'));
    expect(confirmPayment).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('retrieves the payment intent when confirmPayment omits it and maps status honestly', async () => {
    const confirmPayment = vi.fn(async () => ({ paymentIntent: undefined }));
    const retrievePaymentIntent = vi.fn(async () => ({
      paymentIntent: { id: 'pi_retrieved', status: 'requires_action' },
    }));
    const { stripe } = createReadyStripe({ confirmPayment, retrievePaymentIntent });
    await mountReadyPayment(stripe);

    fireEvent.click(screen.getByRole('button', { name: /Pay \$25\.00/ }));

    await waitFor(() =>
      expect(retrievePaymentIntent).toHaveBeenCalledWith('pi_live_cs_pay_secret'),
    );
    await waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    const redirected = new URL(String(assignMock.mock.calls[0]![0]));
    // requires_action is not a success; confirmation page must revalidate session.
    expect(redirected.searchParams.get('redirect_status')).toBe('failed');
    expect(redirected.searchParams.get('payment_intent')).toBe('pi_retrieved');
  });
});

describe('PaymentHandoff local capture is a harness-only path', () => {
  it('only forces succeeded redirect for the synthetic pi_capture_* secret shape', async () => {
    renderPayment('pk_test_local', {
      clientSecret: 'pi_capture_cs_local_secret',
      currency: 'USD',
      totalCents: 1200,
      returnUrl: 'http://localhost:3000/checkout/confirmation?sessionId=cs_local',
      onError: () => {},
    });

    await waitFor(() => expect(screen.getByRole('button', { name: /Pay \$12\.00/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Pay \$12\.00/ }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    const redirected = new URL(String(assignMock.mock.calls[0]![0]));
    expect(redirected.searchParams.get('redirect_status')).toBe('succeeded');
    expect(redirected.searchParams.get('payment_intent')).toBe('pi_capture_cs_local');
    // Live Stripe secrets must never take this branch (covered by auth suite above).
    expect(loadStripe).not.toHaveBeenCalled();
  });
});

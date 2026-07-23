import './test-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import CheckoutFlow from '@/app/checkout/checkout-flow';
import {
  publicApi,
  checkoutApi,
  CheckoutApiError,
  type AvailabilityItem,
  type PublicEvent,
} from '@/lib/api';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/lib/api', () => {
  let checkoutKeySequence = 0;
  let confirmKeySequence = 0;
  class CheckoutApiError extends Error {
    code: string;
    status: number;

    constructor(code: string, message: string, status = 500) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }

  return {
    publicApi: {
      getEvent: vi.fn(),
      getAvailability: vi.fn(),
      getCheckoutBootstrap: vi.fn(),
      getResaleListings: vi.fn(),
      getQuestions: vi.fn(),
      getOccurrences: vi.fn(),
      getBrand: vi.fn(),
    },
    checkoutApi: {
      createSession: vi.fn(),
      getSession: vi.fn(),
      exchangeHandoff: vi.fn(),
      confirmSession: vi.fn(),
    },
    CheckoutApiError,
    CURRENT_RESALE_TERMS_ACCEPTANCE: {
      accepted: true,
      termsVersion: '2026-07-16',
      settlementModel: 'organizer_managed',
      refundModel: 'manual_coordinated_resolution',
    },
    newCheckoutIdempotencyKey: () => `checkout_test_${++checkoutKeySequence}`,
    newConfirmIdempotencyKey: () => `confirm_test_${++confirmKeySequence}`,
    isRetryable: (error: unknown) =>
      error instanceof CheckoutApiError && (error.status === 0 || error.status >= 500),
    userFacingMessage: (error: unknown) =>
      error instanceof Error ? error.message : 'Checkout is temporarily unavailable.',
  };
});

type MockedCallable<TArgs extends unknown[], TResult> = ((...args: TArgs) => TResult) & {
  mockResolvedValue(value: Awaited<TResult>): MockedCallable<TArgs, TResult>;
  mockResolvedValueOnce(value: Awaited<TResult>): MockedCallable<TArgs, TResult>;
  mockRejectedValue(value: unknown): MockedCallable<TArgs, TResult>;
  mockRejectedValueOnce(value: unknown): MockedCallable<TArgs, TResult>;
  mockImplementation(fn: (...args: TArgs) => TResult): MockedCallable<TArgs, TResult>;
  mock: { calls: TArgs[] };
};

const publicApiMock = publicApi as unknown as {
  getEvent: MockedCallable<
    Parameters<typeof publicApi.getEvent>,
    ReturnType<typeof publicApi.getEvent>
  >;
  getAvailability: MockedCallable<
    Parameters<typeof publicApi.getAvailability>,
    ReturnType<typeof publicApi.getAvailability>
  >;
  getCheckoutBootstrap: MockedCallable<
    Parameters<typeof publicApi.getCheckoutBootstrap>,
    ReturnType<typeof publicApi.getCheckoutBootstrap>
  >;
  getResaleListings: MockedCallable<
    Parameters<typeof publicApi.getResaleListings>,
    ReturnType<typeof publicApi.getResaleListings>
  >;
  getQuestions: MockedCallable<
    Parameters<typeof publicApi.getQuestions>,
    ReturnType<typeof publicApi.getQuestions>
  >;
  getOccurrences: MockedCallable<
    Parameters<typeof publicApi.getOccurrences>,
    ReturnType<typeof publicApi.getOccurrences>
  >;
  getBrand: MockedCallable<
    Parameters<typeof publicApi.getBrand>,
    ReturnType<typeof publicApi.getBrand>
  >;
};
const checkoutApiMock = checkoutApi as unknown as {
  createSession: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  exchangeHandoff: ReturnType<typeof vi.fn>;
  confirmSession: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const event: PublicEvent = {
  id: 'evt_checkout',
  title: 'All Access Chicago',
  status: 'published',
  timezone: 'America/Chicago',
  startsAt: '2026-07-17T19:00:00.000Z',
  brandId: 'brd_1',
};

const availability: AvailabilityItem[] = [
  {
    type: 'ticket',
    ticketTypeId: 'tt_general',
    name: 'General Admission',
    kind: 'paid',
    priceCents: 2500,
    currency: 'USD',
    minPerOrder: 1,
    maxPerOrder: 4,
    available: 12,
    status: 'active',
  },
];

function renderCheckoutFlow(props: Partial<React.ComponentProps<typeof CheckoutFlow>> = {}) {
  return render(
    React.createElement(CheckoutFlow, {
      initialEventId: 'evt_checkout',
      initialSessionId: '',
      initialSessionToken: '',
      ...props,
    }),
  );
}

function checkoutSession(
  id: string,
  overrides: Partial<{
    status: string;
    expiresAt: string;
    clientToken: string;
    totalCents: number;
  }> = {},
) {
  const totalCents = overrides.totalCents ?? 2500;
  return {
    id,
    eventId: event.id,
    status: overrides.status ?? 'open',
    currency: 'USD',
    clientToken: overrides.clientToken ?? `token_${id}`,
    quote: {
      subtotalCents: totalCents,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents,
    },
    // Default far in the future so confirm/pay tests are not blocked by live expiry.
    expiresAt: overrides.expiresAt ?? '2099-01-01T00:00:00.000Z',
  };
}

async function reachConfirmPhase(
  view: ReturnType<typeof renderCheckoutFlow>,
  session = checkoutSession('cs_hold', {
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
) {
  checkoutApiMock.createSession.mockResolvedValue(session);
  await view.findByText('General Admission');
  fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
  fireEvent.change(view.getByLabelText(/Email/), {
    target: { value: 'buyer@example.com' },
  });
  fireEvent.click(view.getByRole('button', { name: 'Continue' }));
  expect(await view.findByRole('button', { name: 'Pay $25.00' })).toBeVisible();
  return session;
}

async function reachPaymentPhase(
  view: ReturnType<typeof renderCheckoutFlow>,
  session = checkoutSession('cs_pay_hold', {
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
) {
  await reachConfirmPhase(view, session);
  checkoutApiMock.confirmSession.mockResolvedValue({
    status: 'pending_payment',
    sessionId: session.id,
    clientSecret: `pi_capture_${session.id}_secret`,
    currency: 'USD',
    totalCents: 2500,
  });
  fireEvent.click(view.getByRole('button', { name: 'Pay $25.00' }));
  expect(await view.findByText('Secure payment processed by Stripe').catch(() => null));
  // Local capture mode shows a different banner.
  await waitFor(() => {
    expect(
      view.getByText(/Secure payment processed by Stripe|Payment is ready for local capture/),
    ).toBeVisible();
  });
  return session;
}

function fillRequiredDatesOfBirth(view: ReturnType<typeof renderCheckoutFlow>) {
  for (const field of view.queryAllByLabelText(/Date of birth/)) {
    fireEvent.change(field, { target: { value: '1990-01-01' } });
  }
}

describe('CheckoutFlow buyer validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getAvailability.mockResolvedValue(availability);
    publicApiMock.getResaleListings.mockResolvedValue({ items: [] });
    publicApiMock.getQuestions.mockResolvedValue({
      buyerQuestions: [],
      attendeeQuestions: [],
    });
    publicApiMock.getOccurrences.mockResolvedValue([]);
    publicApiMock.getCheckoutBootstrap.mockImplementation(
      async (
        eventId: string,
        signal?: AbortSignal,
        input?: { products?: string; resaleListingId?: string },
      ) => {
        const [loadedEvent, loadedAvailability, questions, occurrences] = await Promise.all([
          publicApiMock.getEvent(eventId, signal),
          publicApiMock.getAvailability(eventId, signal, input?.products),
          publicApiMock.getQuestions(eventId, signal),
          publicApiMock.getOccurrences(eventId, signal),
        ]);
        let resaleListing = null;
        let cursor: string | undefined;
        // eslint-disable-next-line no-unmodified-loop-condition -- pagination continues until the requested listing is found or exhausted.
        while (input?.resaleListingId) {
          // eslint-disable-next-line no-await-in-loop -- each resale page depends on the previous cursor.
          const page = await publicApiMock.getResaleListings(
            eventId,
            signal,
            cursor ? { cursor } : undefined,
          );
          resaleListing =
            page.items.find((item: { id: string }) => item.id === input.resaleListingId) ?? null;
          if (resaleListing || !page.hasMore || !page.nextCursor) break;
          cursor = page.nextCursor;
        }
        return {
          event: loadedEvent,
          availability: loadedAvailability,
          questions,
          resaleListing,
          occurrences,
        };
      },
    );
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));
  });

  it('strips a fragment handoff before exchanging it from the client', async () => {
    window.history.replaceState(null, '', '/checkout?sessionId=cs_1#handoff=opaque_capability');
    checkoutApiMock.exchangeHandoff.mockResolvedValue({
      id: 'cs_1',
      eventId: 'evt_checkout',
      brandId: 'brd_1',
      status: 'open',
      currency: 'USD',
      quote: {
        totalCents: 2500,
        subtotalCents: 2500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
      },
      expiresAt: '2099-01-01T00:00:00.000Z',
      clientToken: 'scoped_session_credential',
    });

    renderCheckoutFlow({ initialEventId: '', initialSessionId: 'cs_1' });

    await waitFor(() => {
      expect(checkoutApiMock.exchangeHandoff).toHaveBeenCalledWith('cs_1', 'opaque_capability');
    });
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?sessionId=cs_1');
  });

  it('strips an unused fragment handoff when a stored session credential wins', async () => {
    window.sessionStorage.setItem('tk:session:cs_stored', 'stored_credential');
    window.history.replaceState(
      null,
      '',
      '/checkout?sessionId=cs_stored#handoff=unused_capability',
    );
    vi.mocked(checkoutApi.getSession).mockResolvedValue({
      id: 'cs_stored',
      eventId: 'evt_checkout',
      brandId: 'brd_1',
      status: 'open',
      currency: 'USD',
      quote: {
        totalCents: 2500,
        subtotalCents: 2500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
      },
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    renderCheckoutFlow({ initialEventId: '', initialSessionId: 'cs_stored' });

    await waitFor(() => {
      expect(checkoutApi.getSession).toHaveBeenCalledWith('cs_stored', 'stored_credential');
    });
    expect(checkoutApiMock.exchangeHandoff).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
    window.sessionStorage.removeItem('tk:session:cs_stored');
  });

  it('keeps Continue disabled until a ticket is selected', async () => {
    const view = renderCheckoutFlow();

    const continueButton = await view.findByRole('button', { name: 'Continue' });

    await waitFor(() => {
      expect(view.getByText('General Admission')).toBeInTheDocument();
    });
    expect(continueButton).toBeDisabled();
  });

  it('lets buyers submit a selected cart to reveal inline email errors', async () => {
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));

    const continueButton = view.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeEnabled();

    fireEvent.click(continueButton);

    expect(await view.findByText('Email is required to continue.')).toBeInTheDocument();
    expect(view.getByLabelText(/Email/)).toHaveAttribute('aria-describedby', 'email_feedback');
    expect(checkoutApiMock.createSession).not.toHaveBeenCalled();
  });

  it('blocks checkout with a retryable error when question metadata fails to load', async () => {
    publicApiMock.getCheckoutBootstrap.mockRejectedValueOnce(new Error('bootstrap unavailable'));
    publicApiMock.getQuestions
      .mockRejectedValueOnce(new Error('question metadata unavailable'))
      .mockResolvedValueOnce({
        buyerQuestions: [],
        attendeeQuestions: [],
      });
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    await view.findByText('Checkout fields unavailable');
    expect(view.getByText('question metadata unavailable')).toBeInTheDocument();
    expect(view.queryByLabelText(/Email/)).not.toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    expect(view.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(checkoutApiMock.createSession).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: 'Retry checkout fields' }));

    await waitFor(() => {
      expect(publicApiMock.getQuestions).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(view.queryByText('Checkout fields unavailable')).not.toBeInTheDocument();
    });
    expect(view.getByLabelText(/Email/)).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('directs buyers to the missing required checkbox question', async () => {
    publicApiMock.getQuestions.mockResolvedValue({
      buyerQuestions: [
        {
          id: 'q_ack',
          label: 'I agree to the photo policy',
          type: 'checkbox',
          required: true,
          appliesTo: 'buyer',
        },
      ],
      attendeeQuestions: [],
    });
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    await view.findByText('I agree to the photo policy');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(view.getByLabelText(/I agree to the photo policy/));
    fireEvent.click(view.getByLabelText(/I agree to the photo policy/));
    fillRequiredDatesOfBirth(view);
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    const feedback = await view.findAllByText('Please check I agree to the photo policy.');
    expect(feedback).toHaveLength(2);
    expect(view.getByLabelText(/I agree to the photo policy/)).toHaveAccessibleDescription(
      'Please check I agree to the photo policy.',
    );
    expect(
      view
        .getAllByRole('alert')
        .filter((alert) =>
          alert.textContent?.includes('Please check I agree to the photo policy.'),
        ),
    ).toHaveLength(1);
    expect(checkoutApiMock.createSession).not.toHaveBeenCalled();
  });

  it('directs buyers to the missing required multiselect question', async () => {
    publicApiMock.getQuestions.mockResolvedValue({
      buyerQuestions: [
        {
          id: 'q_interests',
          label: 'Interests',
          description: 'Select every topic you want updates for.',
          type: 'multiselect',
          required: true,
          appliesTo: 'buyer',
          options: ['Music', 'Food'],
        },
      ],
      attendeeQuestions: [],
    });
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    await view.findByRole('group', { name: /Interests/ });
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fillRequiredDatesOfBirth(view);
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    const message = 'Choose at least one option for Interests.';
    expect(await view.findAllByText(message)).toHaveLength(2);
    expect(view.getByRole('group', { name: /Interests/ })).toHaveAttribute('aria-invalid', 'true');
    expect(checkoutApiMock.createSession).not.toHaveBeenCalled();
  });

  it('blocks checkout before the API when a buyer email question has an invalid value', async () => {
    publicApiMock.getQuestions.mockResolvedValue({
      buyerQuestions: [
        {
          id: 'q_backup_email',
          label: 'Backup email',
          description: 'Used if your receipt bounces.',
          type: 'email',
          required: false,
          appliesTo: 'buyer',
        },
      ],
      attendeeQuestions: [],
    });
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    await view.findByLabelText('Backup email');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.change(view.getByLabelText('Backup email'), {
      target: { value: 'not-an-email' },
    });
    fillRequiredDatesOfBirth(view);
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    const message = 'Backup email must be a valid email.';
    expect(await view.findAllByText(message)).toHaveLength(2);
    expect(view.getByLabelText('Backup email')).toHaveAttribute('aria-invalid', 'true');
    expect(checkoutApiMock.createSession).not.toHaveBeenCalled();
  });

  it('blocks checkout before the API when a buyer question fails its validation pattern', async () => {
    publicApiMock.getQuestions.mockResolvedValue({
      buyerQuestions: [
        {
          id: 'q_member',
          label: 'Member ID',
          type: 'text',
          required: true,
          appliesTo: 'buyer',
          validationPattern: '^MEM-[0-9]{4}$',
        },
      ],
      attendeeQuestions: [],
    });
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    await view.findByText('Member ID');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.change(view.getByLabelText(/Member ID/), {
      target: { value: 'BAD' },
    });
    fillRequiredDatesOfBirth(view);
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    expect(await view.findAllByText('Member ID format is invalid.')).toHaveLength(2);
    expect(view.getByLabelText(/Member ID/)).toHaveAttribute('aria-invalid', 'true');
    expect(checkoutApiMock.createSession).not.toHaveBeenCalled();
  });

  it('blocks an underage ticket attendee before calling the checkout API', async () => {
    const restrictedEvent = { ...event, minimumAge: 21 };
    publicApiMock.getEvent.mockResolvedValue(restrictedEvent);
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    const dateFields = view.getAllByLabelText(/Date of birth/);
    fireEvent.change(dateFields[0]!, { target: { value: '1990-01-01' } });
    fireEvent.change(dateFields[1]!, { target: { value: '2010-01-01' } });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    expect(
      await view.findAllByText(/General Admission attendee 1: Attendees must be at least 21/),
    ).not.toHaveLength(0);
    expect(checkoutApiMock.createSession).not.toHaveBeenCalled();
  });

  it('omits an uncollected date of birth from unrestricted checkout sessions', async () => {
    checkoutApiMock.createSession.mockResolvedValue({
      id: 'cs_unrestricted',
      eventId: event.id,
      status: 'open',
      currency: 'USD',
      clientToken: 'token_unrestricted',
      quote: {
        subtotalCents: 2500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 2500,
      },
      expiresAt: '2026-07-17T18:10:00.000Z',
    });
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(checkoutApiMock.createSession).toHaveBeenCalledOnce());
    expect(checkoutApiMock.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        buyer: { email: 'buyer@example.com' },
      }),
      expect.any(String),
    );
  });

  it('reuses the exact create key and body after an ambiguous response and rotates after success', async () => {
    checkoutApiMock.createSession
      .mockRejectedValueOnce(new CheckoutApiError('NETWORK_ERROR', 'Response was lost.', 0))
      .mockResolvedValueOnce(checkoutSession('cs_replayed'))
      .mockResolvedValueOnce(checkoutSession('cs_after_success'));
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    expect(await view.findByText('Response was lost.')).toBeVisible();
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(checkoutApiMock.createSession).toHaveBeenCalledTimes(2));

    const [firstInput, firstKey] = checkoutApiMock.createSession.mock.calls[0]!;
    const [secondInput, secondKey] = checkoutApiMock.createSession.mock.calls[1]!;
    expect(secondInput).toEqual(firstInput);
    expect(secondKey).toBe(firstKey);

    fireEvent.click(await view.findByRole('button', { name: 'Edit order' }));
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(checkoutApiMock.createSession).toHaveBeenCalledTimes(3));
    expect(checkoutApiMock.createSession.mock.calls[2]![1]).not.toBe(firstKey);
  });

  it('keeps session creation single-flight during repeated activation', async () => {
    let releaseCreate!: (value: ReturnType<typeof checkoutSession>) => void;
    checkoutApiMock.createSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCreate = resolve;
        }),
    );
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    const continueButton = view.getByRole('button', { name: 'Continue' });
    fireEvent.click(continueButton);
    fireEvent.click(continueButton);

    expect(checkoutApiMock.createSession).toHaveBeenCalledTimes(1);
    releaseCreate(checkoutSession('cs_single_flight'));
    expect(await view.findByRole('button', { name: 'Pay $25.00' })).toBeVisible();
  });

  it('rotates the create key when the buyer changes the request after an ambiguous response', async () => {
    checkoutApiMock.createSession
      .mockRejectedValueOnce(new CheckoutApiError('NETWORK_ERROR', 'Response was lost.', 0))
      .mockResolvedValueOnce(checkoutSession('cs_changed'));
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'first@example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    expect(await view.findByText('Response was lost.')).toBeVisible();
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'changed@example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(checkoutApiMock.createSession).toHaveBeenCalledTimes(2));

    expect(checkoutApiMock.createSession.mock.calls[1]![0]).not.toEqual(
      checkoutApiMock.createSession.mock.calls[0]![0],
    );
    expect(checkoutApiMock.createSession.mock.calls[1]![1]).not.toBe(
      checkoutApiMock.createSession.mock.calls[0]![1],
    );
  });

  it('rotates the create key after a terminal malformed success response', async () => {
    checkoutApiMock.createSession
      .mockRejectedValueOnce(
        new CheckoutApiError('INVALID_RESPONSE', 'Malformed success response.', 200),
      )
      .mockResolvedValueOnce(checkoutSession('cs_after_malformed'));
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    expect(await view.findByText('Malformed success response.')).toBeVisible();
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(checkoutApiMock.createSession).toHaveBeenCalledTimes(2));

    expect(checkoutApiMock.createSession.mock.calls[1]![1]).not.toBe(
      checkoutApiMock.createSession.mock.calls[0]![1],
    );
  });

  it('rotates the create key when a successful response omits its session credential', async () => {
    checkoutApiMock.createSession
      .mockResolvedValueOnce({ ...checkoutSession('cs_missing_token'), clientToken: undefined })
      .mockResolvedValueOnce(checkoutSession('cs_after_missing_token'));
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    expect(await view.findByText('Checkout session token was not returned.')).toBeVisible();
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(checkoutApiMock.createSession).toHaveBeenCalledTimes(2));

    expect(checkoutApiMock.createSession.mock.calls[1]![1]).not.toBe(
      checkoutApiMock.createSession.mock.calls[0]![1],
    );
  });

  it('reuses one confirmation key until the session reaches a terminal response', async () => {
    checkoutApiMock.createSession.mockResolvedValue(checkoutSession('cs_confirm_replay'));
    checkoutApiMock.confirmSession
      .mockRejectedValueOnce(
        new CheckoutApiError('NETWORK_ERROR', 'Confirmation response lost.', 0),
      )
      .mockResolvedValueOnce({ clientSecret: 'pi_secret', currency: 'USD', totalCents: 2500 });
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    const payButton = await view.findByRole('button', { name: 'Pay $25.00' });
    fireEvent.click(payButton);
    expect(await view.findByText('Confirmation response lost.')).toBeVisible();
    fireEvent.click(view.getByRole('button', { name: 'Pay $25.00' }));
    await waitFor(() => expect(checkoutApiMock.confirmSession).toHaveBeenCalledTimes(2));

    expect(checkoutApiMock.confirmSession.mock.calls[1]).toEqual(
      checkoutApiMock.confirmSession.mock.calls[0],
    );
  });

  it('rotates the confirmation key after a terminal malformed success response', async () => {
    checkoutApiMock.createSession.mockResolvedValue(checkoutSession('cs_confirm_terminal'));
    checkoutApiMock.confirmSession
      .mockRejectedValueOnce(
        new CheckoutApiError('INVALID_RESPONSE', 'Malformed confirmation response.', 200),
      )
      .mockResolvedValueOnce({ clientSecret: 'pi_secret', currency: 'USD', totalCents: 2500 });
    const view = renderCheckoutFlow();

    await view.findByText('General Admission');
    fireEvent.click(view.getByRole('button', { name: 'Increase General Admission quantity' }));
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await view.findByRole('button', { name: 'Pay $25.00' }));
    expect(await view.findByText('Malformed confirmation response.')).toBeVisible();
    fireEvent.click(view.getByRole('button', { name: 'Pay $25.00' }));
    await waitFor(() => expect(checkoutApiMock.confirmSession).toHaveBeenCalledTimes(2));

    expect(checkoutApiMock.confirmSession.mock.calls[1]![2]).not.toBe(
      checkoutApiMock.confirmSession.mock.calls[0]![2],
    );
  });

  it('creates a resale checkout session for a selected public listing', async () => {
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getResaleListings.mockResolvedValue({
      items: [
        {
          id: 'lst_1',
          eventId: 'evt_checkout',
          ticketTypeId: 'tt_general',
          ticketTypeName: 'General Admission',
          status: 'listed',
          priceCents: 5500,
          currency: 'USD',
          faceValueCents: 5000,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    checkoutApiMock.createSession.mockResolvedValue({
      id: 'cs_1',
      eventId: 'evt_checkout',
      brandId: 'brd_1',
      status: 'open',
      currency: 'USD',
      clientToken: 'token_1',
      quote: {
        subtotalCents: 5500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 5500,
      },
      expiresAt: '2026-06-01T00:10:00.000Z',
    });
    const view = renderCheckoutFlow({ resaleListingId: 'lst_1' });

    expect(await view.findAllByText('Resale ticket - General Admission')).not.toHaveLength(0);
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fillRequiredDatesOfBirth(view);
    fireEvent.click(view.getByLabelText(/^Accept resale purchase terms/));
    await waitFor(() => expect(view.getByRole('button', { name: 'Continue' })).toBeEnabled());
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(checkoutApiMock.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_checkout',
          items: [{ resaleListingId: 'lst_1', quantity: 1 }],
          buyer: expect.objectContaining({ email: 'buyer@example.com' }),
          resaleTermsAcceptance: {
            accepted: true,
            termsVersion: '2026-07-16',
            settlementModel: 'organizer_managed',
            refundModel: 'manual_coordinated_resolution',
          },
          discountCode: undefined,
          accessCode: undefined,
          waitlistClaimToken: undefined,
        }),
        expect.any(String),
      );
    });
  });

  it('finds a direct resale listing beyond the first public listing page', async () => {
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getResaleListings
      .mockResolvedValueOnce({
        items: [
          {
            id: 'lst_1',
            eventId: 'evt_checkout',
            ticketTypeId: 'tt_general',
            ticketTypeName: 'General Admission',
            status: 'listed',
            priceCents: 5500,
            currency: 'USD',
            faceValueCents: 5000,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        ],
        nextCursor: 'lst_1',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'lst_51',
            eventId: 'evt_checkout',
            ticketTypeId: 'tt_vip',
            ticketTypeName: 'VIP',
            status: 'listed',
            priceCents: 7500,
            currency: 'USD',
            faceValueCents: 7000,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
        hasMore: false,
      });
    checkoutApiMock.createSession.mockResolvedValue({
      id: 'cs_1',
      eventId: 'evt_checkout',
      brandId: 'brd_1',
      status: 'open',
      currency: 'USD',
      clientToken: 'token_1',
      quote: {
        subtotalCents: 7500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 7500,
      },
      expiresAt: '2026-06-01T00:10:00.000Z',
    });
    const view = renderCheckoutFlow({ resaleListingId: 'lst_51' });

    expect(await view.findAllByText('Resale ticket - VIP')).not.toHaveLength(0);
    expect(publicApiMock.getResaleListings).toHaveBeenCalledTimes(2);
    expect(publicApiMock.getResaleListings.mock.calls[0][2]).toBeUndefined();
    expect(publicApiMock.getResaleListings.mock.calls[1][2]).toEqual({ cursor: 'lst_1' });
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fillRequiredDatesOfBirth(view);
    fireEvent.click(view.getByLabelText(/^Accept resale purchase terms/));
    await waitFor(() => expect(view.getByRole('button', { name: 'Continue' })).toBeEnabled());
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(checkoutApiMock.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_checkout',
          items: [{ resaleListingId: 'lst_51', quantity: 1 }],
          buyer: expect.objectContaining({ email: 'buyer@example.com' }),
        }),
        expect.any(String),
      );
    });
  });

  it('uses the ticket occurrence date for resale age eligibility', async () => {
    publicApiMock.getEvent.mockResolvedValue({ ...event, minimumAge: 21 });
    publicApiMock.getAvailability.mockResolvedValue([]);
    publicApiMock.getOccurrences.mockResolvedValue([
      {
        id: 'occ_next_day',
        eventId: event.id,
        title: 'Next-day show',
        startsAt: '2026-07-18T19:00:00.000Z',
        timezone: 'America/Chicago',
        sortOrder: 0,
        status: 'scheduled',
      },
    ]);
    publicApiMock.getResaleListings.mockResolvedValue({
      items: [
        {
          id: 'lst_occurrence',
          eventId: event.id,
          eventOccurrenceId: 'occ_next_day',
          status: 'listed',
          priceCents: 5500,
          currency: 'USD',
          faceValueCents: 5000,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
    });
    checkoutApiMock.createSession.mockResolvedValue({
      id: 'cs_occurrence',
      eventId: event.id,
      status: 'open',
      currency: 'USD',
      clientToken: 'token_occurrence',
      quote: {
        subtotalCents: 5500,
        discountCents: 0,
        taxCents: 0,
        feeCents: 0,
        totalCents: 5500,
      },
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const view = renderCheckoutFlow({ resaleListingId: 'lst_occurrence' });

    expect(await view.findAllByText('Resale ticket')).not.toHaveLength(0);
    fireEvent.change(view.getByLabelText(/Email/), {
      target: { value: 'buyer@example.com' },
    });
    fireEvent.change(view.getByLabelText(/Date of birth/), {
      target: { value: '2005-07-18' },
    });
    fireEvent.click(view.getByLabelText(/^Accept resale purchase terms/));
    await waitFor(() => expect(view.getByRole('button', { name: 'Continue' })).toBeEnabled());
    fireEvent.click(view.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(checkoutApiMock.createSession).toHaveBeenCalledOnce());
  });
});

describe('CheckoutFlow live session expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicApiMock.getEvent.mockResolvedValue(event);
    publicApiMock.getAvailability.mockResolvedValue(availability);
    publicApiMock.getResaleListings.mockResolvedValue({ items: [] });
    publicApiMock.getQuestions.mockResolvedValue({
      buyerQuestions: [],
      attendeeQuestions: [],
    });
    publicApiMock.getOccurrences.mockResolvedValue([]);
    publicApiMock.getCheckoutBootstrap.mockImplementation(
      async (
        eventId: string,
        signal?: AbortSignal,
        input?: { products?: string; resaleListingId?: string },
      ) => {
        const [loadedEvent, loadedAvailability, questions, occurrences] = await Promise.all([
          publicApiMock.getEvent(eventId, signal),
          publicApiMock.getAvailability(eventId, signal, input?.products),
          publicApiMock.getQuestions(eventId, signal),
          publicApiMock.getOccurrences(eventId, signal),
        ]);
        return {
          event: loadedEvent,
          availability: loadedAvailability,
          questions,
          resaleListing: null,
          occurrences,
        };
      },
    );
    publicApiMock.getBrand.mockRejectedValue(new Error('brand unavailable'));
    checkoutApiMock.getSession.mockReset();
    checkoutApiMock.confirmSession.mockReset();
    checkoutApiMock.createSession.mockReset();
  });

  it('revalidates when the hold timer elapses while reviewing the order', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = new Date(Date.now() + 5_000).toISOString();
    const session = checkoutSession('cs_review_timer', { expiresAt });
    checkoutApiMock.getSession.mockResolvedValue({
      ...session,
      status: 'open',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });

    const view = renderCheckoutFlow();
    await reachConfirmPhase(view, session);

    await vi.advanceTimersByTimeAsync(5_100);
    await waitFor(() => expect(checkoutApiMock.getSession).toHaveBeenCalledWith(session.id, `token_${session.id}`));
    expect(view.getByRole('button', { name: 'Pay $25.00' })).toBeEnabled();
    expect(view.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('revalidates when the hold timer elapses during payment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = new Date(Date.now() + 5_000).toISOString();
    const session = checkoutSession('cs_pay_timer', { expiresAt });
    checkoutApiMock.getSession.mockResolvedValue({
      ...session,
      status: 'open',
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });

    const view = renderCheckoutFlow();
    await reachPaymentPhase(view, session);

    await vi.advanceTimersByTimeAsync(5_100);
    await waitFor(() => expect(checkoutApiMock.getSession).toHaveBeenCalledWith(session.id, `token_${session.id}`));
    await waitFor(() => {
      expect(
        view.getByText(/Secure payment processed by Stripe|Payment is ready for local capture/),
      ).toBeVisible();
    });
  });

  it('keeps checkout open when the server says the session is still valid after local expiry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = new Date(Date.now() + 2_000).toISOString();
    const session = checkoutSession('cs_still_valid', { expiresAt });
    const extendedExpiresAt = new Date(Date.now() + 300_000).toISOString();
    checkoutApiMock.getSession.mockResolvedValue({
      ...session,
      status: 'open',
      expiresAt: extendedExpiresAt,
    });

    const view = renderCheckoutFlow();
    await reachConfirmPhase(view, session);
    await vi.advanceTimersByTimeAsync(2_100);

    await waitFor(() => expect(checkoutApiMock.getSession).toHaveBeenCalledTimes(1));
    expect(view.getByRole('button', { name: 'Pay $25.00' })).toBeEnabled();
    expect(view.queryByText('Checkout expired')).not.toBeInTheDocument();
    // Server-confirmed hold must not spin a revalidation loop on the old clock.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(checkoutApiMock.getSession).toHaveBeenCalledTimes(1);
  });

  it('shows an expired state with restart when the server confirms expiration', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = new Date(Date.now() + 2_000).toISOString();
    const session = checkoutSession('cs_server_expired', { expiresAt });
    checkoutApiMock.getSession.mockResolvedValue({
      ...session,
      status: 'expired',
    });

    const view = renderCheckoutFlow();
    await reachConfirmPhase(view, session);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(await view.findByText('Checkout expired')).toBeVisible();
    expect(
      view.getByText(/Your checkout session expired\. Start a new order to reserve tickets again\./),
    ).toBeVisible();
    const restart = view.getByRole('button', { name: 'Start new order' });
    expect(restart).toBeVisible();
    expect(view.getByRole('button', { name: 'Pay $25.00' })).toBeDisabled();

    fireEvent.click(restart);
    expect(await view.findByRole('button', { name: 'Continue' })).toBeVisible();
    expect(view.queryByText('Checkout expired')).not.toBeInTheDocument();
  });

  it('fails closed on offline revalidation and recovers after retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = new Date(Date.now() + 2_000).toISOString();
    const session = checkoutSession('cs_offline', { expiresAt });
    checkoutApiMock.getSession
      .mockRejectedValueOnce(new CheckoutApiError('NETWORK_ERROR', 'offline', 0))
      .mockResolvedValueOnce({
        ...session,
        status: 'open',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });

    const view = renderCheckoutFlow();
    await reachConfirmPhase(view, session);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(await view.findByText('Reservation could not be verified')).toBeVisible();
    expect(
      view.getByText(/Payment is paused until the reservation is revalidated/),
    ).toBeVisible();
    expect(view.getByRole('button', { name: 'Pay $25.00' })).toBeDisabled();

    fireEvent.click(view.getByRole('button', { name: 'Retry reservation check' }));
    await waitFor(() => expect(checkoutApiMock.getSession).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Pay $25.00' })).toBeEnabled();
    });
    expect(view.queryByText('Reservation could not be verified')).not.toBeInTheDocument();
  });

  it('does not submit payment after the hold has expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = new Date(Date.now() + 2_000).toISOString();
    const session = checkoutSession('cs_no_submit', { expiresAt });
    checkoutApiMock.getSession.mockResolvedValue({
      ...session,
      status: 'expired',
    });

    const view = renderCheckoutFlow();
    await reachConfirmPhase(view, session);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await view.findByText('Checkout expired')).toBeVisible();

    fireEvent.click(view.getByRole('button', { name: 'Pay $25.00' }));
    expect(checkoutApiMock.confirmSession).not.toHaveBeenCalled();
  });

  it('cleans up the expiry timer on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const expiresAt = new Date(Date.now() + 30_000).toISOString();
    const session = checkoutSession('cs_unmount', { expiresAt });

    const view = renderCheckoutFlow();
    await reachConfirmPhase(view, session);
    const clearedBefore = clearTimeoutSpy.mock.calls.length;
    view.unmount();
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearedBefore);
    clearTimeoutSpy.mockRestore();
  });

  it('fails safely on malformed expiresAt by revalidating before submit', async () => {
    const session = checkoutSession('cs_bad_expiry', { expiresAt: 'not-a-date' });
    checkoutApiMock.getSession.mockResolvedValue({
      ...session,
      status: 'open',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });

    const view = renderCheckoutFlow();
    await reachConfirmPhase(view, session);

    await waitFor(() => expect(checkoutApiMock.getSession).toHaveBeenCalled());
    // While checking / until server confirms, Pay must not confirm.
    expect(checkoutApiMock.confirmSession).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(view.getByRole('button', { name: 'Pay $25.00' })).toBeEnabled();
    });
  });

  it('treats CHECKOUT_EXPIRED from revalidation as an expired hold', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiresAt = new Date(Date.now() + 2_000).toISOString();
    const session = checkoutSession('cs_code_expired', { expiresAt });
    checkoutApiMock.getSession.mockRejectedValue(
      new CheckoutApiError('CHECKOUT_EXPIRED', 'Your checkout session expired. Please start a new order.', 410),
    );

    const view = renderCheckoutFlow();
    await reachConfirmPhase(view, session);
    await vi.advanceTimersByTimeAsync(2_100);

    expect(await view.findByText('Checkout expired')).toBeVisible();
    expect(view.getByRole('button', { name: 'Start new order' })).toBeVisible();
    expect(view.getByRole('button', { name: 'Pay $25.00' })).toBeDisabled();
  });
});

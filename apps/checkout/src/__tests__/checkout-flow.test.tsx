import './test-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import CheckoutFlow from '@/app/checkout/checkout-flow';
import { publicApi, checkoutApi, type AvailabilityItem, type PublicEvent } from '@/lib/api';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('@/lib/api', () => {
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
  exchangeHandoff: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  cleanup();
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
      expiresAt: '2026-07-17T20:00:00.000Z',
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
      expiresAt: '2026-07-17T20:00:00.000Z',
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
      expiresAt: '2026-07-09T22:00:00.000Z',
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

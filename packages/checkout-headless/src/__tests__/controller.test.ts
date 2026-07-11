import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CheckoutController,
  CheckoutHeadlessError,
  createFetchCheckoutTransport,
  createMemoryCheckoutStorage,
  type CheckoutTransport,
} from '../index.js';

const rawSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'cs_1',
  eventId: 'evt_1',
  status: 'open',
  currency: 'USD',
  clientToken: 'secret_session_token',
  quote: { totalCents: 0, subtotalCents: 0, discountCents: 0, taxCents: 0, feeCents: 0 },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
});

const ticket = (overrides: Record<string, unknown> = {}) => ({
  type: 'ticket' as const,
  ticketTypeId: 'tt_1',
  name: 'General',
  kind: 'free' as const,
  priceCents: 0,
  currency: 'USD',
  minPerOrder: 1,
  maxPerOrder: 4,
  available: 20,
  status: 'active',
  ...overrides,
});

function transport(overrides: Partial<CheckoutTransport> = {}): CheckoutTransport {
  return {
    bootstrap: vi.fn().mockResolvedValue({
      event: { id: 'evt_1' },
      availability: [ticket()],
      questions: { buyerQuestions: [], attendeeQuestions: [] },
    }),
    availability: vi.fn().mockResolvedValue([ticket()]),
    validateAccessCode: vi.fn().mockResolvedValue({ valid: true, ticketTypeIds: ['tt_locked'] }),
    joinWaitlist: vi.fn().mockResolvedValue({ id: 'wl_1' }),
    createSession: vi.fn().mockResolvedValue(rawSession()),
    getSession: vi.fn().mockResolvedValue(rawSession()),
    confirmSession: vi.fn().mockResolvedValue({
      order: { id: 'ord_1' },
      sessionId: 'cs_1',
      status: 'completed',
    }),
    createHostedHandoff: vi.fn().mockResolvedValue({
      url: 'https://checkout.tixkit.example/checkout?sessionId=cs_1#handoff=signed',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    ...overrides,
  };
}

function fill(controller: CheckoutController): void {
  controller.setCartItem({ type: 'ticket', ticketTypeId: 'tt_1', quantity: 1 });
  controller.setBuyer({
    email: 'buyer@example.test',
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '',
  });
}

afterEach(() => vi.useRealTimers());

describe('CheckoutController', () => {
  it('bootstraps and refreshes authoritative availability', async () => {
    const api = transport();
    const controller = new CheckoutController({ eventId: 'evt_1', transport: api });
    const phases: string[] = [];
    controller.subscribe((state) => phases.push(state.phase));
    await controller.bootstrap();
    expect(phases).toEqual(['idle', 'loading', 'selecting']);
    await controller.refreshAvailability();
    expect(api.availability).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('validates the exact access-code contract and refreshes revealed IDs', async () => {
    const api = transport();
    const controller = new CheckoutController({ eventId: 'evt_1', transport: api });
    expect(await controller.applyAccessCode(' vip ', ['tt_locked'], 'buyer@example.test')).toEqual([
      'tt_locked',
    ]);
    expect(api.validateAccessCode).toHaveBeenCalledWith(
      'evt_1',
      {
        ticketTypeIds: ['tt_locked'],
        accessCode: 'VIP',
        buyerEmail: 'buyer@example.test',
      },
      expect.any(AbortSignal),
    );
    expect(api.availability).toHaveBeenCalledWith('evt_1', {
      products: ['tt_locked'],
      signal: expect.any(AbortSignal),
    });
    expect(controller.getState().revealedTicketTypeIds).toEqual(['tt_locked']);
    controller.destroy();
  });

  it('keeps occurrence-specific tickets and rejects invalid cart shapes and price overrides', async () => {
    const controller = new CheckoutController({ eventId: 'evt_1', transport: transport() });
    controller.setCartItem({
      type: 'ticket',
      ticketTypeId: 'tt_1',
      occurrenceId: 'occ_1',
      quantity: 1,
    });
    controller.setCartItem({
      type: 'ticket',
      ticketTypeId: 'tt_1',
      occurrenceId: 'occ_2',
      quantity: 2,
    });
    expect(controller.getState().cart).toHaveLength(2);
    expect(() =>
      controller.setCartItem({
        type: 'ticket',
        ticketTypeId: 'tt_1',
        quantity: 1,
        donationAmountCents: 100,
      }),
    ).toThrow('setDonation');
    expect(() =>
      controller.setCartItem({ type: 'resale', resaleListingId: 'lst_1', quantity: 2 as 1 }),
    ).toThrow('Resale quantity');
    controller.destroy();
  });

  it('allows client amounts only for authoritative donation ticket types', async () => {
    const api = transport({
      bootstrap: vi.fn().mockResolvedValue({
        event: { id: 'evt_1' },
        availability: [ticket({ ticketTypeId: 'tt_donation', kind: 'donation' })],
        questions: { buyerQuestions: [], attendeeQuestions: [] },
      }),
    });
    const controller = new CheckoutController({ eventId: 'evt_1', transport: api });
    await controller.bootstrap();
    controller.setDonation({ ticketTypeId: 'tt_donation', quantity: 1 }, 2500);
    expect(controller.getState().cart[0]).toMatchObject({ donationAmountCents: 2500 });
    expect(() => controller.setDonation({ ticketTypeId: 'tt_regular', quantity: 1 }, 100)).toThrow(
      'donation ticket types',
    );
    controller.destroy();
  });

  it('validates required typed buyer and per-attendee answers', async () => {
    const api = transport({
      bootstrap: vi.fn().mockResolvedValue({
        event: { id: 'evt_1' },
        availability: [ticket()],
        questions: {
          buyerQuestions: [
            { id: 'terms', label: 'Terms', type: 'checkbox', required: true, appliesTo: 'buyer' },
          ],
          attendeeQuestions: [
            {
              id: 'name',
              label: 'Name',
              type: 'text',
              required: true,
              appliesTo: 'attendee',
              ticketTypeId: 'tt_1',
            },
          ],
        },
      }),
    });
    const controller = new CheckoutController({ eventId: 'evt_1', transport: api });
    await controller.bootstrap();
    fill(controller);
    expect(controller.validateDetails().map((issue) => issue.path)).toEqual([
      'answers.terms',
      'cart.0.attendeeFields.0.name',
    ]);
    controller.setAnswers({ terms: true });
    controller.setCartItem({
      type: 'ticket',
      ticketTypeId: 'tt_1',
      quantity: 1,
      attendeeFields: [{ name: 'Grace' }],
    });
    expect(controller.validateDetails()).toEqual([]);
    controller.destroy();
  });

  it('rejects invalid supplied optional answers while allowing omitted optional answers', async () => {
    const api = transport({
      bootstrap: vi.fn().mockResolvedValue({
        event: { id: 'evt_1' },
        availability: [ticket()],
        questions: {
          buyerQuestions: [
            {
              id: 'q_email',
              label: 'Alternative email',
              type: 'email',
              required: false,
              appliesTo: 'buyer',
            },
          ],
          attendeeQuestions: [
            {
              id: 'q_size',
              label: 'Shirt size',
              type: 'select',
              options: ['S', 'M'],
              required: false,
              appliesTo: 'attendee',
            },
          ],
        },
      }),
    });
    const controller = new CheckoutController({ eventId: 'evt_1', transport: api });
    await controller.bootstrap();
    fill(controller);
    expect(controller.validateDetails()).toEqual([]);
    controller.setAnswers({ q_email: 'not-an-email' });
    controller.setCartItem({
      type: 'ticket',
      ticketTypeId: 'tt_1',
      quantity: 1,
      attendeeFields: [{ q_size: 'XL' }],
    });
    expect(controller.validateDetails().map((issue) => issue.path)).toEqual([
      'answers.q_email',
      'cart.0.attendeeFields.0.q_size',
    ]);
    controller.destroy();
  });

  it('creates and completes free checkout without publishing session credentials', async () => {
    const storage = createMemoryCheckoutStorage();
    const controller = new CheckoutController({
      eventId: 'evt_1',
      transport: transport(),
      storage,
    });
    fill(controller);
    const session = await controller.createSession({
      successUrl: 'https://merchant.example/success',
    });
    expect(session).toEqual(expect.not.objectContaining({ clientToken: expect.anything() }));
    expect(JSON.stringify(controller.getState())).not.toContain('secret_session_token');
    const outcome = await controller.confirm();
    expect(outcome).toEqual({
      type: 'completed',
      confirmation: { orderId: 'ord_1', sessionId: 'cs_1', status: 'completed' },
    });
    expect(await storage.get('tixkit:checkout:evt_1')).toBeNull();
    controller.destroy();
  });

  it('allowlists paid handoff output and never returns provider secrets or session tokens', async () => {
    const api = transport({
      confirmSession: vi.fn().mockResolvedValue({
        sessionId: 'cs_1',
        status: 'pending_payment',
        paymentIntentId: 'pi_1',
        clientSecret: 'pi_secret_forbidden',
        internalProviderField: 'forbidden',
        totalCents: 5000,
        currency: 'USD',
      }),
    });
    const controller = new CheckoutController({
      eventId: 'evt_1',
      transport: api,
    });
    fill(controller);
    await controller.createSession();
    const outcome = await controller.confirm();
    expect(api.createHostedHandoff).toHaveBeenCalledWith(
      'cs_1',
      'secret_session_token',
      expect.any(AbortSignal),
    );
    expect(outcome).toMatchObject({
      type: 'hosted-payment',
      handoff: {
        mode: 'hosted',
        paymentIntentId: 'pi_1',
        totalCents: 5000,
        expiresAt: expect.any(String),
      },
    });
    expect(JSON.stringify(outcome)).not.toMatch(
      /clientSecret|clientToken|internalProviderField|secret_/u,
    );
    expect(JSON.stringify(controller.getState())).not.toMatch(/clientSecret|clientToken|secret_/u);
    controller.destroy();
  });

  it('persists and reuses create idempotency keys after lost responses', async () => {
    const storage = createMemoryCheckoutStorage();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new CheckoutHeadlessError('NETWORK_ERROR', 'lost', true))
      .mockResolvedValue(rawSession());
    const api = transport({ createSession: create });
    const first = new CheckoutController({ eventId: 'evt_1', transport: api, storage });
    fill(first);
    await first.createSession();
    first.destroy();
    const second = new CheckoutController({ eventId: 'evt_1', transport: api, storage });
    fill(second);
    await second.createSession();
    expect(create.mock.calls[0]?.[1]).toBe(create.mock.calls[1]?.[1]);
    second.destroy();
  });

  it('reuses confirm idempotency keys after unknown outcomes', async () => {
    const confirm = vi
      .fn()
      .mockRejectedValueOnce(new CheckoutHeadlessError('NETWORK_ERROR', 'lost', true))
      .mockResolvedValue({ order: { id: 'ord_1' }, sessionId: 'cs_1', status: 'completed' });
    const controller = new CheckoutController({
      eventId: 'evt_1',
      transport: transport({ confirmSession: confirm }),
      storage: createMemoryCheckoutStorage(),
    });
    fill(controller);
    await controller.createSession();
    await controller.confirm();
    await controller.confirm();
    expect(confirm.mock.calls[0]?.[2]).toBe(confirm.mock.calls[1]?.[2]);
    controller.destroy();
  });

  it('composes external cancellation and ignores stale transports that resolve after abort', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<CheckoutTransport['bootstrap']>>) => void;
    const first = new Promise<Awaited<ReturnType<CheckoutTransport['bootstrap']>>>((resolve) => {
      resolveFirst = resolve;
    });
    const api = transport({
      bootstrap: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce({
          event: { id: 'evt_1', title: 'new' },
          availability: [ticket({ ticketTypeId: 'tt_new' })],
          questions: { buyerQuestions: [], attendeeQuestions: [] },
        }),
    });
    const controller = new CheckoutController({ eventId: 'evt_1', transport: api });
    const external = new AbortController();
    const stale = controller.bootstrap(external.signal);
    external.abort();
    await controller.bootstrap();
    resolveFirst({
      event: { id: 'evt_1', title: 'old' },
      availability: [ticket({ ticketTypeId: 'tt_old' })],
      questions: { buyerQuestions: [], attendeeQuestions: [] },
    });
    await stale;
    expect(controller.getState().availability[0]?.ticketTypeId).toBe('tt_new');
    controller.destroy();
  });

  it('resumes privately, expires, polls, and cancels', async () => {
    const storage = createMemoryCheckoutStorage();
    const api = transport();
    const first = new CheckoutController({ eventId: 'evt_1', transport: api, storage });
    fill(first);
    await first.createSession();
    first.destroy();
    const resumed = new CheckoutController({ eventId: 'evt_1', transport: api, storage });
    await resumed.resume();
    expect(JSON.stringify(resumed.getState())).not.toContain('secret_session_token');
    resumed.destroy();

    const expired = new CheckoutController({
      eventId: 'evt_1',
      transport: transport({
        getSession: vi.fn().mockResolvedValue(rawSession({ expiresAt: '2020-01-01T00:00:00Z' })),
      }),
    });
    await expired.resume({ sessionId: 'cs_old', clientToken: 'private' });
    expect(expired.getState().phase).toBe('expired');
    expired.destroy();
  });

  it('rejects unsafe redirects and redacts backend error text', async () => {
    const controller = new CheckoutController({
      eventId: 'evt_1',
      transport: transport({
        createSession: vi
          .fn()
          .mockRejectedValue(
            new CheckoutHeadlessError('DB_SECRET', 'buyer@example.test password=secret', false),
          ),
      }),
    });
    fill(controller);
    await controller.createSession({ successUrl: 'javascript:alert(1)' });
    expect(controller.getState().error?.code).toBe('invalid_redirect');
    await controller.createSession();
    expect(controller.getState().error).toEqual({
      code: 'DB_SECRET',
      message: 'Checkout could not continue.',
      retryable: false,
    });
    expect(JSON.stringify(controller.getState().error)).not.toMatch(
      /buyer@example|password=secret/u,
    );
    controller.destroy();
  });
});

describe('createFetchCheckoutTransport', () => {
  it('matches access-code, product reveal, token, and idempotency contracts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => rawSession() });
    const api = createFetchCheckoutTransport({
      apiBaseUrl: 'https://api.example.test/v1/',
      fetch: fetchMock,
    });
    const signal = new AbortController().signal;
    await api.validateAccessCode(
      'evt_1',
      { ticketTypeIds: ['tt_locked'], accessCode: 'VIP', buyerEmail: 'a@b.co' },
      signal,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/v1/public/events/evt_1/access-code',
    );
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      ticketTypeIds: ['tt_locked'],
      accessCode: 'VIP',
      buyerEmail: 'a@b.co',
    });
    await api.availability('evt_1', { products: ['tt_locked'], signal });
    expect(fetchMock.mock.calls[1]?.[0]).toContain('availability?products=tt_locked');
    await api.createSession(
      {
        eventId: 'evt_1',
        items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
        buyer: { email: 'a@b.co', firstName: 'A', lastName: 'B', phone: '' },
      },
      'idem_1',
      signal,
    );
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({ 'Idempotency-Key': 'idem_1' });
    await api.createHostedHandoff('cs_1', 'session_token', signal);
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      'https://api.example.test/v1/checkout/sessions/cs_1/handoff',
    );
    expect(fetchMock.mock.calls[3]?.[1]?.headers).toMatchObject({
      'X-Checkout-Session-Token': 'session_token',
    });
  });
});

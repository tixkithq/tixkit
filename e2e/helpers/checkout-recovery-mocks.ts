import type { Page, Route } from '@playwright/test';

export type MockTicket = {
  ticketTypeId: string;
  name: string;
  priceCents: number;
  available: number;
  status?: string;
};

export type MockSession = {
  id: string;
  eventId: string;
  brandId: string;
  status: string;
  currency: string;
  clientToken?: string;
  quote: {
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    feeCents: number;
    totalCents: number;
  };
  expiresAt: string;
  orderId: string | null;
};

type MockError = {
  error: { code: string; message: string; details?: Record<string, unknown> };
  status?: number;
};

export type CheckoutRecoveryMockState = {
  eventId: string;
  brandId: string;
  tickets: MockTicket[];
  session?: MockSession | null;
  sessionFactory?: () => MockSession;
  createSessionImpl?: (body: unknown) => MockSession | MockError | Promise<MockSession | MockError>;
  confirmSessionImpl?: (sessionId: string) => unknown | MockError | Promise<unknown | MockError>;
  pageBootstrapFail?: boolean;
  availabilityFailOnce?: boolean;
  getSessionFailOnce?: boolean;
  createCalls: number;
  confirmCalls: number;
  getSessionCalls: number;
  availabilityCalls: number;
};

export function createRecoveryMockState(
  overrides: Partial<CheckoutRecoveryMockState> = {},
): CheckoutRecoveryMockState {
  return {
    eventId: 'evt_recovery',
    brandId: 'brand_platform',
    tickets: [
      {
        ticketTypeId: 'tt_ga',
        name: 'General Admission',
        priceCents: 2500,
        available: 12,
        status: 'active',
      },
      {
        ticketTypeId: 'tt_vip',
        name: 'VIP',
        priceCents: 7500,
        available: 2,
        status: 'active',
      },
    ],
    session: null,
    createCalls: 0,
    confirmCalls: 0,
    getSessionCalls: 0,
    availabilityCalls: 0,
    ...overrides,
  };
}

export function baseSession(
  state: CheckoutRecoveryMockState,
  overrides: Partial<MockSession> = {},
): MockSession {
  return {
    id: 'cs_recovery',
    eventId: state.eventId,
    brandId: state.brandId,
    status: 'open',
    currency: 'USD',
    clientToken: 'tok_recovery',
    quote: {
      subtotalCents: 2500,
      discountCents: 0,
      taxCents: 0,
      feeCents: 0,
      totalCents: 2500,
    },
    expiresAt: '2099-01-01T00:00:00.000Z',
    orderId: null,
    ...overrides,
  };
}

function tickets(state: CheckoutRecoveryMockState) {
  return state.tickets.map((ticket) => ({
    type: 'ticket',
    ticketTypeId: ticket.ticketTypeId,
    name: ticket.name,
    kind: 'paid',
    priceCents: ticket.priceCents,
    currency: 'USD',
    minPerOrder: 1,
    maxPerOrder: 4,
    available: ticket.available,
    status: ticket.status ?? (ticket.available > 0 ? 'active' : 'sold_out'),
  }));
}

function event(state: CheckoutRecoveryMockState) {
  return {
    id: state.eventId,
    title: 'Recovery Night',
    status: 'published',
    timezone: 'America/New_York',
    startsAt: '2026-12-01T19:00:00.000Z',
    brandId: state.brandId,
  };
}

function contentPage(state: CheckoutRecoveryMockState) {
  return {
    document: {
      eventId: state.eventId,
      channel: 'event_page',
      key: 'event-page',
      name: 'Recovery event page',
      locale: 'en',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    version: { versionNumber: 1, publishedAt: '2026-01-01T00:00:00.000Z' },
    page: {
      provider: '@puckeditor/core',
      puckData: null,
      discovery: { title: 'Recovery Night', summary: 'Recovery fixture', tags: [] },
    },
  };
}

async function json(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function isError(value: unknown): value is MockError {
  return Boolean(value && typeof value === 'object' && 'error' in value);
}

/** Deterministic public checkout mocks. An intentional availability outage aborts exactly once. */
export async function installCheckoutRecoveryMocks(
  page: Page,
  state: CheckoutRecoveryMockState,
): Promise<void> {
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    if (url.includes(`/v1/public/events/${state.eventId}/page-bootstrap`)) {
      if (state.pageBootstrapFail)
        return json(route, 503, {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Bootstrap unavailable',
          },
        });
      return json(route, 200, {
        event: event(state),
        contentPage: null,
        availability: tickets(state),
        resaleListings: { items: [], nextCursor: null, hasMore: false },
      });
    }
    if (url.includes(`/v1/public/events/${state.eventId}/bootstrap`))
      return json(route, 200, {
        event: event(state),
        availability: tickets(state),
        questions: { buyerQuestions: [], attendeeQuestions: [] },
        occurrences: [],
        resaleListing: null,
      });
    if (url.includes(`/v1/public/events/${state.eventId}/availability`)) {
      state.availabilityCalls += 1;
      if (state.availabilityFailOnce) {
        state.availabilityFailOnce = false;
        await route.abort('failed');
        return;
      }
      return json(route, 200, tickets(state));
    }
    if (url.includes(`/v1/public/events/${state.eventId}/questions`))
      return json(route, 200, { buyerQuestions: [], attendeeQuestions: [] });
    if (url.includes(`/v1/public/events/${state.eventId}/occurrences`))
      return json(route, 200, { items: [] });
    if (url.includes(`/v1/public/events/${state.eventId}/resale-listings`))
      return json(route, 200, { items: [], nextCursor: null, hasMore: false });
    if (url.includes(`/v1/public/events/${state.eventId}/revision`))
      return json(route, 200, { revision: 'rev_1' });
    if (url.includes(`/v1/public/events/${state.eventId}/page`))
      return json(route, 200, contentPage(state));
    if (url.includes(`/v1/public/events/${state.eventId}`)) return json(route, 200, event(state));
    if (url.includes(`/v1/public/brands/${state.brandId}`))
      return json(route, 200, {
        id: state.brandId,
        name: 'Platform',
        status: 'active',
        whiteLabel: false,
        supportUrl: null,
        termsUrl: null,
        privacyUrl: null,
        refundUrl: null,
      });
    if (url.includes('/v1/public/rum')) return route.fulfill({ status: 204 });
    if (method === 'POST' && url.endsWith('/v1/checkout/sessions')) {
      state.createCalls += 1;
      const result = state.createSessionImpl
        ? await state.createSessionImpl(request.postDataJSON())
        : baseSession(state, {
            id: `cs_created_${state.createCalls}`,
            clientToken: `tok_created_${state.createCalls}`,
          });
      if (isError(result)) return json(route, result.status ?? 409, { error: result.error });
      state.session = result;
      return json(route, 201, result);
    }
    const sessionMatch = url.match(/\/v1\/checkout\/sessions\/([^/?]+)/u);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1] ?? '');
      if (url.includes('/confirm') && method === 'POST') {
        state.confirmCalls += 1;
        const result = state.confirmSessionImpl
          ? await state.confirmSessionImpl(sessionId)
          : {
              status: 'pending_payment',
              sessionId,
              clientSecret: `pi_${sessionId}`,
              currency: 'USD',
              totalCents: state.session?.quote.totalCents ?? 2500,
            };
        return isError(result)
          ? json(route, result.status ?? 409, { error: result.error })
          : json(route, 200, result);
      }
      if (url.includes('/wallet-passes')) return json(route, 200, { tickets: [] });
      if (!url.includes('/handoff')) {
        state.getSessionCalls += 1;
        if (state.getSessionFailOnce) {
          state.getSessionFailOnce = false;
          await route.abort('failed');
          return;
        }
        return json(
          route,
          200,
          state.sessionFactory?.() ?? state.session ?? baseSession(state, { id: sessionId }),
        );
      }
    }
    return json(route, 404, {
      error: { code: 'not_found', message: `unmocked ${method} ${url}` },
    });
  });
}

export async function seedSessionToken(
  page: Page,
  sessionId: string,
  token = 'tok_recovery',
): Promise<void> {
  await page.addInitScript(
    ({ id, value }) => window.sessionStorage.setItem(`tk:session:${id}`, value),
    { id: sessionId, value: token },
  );
}

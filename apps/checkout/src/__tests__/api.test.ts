import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CheckoutApiError,
  checkoutApi,
  publicApi,
  isRetryable,
  userFacingMessage,
  newCheckoutIdempotencyKey,
  newConfirmIdempotencyKey,
} from '../lib/api'
import type { CartItem, AvailabilityItem, CheckoutQuestion } from '../lib/api'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CheckoutApiError', () => {
  it('exposes code, status, and message', () => {
    const err = new CheckoutApiError('BOOM', 'something broke', 500, 'req_1')
    expect(err.code).toBe('BOOM')
    expect(err.status).toBe(500)
    expect(err.requestId).toBe('req_1')
    expect(err.message).toBe('something broke')
    expect(err.name).toBe('CheckoutApiError')
    expect(err instanceof Error).toBe(true)
  })
})

describe('isRetryable', () => {
  it('treats network errors and 5xx as retryable', () => {
    expect(isRetryable(new CheckoutApiError('NETWORK_ERROR', 'x', 0))).toBe(true)
    expect(isRetryable(new CheckoutApiError('X', 'x', 503))).toBe(true)
    expect(
      isRetryable(new CheckoutApiError('SERVICE_UNAVAILABLE', 'x', 503)),
    ).toBe(true)
  })

  it('treats 4xx as non-retryable', () => {
    expect(isRetryable(new CheckoutApiError('VALIDATION', 'x', 400))).toBe(false)
    expect(isRetryable(new CheckoutApiError('NOT_FOUND', 'x', 404))).toBe(false)
  })

  it('returns false for non-api errors', () => {
    expect(isRetryable(new Error('boom'))).toBe(false)
    expect(isRetryable('nope')).toBe(false)
  })
})

describe('userFacingMessage', () => {
  it('returns friendly copy for known error codes', () => {
    expect(
      userFacingMessage(new CheckoutApiError('PAYMENT_FAILED', 'x', 402)),
    ).toContain('Payment could not be started')
    expect(
      userFacingMessage(new CheckoutApiError('SERVICE_UNAVAILABLE', 'x', 503)),
    ).toContain('preparing your payment')
    expect(
      userFacingMessage(new CheckoutApiError('CHECKOUT_EXPIRED', 'x', 410)),
    ).toContain('expired')
  })

  it('falls back to the error message for unknown codes', () => {
    expect(
      userFacingMessage(new CheckoutApiError('WEIRD', 'custom message', 400)),
    ).toBe('custom message')
  })

  it('handles generic errors', () => {
    expect(userFacingMessage(new Error('boom'))).toBe('boom')
    expect(userFacingMessage('nope')).toContain('Something went wrong')
  })
})

describe('idempotency keys', () => {
  it('generates prefixed keys', () => {
    const checkoutKey = newCheckoutIdempotencyKey()
    const confirmKey = newConfirmIdempotencyKey()
    expect(checkoutKey.startsWith('checkout_')).toBe(true)
    expect(confirmKey.startsWith('confirm_')).toBe(true)
    expect(checkoutKey).not.toEqual(newCheckoutIdempotencyKey())
  })
})

describe('checkoutApi.getSession', () => {
  it('passes Stripe payment intent client secret as tokenless confirmation proof', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'pending_payment',
          currency: 'USD',
          quote: {
            totalCents: 2500,
            subtotalCents: 2500,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          },
          expiresAt: '2026-06-01T00:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await checkoutApi.getSession('cs_1', undefined, 'pi_secret_123')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/checkout/sessions/cs_1?payment_intent_client_secret=pi_secret_123')
    expect((init.headers as Record<string, string>)['X-Checkout-Session-Token']).toBeUndefined()
  })
})

describe('checkoutApi.getWalletPasses', () => {
  it('fetches session-scoped wallet passes without a checkout token for completed confirmations', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ tickets: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await checkoutApi.getWalletPasses('cs_1')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/checkout/sessions/cs_1/wallet-passes')
    expect((init.headers as Record<string, string>)['X-Checkout-Session-Token']).toBeUndefined()
  })

  it('sends the checkout token while a session is still token-scoped', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ tickets: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await checkoutApi.getWalletPasses('cs_1', 'tok_1')

    const [_url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-Checkout-Session-Token']).toBe('tok_1')
  })
})

describe('checkoutApi.createSession', () => {
  it('sends trackingId separately from affiliateCode', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'cs_1',
          eventId: 'evt_1',
          status: 'open',
          currency: 'USD',
          clientToken: 'tok_1',
          quote: {
            totalCents: 2500,
            subtotalCents: 2500,
            discountCents: 0,
            taxCents: 0,
            feeCents: 0,
          },
          expiresAt: '2026-06-01T00:00:00.000Z',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await checkoutApi.createSession({
      eventId: 'evt_1',
      items: [{ ticketTypeId: 'tt_1', quantity: 1 }],
      buyer: { email: 'buyer@example.com' },
      discountCode: 'SAVE10',
      accessCode: 'VIP123',
      trackingId: 'campaign-123',
      affiliateCode: 'AFF123',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [_url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      eventId: 'evt_1',
      discountCode: 'SAVE10',
      accessCode: 'VIP123',
      trackingId: 'campaign-123',
      affiliateCode: 'AFF123',
    })
  })
})

describe('publicApi.getAvailability', () => {
  it('passes explicit product filters for hidden/direct-link ticket lookup', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await publicApi.getAvailability('evt_1', undefined, 'tt_hidden,tt_public')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/public/events/evt_1/availability?products=tt_hidden%2Ctt_public')
  })
})

describe('publicApi.validateAccessCode', () => {
  it('posts selected ticket types and access code to the public validator', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ valid: true, ticketTypeIds: ['tt_locked'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await publicApi.validateAccessCode('evt_1', {
      ticketTypeIds: ['tt_locked'],
      accessCode: 'VIP123',
      buyerEmail: 'buyer@example.com',
    })

    expect(result.valid).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/public/events/evt_1/access-code')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      ticketTypeIds: ['tt_locked'],
      accessCode: 'VIP123',
      buyerEmail: 'buyer@example.com',
    })
  })
})

describe('CartItem type', () => {
  it('supports attendeeFields', () => {
    const item: CartItem = {
      ticketTypeId: 'tt_1',
      quantity: 2,
      unitAmountCents: 5000,
      attendeeFields: [
        { name: 'Alice', dietary: 'vegetarian' },
        { name: 'Bob', dietary: 'none' },
      ],
    }
    expect(item.attendeeFields).toHaveLength(2)
    expect(item.attendeeFields?.[0]?.name).toBe('Alice')
  })

  it('works without attendeeFields', () => {
    const item: CartItem = {
      ticketTypeId: 'tt_1',
      quantity: 1,
    }
    expect(item.attendeeFields).toBeUndefined()
  })
})

describe('AvailabilityItem type', () => {
  it('includes access code and sales window fields', () => {
    const item: AvailabilityItem = {
      ticketTypeId: 'tt_locked',
      name: 'VIP',
      kind: 'paid',
      priceCents: 10000,
      currency: 'USD',
      minPerOrder: 1,
      maxPerOrder: 4,
      available: 10,
      status: 'active',
      requiresAccessCode: true,
      accessCodeHint: 'Check your email',
      description: 'VIP access',
      salesStartAt: '2026-01-01T00:00:00Z',
      salesEndAt: '2026-12-31T23:59:59Z',
    }
    expect(item.requiresAccessCode).toBe(true)
    expect(item.accessCodeHint).toBe('Check your email')
    expect(item.description).toBe('VIP access')
    expect(item.salesStartAt).toBe('2026-01-01T00:00:00Z')
    expect(item.salesEndAt).toBe('2026-12-31T23:59:59Z')
  })

  it('includes donation kind with minimumPriceCents', () => {
    const item: AvailabilityItem = {
      ticketTypeId: 'tt_donation',
      name: 'Donate',
      kind: 'donation',
      priceCents: 2500,
      minimumPriceCents: 500,
      currency: 'USD',
      minPerOrder: 1,
      maxPerOrder: 10,
      available: 999,
      status: 'active',
    }
    expect(item.kind).toBe('donation')
    expect(item.minimumPriceCents).toBe(500)
  })
})

describe('CheckoutQuestion type', () => {
  it('supports all question types', () => {
    const types: CheckoutQuestion['type'][] = [
      'text', 'textarea', 'email', 'phone', 'select', 'multiselect',
      'checkbox', 'date', 'waiver', 'file',
    ]
    for (const type of types) {
      const q: CheckoutQuestion = {
        id: `q_${type}`,
        label: `Question ${type}`,
        type,
        required: false,
        appliesTo: 'attendee',
      }
      expect(q.type).toBe(type)
    }
  })
})

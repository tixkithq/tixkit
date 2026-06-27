import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import EventPageClient from '@/app/e/[eventId]/event-page-client'
import { publicApi, type AvailabilityItem, type PublicEvent } from '@/lib/api'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    publicApi: {
      ...actual.publicApi,
      getEvent: vi.fn(),
      getAvailability: vi.fn(),
      getBrand: vi.fn(),
    },
  }
})

describe('EventPageClient escaping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders HTML-looking event and ticket copy as text', async () => {
    const event: PublicEvent = {
      id: 'evt_xss',
      title: '<img src=x onerror=alert(1)>',
      description: '<script>alert(1)</script>',
      status: 'published',
      timezone: 'America/New_York',
      startsAt: '2026-06-01T18:00:00.000Z',
      brandId: 'brd_1',
    }
    const availability: AvailabilityItem[] = [
      {
        type: 'ticket',
        ticketTypeId: 'tt_xss',
        name: '<svg onload=alert(1)>',
        description: '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
        kind: 'paid',
        priceCents: 2500,
        currency: 'USD',
        minPerOrder: 1,
        maxPerOrder: 4,
        available: 10,
        status: 'active',
      },
    ]
    vi.mocked(publicApi.getEvent).mockResolvedValue(event)
    vi.mocked(publicApi.getAvailability).mockResolvedValue(availability)
    vi.mocked(publicApi.getBrand).mockRejectedValue(new Error('brand unavailable'))

    const { container } = render(<EventPageClient eventId='evt_xss' />)

    await waitFor(() => {
      expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    })
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument()
    expect(screen.getByText('<svg onload=alert(1)>')).toBeInTheDocument()
    expect(screen.getByText('<iframe srcdoc="<script>alert(1)</script>"></iframe>')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[onload]')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { routes } from './routes'

describe('admin dashboard routes', () => {
  it('builds the event checkout form route', () => {
    expect(routes.eventCheckoutForm('evt_123')).toBe('/events/evt_123/checkout-form')
  })
})

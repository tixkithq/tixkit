import { describe, expect, it } from 'vitest'
import { adminApi } from '@/lib/api'

describe('AdminApi.getPrincipal', () => {
  it('returns a principal with permissions in dev fixtures', async () => {
    const result = await adminApi.getPrincipal()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.permissions.length).toBeGreaterThan(0)
      expect(result.data.tenantId).toBeDefined()
      expect(Array.isArray(result.data.organizationIds)).toBe(true)
    }
  })
})

describe('AdminApi settings fixtures', () => {
  it('loads and updates organization settings through the typed API', async () => {
    const listResult = await adminApi.listOrganizations()
    expect(listResult.ok).toBe(true)
    if (!listResult.ok) return

    const organization = listResult.data[0]
    expect(organization).toBeDefined()

    const updateResult = await adminApi.updateOrganization(organization.id, {
      name: 'Updated GateKit',
      slug: organization.slug,
    })
    expect(updateResult.ok).toBe(true)
    if (updateResult.ok) {
      expect(updateResult.data.name).toBe('Updated GateKit')
    }
  })

  it('updates brand settings and creates domains through the typed API', async () => {
    const listResult = await adminApi.listBrands()
    expect(listResult.ok).toBe(true)
    if (!listResult.ok) return

    const brand = listResult.data[0]
    expect(brand).toBeDefined()

    const updateResult = await adminApi.updateBrand(brand.id, {
      theme: { ...brand.theme, primaryColor: '#111111' },
    })
    expect(updateResult.ok).toBe(true)
    if (updateResult.ok) {
      expect(updateResult.data.theme.primaryColor).toBe('#111111')
    }

    const domainResult = await adminApi.addBrandDomain(brand.id, 'tickets.example.test')
    expect(domainResult.ok).toBe(true)
    if (domainResult.ok) {
      expect(domainResult.data.domain).toBe('tickets.example.test')
    }
  })

  it('invites team members and starts payment account setup through the typed API', async () => {
    const inviteResult = await adminApi.inviteTeamMember('org_demo', {
      email: 'teammate@example.test',
      role: 'viewer',
    })
    expect(inviteResult.ok).toBe(true)
    if (inviteResult.ok) {
      expect(inviteResult.data.status).toBe('invited')
    }

    const accountResult = await adminApi.createStripeConnectAccount('org_demo')
    expect(accountResult.ok).toBe(true)
    if (accountResult.ok) {
      expect(accountResult.data.provider).toBe('stripe_connect')
    }
  })
})

describe('AdminApi.updateTicketType', () => {
  it('updates an existing ticket type by id', async () => {
    const createResult = await adminApi.createTicketType('evt_demo_001', {
      name: 'Original Name',
      priceCents: 3000,
      currency: 'USD',
    })
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return

    const updateResult = await adminApi.updateTicketType(createResult.data.id, {
      name: 'Updated Name',
      priceCents: 3999,
    })
    expect(updateResult.ok).toBe(true)
    if (updateResult.ok) {
      expect(updateResult.data.name).toBe('Updated Name')
      expect(updateResult.data.priceCents).toBe(3999)
    }
  })

  it('returns not_found for a nonexistent ticket type', async () => {
    const result = await adminApi.updateTicketType('tt_nonexistent', {
      name: 'Nope',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_found')
      expect(result.error.status).toBe(404)
    }
  })
})

describe('AdminApi checkout questions', () => {
  it('creates, updates, and deletes event checkout questions through the typed API', async () => {
    const createResult = await adminApi.createCheckoutQuestion('evt_demo_001', {
      type: 'select',
      label: 'T-shirt size',
      required: true,
      appliesTo: 'attendee',
      options: ['S', 'M', 'L'],
      sortOrder: 99,
    })
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return

    expect(createResult.data.eventId).toBe('evt_demo_001')
    expect(createResult.data.options).toEqual(['S', 'M', 'L'])

    const updateResult = await adminApi.updateCheckoutQuestion(createResult.data.id, {
      label: 'Shirt size',
      required: false,
      sortOrder: 12,
    })
    expect(updateResult.ok).toBe(true)
    if (updateResult.ok) {
      expect(updateResult.data.label).toBe('Shirt size')
      expect(updateResult.data.required).toBe(false)
      expect(updateResult.data.sortOrder).toBe(12)
    }

    const listResult = await adminApi.listCheckoutQuestions('evt_demo_001')
    expect(listResult.ok).toBe(true)
    if (listResult.ok) {
      expect(listResult.data.some((question) => question.id === createResult.data.id)).toBe(true)
    }

    const deleteResult = await adminApi.deleteCheckoutQuestion(createResult.data.id)
    expect(deleteResult.ok).toBe(true)
  })

  it('returns not_found when updating a missing checkout question', async () => {
    const result = await adminApi.updateCheckoutQuestion('q_missing', {
      label: 'Nope',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_found')
    }
  })
})

describe('AdminApi reports date range', () => {
  it('getSalesReport reflects the requested from/to range', async () => {
    const from = '2026-01-01'
    const to = '2026-01-31'
    const result = await adminApi.getSalesReport('evt_demo_001', { from, to })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.range.from).toBe(from)
      expect(result.data.range.to).toBe(to)
    }
  })

  it('getTaxReport accepts a date range without error', async () => {
    const result = await adminApi.getTaxReport('evt_demo_001', {
      from: '2026-02-01',
      to: '2026-02-28',
    })
    expect(result.ok).toBe(true)
  })

  it('createExport returns a queued export job through the typed API', async () => {
    const result = await adminApi.createExport({
      eventId: 'evt_demo_001',
      type: 'sales',
      format: 'csv',
      filters: { from: '2026-02-01', to: '2026-02-28' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.exportId).toMatch(/^exp_/)
      expect(result.data.status).toBe('pending')
    }
  })

  it('getExport returns the queued export job through the typed API', async () => {
    const createResult = await adminApi.createExport({
      eventId: 'evt_demo_001',
      type: 'attendees',
      format: 'csv',
    })
    expect(createResult.ok).toBe(true)
    if (!createResult.ok) return

    const getResult = await adminApi.getExport(createResult.data.exportId)
    expect(getResult.ok).toBe(true)
    if (getResult.ok) {
      expect(getResult.data.exportId).toBe(createResult.data.exportId)
      expect(getResult.data.status).toBe('pending')
      expect(getResult.data.type).toBe('attendees')
      expect(getResult.data.format).toBe('csv')
    }
  })
})

describe('AdminApi order timestamps', () => {
  it('paid fixture orders expose paidAt', async () => {
    const result = await adminApi.getOrder('ord_001')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('paid')
      expect(result.data.paidAt).toBeDefined()
    }
  })

  it('refundOrder queues a refund workflow', async () => {
    // ord_002 is paid with zero refunds.
    const result = await adminApi.refundOrder('ord_002', {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.status).toBe('pending')
      expect(result.data.message).toContain('Refund workflow')
    }
  })

  it('cancelOrder sets cancelledAt', async () => {
    // ord_003 is pending.
    const result = await adminApi.cancelOrder('ord_003')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.cancelledAt).toBeDefined()
    }
  })
})

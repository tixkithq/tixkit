import { fireEvent, render, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import * as React from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportsView } from './reports-view'

if (typeof window === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

vi.mock('recharts', () => ({
  Bar: () => null,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))

vi.mock('@/components/ui/tabs', () => {
  const TabsContext = React.createContext<{
    value?: string
    onValueChange?: (value: string) => void
  }>({})

  function Tabs({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (value: string) => void
    children: React.ReactNode
  }) {
    return (
      <TabsContext.Provider value={{ value, onValueChange }}>
        <div>{children}</div>
      </TabsContext.Provider>
    )
  }

  function TabsList({ children }: { children: React.ReactNode }) {
    return <div role='tablist'>{children}</div>
  }

  function TabsTrigger({
    value,
    children,
  }: {
    value: string
    children: React.ReactNode
  }) {
    const context = React.useContext(TabsContext)
    return (
      <button
        role='tab'
        aria-selected={context.value === value}
        type='button'
        onClick={() => context.onValueChange?.(value)}
      >
        {children}
      </button>
    )
  }

  function TabsContent({
    value,
    children,
  }: {
    value: string
    children: React.ReactNode
  }) {
    const context = React.useContext(TabsContext)
    return context.value === value ? <div role='tabpanel'>{children}</div> : null
  }

  return { Tabs, TabsList, TabsTrigger, TabsContent }
})

vi.mock('@/lib/export-jobs', () => ({
  subscribeToExportJob: vi.fn(() => vi.fn()),
}))

type ReportsAdminApiMock = {
  listEvents: ReturnType<typeof vi.fn>
  listOrganizations: ReturnType<typeof vi.fn>
  getSalesReport: ReturnType<typeof vi.fn>
  getTaxReport: ReturnType<typeof vi.fn>
  getAttendanceReport: ReturnType<typeof vi.fn>
  getPromoReport: ReturnType<typeof vi.fn>
  getConversionReport: ReturnType<typeof vi.fn>
  getAffiliateReport: ReturnType<typeof vi.fn>
  createExport: ReturnType<typeof vi.fn>
}

function getAdminApiMock(): ReportsAdminApiMock {
  const globalWithMock = globalThis as typeof globalThis & {
    __reportsAdminApiMock?: ReportsAdminApiMock
  }
  globalWithMock.__reportsAdminApiMock ??= {
    listEvents: vi.fn(),
    listOrganizations: vi.fn(),
    getSalesReport: vi.fn(),
    getTaxReport: vi.fn(),
    getAttendanceReport: vi.fn(),
    getPromoReport: vi.fn(),
    getConversionReport: vi.fn(),
    getAffiliateReport: vi.fn(),
    createExport: vi.fn(),
  }
  return globalWithMock.__reportsAdminApiMock
}

vi.mock('@/lib/api', () => ({
  adminApi: getAdminApiMock(),
}))

const adminApiMock = getAdminApiMock()

describe('ReportsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    adminApiMock.listEvents.mockResolvedValue({
      ok: true,
      data: { items: [], total: 0 },
    })
    adminApiMock.listOrganizations.mockResolvedValue({
      ok: true,
      data: [{ id: 'org_1', name: 'Demo Org', slug: 'demo', status: 'active', tenantId: 'tnt_1' }],
    })
    adminApiMock.getSalesReport.mockResolvedValue({
      ok: true,
      data: {
        eventId: 'evt_1',
        currency: 'USD',
        grossSalesCents: 12500,
        netRevenueCents: 10000,
        feesCents: 500,
        taxCents: 1000,
        refundsCents: 2000,
        ordersCount: 6,
        paidOrdersCount: 5,
        ticketsSold: 8,
        checkIns: 4,
        range: { from: '2026-06-01', to: '2026-06-30' },
      },
    })
    adminApiMock.getTaxReport.mockResolvedValue({
      ok: true,
      data: {
        eventId: 'evt_1',
        currency: 'USD',
        totalTaxCollectedCents: 1000,
        breakdown: [{
          taxRuleName: 'Actual collected tax',
          rate: null,
          taxableAmountCents: 10000,
          taxCollectedCents: 1000,
        }],
      },
    })
    adminApiMock.getAttendanceReport.mockResolvedValue({
      ok: true,
      data: {
        eventId: 'evt_1',
        totalAttendees: 8,
        checkedIn: 4,
        notCheckedIn: 4,
        checkInRate: 0.5,
        breakdownByTicketType: [{
          ticketTypeId: 'tt_1',
          ticketTypeName: 'General Admission',
          total: 8,
          checkedIn: 4,
        }],
      },
    })
    adminApiMock.getPromoReport.mockResolvedValue({
      ok: true,
      data: {
        eventId: 'evt_1',
        discountCodes: [{
          code: 'PROMO10',
          usesCount: 3,
          discountAmountCents: 1500,
          revenueAttributedCents: 9000,
        }],
      },
    })
    adminApiMock.getConversionReport.mockResolvedValue({
      ok: true,
      data: {
        eventId: 'evt_1',
        widgetViews: null,
        checkoutStarted: 12,
        checkoutCompleted: 6,
        conversionRate: 0.5,
      },
    })
    adminApiMock.getAffiliateReport.mockResolvedValue({
      ok: true,
      data: {
        organizationId: 'org_1',
        affiliates: [{
          affiliateId: 'aff_1',
          code: 'ADA',
          name: 'Ada Partners',
          referralsCount: 3,
          revenueAttributedCents: 9000,
          commissionCents: 900,
        }],
      },
    })
    adminApiMock.createExport.mockResolvedValue({
      ok: true,
      data: { exportId: 'exp_1', status: 'pending', type: 'sales', format: 'csv' },
    })
  })

  it('renders navigation tabs for all existing report APIs', async () => {
    const view = render(<ReportsView eventId='evt_1' />)

    for (const tab of ['Sales', 'Tax', 'Attendance', 'Promo', 'Conversion', 'Affiliate']) {
      expect(await view.findByRole('tab', { name: tab })).toBeInTheDocument()
    }
  })

  it('shows report data when switching tabs', async () => {
    const view = render(<ReportsView eventId='evt_1' />)

    expect(await view.findByText('Gross Sales')).toBeInTheDocument()

    fireEvent.click(view.getByRole('tab', { name: 'Tax' }))
    expect(await view.findAllByText('Tax Collected')).toHaveLength(2)
    expect(view.getByText('Actual collected tax')).toBeInTheDocument()

    fireEvent.click(view.getByRole('tab', { name: 'Attendance' }))
    expect(await view.findByText('Check-in Rate')).toBeInTheDocument()
    expect(view.getByText('General Admission')).toBeInTheDocument()

    fireEvent.click(view.getByRole('tab', { name: 'Promo' }))
    expect(await view.findByText('Promo Codes')).toBeInTheDocument()
    expect(view.getByText('PROMO10')).toBeInTheDocument()

    fireEvent.click(view.getByRole('tab', { name: 'Conversion' }))
    expect(await view.findByText('Widget Views')).toBeInTheDocument()
    expect(view.getByText('Untracked')).toBeInTheDocument()
    expect(view.getByText(/Widget impressions are not tracked/i)).toBeInTheDocument()

    fireEvent.click(view.getByRole('tab', { name: 'Affiliate' }))
    expect(await view.findAllByText('Select report scope')).not.toHaveLength(0)
    expect(adminApiMock.getAffiliateReport).not.toHaveBeenCalled()
  })

  it('exposes and queues every backend-supported report export type', async () => {
    const view = render(<ReportsView eventId='evt_1' />)

    await view.findByText('Gross Sales')

    for (const name of [
      'Export sales CSV',
      'Export tax CSV',
      'Export attendees CSV',
      'Export orders CSV',
      'Export tickets CSV',
      'Export scan logs CSV',
    ]) {
      expect(view.getByRole('button', { name })).toBeInTheDocument()
    }

    fireEvent.click(view.getByRole('button', { name: 'Export orders CSV' }))

    await waitFor(() => {
      expect(adminApiMock.createExport).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_1',
          type: 'orders',
          format: 'csv',
        })
      )
    })
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportsView } from './reports-view'

vi.mock('recharts', () => ({
  Bar: () => null,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))

vi.mock('@/components/ui/tabs', async () => {
  const React = await import('react')
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

const adminApiMock = vi.hoisted(() => ({
  listEvents: vi.fn(),
  listOrganizations: vi.fn(),
  getSalesReport: vi.fn(),
  getTaxReport: vi.fn(),
  getAttendanceReport: vi.fn(),
  getPromoReport: vi.fn(),
  getConversionReport: vi.fn(),
  getAffiliateReport: vi.fn(),
  createExport: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    adminApi: adminApiMock,
  }
})

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
        widgetViews: 20,
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
    render(<ReportsView eventId='evt_1' />)

    for (const tab of ['Sales', 'Tax', 'Attendance', 'Promo', 'Conversion', 'Affiliate']) {
      expect(await screen.findByRole('tab', { name: tab })).toBeInTheDocument()
    }
  })

  it('shows report data when switching tabs', async () => {
    render(<ReportsView eventId='evt_1' />)

    expect(await screen.findByText('Gross Sales')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Tax' }))
    expect(await screen.findAllByText('Tax Collected')).toHaveLength(2)
    expect(screen.getByText('Actual collected tax')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Attendance' }))
    expect(await screen.findByText('Check-in Rate')).toBeInTheDocument()
    expect(screen.getByText('General Admission')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Promo' }))
    expect(await screen.findByText('Promo Codes')).toBeInTheDocument()
    expect(screen.getByText('PROMO10')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Conversion' }))
    expect(await screen.findByText('Widget Views')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Affiliate' }))
    expect(await screen.findByText('Affiliates')).toBeInTheDocument()
    expect(screen.getByText('Ada Partners')).toBeInTheDocument()
  })

  it('exports the currently selected supported report type', async () => {
    render(<ReportsView eventId='evt_1' />)

    await screen.findByText('Gross Sales')
    fireEvent.click(screen.getByRole('tab', { name: 'Tax' }))
    await screen.findAllByText('Tax Collected')
    fireEvent.click(screen.getByRole('button', { name: /export/i }))

    await waitFor(() => {
      expect(adminApiMock.createExport).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_1',
          type: 'tax',
          format: 'csv',
        })
      )
    })
  })
})

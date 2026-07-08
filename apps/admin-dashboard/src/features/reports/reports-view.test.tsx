import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportsView } from './reports-view';

if (typeof window === 'undefined') {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    navigator: dom.window.navigator,
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

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
});

vi.mock('recharts', () => ({
  Bar: () => null,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock('@/components/ui/select', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const SelectContext = React.createContext<{
    value: string;
    onValueChange: (value: string) => void;
    items: { value: string; label: string }[];
    registerItem: (value: string, label: string) => void;
  } | null>(null);

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) {
    const [items, setItems] = React.useState<{ value: string; label: string }[]>([]);
    const registerItem = React.useCallback((value: string, label: string) => {
      setItems((current) =>
        current.some((item) => item.value === value) ? current : [...current, { value, label }],
      );
    }, []);

    return (
      <SelectContext.Provider value={{ value, onValueChange, items, registerItem }}>
        {children}
      </SelectContext.Provider>
    );
  }

  function SelectTrigger({
    className,
    ...props
  }: {
    className?: string;
    children?: React.ReactNode;
    'aria-label'?: string;
  }) {
    const context = React.useContext(SelectContext);
    return (
      <select
        className={className}
        value={context?.value ?? ''}
        onChange={(event) => context?.onValueChange(event.target.value)}
        {...props}
      >
        <option value="">All</option>
        {(context?.items ?? []).map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    );
  }

  function SelectValue() {
    return null;
  }

  function SelectContent({ children }: { children: React.ReactNode }) {
    return children;
  }

  function SelectItem({ value, children }: { value: string; children: React.ReactNode }) {
    const context = React.useContext(SelectContext);
    const registerItem = context?.registerItem;
    React.useEffect(() => {
      registerItem?.(value, String(children));
    }, [value, children, registerItem]);
    return null;
  }

  return { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
});

vi.mock('@/components/ui/tabs', () => {
  const TabsContext = React.createContext<{
    value?: string;
    onValueChange?: (value: string) => void;
  }>({});

  // Keep these mock components inside the hoisted factory so the tab context is
  // initialized with the mocked module instead of test-file execution order.
  // eslint-disable-next-line unicorn/consistent-function-scoping
  function Tabs({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
  }) {
    const contextValue = React.useMemo(() => ({ value, onValueChange }), [onValueChange, value]);

    return (
      <TabsContext.Provider value={contextValue}>
        <div>{children}</div>
      </TabsContext.Provider>
    );
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping
  function TabsList({ children }: { children: React.ReactNode }) {
    return <div role="tablist">{children}</div>;
  }

  function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
    const context = React.useContext(TabsContext);
    return (
      <button
        role="tab"
        aria-selected={context.value === value}
        type="button"
        onClick={() => context.onValueChange?.(value)}
      >
        {children}
      </button>
    );
  }

  function TabsContent({ value, children }: { value: string; children: React.ReactNode }) {
    const context = React.useContext(TabsContext);
    return context.value === value ? <div role="tabpanel">{children}</div> : null;
  }

  return { Tabs, TabsList, TabsTrigger, TabsContent };
});

vi.mock('@/lib/export-jobs', () => ({
  subscribeToExportJob: vi.fn(() => vi.fn()),
}));

const permissionsMock = vi.hoisted(() => ({
  can: vi.fn(),
}));

vi.mock('@/context/bootstrap-provider', () => ({
  useBootstrap: () => ({
    organizations: [],
    brands: [],
    organizationId: undefined,
    brandId: undefined,
    availableBrands: [],
    setOrganizationId: vi.fn(),
    setBrandId: vi.fn(),
    loading: false,
    error: null,
  }),
}));

vi.mock('@/context/permission-provider', () => ({
  usePermissions: () => permissionsMock,
}));

type ReportsAdminApiMock = {
  listEvents: ReturnType<typeof vi.fn>;
  listOrganizations: ReturnType<typeof vi.fn>;
  getSalesReport: ReturnType<typeof vi.fn>;
  getTaxReport: ReturnType<typeof vi.fn>;
  getAttendanceReport: ReturnType<typeof vi.fn>;
  getPromoReport: ReturnType<typeof vi.fn>;
  getConversionReport: ReturnType<typeof vi.fn>;
  getAffiliateReport: ReturnType<typeof vi.fn>;
  createExport: ReturnType<typeof vi.fn>;
};

function getAdminApiMock(): ReportsAdminApiMock {
  const globalWithMock = globalThis as typeof globalThis & {
    reportsAdminApiMock?: ReportsAdminApiMock;
  };
  globalWithMock.reportsAdminApiMock ??= {
    listEvents: vi.fn(),
    listOrganizations: vi.fn(),
    getSalesReport: vi.fn(),
    getTaxReport: vi.fn(),
    getAttendanceReport: vi.fn(),
    getPromoReport: vi.fn(),
    getConversionReport: vi.fn(),
    getAffiliateReport: vi.fn(),
    createExport: vi.fn(),
  };
  return globalWithMock.reportsAdminApiMock;
}

vi.mock('@/lib/api', () => ({
  adminApi: getAdminApiMock(),
}));

const adminApiMock = getAdminApiMock();

describe('ReportsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionsMock.can.mockReturnValue(true);
    adminApiMock.listEvents.mockResolvedValue({
      ok: true,
      data: { items: [], total: 0 },
    });
    adminApiMock.listOrganizations.mockResolvedValue({
      ok: true,
      data: [{ id: 'org_1', name: 'Demo Org', slug: 'demo', status: 'active', tenantId: 'tnt_1' }],
    });
    adminApiMock.getSalesReport.mockResolvedValue({
      ok: true,
      data: {
        eventId: 'evt_1',
        currency: 'USD',
        grossSalesCents: 12500,
        grossSalesByChannelCents: { online: 9000, boxOffice: 3500 },
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
    });
    adminApiMock.getTaxReport.mockResolvedValue({
      ok: true,
      data: {
        eventId: 'evt_1',
        currency: 'USD',
        totalTaxCollectedCents: 1000,
        breakdown: [
          {
            taxRuleName: 'Actual collected tax',
            rate: null,
            taxableAmountCents: 10000,
            taxCollectedCents: 1000,
          },
        ],
      },
    });
    adminApiMock.getAttendanceReport.mockResolvedValue({
      ok: true,
      data: {
        eventId: 'evt_1',
        totalAttendees: 8,
        checkedIn: 4,
        notCheckedIn: 4,
        checkInRate: 0.5,
        breakdownByTicketType: [
          {
            ticketTypeId: 'tt_1',
            ticketTypeName: 'General Admission',
            total: 8,
            checkedIn: 4,
          },
        ],
      },
    });
    adminApiMock.getPromoReport.mockResolvedValue({
      ok: true,
      data: {
        eventId: 'evt_1',
        discountCodes: [
          {
            code: 'PROMO10',
            usesCount: 3,
            discountAmountCents: 1500,
            revenueAttributedCents: 9000,
          },
        ],
      },
    });
    adminApiMock.getConversionReport.mockResolvedValue({
      ok: true,
      data: {
        eventId: 'evt_1',
        widgetViews: 18,
        checkoutStarted: 12,
        checkoutCompleted: 6,
        conversionRate: 0.5,
      },
    });
    adminApiMock.getAffiliateReport.mockResolvedValue({
      ok: true,
      data: {
        organizationId: 'org_1',
        affiliates: [
          {
            affiliateId: 'aff_1',
            code: 'ADA',
            name: 'Ada Partners',
            referralsCount: 3,
            revenueAttributedCents: 9000,
            commissionCents: 900,
          },
        ],
      },
    });
    adminApiMock.createExport.mockImplementation(async (input: { type: string }) => ({
      ok: true,
      data: { exportId: 'exp_1', status: 'pending', type: input.type, format: 'csv' },
    }));
  });

  it('renders navigation tabs for all existing report APIs', async () => {
    const view = render(<ReportsView eventId="evt_1" />);

    const renderedTabs = await view.findAllByRole('tab');
    expect(renderedTabs.map((tab) => tab.textContent)).toEqual(
      expect.arrayContaining(['Sales', 'Tax', 'Attendance', 'Promo', 'Conversion', 'Affiliate']),
    );
  });

  it('shows report data when switching tabs', async () => {
    const view = render(<ReportsView eventId="evt_1" />);

    expect(await view.findByText('Gross Sales')).toBeInTheDocument();
    expect(view.getByText('Online Sales')).toBeInTheDocument();
    expect(view.getByText('Box Office')).toBeInTheDocument();

    fireEvent.click(view.getByRole('tab', { name: 'Tax' }));
    expect(await view.findAllByText('Tax Collected')).toHaveLength(2);
    expect(view.getByText('Actual collected tax')).toBeInTheDocument();

    fireEvent.click(view.getByRole('tab', { name: 'Attendance' }));
    expect(await view.findByText('Check-in Rate')).toBeInTheDocument();
    expect(view.getByText('General Admission')).toBeInTheDocument();

    fireEvent.click(view.getByRole('tab', { name: 'Promo' }));
    expect(await view.findByText('Promo Codes')).toBeInTheDocument();
    expect(view.getByText('PROMO10')).toBeInTheDocument();

    fireEvent.click(view.getByRole('tab', { name: 'Conversion' }));
    expect(await view.findByText('Widget Views')).toBeInTheDocument();
    expect(view.getByText('18')).toBeInTheDocument();

    fireEvent.click(view.getByRole('tab', { name: 'Affiliate' }));
    expect(await view.findAllByText('Select workspace')).not.toHaveLength(0);
    expect(adminApiMock.getAffiliateReport).not.toHaveBeenCalled();
  });

  it('loads affiliate reporting on the global reports route without selecting an event', async () => {
    const view = render(<ReportsView />);

    const renderedTabs = await view.findAllByRole('tab');
    expect(renderedTabs.map((tab) => tab.textContent)).toEqual(
      expect.arrayContaining(['Sales', 'Tax', 'Attendance', 'Promo', 'Conversion', 'Affiliate']),
    );
    expect(
      view.getByText('Pick an event to view event-scoped reporting tabs.'),
    ).toBeInTheDocument();
    expect(adminApiMock.getSalesReport).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('tab', { name: 'Affiliate' }));

    expect(await view.findAllByText('Select workspace')).not.toHaveLength(0);
    expect(adminApiMock.getAffiliateReport).not.toHaveBeenCalled();

    await view.findByRole('option', { name: 'Demo Org' });
    fireEvent.change(view.getByRole('combobox', { name: 'Select workspace' }), {
      target: { value: 'org_1' },
    });

    await waitFor(() => {
      expect(adminApiMock.getAffiliateReport).toHaveBeenCalledWith('org_1');
    });
    expect(await view.findByText('Ada Partners')).toBeInTheDocument();
    expect(view.getByText('ADA')).toBeInTheDocument();
    expect(adminApiMock.getSalesReport).not.toHaveBeenCalled();
  });

  it('shows a retryable error when affiliate workspaces fail to load', async () => {
    adminApiMock.listOrganizations.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'workspace_unavailable',
        message: 'Workspaces unavailable',
        status: 500,
      },
    });

    const view = render(<ReportsView />);

    await view.findByText('Pick an event to view event-scoped reporting tabs.');
    fireEvent.click(view.getByRole('tab', { name: 'Affiliate' }));

    expect(await view.findByText('Unable to load workspaces')).toBeInTheDocument();
    expect(view.getByText('Workspaces unavailable')).toBeInTheDocument();
    expect(
      view.queryByText('Choose a workspace before loading affiliate reporting.'),
    ).not.toBeInTheDocument();
    expect(view.getByRole('combobox', { name: 'Select workspace' })).toBeDisabled();
    expect(adminApiMock.getAffiliateReport).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: 'Try again' }));

    await view.findByRole('option', { name: 'Demo Org' });
    expect(view.getByRole('combobox', { name: 'Select workspace' })).toBeEnabled();
    fireEvent.change(view.getByRole('combobox', { name: 'Select workspace' }), {
      target: { value: 'org_1' },
    });

    await waitFor(() => {
      expect(adminApiMock.getAffiliateReport).toHaveBeenCalledWith('org_1');
    });
    expect(await view.findByText('Ada Partners')).toBeInTheDocument();
  });

  it('loads report APIs only after their tab is selected', async () => {
    const view = render(<ReportsView eventId="evt_1" />);

    await view.findByText('Gross Sales');
    expect(adminApiMock.getSalesReport).toHaveBeenCalledTimes(1);
    expect(adminApiMock.getTaxReport).not.toHaveBeenCalled();
    expect(adminApiMock.getAttendanceReport).not.toHaveBeenCalled();
    expect(adminApiMock.getPromoReport).not.toHaveBeenCalled();
    expect(adminApiMock.getConversionReport).not.toHaveBeenCalled();
    expect(adminApiMock.getAffiliateReport).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('tab', { name: 'Tax' }));
    expect(await view.findAllByText('Tax Collected')).toHaveLength(2);

    expect(adminApiMock.getTaxReport).toHaveBeenCalledTimes(1);
    expect(adminApiMock.getAttendanceReport).not.toHaveBeenCalled();
    expect(adminApiMock.getPromoReport).not.toHaveBeenCalled();
    expect(adminApiMock.getConversionReport).not.toHaveBeenCalled();
    expect(adminApiMock.getAffiliateReport).not.toHaveBeenCalled();
  });

  it('exposes and queues every backend-supported report export type', async () => {
    const view = render(<ReportsView eventId="evt_1" />);

    await view.findByText('Gross Sales');

    for (const name of [
      'Export sales CSV',
      'Export tax CSV',
      'Export attendees CSV',
      'Export orders CSV',
      'Export tickets CSV',
      'Export scan logs CSV',
    ]) {
      expect(view.getByRole('button', { name })).toBeInTheDocument();
    }

    fireEvent.click(view.getByRole('button', { name: 'Export orders CSV' }));

    await waitFor(() => {
      expect(adminApiMock.createExport).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'evt_1',
          type: 'orders',
          format: 'csv',
        }),
      );
    });
  });

  it('hides export types when the paired raw-data permission is missing', async () => {
    permissionsMock.can.mockImplementation((permission: string) => permission === 'orders.read');
    const view = render(<ReportsView eventId="evt_1" />);

    await view.findByText('Gross Sales');

    expect(view.getByRole('button', { name: 'Export sales CSV' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Export tax CSV' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Export orders CSV' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Export attendees CSV' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Export tickets CSV' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Export scan logs CSV' })).not.toBeInTheDocument();
  });

  it('shows status for the selected export type and unlocks exports after queueing', async () => {
    const view = render(<ReportsView eventId="evt_1" />);

    await view.findByText('Gross Sales');
    fireEvent.click(view.getByRole('button', { name: 'Export orders CSV' }));

    expect(await view.findByRole('status')).toHaveTextContent(
      'Orders CSV export exp_1 is pending.',
    );
    expect(view.getByRole('button', { name: 'Export sales CSV' })).toBeEnabled();
    expect(view.getByRole('button', { name: 'Export tax CSV' })).toBeEnabled();
    expect(view.getByRole('button', { name: 'Export orders CSV' })).toBeEnabled();
  });
});

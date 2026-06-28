'use client';

import * as React from 'react';
import {
  BadgePercent,
  BarChart3,
  CalendarCheck,
  CalendarRange,
  Download,
  DollarSign,
  MousePointerClick,
  Receipt,
  Ticket,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  type AdminAffiliateReport,
  type AdminAttendanceReport,
  type AdminConversionReport,
  type AdminEventListItem,
  type AdminExportJob,
  type AdminExportType,
  type AdminPromoReport,
  type AdminSalesReportSummary,
  type AdminTaxReport,
  type PageResult,
  adminApi,
} from '@/lib/api';
import { ApiErrorState } from '@/components/api-error-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DatePicker } from '@/components/date-picker';
import { EmptyState } from '@/components/empty-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAdminData } from '@/hooks/use-admin-data';
import { formatCurrency, formatDate, formatNumber } from '@/lib/format';
import { subscribeToExportJob } from '@/lib/export-jobs';
import { toast } from 'sonner';
import type { AdminApiError } from '@/lib/api';

type ReportTab = 'sales' | 'tax' | 'attendance' | 'promo' | 'conversion' | 'affiliate';

type ReportsViewProps = {
  eventId?: string;
};

type LoadState<T> = {
  data: T | undefined;
  loading: boolean;
  error: AdminApiError | undefined;
  refetch: () => void;
};

const EXPORT_OPTIONS: Array<{ type: AdminExportType; label: string; ariaLabel: string }> = [
  { type: 'sales', label: 'Sales', ariaLabel: 'Export sales CSV' },
  { type: 'tax', label: 'Tax', ariaLabel: 'Export tax CSV' },
  { type: 'attendees', label: 'Attendees', ariaLabel: 'Export attendees CSV' },
  { type: 'orders', label: 'Orders', ariaLabel: 'Export orders CSV' },
  { type: 'tickets', label: 'Tickets', ariaLabel: 'Export tickets CSV' },
  { type: 'scan_logs', label: 'Scan logs', ariaLabel: 'Export scan logs CSV' },
];

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatPercent(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

function emptyResult<T>(): Promise<{ ok: true; data: T | null }> {
  return Promise.resolve({ ok: true as const, data: null });
}

function emptyPage<T>(): Promise<{ ok: true; data: PageResult<T> }> {
  return Promise.resolve({ ok: true as const, data: { items: [], total: 0 } });
}

export function ReportsView({ eventId }: ReportsViewProps) {
  const [selectedEventId, setSelectedEventId] = React.useState<string>(eventId ?? '');
  const [activeTab, setActiveTab] = React.useState<ReportTab>('sales');
  const [exporting, setExporting] = React.useState(false);
  const [lastExport, setLastExport] = React.useState<AdminExportJob | null>(null);
  const [selectedOrganizationId, setSelectedOrganizationId] = React.useState('');
  const exportSubscriptionRef = React.useRef<(() => void) | null>(null);
  const [from, setFrom] = React.useState<Date | undefined>(
    () => new Date(Date.now() - 30 * 86_400_000),
  );
  const [to, setTo] = React.useState<Date | undefined>(() => new Date());

  React.useEffect(() => {
    if (eventId) setSelectedEventId(eventId);
  }, [eventId]);

  const eventsState = useAdminData(
    () => (eventId ? emptyPage<AdminEventListItem>() : adminApi.listEvents()),
    [eventId],
  );
  const organizationsState = useAdminData(() => adminApi.listOrganizations());
  const events = eventsState.data?.items ?? [];
  const organizations = organizationsState.data ?? [];
  const selectedEvent = events.find((event) => event.id === selectedEventId);

  const range = React.useMemo(
    () => ({
      from: from ? toIsoDate(from) : undefined,
      to: to ? toIsoDate(to) : undefined,
    }),
    [from, to],
  );
  const selectedRangeKey = `${range.from ?? ''}:${range.to ?? ''}`;

  const salesState = useAdminData(
    () =>
      selectedEventId
        ? adminApi.getSalesReport(selectedEventId, range)
        : emptyResult<AdminSalesReportSummary>(),
    [selectedEventId, selectedRangeKey],
  );
  const taxState = useAdminData(
    () =>
      selectedEventId
        ? adminApi.getTaxReport(selectedEventId, range)
        : emptyResult<AdminTaxReport>(),
    [selectedEventId, selectedRangeKey],
  );
  const attendanceState = useAdminData(
    () =>
      selectedEventId
        ? adminApi.getAttendanceReport(selectedEventId)
        : emptyResult<AdminAttendanceReport>(),
    [selectedEventId],
  );
  const promoState = useAdminData(
    () =>
      selectedEventId ? adminApi.getPromoReport(selectedEventId) : emptyResult<AdminPromoReport>(),
    [selectedEventId],
  );
  const conversionState = useAdminData(
    () =>
      selectedEventId
        ? adminApi.getConversionReport(selectedEventId)
        : emptyResult<AdminConversionReport>(),
    [selectedEventId],
  );
  const affiliateState = useAdminData(
    () =>
      selectedOrganizationId
        ? adminApi.getAffiliateReport(selectedOrganizationId)
        : emptyResult<AdminAffiliateReport>(),
    [selectedOrganizationId],
  );

  React.useEffect(() => {
    return () => {
      exportSubscriptionRef.current?.();
    };
  }, []);

  const handleExport = async (exportType: AdminExportType) => {
    if (!selectedEventId) return;

    exportSubscriptionRef.current?.();
    setExporting(true);
    const result = await adminApi.createExport({
      eventId: selectedEventId,
      type: exportType,
      format: 'csv',
      filters: range,
    });
    if (!result.ok) {
      setExporting(false);
      toast.error(result.error.message);
      return;
    }

    setLastExport(result.data);
    toast.success(`Export queued (${result.data.exportId})`);
    exportSubscriptionRef.current = subscribeToExportJob(result.data.exportId, {
      onUpdate: setLastExport,
      onDone: (completed) => {
        setLastExport(completed);
        setExporting(false);
        if (completed.status === 'completed') {
          toast.success('Export ready to download');
        } else {
          toast.error('Export failed');
        }
      },
      onError: (error) => {
        setExporting(false);
        toast.error(error.message);
      },
    });
  };

  if (eventsState.loading && !eventId) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (eventsState.error && !eventId) {
    return (
      <ApiErrorState error={eventsState.error} onRetry={eventsState.refetch} className="h-96" />
    );
  }

  if (!eventId && events.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No events to report on"
        description="Create an event first to view sales, tax, attendance, promo, conversion, and affiliate reports."
      />
    );
  }

  const currency = salesState.data?.currency ?? selectedEvent?.currency ?? 'USD';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        {!eventId ? (
          <div className="grid gap-2">
            <span className="text-sm font-medium">Event</span>
            <Select value={selectedEventId} onValueChange={setSelectedEventId}>
              <SelectTrigger className="w-full max-w-xs" aria-label="Select an event for reports">
                <SelectValue placeholder="Select an event" />
              </SelectTrigger>
              <SelectContent>
                {events.map((event) => (
                  <SelectItem key={event.id} value={event.id}>
                    {event.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {activeTab === 'affiliate' && (
          <div className="grid gap-2">
            <span className="text-sm font-medium">Workspace</span>
            <Select value={selectedOrganizationId} onValueChange={setSelectedOrganizationId}>
              <SelectTrigger className="w-full max-w-xs" aria-label="Select workspace">
                <SelectValue placeholder="Select workspace" />
              </SelectTrigger>
              <SelectContent>
                {organizations.map((organization) => (
                  <SelectItem key={organization.id} value={organization.id}>
                    {organization.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-4">
          <div className="grid gap-2">
            <span className="text-sm font-medium">From</span>
            <DatePicker
              value={from}
              onChange={setFrom}
              placeholder="Start date"
              disabled={!selectedEventId}
            />
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">To</span>
            <DatePicker
              value={to}
              onChange={setTo}
              placeholder="End date"
              disabled={!selectedEventId}
            />
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">Exports</span>
            <div className="flex max-w-3xl flex-wrap gap-2">
              {EXPORT_OPTIONS.map((option) => (
                <Button
                  key={option.type}
                  aria-label={option.ariaLabel}
                  variant="outline"
                  size="sm"
                  onClick={() => handleExport(option.type)}
                  disabled={!selectedEventId || exporting}
                >
                  <Download className="size-4" />
                  {exporting ? 'Exporting...' : option.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {lastExport ? <ExportStatusNotice exportJob={lastExport} /> : null}

      {!selectedEventId ? (
        <EmptyState
          icon={BarChart3}
          title="Select an event"
          description="Pick an event to view reporting tabs."
        />
      ) : (
        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ReportTab)}>
          <TabsList className="flex h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="sales">Sales</TabsTrigger>
            <TabsTrigger value="tax">Tax</TabsTrigger>
            <TabsTrigger value="attendance">Attendance</TabsTrigger>
            <TabsTrigger value="promo">Promo</TabsTrigger>
            <TabsTrigger value="conversion">Conversion</TabsTrigger>
            <TabsTrigger value="affiliate">Affiliate</TabsTrigger>
          </TabsList>

          <TabsContent value="sales">
            <ReportLoadState
              state={salesState}
              render={(report) => <SalesReportPanel report={report} />}
            />
          </TabsContent>
          <TabsContent value="tax">
            <ReportLoadState
              state={taxState}
              render={(report) => <TaxReportPanel report={report} />}
            />
          </TabsContent>
          <TabsContent value="attendance">
            <ReportLoadState
              state={attendanceState}
              render={(report) => <AttendanceReportPanel report={report} />}
            />
          </TabsContent>
          <TabsContent value="promo">
            <ReportLoadState
              state={promoState}
              render={(report) => <PromoReportPanel report={report} currency={currency} />}
            />
          </TabsContent>
          <TabsContent value="conversion">
            <ReportLoadState
              state={conversionState}
              render={(report) => <ConversionReportPanel report={report} />}
            />
          </TabsContent>
          <TabsContent value="affiliate">
            {!selectedOrganizationId ? (
              <EmptyState
                icon={Users}
                title="Select workspace"
                description="Choose a workspace before loading affiliate reporting."
              />
            ) : (
              <ReportLoadState
                state={affiliateState}
                render={(report) => <AffiliateReportPanel report={report} />}
              />
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function ReportLoadState<T>({
  state,
  render,
}: {
  state: LoadState<T | null>;
  render: (data: T) => React.ReactNode;
}) {
  if (state.error) return <ApiErrorState error={state.error} onRetry={state.refetch} />;
  if (state.loading || !state.data) return <ReportSkeleton />;
  return <>{render(state.data)}</>;
}

function SalesReportPanel({ report }: { report: AdminSalesReportSummary }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CalendarRange className="size-4" />
        <span>
          Showing data for {formatDate(report.range.from)} - {formatDate(report.range.to)}
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportCard
          title="Gross Sales"
          value={formatCurrency(report.grossSalesCents, report.currency)}
          icon={DollarSign}
        />
        <ReportCard
          title="Net Revenue"
          value={formatCurrency(report.netRevenueCents, report.currency)}
          icon={TrendingUp}
        />
        <ReportCard title="Tickets Sold" value={formatNumber(report.ticketsSold)} icon={Ticket} />
        <ReportCard title="Check-ins" value={formatNumber(report.checkIns)} icon={CalendarCheck} />
        <ReportCard
          title="Fees"
          value={formatCurrency(report.feesCents, report.currency)}
          icon={Receipt}
        />
        <ReportCard
          title="Tax"
          value={formatCurrency(report.taxCents, report.currency)}
          icon={Receipt}
        />
        <ReportCard
          title="Refunds"
          value={formatCurrency(report.refundsCents, report.currency)}
          icon={Receipt}
        />
        <ReportCard
          title="Paid Orders"
          value={formatNumber(report.paidOrdersCount)}
          icon={TrendingUp}
        />
      </div>
    </div>
  );
}

function TaxReportPanel({ report }: { report: AdminTaxReport }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportCard
          title="Tax Collected"
          value={formatCurrency(report.totalTaxCollectedCents, report.currency)}
          icon={Receipt}
        />
        <ReportCard
          title="Tax Buckets"
          value={formatNumber(report.breakdown.length)}
          icon={BarChart3}
        />
      </div>
      <ReportTable
        headers={['Tax Rule', 'Rate', 'Taxable Amount', 'Tax Collected']}
        rows={report.breakdown.map((row) => [
          row.taxRuleName,
          row.rate == null ? 'Actual' : formatPercent(row.rate > 1 ? row.rate / 10_000 : row.rate),
          formatCurrency(row.taxableAmountCents, report.currency),
          formatCurrency(row.taxCollectedCents, report.currency),
        ])}
      />
    </div>
  );
}

function AttendanceReportPanel({ report }: { report: AdminAttendanceReport }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportCard title="Attendees" value={formatNumber(report.totalAttendees)} icon={Users} />
        <ReportCard
          title="Checked In"
          value={formatNumber(report.checkedIn)}
          icon={CalendarCheck}
        />
        <ReportCard
          title="Not Checked In"
          value={formatNumber(report.notCheckedIn)}
          icon={Ticket}
        />
        <ReportCard
          title="Check-in Rate"
          value={formatPercent(report.checkInRate)}
          icon={TrendingUp}
        />
      </div>
      <ReportTable
        headers={['Ticket Type', 'Total', 'Checked In', 'Rate']}
        rows={report.breakdownByTicketType.map((row) => [
          row.ticketTypeName,
          formatNumber(row.total),
          formatNumber(row.checkedIn),
          formatPercent(row.total > 0 ? row.checkedIn / row.total : 0),
        ])}
      />
    </div>
  );
}

function PromoReportPanel({ report, currency }: { report: AdminPromoReport; currency: string }) {
  const totalDiscount = report.discountCodes.reduce((sum, row) => sum + row.discountAmountCents, 0);
  const totalRevenue = report.discountCodes.reduce(
    (sum, row) => sum + row.revenueAttributedCents,
    0,
  );
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportCard
          title="Promo Codes"
          value={formatNumber(report.discountCodes.length)}
          icon={BadgePercent}
        />
        <ReportCard
          title="Uses"
          value={formatNumber(report.discountCodes.reduce((sum, row) => sum + row.usesCount, 0))}
          icon={Ticket}
        />
        <ReportCard
          title="Discounts"
          value={formatCurrency(totalDiscount, currency)}
          icon={Receipt}
        />
        <ReportCard
          title="Attributed Revenue"
          value={formatCurrency(totalRevenue, currency)}
          icon={DollarSign}
        />
      </div>
      <ReportTable
        headers={['Code', 'Uses', 'Discounts', 'Attributed Revenue']}
        rows={report.discountCodes.map((row) => [
          row.code,
          formatNumber(row.usesCount),
          formatCurrency(row.discountAmountCents, currency),
          formatCurrency(row.revenueAttributedCents, currency),
        ])}
      />
    </div>
  );
}

function ConversionReportPanel({ report }: { report: AdminConversionReport }) {
  return (
    <div className="space-y-3">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportCard
          title="Widget Views"
          value={formatNumber(report.widgetViews)}
          icon={MousePointerClick}
        />
        <ReportCard
          title="Checkout Started"
          value={formatNumber(report.checkoutStarted)}
          icon={Ticket}
        />
        <ReportCard
          title="Checkout Completed"
          value={formatNumber(report.checkoutCompleted)}
          icon={CalendarCheck}
        />
        <ReportCard
          title="Conversion Rate"
          value={formatPercent(report.conversionRate)}
          icon={TrendingUp}
        />
      </div>
    </div>
  );
}

function AffiliateReportPanel({ report }: { report: AdminAffiliateReport }) {
  const totalRevenue = report.affiliates.reduce((sum, row) => sum + row.revenueAttributedCents, 0);
  const totalCommission = report.affiliates.reduce((sum, row) => sum + row.commissionCents, 0);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <ReportCard
          title="Affiliates"
          value={formatNumber(report.affiliates.length)}
          icon={Users}
        />
        <ReportCard
          title="Referrals"
          value={formatNumber(report.affiliates.reduce((sum, row) => sum + row.referralsCount, 0))}
          icon={Ticket}
        />
        <ReportCard title="Revenue" value={formatCurrency(totalRevenue)} icon={DollarSign} />
        <ReportCard title="Commission" value={formatCurrency(totalCommission)} icon={Receipt} />
      </div>
      <ReportTable
        headers={['Affiliate', 'Code', 'Referrals', 'Revenue', 'Commission']}
        rows={report.affiliates.map((row) => [
          row.name,
          row.code,
          formatNumber(row.referralsCount),
          formatCurrency(row.revenueAttributedCents),
          formatCurrency(row.commissionCents),
        ])}
      />
    </div>
  );
}

function ReportTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-muted/20 p-6 text-sm text-muted-foreground">
        No rows for this report.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {headers.map((header) => (
            <TableHead key={header}>{header}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.join(':')}>
            {row.map((cell, index) => (
              <TableCell key={`${cell}-${index}`}>{cell}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ReportSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full" />
      ))}
      <Skeleton className="h-64 w-full sm:col-span-2 lg:col-span-4" />
    </div>
  );
}

function ExportStatusNotice({ exportJob }: { exportJob: AdminExportJob }) {
  const href = exportJob.downloadUrl ?? exportJob.fileUrl;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
      <span>
        Export {exportJob.exportId} is {exportJob.status}.
      </span>
      {exportJob.status === 'completed' && href ? (
        <Button asChild size="sm" variant="outline">
          <a href={href} target="_blank" rel="noreferrer">
            <Download className="size-4" />
            Download
          </a>
        </Button>
      ) : null}
    </div>
  );
}

function ReportCard({
  title,
  value,
  icon: Icon,
}: {
  title: string;
  value: string;
  icon: React.ElementType;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

'use client'

import * as React from 'react'
import {
  BarChart3,
  DollarSign,
  Ticket,
  TrendingUp,
  Download,
  Receipt,
  CalendarCheck,
  CalendarRange,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { type AdminExportJob, type AdminSalesReportSummary, adminApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { DatePicker } from '@/components/date-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAdminData } from '@/hooks/use-admin-data'
import { formatCurrency, formatNumber, formatDate } from '@/lib/format'
import { subscribeToExportJob } from '@/lib/export-jobs'
import { toast } from 'sonner'

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function ReportsView() {
  const [selectedEventId, setSelectedEventId] = React.useState<string>('')
  const [exporting, setExporting] = React.useState(false)
  const [lastExport, setLastExport] = React.useState<AdminExportJob | null>(null)
  const exportSubscriptionRef = React.useRef<(() => void) | null>(null)
  // Default to the last 30 days.
  const [from, setFrom] = React.useState<Date | undefined>(
    () => new Date(Date.now() - 30 * 86_400_000)
  )
  const [to, setTo] = React.useState<Date | undefined>(() => new Date())

  const { data: eventsData, loading: eventsLoading } = useAdminData(() =>
    adminApi.listEvents()
  )
  const events = eventsData?.items ?? []

  const range = React.useMemo(
    () => ({
      from: from ? toIsoDate(from) : undefined,
      to: to ? toIsoDate(to) : undefined,
    }),
    [from, to],
  )

  const { data: report, loading: reportLoading } = useAdminData(
    () =>
      selectedEventId
        ? adminApi.getSalesReport(selectedEventId, range)
        : Promise.resolve({
            ok: true as const,
            data: null as AdminSalesReportSummary | null,
          }),
    [selectedEventId, range.from, range.to]
  )

  React.useEffect(() => {
    return () => {
      exportSubscriptionRef.current?.()
    }
  }, [])

  const handleExport = async () => {
    if (!selectedEventId) return
    exportSubscriptionRef.current?.()
    setExporting(true)
    const result = await adminApi.createExport({
      eventId: selectedEventId,
      type: 'sales',
      format: 'csv',
      filters: range,
    })
    if (!result.ok) {
      setExporting(false)
      toast.error(result.error.message)
      return
    }

    setLastExport(result.data)
    toast.success(`Export queued (${result.data.exportId})`)
    exportSubscriptionRef.current = subscribeToExportJob(result.data.exportId, {
      onUpdate: setLastExport,
      onDone: (completed) => {
        setLastExport(completed)
        setExporting(false)
        if (completed.status === 'completed') {
          toast.success('Export ready to download')
        } else {
          toast.error('Export failed')
        }
      },
      onError: (error) => {
        setExporting(false)
        toast.error(error.message)
      },
    })
  }

  if (eventsLoading) {
    return <Skeleton className='h-96 w-full' />
  }

  if (events.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title='No events to report on'
        description='Create an event first to view sales and attendance reports.'
      />
    )
  }

  return (
    <div className='space-y-6'>
      <div className='flex flex-wrap items-end justify-between gap-4'>
        <div className='grid gap-2'>
          <span className='text-sm font-medium'>Event</span>
          <Select value={selectedEventId} onValueChange={setSelectedEventId}>
            <SelectTrigger className='w-full max-w-xs'>
              <SelectValue placeholder='Select an event' />
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

        <div className='flex flex-wrap items-end gap-4'>
          <div className='grid gap-2'>
            <span className='text-sm font-medium'>From</span>
            <DatePicker
              value={from}
              onChange={setFrom}
              placeholder='Start date'
              disabled={!selectedEventId}
            />
          </div>
          <div className='grid gap-2'>
            <span className='text-sm font-medium'>To</span>
            <DatePicker
              value={to}
              onChange={setTo}
              placeholder='End date'
              disabled={!selectedEventId}
            />
          </div>
          <Button
            variant='outline'
            onClick={handleExport}
            disabled={!selectedEventId || !report || exporting}
          >
            <Download className='size-4' />
            {exporting ? 'Exporting...' : 'Export'}
          </Button>
        </div>
      </div>

      {lastExport && <ExportStatusNotice exportJob={lastExport} />}

      {!selectedEventId ? (
        <EmptyState
          icon={BarChart3}
          title='Select an event'
          description='Pick an event to view revenue, fees, and check-in metrics.'
        />
      ) : reportLoading || !report ? (
        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className='h-28 w-full' />
          ))}
          <Skeleton className='h-64 w-full sm:col-span-2 lg:col-span-4' />
        </div>
      ) : (
        <>
          <div className='flex items-center gap-2 text-sm text-muted-foreground'>
            <CalendarRange className='size-4' />
            <span>
              Showing data for{' '}
              {formatDate(report.range.from)} – {formatDate(report.range.to)}
            </span>
          </div>

          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
            <ReportCard
              title='Gross Sales'
              value={formatCurrency(report.grossSalesCents, report.currency)}
              icon={DollarSign}
            />
            <ReportCard
              title='Net Revenue'
              value={formatCurrency(report.netRevenueCents, report.currency)}
              icon={TrendingUp}
            />
            <ReportCard
              title='Tickets Sold'
              value={formatNumber(report.ticketsSold)}
              icon={Ticket}
            />
            <ReportCard
              title='Check-ins'
              value={formatNumber(report.checkIns)}
              icon={CalendarCheck}
            />
          </div>

          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
            <ReportCard
              title='Fees'
              value={formatCurrency(report.feesCents, report.currency)}
              icon={Receipt}
            />
            <ReportCard
              title='Tax'
              value={formatCurrency(report.taxCents, report.currency)}
              icon={Receipt}
            />
            <ReportCard
              title='Refunds'
              value={formatCurrency(report.refundsCents, report.currency)}
              icon={Receipt}
            />
            <ReportCard
              title='Paid Orders'
              value={formatNumber(report.paidOrdersCount)}
              icon={TrendingUp}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Revenue Breakdown</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width='100%' height={300}>
                <BarChart
                  data={[
                    { name: 'Gross', value: report.grossSalesCents / 100 },
                    { name: 'Fees', value: report.feesCents / 100 },
                    { name: 'Tax', value: report.taxCents / 100 },
                    { name: 'Refunds', value: report.refundsCents / 100 },
                    { name: 'Net', value: report.netRevenueCents / 100 },
                  ]}
                >
                  <CartesianGrid strokeDasharray='3 3' className='stroke-border' />
                  <XAxis dataKey='name' className='text-xs' />
                  <YAxis className='text-xs' />
                  <Tooltip
                    formatter={(value: unknown) =>
                      formatCurrency(Number(value) * 100, report.currency)
                    }
                  />
                  <Bar dataKey='value' fill='var(--chart-1)' radius={4} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function ExportStatusNotice({ exportJob }: { exportJob: AdminExportJob }) {
  const href = exportJob.downloadUrl ?? exportJob.fileUrl
  return (
    <div className='flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm'>
      <span>
        Export {exportJob.exportId} is {exportJob.status}.
      </span>
      {exportJob.status === 'completed' && href && (
        <Button asChild size='sm' variant='outline'>
          <a href={href} target='_blank' rel='noreferrer'>
            <Download className='size-4' />
            Download
          </a>
        </Button>
      )}
    </div>
  )
}

function ReportCard({
  title,
  value,
  icon: Icon,
}: {
  title: string
  value: string
  icon: React.ElementType
}) {
  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
        <CardTitle className='text-sm font-medium'>{title}</CardTitle>
        <Icon className='size-4 text-muted-foreground' />
      </CardHeader>
      <CardContent>
        <div className='text-2xl font-bold'>{value}</div>
      </CardContent>
    </Card>
  )
}

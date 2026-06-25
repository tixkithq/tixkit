'use client'

import * as React from 'react'
import {
  DollarSign,
  Ticket,
  TrendingUp,
  CalendarCheck,
  Receipt,
  Download,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { type AdminExportJob, adminApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAdminData } from '@/hooks/use-admin-data'
import { formatCurrency, formatNumber } from '@/lib/format'
import { subscribeToExportJob } from '@/lib/export-jobs'
import { toast } from 'sonner'

export function EventReportsView({ eventId }: { eventId: string }) {
  const [range, setRange] = React.useState<string>('all')
  const [exporting, setExporting] = React.useState(false)
  const [lastExport, setLastExport] = React.useState<AdminExportJob | null>(null)
  const exportSubscriptionRef = React.useRef<(() => void) | null>(null)

  const dateRange = React.useMemo(() => {
    if (range === 'all') return undefined
    const now = new Date()
    const days = parseInt(range, 10)
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
    return { from, to: now.toISOString() }
  }, [range])

  const { data: report, loading } = useAdminData(
    () => adminApi.getSalesReport(eventId, dateRange),
    [eventId, dateRange]
  )

  React.useEffect(() => {
    return () => {
      exportSubscriptionRef.current?.()
    }
  }, [])

  const handleExport = async () => {
    exportSubscriptionRef.current?.()
    setExporting(true)
    const result = await adminApi.createExport({
      eventId,
      type: 'sales',
      format: 'csv',
      filters: dateRange,
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

  if (loading || !report) {
    return (
      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className='h-28 w-full' />
        ))}
        <Skeleton className='h-64 w-full sm:col-span-2 lg:col-span-4' />
      </div>
    )
  }

  return (
    <div className='space-y-6'>
      <div className='flex justify-end items-center gap-4'>
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className='w-[180px]'>
            <SelectValue placeholder='Select date range' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>All time</SelectItem>
            <SelectItem value='7'>Last 7 days</SelectItem>
            <SelectItem value='30'>Last 30 days</SelectItem>
            <SelectItem value='90'>Last 90 days</SelectItem>
          </SelectContent>
        </Select>
        <Button variant='outline' onClick={handleExport} disabled={exporting}>
          <Download className='size-4' />
          {exporting ? 'Exporting...' : 'Export'}
        </Button>
      </div>

      {lastExport && <ExportStatusNotice exportJob={lastExport} />}

      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <ReportCard title='Gross Sales' value={formatCurrency(report.grossSalesCents, report.currency)} icon={DollarSign} />
        <ReportCard title='Net Revenue' value={formatCurrency(report.netRevenueCents, report.currency)} icon={TrendingUp} />
        <ReportCard title='Tickets Sold' value={formatNumber(report.ticketsSold)} icon={Ticket} />
        <ReportCard title='Check-ins' value={formatNumber(report.checkIns)} icon={CalendarCheck} />
      </div>

      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <ReportCard title='Fees' value={formatCurrency(report.feesCents, report.currency)} icon={Receipt} />
        <ReportCard title='Tax' value={formatCurrency(report.taxCents, report.currency)} icon={Receipt} />
        <ReportCard title='Refunds' value={formatCurrency(report.refundsCents, report.currency)} icon={Receipt} />
        <ReportCard title='Paid Orders' value={formatNumber(report.paidOrdersCount)} icon={TrendingUp} />
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

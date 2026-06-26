'use client'

import { ReportsView } from '@/features/reports/reports-view'

export function EventReportsView({ eventId }: { eventId: string }) {
  return <ReportsView eventId={eventId} />
}

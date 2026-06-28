import { AttendeesTable } from '@/features/attendees/attendees-table';

export default function Page() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Attendees</h1>
          <p className="text-sm text-muted-foreground">Search, filter, and export your audience</p>
        </div>
      </div>
      <AttendeesTable />
    </div>
  );
}

import { HelpCircle } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';

export default function Page() {
  return (
    <div className="space-y-6">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 space-y-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Help</h1>
          <p className="text-sm text-muted-foreground">Guides, troubleshooting, and support</p>
        </div>
      </div>
      <EmptyState
        icon={HelpCircle}
        title="Help center coming soon"
        description="Documentation and support resources will be available here."
      />
    </div>
  );
}

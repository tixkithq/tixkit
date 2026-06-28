import { Suspense } from 'react';
import ConfirmationClient from './confirmation-client';

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-svh items-center justify-center p-6">
          <div className="size-6 animate-spin rounded-full border-2 border-muted border-t-foreground" />
        </div>
      }
    >
      <ConfirmationClient />
    </Suspense>
  );
}

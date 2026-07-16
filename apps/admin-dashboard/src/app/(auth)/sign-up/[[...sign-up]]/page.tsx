import { SignUp } from '@clerk/nextjs';
import { redirect } from 'next/navigation';
import { hasClerkKey, usesLocalDevAuth } from '@/lib/auth-server';
import { routes } from '@/lib/routes';

export default function SignUpPage() {
  if (usesLocalDevAuth()) redirect(routes.dashboard);
  if (!hasClerkKey()) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background p-6">
        <div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Authentication unavailable</p>
            <h1 className="text-2xl font-semibold tracking-tight">
              Admin sign-up is not configured
            </h1>
            <p className="text-sm text-muted-foreground">
              Configure a valid Clerk publishable key before using the production admin dashboard.
            </p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <SignUp fallbackRedirectUrl={routes.dashboard} signInFallbackRedirectUrl={routes.dashboard} />
    </main>
  );
}

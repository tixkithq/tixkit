import type { ReactNode } from 'react';
import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { hasClerkKey, usesLocalDevAuth } from '@/lib/auth';

type PrincipalError = {
  code: string;
  message: string;
  status?: number;
};

function isApiUnavailable(error: PrincipalError): boolean {
  return (
    error.status === undefined &&
    (error.code === 'network_error' || error.code === 'timeout' || error.code === 'unknown')
  );
}

function ApiUnavailableState({ apiBaseUrl, message }: { apiBaseUrl: string; message: string }) {
  return (
    <div className="flex min-h-svh items-center justify-center bg-neutral-950 p-6 text-white">
      <div className="w-full max-w-lg space-y-4 rounded-lg border border-white/10 bg-white/5 p-6 shadow-sm">
        <div className="space-y-2">
          <p className="text-sm font-medium text-white/55">Tixkit API unavailable</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Dashboard cannot reach the local API
          </h1>
          <p className="text-sm text-white/65">
            The admin session is signed in, but the API health check failed at{' '}
            <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs">{apiBaseUrl}</code>.
          </p>
        </div>
        <p className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-white/65">
          {message}
        </p>
      </div>
    </div>
  );
}

function AuthUnavailableState() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-neutral-950 p-6 text-white">
      <div className="w-full max-w-lg space-y-4 rounded-lg border border-white/10 bg-white/5 p-6 shadow-sm">
        <div className="space-y-2">
          <p className="text-sm font-medium text-white/55">Authentication unavailable</p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Dashboard authentication is not configured
          </h1>
          <p className="text-sm text-white/65">
            Configure a valid Clerk publishable key before using the production admin dashboard.
          </p>
        </div>
      </div>
    </div>
  );
}

export default async function EditorLayout({ children }: { children: ReactNode }) {
  const clerkEnabled = hasClerkKey();
  if (!clerkEnabled && !usesLocalDevAuth()) {
    return <AuthUnavailableState />;
  }

  if (clerkEnabled) {
    const { userId, getToken } = await auth();
    if (!userId) redirect('/sign-in');

    const token = await getToken();
    const { adminApi, getAdminApiBaseUrl } = await import('@/lib/api');
    const principalRes = await adminApi.getPrincipal(token ?? undefined);

    if (!principalRes.ok) {
      console.error('Failed to fetch Tixkit principal:', principalRes.error);
      if (isApiUnavailable(principalRes.error)) {
        return (
          <ApiUnavailableState
            apiBaseUrl={getAdminApiBaseUrl()}
            message={principalRes.error.message}
          />
        );
      }
      redirect('/sign-in?error=unauthorized');
    }
  }

  return children;
}

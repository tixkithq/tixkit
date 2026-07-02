import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';

function hasUsableClerkPublishableKey(): boolean {
  const key = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY;
  const hasKey = Boolean(
    key &&
    key !== 'pk_test_' &&
    key !== 'pk_live_' &&
    (key.startsWith('pk_test_') || key.startsWith('pk_live_')),
  );
  const provider = (
    process.env.NEXT_PUBLIC_AUTH_PROVIDER ??
    process.env.AUTH_PROVIDER ??
    (hasKey ? 'clerk' : undefined) ??
    (process.env.NODE_ENV === 'development' ? 'dev' : 'clerk')
  ).toLowerCase();
  const allowLocalAdminAuth =
    process.env.NODE_ENV === 'development' || process.env.E2E_LOCAL_ADMIN_AUTH === '1';
  if (allowLocalAdminAuth && provider === 'dev') return false;

  return hasKey;
}

const clerkProxy = clerkMiddleware();

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!hasUsableClerkPublishableKey()) {
    return NextResponse.next();
  }
  return clerkProxy(request, event);
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
};

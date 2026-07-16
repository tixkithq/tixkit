import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import {
  adminSecurityHeaders,
  INVALID_RUNTIME_SECURITY_HEADERS,
} from '@/lib/admin-security-headers';
import { parseAdminServerRuntimeConfig } from '@/lib/runtime-config-server';

const clerkProxy = clerkMiddleware();

function applySecurityHeaders(response: Response, headers: Readonly<Record<string, string>>) {
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

function requestPathname(request: NextRequest): string {
  return request.nextUrl?.pathname ?? '/';
}

function unavailableResponse(): NextResponse {
  return new NextResponse('Service unavailable', {
    status: 503,
    headers: INVALID_RUNTIME_SECURITY_HEADERS,
  });
}

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  let runtimeConfig;
  try {
    runtimeConfig = parseAdminServerRuntimeConfig().publicConfig;
  } catch {
    const pathname = requestPathname(request);
    if (pathname === '/health' || pathname === '/ready') {
      return applySecurityHeaders(NextResponse.next(), INVALID_RUNTIME_SECURITY_HEADERS);
    }
    return unavailableResponse();
  }

  let response;
  try {
    response =
      runtimeConfig.authProvider === 'clerk'
        ? await clerkProxy(request, event)
        : NextResponse.next();
  } catch {
    return unavailableResponse();
  }
  return applySecurityHeaders(response ?? NextResponse.next(), adminSecurityHeaders(runtimeConfig));
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
};

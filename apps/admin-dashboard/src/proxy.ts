import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server';
import {
  adminSecurityHeaders,
  INVALID_RUNTIME_SECURITY_HEADERS,
} from '@/lib/admin-security-headers';
import { parseAdminServerRuntimeConfig } from '@/lib/runtime-config-server';

const clerkProxy = clerkMiddleware((_auth, request) =>
  NextResponse.next({ request: { headers: request.headers } }),
);

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
  const pathname = requestPathname(request);
  if (pathname === '/health' || pathname === '/ready') {
    return applySecurityHeaders(NextResponse.next(), INVALID_RUNTIME_SECURITY_HEADERS);
  }

  let runtimeConfig;
  try {
    runtimeConfig = parseAdminServerRuntimeConfig().publicConfig;
  } catch {
    return unavailableResponse();
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const securityHeaders = adminSecurityHeaders(runtimeConfig, nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', securityHeaders['Content-Security-Policy']);
  const securedRequest = new NextRequest(request, { headers: requestHeaders });

  let response;
  try {
    response =
      runtimeConfig.authProvider === 'clerk'
        ? await clerkProxy(securedRequest, event)
        : NextResponse.next({ request: { headers: requestHeaders } });
  } catch {
    return unavailableResponse();
  }
  return applySecurityHeaders(
    response ?? NextResponse.next({ request: { headers: requestHeaders } }),
    securityHeaders,
  );
}

export const config = {
  matcher: [
    {
      source:
        '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
    '/(api|trpc)(.*)',
    '/__clerk/(.*)',
  ],
};

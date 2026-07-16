import { NextResponse, type NextRequest } from 'next/server';
import {
  checkoutSecurityHeaders,
  INVALID_RUNTIME_SECURITY_HEADERS,
} from './lib/checkout-security-headers';
import { parseCheckoutRuntimeConfig } from './lib/runtime-config-server';

function applyHeaders(response: NextResponse, values: Readonly<Record<string, string>>) {
  for (const [name, value] of Object.entries(values)) response.headers.set(name, value);
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  let runtimeConfig;
  try {
    runtimeConfig = parseCheckoutRuntimeConfig();
  } catch {
    if (request.nextUrl.pathname === '/health' || request.nextUrl.pathname === '/ready') {
      return applyHeaders(NextResponse.next(), INVALID_RUNTIME_SECURITY_HEADERS);
    }
    return applyHeaders(
      NextResponse.json(
        { error: { code: 'INVALID_RUNTIME_CONFIGURATION', message: 'Checkout is unavailable' } },
        { status: 503 },
      ),
      INVALID_RUNTIME_SECURITY_HEADERS,
    );
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const securityHeaders = checkoutSecurityHeaders(runtimeConfig, nonce, {
    noReferrer:
      request.nextUrl.pathname === '/checkout' || request.nextUrl.pathname.startsWith('/checkout/'),
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', securityHeaders['Content-Security-Policy']);
  return applyHeaders(NextResponse.next({ request: { headers: requestHeaders } }), securityHeaders);
}

export const config = {
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

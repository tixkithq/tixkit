import { NextResponse, type NextRequest } from 'next/server';

function exactOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export function checkoutContentSecurityPolicy(nonce: string): string {
  const apiOrigin = exactOrigin(
    process.env.NEXT_PUBLIC_TIXKIT_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL,
  );
  const development =
    process.env.NODE_ENV === 'production' ? [] : ['http://localhost:*', 'http://127.0.0.1:*'];
  const loopbackHttpApi = (() => {
    if (!apiOrigin) return false;
    const url = new URL(apiOrigin);
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    );
  })();
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https:",
    `img-src 'self' data: blob: ${apiOrigin ?? ''} https://q.stripe.com`
      .replaceAll(/\s+/g, ' ')
      .trim(),
    "font-src 'self' data:",
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com ${development.join(' ')}`.trim(),
    `connect-src 'self' ${apiOrigin ?? ''} https://api.stripe.com https://r.stripe.com ${development.join(' ')}`
      .replaceAll(/\s+/g, ' ')
      .trim(),
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com",
    "worker-src 'self' blob:",
    ...(loopbackHttpApi ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', checkoutContentSecurityPolicy(nonce));
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', checkoutContentSecurityPolicy(nonce));
  return response;
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

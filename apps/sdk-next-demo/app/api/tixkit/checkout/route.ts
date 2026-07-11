import { createCheckoutSessionRouteHandler } from '@tixkit/next/route-handlers';
import type { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const apiKey = process.env.TIXKIT_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'TIXKIT_API_KEY is not configured on the server.' },
      { status: 503 },
    );
  }
  return createCheckoutSessionRouteHandler({
    apiKey,
    apiBaseUrl: process.env.TIXKIT_API_BASE_URL ?? 'http://localhost:4200/v1',
    defaultSuccessUrl: process.env.TIXKIT_SUCCESS_URL ?? 'http://localhost:3000/success',
    defaultCancelUrl: process.env.TIXKIT_CANCEL_URL ?? 'http://localhost:3000/cancel',
  })(request);
}

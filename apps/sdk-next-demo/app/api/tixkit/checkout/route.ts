import { createCheckoutSessionRouteHandler } from '@tixkit/next/route-handlers';

export const POST = createCheckoutSessionRouteHandler({
  apiKey: process.env.TIXKIT_API_KEY ?? 'tk_test_demo',
  apiBaseUrl: process.env.TIXKIT_API_BASE_URL ?? 'http://localhost:4200/v1',
  defaultSuccessUrl: process.env.TIXKIT_SUCCESS_URL ?? 'http://localhost:3000/success',
  defaultCancelUrl: process.env.TIXKIT_CANCEL_URL ?? 'http://localhost:3000/cancel',
});

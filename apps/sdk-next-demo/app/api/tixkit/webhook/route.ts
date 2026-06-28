import { createTixkitWebhookRouteHandler } from '@tixkit/next/route-handlers';

export const POST = createTixkitWebhookRouteHandler({
  secret: process.env.TIXKIT_WEBHOOK_SECRET ?? 'whsec_demo',
  onEvent: async (event) => ({
    received: true,
    event,
    handledBy: 'sdk-next-demo',
  }),
});

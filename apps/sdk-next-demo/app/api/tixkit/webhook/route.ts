import { createTixkitWebhookRouteHandler } from '@tixkit/next/route-handlers';

export async function POST(request: Request) {
  const secret = process.env.TIXKIT_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json(
      { error: 'TIXKIT_WEBHOOK_SECRET is not configured on the server.' },
      { status: 503 },
    );
  }
  return createTixkitWebhookRouteHandler({
    secret,
    onEvent: async () => ({ received: true, handledBy: 'sdk-next-demo' }),
  })(request);
}

import type { APIRoute } from 'astro';
import { verifyTixkitWebhook } from '@tixkit/astro/server';

export const POST: APIRoute = async ({ request }) => {
  const body = await request.text();
  const signature = request.headers.get('tixkit-signature') ?? '';
  const secret = import.meta.env.TIXKIT_WEBHOOK_SECRET ?? process.env.TIXKIT_WEBHOOK_SECRET ?? '';

  if (!verifyTixkitWebhook({ body, signature, secret })) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const event = JSON.parse(body);
  console.log('Tixkit webhook received', event);
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

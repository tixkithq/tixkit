import type { APIRoute } from 'astro';
import { verifyTixkitWebhook } from '@tixkit/astro/server';

export const prerender = false;

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

  try {
    JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ received: true, handledBy: 'sdk-astro-demo' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

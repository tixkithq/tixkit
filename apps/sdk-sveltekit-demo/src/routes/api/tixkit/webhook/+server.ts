import { json, type RequestHandler } from '@sveltejs/kit';
import { verifyTixkitWebhook } from '@tixkit/sveltekit/server';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.text();
  const signature = request.headers.get('x-tixkit-signature') ?? '';
  const secret = process.env.TIXKIT_WEBHOOK_SECRET;
  if (!secret) {
    return json(
      { error: 'TIXKIT_WEBHOOK_SECRET is not configured on the server.' },
      { status: 503 },
    );
  }

  if (!verifyTixkitWebhook({ body, signature, secret })) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  try {
    JSON.parse(body);
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  return json({
    received: true,
    handledBy: 'sdk-sveltekit-demo',
  });
};

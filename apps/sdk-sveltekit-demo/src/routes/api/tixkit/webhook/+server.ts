import { json, type RequestHandler } from '@sveltejs/kit';
import { verifyTixkitWebhook } from '@tixkit/sveltekit/server';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.text();
  const signature = request.headers.get('x-tixkit-signature') ?? '';
  const secret = process.env.TIXKIT_WEBHOOK_SECRET ?? 'whsec_demo';

  if (!verifyTixkitWebhook({ body, signature, secret })) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  return json({
    received: true,
    event: body ? JSON.parse(body) : null,
    handledBy: 'sdk-sveltekit-demo',
  });
};

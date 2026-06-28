import type { ActionFunctionArgs } from '@remix-run/node';
import { json } from '@remix-run/node';
import { verifyTixkitWebhook } from '@tixkit/remix/server';

export async function action({ request }: ActionFunctionArgs) {
  const body = await request.text();
  const signature = request.headers.get('tixkit-signature') ?? '';
  const secret = process.env.TIXKIT_WEBHOOK_SECRET ?? '';

  if (!verifyTixkitWebhook({ body, signature, secret })) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  const event = JSON.parse(body);
  console.log('Tixkit webhook received', event);
  return json({ received: true });
}

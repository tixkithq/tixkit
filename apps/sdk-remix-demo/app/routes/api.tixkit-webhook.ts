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

  try {
    JSON.parse(body);
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  return json({ received: true, handledBy: 'sdk-remix-demo' });
}

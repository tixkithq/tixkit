import { verifyTixkitWebhook } from '@tixkit/vue/server';

export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  const bodyString = JSON.stringify(body);
  const signature = getHeader(event, 'tixkit-signature') ?? '';
  const secret = process.env.TIXKIT_WEBHOOK_SECRET ?? '';

  if (!verifyTixkitWebhook({ body: bodyString, signature, secret })) {
    return { status: 401, body: { error: 'Invalid signature' } };
  }

  console.log('Tixkit webhook received', body);
  return { received: true };
});

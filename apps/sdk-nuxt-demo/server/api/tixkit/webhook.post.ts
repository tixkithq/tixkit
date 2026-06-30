import { verifyTixkitWebhook } from '@tixkit/vue/server';

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event, 'utf8');
  const body = typeof rawBody === 'string' ? rawBody : '';
  const signature = getHeader(event, 'tixkit-signature') ?? '';
  const secret = process.env.TIXKIT_WEBHOOK_SECRET ?? '';

  if (!verifyTixkitWebhook({ body, signature, secret })) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid signature' });
  }

  let eventBody: unknown;
  try {
    eventBody = JSON.parse(body);
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid JSON body' });
  }

  console.log('Tixkit webhook received', eventBody);
  return { received: true, handledBy: 'sdk-nuxt-demo' };
});

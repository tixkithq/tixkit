import { verifyTixkitWebhook } from '@tixkit/vue/server';

export default defineEventHandler(async (event) => {
  const rawBody = await readRawBody(event, 'utf8');
  const body = typeof rawBody === 'string' ? rawBody : '';
  const signature = getHeader(event, 'tixkit-signature') ?? '';
  const secret = process.env.TIXKIT_WEBHOOK_SECRET ?? '';

  if (!verifyTixkitWebhook({ body, signature, secret })) {
    throw createError({ statusCode: 401, statusMessage: 'Invalid signature' });
  }

  try {
    JSON.parse(body);
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid JSON body' });
  }

  return { received: true, handledBy: 'sdk-nuxt-demo' };
});

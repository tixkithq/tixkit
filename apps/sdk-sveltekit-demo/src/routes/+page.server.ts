import type { Actions } from './$types';
import { createCheckoutFormAction, createTixkitClient } from '@tixkit/sveltekit/server';

export const actions: Actions = {
  checkout: async (event) => {
    const apiKey = process.env.TIXKIT_API_KEY;
    if (!apiKey)
      return { success: false, error: 'TIXKIT_API_KEY is not configured on the server.' };
    const client = createTixkitClient({
      apiKey,
      apiBaseUrl: process.env.TIXKIT_API_BASE_URL ?? 'http://localhost:4200/v1',
    });
    return createCheckoutFormAction(client, {
      successUrl: 'http://localhost:5173/success',
      cancelUrl: 'http://localhost:5173/cancel',
    })(event);
  },
};

import type { Actions } from './$types';
import { createCheckoutFormAction, createTixkitClient } from '@tixkit/sveltekit/server';

const client = createTixkitClient({
  apiKey: process.env.TIXKIT_API_KEY ?? 'tk_test_demo',
  apiBaseUrl: process.env.TIXKIT_API_BASE_URL ?? 'http://localhost:4200/v1',
});

export const actions: Actions = {
  checkout: createCheckoutFormAction(client, {
    successUrl: 'http://localhost:5173/success',
    cancelUrl: 'http://localhost:5173/cancel',
  }),
};

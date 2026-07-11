<script lang="ts">
  import { createFetchCheckoutTransport } from '@tixkit/checkout-headless';
  import { createTixkitCheckoutStore } from '@tixkit/checkout-headless/svelte';
  const transport = createFetchCheckoutTransport({ apiBaseUrl: 'https://api.example.test/v1' });
  const checkout = createTixkitCheckoutStore({ eventId: 'evt_example', transport });
  const state = checkout.state;
</script>
<main>Checkout state: {$state.phase}</main>

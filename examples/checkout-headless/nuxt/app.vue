<script setup lang="ts">
import { createFetchCheckoutTransport } from '@tixkit/checkout-headless';
import { useTixkitCheckout } from '@tixkit/checkout-headless/vue';
const transport = createFetchCheckoutTransport({ apiBaseUrl: 'https://api.example.test/v1' });
const { state } = useTixkitCheckout({ eventId: 'evt_example', transport });
</script>
<template>
  <main>Checkout state: {{ state.phase }}</main>
</template>

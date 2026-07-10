<template>
  <main style="font-family: system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 32px">
    <h1>Tixkit Nuxt Demo</h1>
    <p>Demonstrates the @tixkit/vue SDK: widget iframe, checkout handoff, and lifecycle events.</p>

    <section style="margin-top: 24px">
      <h2>Inline Widget</h2>
      <iframe
        id="tixkit-widget-demo"
        :src="widgetAttrs.src"
        :title="widgetAttrs.title"
        :sandbox="widgetAttrs.sandbox"
        :allow="widgetAttrs.allow"
        :referrerpolicy="widgetAttrs.referrerPolicy as ReferrerPolicy"
        style="width: 100%; height: 560px; border: 0"
      ></iframe>
    </section>

    <section style="margin-top: 24px">
      <h2>Checkout Handoff URL</h2>
      <code data-testid="checkout-handoff-url">{{ checkoutHandoffUrl }}</code>
    </section>

    <section style="margin-top: 24px">
      <h2>Lifecycle Events</h2>
      <output aria-label="Tixkit lifecycle events">{{
        events.join(', ') || 'No events yet'
      }}</output>
    </section>
  </main>
</template>

<script setup lang="ts">
import { useTixkitDemoState } from './app-state';

const { events, widgetAttrs, checkoutHandoffUrl } = useTixkitDemoState();
</script>

<script lang="ts">
  import TixkitWidget, { type TixkitWidgetProps } from '@tixkit/sveltekit/TixkitWidget.svelte';

  let lifecycleEvents = $state<string[]>([]);
  const widgetProps: TixkitWidgetProps = {
    widgetBaseUrl: 'http://localhost:3201',
    brand: 'brd_demo',
    event: 'evt_demo_sveltekit',
    trackingId: 'sveltekit-demo',
    mode: 'inline',
    height: '560px',
    onEvent: (event) => {
      lifecycleEvents = [...lifecycleEvents, event.type];
    },
  };
</script>

<main>
  <h1>Tixkit SvelteKit SDK Demo</h1>
  <p>External SvelteKit demo for the Tixkit widget component, form action helper, and webhook verification.</p>

  <TixkitWidget {...widgetProps} />

  <form method="POST" action="?/checkout">
    <input type="hidden" name="eventId" value="evt_demo_sveltekit" />
    <input type="hidden" name="idempotencyKey" value="demo-sveltekit-checkout" />
    <input type="hidden" name="ticketTypeId" value="tt_demo_general" />
    <input type="hidden" name="quantity" value="1" />
    <input type="email" name="buyerEmail" aria-label="Buyer email" value="buyer@example.test" />
    <button type="submit">Create checkout session</button>
  </form>

  <output aria-label="Tixkit lifecycle events">{lifecycleEvents.join(', ') || 'No events yet'}</output>
</main>

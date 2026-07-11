import { createApp, defineComponent, h } from 'vue';
import { createFetchCheckoutTransport } from '@tixkit/checkout-headless';
import { useTixkitCheckout } from '@tixkit/checkout-headless/vue';
const transport = createFetchCheckoutTransport({ apiBaseUrl: 'https://api.example.test/v1' });
createApp(
  defineComponent({
    setup() {
      const { state } = useTixkitCheckout({ eventId: 'evt_example', transport });
      return () => h('main', `Checkout state: ${state.value.phase}`);
    },
  }),
).mount('#app');

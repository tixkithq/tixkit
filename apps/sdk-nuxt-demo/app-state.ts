import { onBeforeUnmount, onMounted, ref } from 'vue';
import { checkoutUrl, parseTixkitWidgetMessage, tixkitWidgetIframeAttributes } from '@tixkit/vue';

export function useTixkitDemoState() {
  const config = useRuntimeConfig();
  const checkoutBaseUrl = config.public.tixkitCheckoutUrl as string;
  const events = ref<string[]>([]);

  const widgetAttrs = tixkitWidgetIframeAttributes({
    widgetBaseUrl: checkoutBaseUrl,
    brand: 'brd_demo',
    event: 'evt_demo',
    mode: 'inline',
    title: 'Tixkit Ticket Widget',
  });

  const checkoutHandoffUrl = checkoutUrl({
    event: 'evt_demo',
    brand: 'brd_demo',
    items: [{ ticketTypeId: 'tt_demo_general', quantity: 2 }],
    checkoutBaseUrl,
  });

  const handleMessage = (message: MessageEvent) => {
    const parsed = parseTixkitWidgetMessage(message, new URL(checkoutBaseUrl).origin);
    if (parsed) events.value.push(parsed.type);
  };

  onMounted(() => window.addEventListener('message', handleMessage));
  onBeforeUnmount(() => window.removeEventListener('message', handleMessage));

  return { events, widgetAttrs, checkoutHandoffUrl };
}

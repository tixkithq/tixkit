<script lang="ts" module>
  import type { TixkitCheckoutEvent, TixkitWidgetPostMessage } from './client.js';

  export type TixkitWidgetProps = {
    widgetBaseUrl?: string;
    apiBaseUrl?: string;
    brand: string;
    event: string;
    locale?: string;
    theme?: string;
    products?: string[];
    discountCode?: string;
    trackingId?: string;
    mode?: 'inline' | 'modal' | 'redirect';
    title?: string;
    height?: string;
    class?: string;
    style?: string;
    allowedOrigin?: string;
    onEvent?: (event: TixkitWidgetPostMessage) => void;
    onCheckoutEvent?: (event: TixkitCheckoutEvent) => void;
  };
</script>

<script lang="ts">
  import { tixkitWidgetIframeAttributes, parseTixkitWidgetMessage } from './client.js';

  let {
    widgetBaseUrl,
    apiBaseUrl,
    brand,
    event,
    locale,
    theme,
    products,
    discountCode,
    trackingId,
    mode = 'inline',
    title,
    height = '720px',
    class: className = '',
    style = '',
    allowedOrigin,
    onEvent,
    onCheckoutEvent,
  }: TixkitWidgetProps = $props();

  let attributes = $derived(
    tixkitWidgetIframeAttributes({
      widgetBaseUrl,
      apiBaseUrl,
      brand,
      event,
      locale,
      theme,
      products,
      discountCode,
      trackingId,
      mode,
      title,
    }),
  );

  let expectedOrigin = $derived(allowedOrigin ?? new URL(attributes.src).origin);
  let iframeStyle = $derived(`width:100%;height:${height};border:0;display:block;${style}`);

  function handleMessage(message: { origin: string; data: unknown }) {
    const payload = parseTixkitWidgetMessage(message, expectedOrigin, event);
    if (!payload) return;

    onEvent?.(payload);
    onCheckoutEvent?.(payload.type);
  }
</script>

<svelte:window onmessage={handleMessage} />

<iframe
  src={attributes.src}
  title={attributes.title}
  sandbox={attributes.sandbox}
  allow={attributes.allow}
  referrerpolicy={attributes.referrerPolicy}
  class={className}
  style={iframeStyle}
></iframe>

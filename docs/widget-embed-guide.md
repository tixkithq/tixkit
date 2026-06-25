# GateKit Widget Embed Guide

This guide covers the browser-only GateKit widget package. The widget is safe to load in public pages: it does not accept or embed secret API keys, payment provider secrets, session tokens, or admin credentials.

## Script Loading

Load the widget script once per page, then mount one or more custom elements.

```html
<script type="module" src="https://cdn.gatekit.com/widget/gatekit-widget.js"></script>
```

For local development against the checkout app:

```html
<script type="module" src="http://localhost:3000/gatekit-widget.js"></script>
```

## Inline Widget

Use `gatekit-widget` when tickets should render directly inside the page.

```html
<gatekit-widget
  brand="brand_demo"
  event="evt_demo"
  checkout-mode="inline"
  products="tt_general,tt_vip"
  discount-code="EARLYBIRD"
  tracking-id="affiliate_123"
  api-base-url="https://checkout.gatekit.com"
></gatekit-widget>
```

Supported attributes:

| Attribute | Required | Description |
| --- | --- | --- |
| `brand` | yes | Brand or white-label context allowed to sell the event. |
| `event` | yes | Event ID to render. |
| `checkout-mode` | no | `inline`, `modal`, or `redirect`. Defaults to `inline` for `gatekit-widget`. |
| `products` | no | Comma-separated ticket/product IDs to show or direct-link, including hidden tickets. |
| `discount-code` | no | Promo or access code to prefill. Server validation remains authoritative. |
| `tracking-id` | no | Non-PII attribution value persisted with checkout. |
| `locale` | no | Locale hint forwarded to hosted checkout. |
| `theme` | no | `auto`, `light`, or `dark`. |
| `api-base-url` | no | Checkout origin. Defaults to `https://checkout.gatekit.com`. |

## Button Embeds

Use `gatekit-button` when a page should open checkout from a button. The button defaults to modal mode.

```html
<gatekit-button
  brand="brand_demo"
  event="evt_demo"
  items="tt_general=2,tt_vip=1"
  checkout-mode="modal"
  discount-code="EARLYBIRD"
  tracking-id="affiliate_123"
  api-base-url="https://checkout.gatekit.com"
>
  Buy tickets
</gatekit-button>
```

`items` is a comma-separated list of `ticketTypeId=quantity` pairs. Hosted checkout recalculates price, fees, discounts, access rules, and inventory on the server; client values are only prefill hints.

## Checkout Modes

| Mode | Element | Behavior |
| --- | --- | --- |
| `inline` | `gatekit-widget` | Renders a sandboxed iframe in the host page and emits `opened` after the iframe loads. |
| `modal` | `gatekit-widget`, `gatekit-button` | Opens a sandboxed iframe in a shadow-DOM modal. Buyers can close it with the close button, backdrop, or Escape. |
| `redirect` | `gatekit-widget`, `gatekit-button` | Emits `opened` and `checkout_started`, then navigates the current page to hosted checkout. |

For `gatekit-button checkout-mode="inline"`, the runtime opens checkout in a new tab as a safe fallback because a button has no inline container.

## Lifecycle Events

Lifecycle events are dispatched from the host custom element. Attach listeners to each widget or button instance.

```html
<gatekit-widget id="tickets" brand="brand_demo" event="evt_demo"></gatekit-widget>

<script type="module">
  const widget = document.getElementById('tickets');

  for (const name of [
    'loaded',
    'loading',
    'opened',
    'closed',
    'checkout_started',
    'order_completed',
    'error',
  ]) {
    widget.addEventListener(name, (event) => {
      console.log(name, event.detail);
    });
  }
</script>
```

Event detail fields:

| Event | Detail |
| --- | --- |
| `loaded` | `{ event, eventId }` after the element is initialized. |
| `loading` | `{ event, eventId }` while an inline iframe is loading. |
| `opened` | `{ event, eventId }` after an inline/modal iframe loads, or immediately before redirect navigation. |
| `closed` | `{ event, eventId }` when a modal closes, the element disconnects, or the host page unloads. |
| `checkout_started` | `{ event, eventId, sessionId? }` from hosted checkout or immediately before redirect navigation. |
| `order_completed` | `{ event, eventId, sessionId?, orderId? }` from hosted checkout or the confirmation page. |
| `error` | `{ event, eventId, message }` for widget configuration or load failures. |

`event` and `eventId` are both present for compatibility. New integrations should read `eventId`.

## postMessage Origins

Hosted checkout posts messages with this shape:

```js
{
  source: 'gatekit-checkout',
  event: 'order_completed',
  type: 'order_completed',
  eventId: 'evt_demo',
  sessionId: 'cs_demo',
  orderId: 'ord_demo'
}
```

The widget accepts checkout messages only when:

- `event.origin` exactly matches the `api-base-url` origin.
- `data.source` is `gatekit-checkout`.
- `data.event` or `data.type` is a supported lifecycle event.
- `data.eventId`, when present, matches the element's `event` attribute.

The checkout frame uses `postMessage(..., '*')` because GateKit cannot know every merchant domain in advance. Host pages that listen to `window` messages directly must still validate `event.origin` before using the payload.

## Multiple Widgets On One Page

Load the script once and mount multiple elements.

```html
<script type="module" src="https://cdn.gatekit.com/widget/gatekit-widget.js"></script>

<gatekit-widget brand="brand_demo" event="evt_friday" products="tt_friday"></gatekit-widget>
<gatekit-widget brand="brand_demo" event="evt_saturday" products="tt_saturday"></gatekit-widget>
<gatekit-button brand="brand_demo" event="evt_weekend" items="tt_weekend=2">
  Weekend pass
</gatekit-button>
```

Current hosted checkout messages include `eventId`, so lifecycle events are routed only to the matching element. Legacy checkout messages without `eventId` are treated as compatible broadcasts.

## Modal Behavior

Modal checkouts are rendered inside the custom element shadow DOM. The modal:

- Uses a sandboxed iframe with payment and passkey permissions.
- Closes from the close button, backdrop click, Escape, disconnect, or page unload.
- Emits `closed` when the modal closes.
- Does not write session tokens or checkout secrets into the host page URL.

## Content Security Policy

At minimum, allow the widget script and checkout iframe origins. Replace the origins with your CDN and checkout/custom-domain origins.

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://cdn.gatekit.com;
  frame-src https://checkout.gatekit.com;
  child-src https://checkout.gatekit.com;
  connect-src 'self' https://checkout.gatekit.com;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  frame-ancestors 'self';
```

Notes:

- `style-src 'unsafe-inline'` is currently required because the widget injects shadow-DOM styles at runtime and supports CSS custom property overrides.
- Add your brand custom checkout domain to `frame-src`, `child-src`, and `connect-src` when using white-label checkout.
- If the host page uses a strict `script-src` nonce, serve the widget script from an allowed external origin instead of inlining it.
- The checkout iframe has its own CSP; host-page CSP controls whether the frame can load, not what checkout can load inside the frame.

## No-Secret Guarantees

Do not put secret values in widget attributes. The browser widget contract is:

- Public identifiers only: brand ID, event ID, ticket/product IDs, promo/access codes, and non-PII tracking IDs.
- No secret API keys, payment secrets, admin tokens, session tokens, or webhook secrets.
- Checkout price, inventory, access codes, discounts, taxes, and fees are always recalculated by the server.
- Session tokens are owned by hosted checkout and are not serialized into widget URLs.

## Styling

The widget exposes CSS custom properties on the host element.

```css
gatekit-widget,
gatekit-button {
  --gk-radius: 8px;
  --gk-primary: #111827;
  --gk-bg: #ffffff;
  --gk-fg: #111827;
}
```

These tokens are visual only. They do not affect brand authorization or checkout behavior.

# Tixkit Widget Embed Guide

This guide covers the browser-only Tixkit widget package. The widget is safe to load in public pages: it does not accept or embed secret API keys, payment provider secrets, session tokens, or admin credentials.

Embed Contract v1 is owned by `@tixkit/embed-core`. The CLI and interactive `docs/embed-generator.html` import that package instead of maintaining separate generation logic. Use `bun run embed:generate --event-id <id> --brand-id <id> --platform webflow --allowed-origin https://merchant.example` to produce a validated snippet, strict feature-derived CSP, and placement instructions.

## Script Loading

Load the widget script once per page, then mount one or more custom elements.

```html
<script
  type="module"
  src="https://cdn.tixkit.com/widget/v0.1.0/tixkit-widget-0.1.0.js"
  integrity="sha384-dekV7a3DQg8bDdculs4uy24zS9CiyMfb4QpROp1Pb878LK63cHRC212CsRjzESAB"
  crossorigin="anonymous"
></script>
```

For local development against the checkout app:

```html
<script type="module" src="http://localhost:3000/tixkit-widget.js"></script>
```

## Inline Widget

Use `tixkit-widget` when tickets should render directly inside the page.

```html
<tixkit-widget
  brand="brand_demo"
  event="evt_demo"
  checkout-mode="inline"
  products="tt_general,tt_vip"
  discount-code="EARLYBIRD"
  tracking-id="campaign_spring_launch"
  api-base-url="https://checkout.tixkit.com"
  host-origin="https://merchant.example"
></tixkit-widget>
```

Supported attributes:

| Attribute           | Required | Description                                                                                                                                      |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `brand`             | yes      | Brand or white-label context allowed to sell the event.                                                                                          |
| `event`             | yes      | Event ID to render.                                                                                                                              |
| `checkout-mode`     | no       | `inline`, `modal`, or `redirect`. Defaults to `inline` for `tixkit-widget`.                                                                      |
| `products`          | no       | Comma-separated ticket/product IDs to show or direct-link, including hidden tickets.                                                             |
| `discount-code`     | no       | Promo or access code to prefill. Server validation remains authoritative.                                                                        |
| `tracking-id`       | no       | Non-PII attribution value persisted with checkout. Affiliate/referral attribution is separate and must use an explicit affiliate code parameter. |
| `locale`            | no       | Locale hint forwarded to hosted checkout.                                                                                                        |
| `theme`             | no       | `auto`, `light`, or `dark`.                                                                                                                      |
| `api-base-url`      | no       | Checkout origin. Defaults to `https://checkout.tixkit.com`.                                                                                      |
| `reporting-api-url` | no       | API origin for persisted widget impressions. Defaults to `https://api.tixkit.com`, or `localhost:4000` when checkout runs on localhost.          |
| `host-origin`       | no       | Exact host page origin used by the v1 handshake. When set, it must match `window.location.origin`.                                               |

## Button Embeds

Use `tixkit-button` when a page should open checkout from a button. The button defaults to modal mode.

```html
<tixkit-button
  brand="brand_demo"
  event="evt_demo"
  items="tt_general=2,tt_vip=1"
  checkout-mode="modal"
  discount-code="EARLYBIRD"
  tracking-id="campaign_spring_launch"
  locale="fr-FR"
  theme="dark"
  api-base-url="https://checkout.tixkit.com"
  host-origin="https://merchant.example"
>
  Buy tickets
</tixkit-button>
```

`tixkit-button` consumes the same locale, theme, checkout origin, reporting origin, and host-origin attributes as `tixkit-widget`. `items` is a comma-separated list of `ticketTypeId=quantity` pairs. Hosted checkout recalculates price, fees, discounts, access rules, and inventory on the server; client values are only prefill hints.

## Checkout Modes

| Mode       | Element                          | Behavior                                                                                                                                        |
| ---------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `inline`   | `tixkit-widget`                  | Renders a sandboxed iframe in the host page and emits `opened` after the iframe loads.                                                          |
| `modal`    | `tixkit-widget`, `tixkit-button` | Opens a sandboxed iframe in a shadow-DOM modal. Buyers can close it with the close button, backdrop, or Escape.                                 |
| `redirect` | `tixkit-widget`, `tixkit-button` | Emits `opened`, then navigates the current page to hosted checkout. Checkout lifecycle starts only after hosted checkout confirms buyer intent. |

For `tixkit-button checkout-mode="inline"`, the runtime opens checkout in a new tab as a safe fallback because a button has no inline container.

## Lifecycle Events

Lifecycle events are dispatched from the host custom element. Attach listeners to each widget or button instance.

```html
<tixkit-widget id="tickets" brand="brand_demo" event="evt_demo"></tixkit-widget>

<script type="module">
  const widget = document.getElementById('tickets');

  for (const name of [
    'tixkit:v1:loading',
    'tixkit:v1:ready',
    'tixkit:v1:opened',
    'tixkit:v1:closed',
    'tixkit:v1:checkout-started',
    'tixkit:v1:checkout-session-created',
    'tixkit:v1:order-completed',
    'tixkit:v1:recoverable-error',
    'tixkit:v1:fatal-error',
  ]) {
    widget.addEventListener(name, (event) => {
      console.log(name, event.detail);
    });
  }
</script>
```

Event detail fields:

Every detail contains `contractVersion`, `widgetId`, `eventId`, `mode`, `timestamp`, and `name`. Session creation adds `sessionId`; order completion adds `orderId` and may add `sessionId`; errors add `errorCode`, `message`, and `retryable`; close adds a bounded `reason`. Buyer names, email, phone, address, answers, access/promo values, payment data, and provider secrets are never included.

Legacy aliases remain available during the compatibility window: `loaded`, `loading`, `opened`, `closed`, `checkout_started`, `order_completed`, and `error`. New integrations must use `tixkit:v1:*` names. `event` remains in legacy event details as an alias of `eventId`.

## Marketing Integrations

Event marketing integrations are configured in the admin event detail page or through the API. Active GA4, Meta Pixel, and generic HTTPS pixel configs are exposed through the public event contract without tenant, organization, buyer, or attendee PII.

Hosted checkout/event pages and widget host flows emit these ecommerce events:

Hosted event pages render through the shared event-page renderer (the same resolver/render model as the admin canvas and admin preview drawer), so widget/marketing integrations see the same published page surface attendees see. Event pages use canonical structured `EventPageDocument` JSON, not raw HTML, and `@react-email/editor` is not involved in event-page rendering. See `docs/event-page-renderer-parity-implementation-plan.md`.

| Tixkit event              | GA4              | Meta Pixel         | Generic pixel parameter   |
| ------------------------- | ---------------- | ------------------ | ------------------------- |
| Event page or widget view | `view_item`      | `PageView`         | `tk_event=view_item`      |
| Checkout session created  | `begin_checkout` | `InitiateCheckout` | `tk_event=begin_checkout` |
| Order completed           | `purchase`       | `Purchase`         | `tk_event=purchase`       |

Payloads include event ID, session/order IDs when present, currency/value when known, and item IDs/names/quantities when known. Buyer email, name, phone, address, and attendee answers are never sent.

Consent-gated integrations fire only when the browser has `localStorage["tixkit_marketing_consent"]` set to `granted`, `true`, or `1`. If an integration is configured with `consentRequired=false`, it can fire without that key. Host sites are responsible for setting the key after their consent manager records valid marketing consent.

## postMessage Origins

The host starts a per-iframe handshake with this shape:

```js
{
  contractVersion: '1.0',
  source: 'tixkit-embed-host',
  type: 'host:hello',
  widgetId: 'tkw_opaque',
  eventId: 'evt_demo',
  nonce: 'per-instance-random-nonce',
  hostOrigin: 'https://merchant.example'
}
```

Hosted checkout acknowledges the exact source window and origin, then emits lifecycle messages such as:

```js
{
  contractVersion: '1.0',
  source: 'tixkit-checkout',
  type: 'checkout:lifecycle',
  widgetId: 'tkw_opaque',
  eventId: 'evt_demo',
  nonce: 'per-instance-random-nonce',
  lifecycle: 'order-completed',
  sessionId: 'cs_demo',
  orderId: 'ord_demo'
}
```

The widget accepts checkout messages only when:

- `contractVersion` is exactly a supported v1 version; unknown versions fail closed.
- `event.origin` exactly matches the active `api-base-url` checkout origin.
- `event.source` is exactly the active iframe `contentWindow`.
- `source`, `type`, lifecycle payload, widget ID, event ID, and nonce pass the public schema.
- The nonce belongs to the current render; stale or replaced frames cannot emit events.

Neither peer uses `postMessage(..., '*')`. The widget sends to the checkout origin and checkout replies to the validated handshake origin. `host-origin` makes an explicitly generated allowed origin active instead of validation-only configuration.

## Multiple Widgets On One Page

Load the script once and mount multiple elements.

```html
<script
  type="module"
  src="https://cdn.tixkit.com/widget/v0.1.0/tixkit-widget-0.1.0.js"
  integrity="sha384-dekV7a3DQg8bDdculs4uy24zS9CiyMfb4QpROp1Pb878LK63cHRC212CsRjzESAB"
  crossorigin="anonymous"
></script>

<tixkit-widget brand="brand_demo" event="evt_friday" products="tt_friday"></tixkit-widget>
<tixkit-widget brand="brand_demo" event="evt_saturday" products="tt_saturday"></tixkit-widget>
<tixkit-button brand="brand_demo" event="evt_weekend" items="tt_weekend=2">
  Weekend pass
</tixkit-button>
```

Each instance has a unique widget ID and nonce, so even two widgets for the same event cannot cross-associate messages. Messages without an event ID, widget ID, nonce, or supported contract version fail closed.

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
  script-src 'self' https://cdn.tixkit.com;
  frame-src https://checkout.tixkit.com;
  connect-src 'self' https://checkout.tixkit.com;
  style-src 'self';
  img-src 'self' data:;
  object-src 'none';
  base-uri 'self';
  frame-ancestors 'self';
```

Notes:

- The widget uses constructable shadow-DOM stylesheets in supported browsers, so `'unsafe-inline'` is not required.
- Add only your selected custom checkout origin to `frame-src` and `connect-src` when using white-label checkout.
- Generate the exact feature profile with `generateCspProfile`; marketing domains appear only when marketing integrations are enabled.
- If the host page uses a strict `script-src` nonce, serve the widget script from an allowed external origin instead of inlining it.
- The checkout iframe has its own CSP; host-page CSP controls whether the frame can load, not what checkout can load inside the frame.
- If widget host marketing integrations are enabled, `script-src` must allow GA4 and/or Meta script origins, and `img-src` must allow the configured generic HTTPS pixel origin.

## No-Secret Guarantees

Do not put secret values in widget attributes. The browser widget contract is:

- Public identifiers only: brand ID, event ID, ticket/product IDs, promo/access codes, and non-PII tracking IDs.
- No secret API keys, payment secrets, admin tokens, session tokens, or webhook secrets.
- Checkout price, inventory, access codes, discounts, taxes, and fees are always recalculated by the server.
- Session tokens are owned by hosted checkout and are not serialized into widget URLs.

## Styling

The widget exposes CSS custom properties on the host element.

```css
tixkit-widget,
tixkit-button {
  --tk-radius: 8px;
  --tk-primary: #111827;
  --tk-bg: #ffffff;
  --tk-fg: #111827;
}
```

These tokens are visual only. They do not affect brand authorization or checkout behavior.

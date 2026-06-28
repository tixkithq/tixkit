# Tixkit Widget Embed Guide

This guide covers the browser-only Tixkit widget package. The widget is safe to load in public pages: it does not accept or embed secret API keys, payment provider secrets, session tokens, or admin credentials.

Phase 4 embed generator (C-060): Use `bun run embed:generate --event-id <id> --brand-id <id> --platform webflow` to produce a validated, copy-paste snippet with CSP guidance and placement instructions. An interactive HTML generator is at `docs/embed-generator.html`. The manual examples below remain useful for custom integrations.

## Script Loading

Load the widget script once per page, then mount one or more custom elements.

```html
<script type="module" src="https://cdn.tixkit.com/widget/tixkit-widget.js"></script>
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
  api-base-url="https://checkout.tixkit.com"
>
  Buy tickets
</tixkit-button>
```

`items` is a comma-separated list of `ticketTypeId=quantity` pairs. Hosted checkout recalculates price, fees, discounts, access rules, and inventory on the server; client values are only prefill hints.

## Checkout Modes

| Mode       | Element                          | Behavior                                                                                                        |
| ---------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `inline`   | `tixkit-widget`                  | Renders a sandboxed iframe in the host page and emits `opened` after the iframe loads.                          |
| `modal`    | `tixkit-widget`, `tixkit-button` | Opens a sandboxed iframe in a shadow-DOM modal. Buyers can close it with the close button, backdrop, or Escape. |
| `redirect` | `tixkit-widget`, `tixkit-button` | Emits `opened` and `checkout_started`, then navigates the current page to hosted checkout.                      |

For `tixkit-button checkout-mode="inline"`, the runtime opens checkout in a new tab as a safe fallback because a button has no inline container.

## Lifecycle Events

Lifecycle events are dispatched from the host custom element. Attach listeners to each widget or button instance.

```html
<tixkit-widget id="tickets" brand="brand_demo" event="evt_demo"></tixkit-widget>

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

| Event              | Detail                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `loaded`           | `{ event, eventId }` after the element is initialized.                                              |
| `loading`          | `{ event, eventId }` while an inline iframe is loading.                                             |
| `opened`           | `{ event, eventId }` after an inline/modal iframe loads, or immediately before redirect navigation. |
| `closed`           | `{ event, eventId }` when a modal closes, the element disconnects, or the host page unloads.        |
| `checkout_started` | `{ event, eventId, sessionId? }` from hosted checkout or immediately before redirect navigation.    |
| `order_completed`  | `{ event, eventId, sessionId?, orderId? }` from hosted checkout or the confirmation page.           |
| `error`            | `{ event, eventId, message }` for widget configuration or load failures.                            |

`event` and `eventId` are both present for compatibility. New integrations should read `eventId`.

## Marketing Integrations

Event marketing integrations are configured in the admin event detail page or through the API. Active GA4, Meta Pixel, and generic HTTPS pixel configs are exposed through the public event contract without tenant, organization, buyer, or attendee PII.

Hosted checkout/event pages and widget host flows emit these ecommerce events:

| Tixkit event              | GA4              | Meta Pixel         | Generic pixel parameter   |
| ------------------------- | ---------------- | ------------------ | ------------------------- |
| Event page or widget view | `view_item`      | `PageView`         | `tk_event=view_item`      |
| Checkout session created  | `begin_checkout` | `InitiateCheckout` | `tk_event=begin_checkout` |
| Order completed           | `purchase`       | `Purchase`         | `tk_event=purchase`       |

Payloads include event ID, session/order IDs when present, currency/value when known, and item IDs/names/quantities when known. Buyer email, name, phone, address, and attendee answers are never sent.

Consent-gated integrations fire only when the browser has `localStorage["tixkit_marketing_consent"]` set to `granted`, `true`, or `1`. If an integration is configured with `consentRequired=false`, it can fire without that key. Host sites are responsible for setting the key after their consent manager records valid marketing consent.

## postMessage Origins

Hosted checkout posts messages with this shape:

```js
{
  source: 'tixkit-checkout',
  event: 'order_completed',
  type: 'order_completed',
  eventId: 'evt_demo',
  sessionId: 'cs_demo',
  orderId: 'ord_demo'
}
```

The widget accepts checkout messages only when:

- `event.origin` exactly matches the `api-base-url` checkout origin.
- `data.source` is `tixkit-checkout`.
- `data.event` or `data.type` is a supported lifecycle event.
- `data.eventId`, when present, matches the element's `event` attribute.

The checkout frame uses `postMessage(..., '*')` because Tixkit cannot know every merchant domain in advance. Host pages that listen to `window` messages directly must still validate `event.origin` before using the payload.

## Multiple Widgets On One Page

Load the script once and mount multiple elements.

```html
<script type="module" src="https://cdn.tixkit.com/widget/tixkit-widget.js"></script>

<tixkit-widget brand="brand_demo" event="evt_friday" products="tt_friday"></tixkit-widget>
<tixkit-widget brand="brand_demo" event="evt_saturday" products="tt_saturday"></tixkit-widget>
<tixkit-button brand="brand_demo" event="evt_weekend" items="tt_weekend=2">
  Weekend pass
</tixkit-button>
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
  script-src 'self' https://cdn.tixkit.com https://www.googletagmanager.com https://connect.facebook.net;
  frame-src https://checkout.tixkit.com;
  child-src https://checkout.tixkit.com;
  connect-src 'self' https://checkout.tixkit.com https://www.google-analytics.com https://www.googletagmanager.com https:;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  frame-ancestors 'self';
```

Notes:

- `style-src 'unsafe-inline'` is currently required because the widget injects shadow-DOM styles at runtime and supports CSS custom property overrides.
- Add your brand custom checkout domain to `frame-src`, `child-src`, and `connect-src` when using white-label checkout.
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

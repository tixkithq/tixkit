# Puck Event Page Contract

This is the hard-cutover contract for event pages. Schema v2 is Puck-only content and uses `@puckeditor/core` terminology: `Config`, `Data`, root props, `content`, `zones`, `<Puck>`, and `<Render>`.

Shared imports:

- Server-safe contract, validation guards, migration signatures, and Puck data aliases: `@tixkit/content-event-page/puck`
- React-side Puck config and render wrapper: `@tixkit/content-event-page-react/puck`

`EventPageDocumentV2` stores canonical Puck data at `editor.data` with `editor.provider: "@puckeditor/core"`. It does not store the old TipTap `editor.document`, the old typed `blocks[]` store, server-rendered HTML, headless blocks, or a `renderModel`.

Public checkout consumes `PublicEventPagePayloadV2.page.puckData`. The payload keeps document/version metadata, discovery data, settings, and the shared validation shape. Runtime fields from the old event-page surface are not part of the v2 payload: `page.html`, `page.text`, `page.headless`, `page.renderModel`, `version.renderedHtml`, `version.renderedText`, and public `contentJson`.

Responsibility split:

- Checkout Form remains the checkout data-collection editor.
- Event Page owns the complete Puck page composition, including editable header, ticket, product add-on, resale, checkout CTA, and footer blocks.
- Public checkout supplies live runtime data and interaction handlers to those blocks; it does not inject a second visual chrome outside the Puck document.

The v2 guards accept canonical PascalCase component types such as `EventHeader`, `Tickets`, `ProductAddOns`, `ResaleTickets`, `CheckoutCta`, and `BrandFooter`. Legacy snake_case commerce types such as `event_header`, `tickets`, `products`, `resale_tickets`, and `brand_footer` are rejected after migration.

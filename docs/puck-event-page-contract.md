# Puck Event Page Contract

This is the hard-cutover contract for event pages. Schema v2 is Puck-only content and uses `@puckeditor/core` terminology: `Config`, `Data`, root props, `content`, `zones`, `<Puck>`, and `<Render>`.

Shared imports:

- Server-safe contract, validation guards, migration signatures, and Puck data aliases: `@tixkit/content-event-page/puck`
- React-side Puck config and render wrapper: `@tixkit/content-event-page-react/puck`

`EventPageDocumentV2` stores canonical Puck data at `editor.data` with `editor.provider: "@puckeditor/core"`. It does not store the old TipTap `editor.document`, the old typed `blocks[]` store, server-rendered HTML, headless blocks, or a `renderModel`.

Public checkout consumes `PublicEventPagePayloadV2.page.puckData`. The payload keeps document/version metadata, discovery data, settings, and the shared validation shape. Runtime fields from the old event-page surface are not part of the v2 payload: `page.html`, `page.text`, `page.headless`, `page.renderModel`, `version.renderedHtml`, `version.renderedText`, and public `contentJson`.

Responsibility split:

- Checkout Form remains the checkout data-collection editor.
- Event Page owns Puck content blocks only.
- Public checkout owns commerce chrome: header, tickets, resale, checkout CTA behavior, and footer.

The v2 guards reject checkout chrome component types inside Puck `content` or `zones`, including `event_header`, `tickets`, `products`, `resale_tickets`, and `brand_footer`.

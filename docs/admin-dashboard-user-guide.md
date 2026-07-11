# Tixkit Admin Dashboard User Guide

This guide is for organizers, box-office operators, support staff, and developers using the Tixkit admin dashboard.

## Create and launch an event

Use **Events → Create event** to open `/events/new`. Choose a starting point, then enter only the title, schedule, timezone, currency, and optional venue. The browser timezone is suggested when the workspace has no saved default. The event is immediately stored as a draft and opens in its launch center.

The launch center is the source of truth for setup progress. Required blockers must pass before publication; recommended items can be addressed later. Each available action opens the existing specialist editor for tickets, products, checkout questions, event-page content, messages, payments, preview, or check-in. Actions the current role cannot perform are not offered.

Preview is authenticated for unpublished events. Marking preview reviewed is explicit and is invalidated when relevant event, ticket, checkout, product, or content state changes. In capture/mock or provider-test mode, **Run safe test checkout** exercises real availability, pricing, questions, and product rules without charging, issuing tickets, consuming inventory, or affecting production reports.

Use `/events/{eventId}/settings` for advanced settings. Sections cover basics, schedule and structured venue, sales, owned media uploads with alt text, and SEO/marketing. Changes save with event-version checks; if another editor changes the event first, reload the latest version before retrying. Published events collapse setup guidance and prioritize operational health, while readiness remains available as a secondary action.

## First Run

Before selling tickets:

1. Open Workspace and confirm the organization, brand, and member access.
2. Open Brand and set the public name, primary color, support links, and domains.
3. Open Payments and connect or refresh the payment account before publishing paid tickets.
4. Invite members with the smallest permission set they need.
5. Keep events in draft until tickets, checkout, payment, and confirmation paths are ready.

## Launch An Event

1. Create the event from Events.
2. Add ticket types with clear names, prices, capacity, and visibility rules.
3. Configure checkout questions and consent text.
4. Review the event detail quick links for tickets, messages, reports, and public checkout.
5. Publish only after the public page, checkout, payment account, and confirmation path are ready.

## Orders And Refunds

Use order detail as the source of truth for buyer state, line items, attendees, refunds, and timeline activity.

1. Search Orders by buyer name, email, or order status.
2. Open order detail before refunding or cancelling.
3. Use full refund for the full remaining balance.
4. Use partial refund for a specific amount and record a specific reason.
5. Void tickets and restore inventory only when the operational outcome requires those changes.

## Check-In

1. Open Check-in and select the event.
2. Choose the correct check-in list for the door, session, or zone.
3. Scan QR codes and confirm accepted, duplicate, revoked, or invalid results.
4. Use manual lookup when a QR code is damaged or the attendee needs identity confirmation.
5. Review duplicate and invalid scans after the door opens.

## Messages And Reports

1. Create messages from Messages or from an event message surface.
2. Preview recipients before sending.
3. Review queued, delivered, failed, and suppressed counts separately.
4. Use Reports for sales and export workflows.
5. Verify date range, event selection, refunds, and export status before sharing numbers externally.

## Developer API And Webhooks

1. Create API keys only for server-side integrations.
2. Choose the narrowest API scopes possible.
3. Store the one-time API key secret immediately; it will not be shown again.
4. Create webhook endpoints with HTTPS URLs.
5. Verify webhook signatures and timestamps before trusting payloads.
6. Replay webhook events only after the destination bug or outage is fixed.

## Troubleshooting

| Problem                             | First checks                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Paid checkout did not issue tickets | Open Orders, search by buyer email or payment reference, and check the order timeline before retrying or refunding. |
| Scanner says duplicate              | Confirm the selected event and check-in list, then review attendee status before overriding at the door.            |
| Webhook delivery failed             | Open Developer > Webhooks, inspect endpoint status and recent events, then replay after the destination is healthy. |
| Report looks incomplete             | Verify date range, event selection, refund state, and export status before sharing externally.                      |

## Related Operator Docs

- API reference: `docs/api-reference.md`
- Webhook guide: `docs/webhook-guide.md`
- Widget embed guide: `docs/widget-embed-guide.md`
- Production deployment guide: `docs/production-deployment-guide.md`
- Incident runbooks: `docs/incident-runbooks.md`

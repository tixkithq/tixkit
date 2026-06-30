# Rust SDK

API version: `2026-01-01`

Use the `tixkit` crate for async Rust services that need typed Tixkit API access,
idempotent checkout/order operations, cursor pagination, and webhook signature
verification.

```rust
use tixkit::{Buyer, CheckoutItem, CreateCheckoutSession, TixkitClient, TIXKIT_API_VERSION};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = TixkitClient::builder()
        .api_key(std::env::var("TIXKIT_API_KEY")?)
        .api_version(TIXKIT_API_VERSION)
        .build()?;

    let session = client.checkout().create(
        CreateCheckoutSession {
            event_id: "evt_123".to_string(),
            items: vec![CheckoutItem {
                ticket_type_id: Some("tt_123".to_string()),
                occurrence_id: None,
                product_id: None,
                quantity: 1,
                unit_amount_cents: None,
                attendee_fields: None,
            }],
            buyer: Some(Buyer {
                email: Some("buyer@example.com".to_string()),
                first_name: None,
                last_name: None,
                phone: None,
            }),
            buyer_fields: None,
            discount_code: None,
            affiliate_code: None,
            tracking_id: None,
            success_url: None,
            cancel_url: None,
            access_code: None,
            waitlist_claim_token: None,
        },
        "checkout-idempotency-key",
    ).await?;

    println!("checkout session {}", session.id);
    Ok(())
}
```

## Resale

Resale reads use cursor pagination; resale writes require an idempotency key:

```rust
use tixkit::{CompleteResaleListing, CreateResaleListing, PageParams};

let listings = client.events().list_resale_listings(
    "evt_123",
    PageParams {
        cursor: None,
        limit: Some(25),
    },
).await?;

let listing = client.tickets().create_resale_listing(
    "tkt_123",
    CreateResaleListing {
        price_cents: 5500,
        expires_at: Some("2026-07-01T00:00:00.000Z".to_string()),
    },
    "resale-list-tkt-123",
).await?;

client
    .tickets()
    .delist_resale_listing(&listing.id, format!("resale-delist-{}", listing.id))
    .await?;

client.tickets().complete_resale_listing(
    &listings.items[0].id,
    CompleteResaleListing {
        buyer_id: "usr_456".to_string(),
        buyer_email: "buyer@example.com".to_string(),
        buyer_first_name: None,
        buyer_last_name: None,
        buyer_phone: None,
        external_payment_reference: Some("stripe_pi_...".to_string()),
    },
    format!("resale-complete-{}", listings.items[0].id),
).await?;
```

Buyer-owned checkout sessions list issued wallet-pass tickets by passing the session client token separately from the JSON body:

```rust
client.checkout().create_ticket_resale_listing(
    "cs_123",
    "tkt_123",
    CreateResaleListing {
        price_cents: 5500,
        expires_at: None,
    },
    "client_...",
    "buyer-resale-tkt-123",
).await?;
```

Webhook verification expects Tixkit's `X-Tixkit-Signature` header in the
current `t=<timestamp>,v1=<hex>` format and performs constant-time comparison
before deserializing the event:

```rust
let event = tixkit::verify_tixkit_webhook(raw_body, signature_header, webhook_secret)?;
```

## Validation

Run these from `packages/sdk-rust`:

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --examples
cargo package --allow-dirty
```

The crate manifest includes crates.io/docs.rs metadata and an explicit package
include list so local build artifacts are not published.

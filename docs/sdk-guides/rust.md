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
```

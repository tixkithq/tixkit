# Tixkit Rust SDK

Async Rust client for the Tixkit API, pinned to API version `2026-01-01`.

The crate provides typed resources for checkout sessions, events, ticket types,
orders, refunds, attendees, check-in, questions, waitlist, reports, exports,
webhooks, developer API keys, cursor pagination, idempotency keys, typed API
errors, and `X-Tixkit-Signature` webhook verification.

## Install

```bash
cargo add tixkit
```

## Create a checkout session

```rust
use tixkit::{Buyer, CheckoutItem, CreateCheckoutSession, TIXKIT_API_VERSION, TixkitClient};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = TixkitClient::builder()
        .api_key(std::env::var("TIXKIT_API_KEY")?)
        .api_version(TIXKIT_API_VERSION)
        .build()?;

    let session = client
        .checkout()
        .create(
            CreateCheckoutSession {
                event_id: std::env::var("TIXKIT_EVENT_ID")?,
                items: vec![CheckoutItem {
                    ticket_type_id: Some(std::env::var("TIXKIT_TICKET_TYPE_ID")?),
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
        )
        .await?;

    println!("checkout session {}", session.id);
    Ok(())
}
```

## Verify webhooks

```rust
let event = tixkit::verify_tixkit_webhook(raw_body, signature_header, webhook_secret)?;
```

Webhook verification expects Tixkit's `X-Tixkit-Signature` header in the
`t=<timestamp>,v1=<hex>` format and performs constant-time HMAC comparison
before returning the parsed event.

## Local validation

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --examples
cargo package --list
cargo package --allow-dirty
```

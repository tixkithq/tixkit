use tixkit::{Buyer, CheckoutItem, CreateCheckoutSession, TIXKIT_API_VERSION, TixkitClient};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_key = std::env::var("TIXKIT_API_KEY")?;
    let event_id = std::env::var("TIXKIT_EVENT_ID")?;
    let ticket_type_id = std::env::var("TIXKIT_TICKET_TYPE_ID")?;

    let client = TixkitClient::builder()
        .api_key(api_key)
        .api_version(TIXKIT_API_VERSION)
        .build()?;

    let session = client
        .checkout()
        .create(
            CreateCheckoutSession {
                event_id,
                items: vec![CheckoutItem {
                    ticket_type_id: Some(ticket_type_id),
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
            format!("checkout-{}", std::process::id()),
        )
        .await?;

    println!("created checkout session {}", session.id);
    Ok(())
}

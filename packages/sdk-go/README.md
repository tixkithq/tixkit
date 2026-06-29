# Tixkit Go SDK

Go client for the Tixkit API, pinned to API version `2026-01-01`.

The module provides typed resources for checkout sessions, events, ticket types,
orders, refunds, attendees, check-in, questions, waitlist, reports, exports,
webhooks, developer API keys, cursor pagination, idempotency keys, typed API
errors, configurable retries/timeouts, and `X-Tixkit-Signature` webhook
verification.

## Install

```bash
go get github.com/tixkit/tixkit-go
```

## Create a checkout session

```go
package main

import (
	"context"
	"log"
	"time"

	tixkit "github.com/tixkit/tixkit-go"
)

func main() {
	client, err := tixkit.NewClient(
		"tk_live_...",
		tixkit.WithBaseURL("https://api.tixkit.com"),
		tixkit.WithTimeout(30*time.Second),
		tixkit.WithMaxRetries(3),
	)
	if err != nil {
		log.Fatal(err)
	}

	session, err := client.CheckoutSessions.Create(context.Background(), tixkit.CreateCheckoutSessionRequest{
		EventID: "evt_123",
		Items: []tixkit.CheckoutItem{{
			TicketTypeID: "tt_123",
			Quantity:     1,
		}},
		Buyer:          &tixkit.Buyer{Email: "buyer@example.com"},
		SuccessURL:     "https://example.com/success",
		CancelURL:      "https://example.com/cancel",
		IdempotencyKey: "checkout-idempotency-key",
	})
	if err != nil {
		log.Fatal(err)
	}

	log.Println(session.ID)
}
```

## Verify webhooks

```go
ok := tixkit.VerifyWebhookSignature(rawBody, signatureHeader, webhookSecret)
```

Webhook verification expects Tixkit's `X-Tixkit-Signature` header in the
`t=<timestamp>,v1=<hex>` format and performs constant-time HMAC comparison.

## Local validation

```bash
go list -m -json
go list ./...
gofmt -w client.go doc.go errors.go pagination.go services.go types.go webhook.go client_test.go webhook_test.go examples/checkout/main.go
go test ./...
go vet ./...
go build ./examples/...
```

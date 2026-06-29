# Tixkit Go SDK

The Go SDK is published as `github.com/tixkit/tixkit-go` and sends `X-Tixkit-Version: 2026-01-01` on every request.

## Install

```bash
go get github.com/tixkit/tixkit-go
```

## Client

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

	events, err := client.Events.List(context.Background(), &tixkit.PaginationParams{Limit: 25})
	if err != nil {
		log.Fatal(err)
	}
	log.Println(events.Items)
}
```

The client accepts a custom `*http.Client`, base URL, timeout, retry count, and backoff function:

```go
client, err := tixkit.NewClient(
	"tk_live_...",
	tixkit.WithHTTPClient(myHTTPClient),
	tixkit.WithBackoff(func(attempt int) time.Duration {
		return time.Duration(attempt+1) * 250 * time.Millisecond
	}),
)
```

Retries are applied to safe methods and to write methods that include an idempotency key.

## Checkout

```go
session, err := client.CheckoutSessions.Create(ctx, tixkit.CreateCheckoutSessionRequest{
	EventID: "evt_123",
	Items: []tixkit.CheckoutItem{{
		TicketTypeID: "tt_123",
		Quantity:     2,
	}},
	Buyer: &tixkit.Buyer{Email: "buyer@example.com"},
	SuccessURL:     "https://example.com/success",
	CancelURL:      "https://example.com/cancel",
	IdempotencyKey: "checkout-cart-123",
})
```

Box-office orders also require caller-provided idempotency:

```go
order, err := client.CheckoutSessions.CreateBoxOfficeOrder(ctx, "evt_123", tixkit.BoxOfficeOrderRequest{
	TenderType:     "cash",
	Items:          []tixkit.CheckoutItem{{TicketTypeID: "tt_123", Quantity: 1}},
	IdempotencyKey: "box-office-register-1-order-456",
})
```

## Pagination

List methods return `Page[T]`. For cursor iteration, use `NewCursorIterator`:

```go
iter := tixkit.NewCursorIterator(func(ctx context.Context, cursor string) (*tixkit.Page[tixkit.Event], error) {
	return client.Events.List(ctx, &tixkit.PaginationParams{Cursor: cursor, Limit: 50})
})

for {
	event, ok, err := iter.Next(ctx)
	if err != nil {
		log.Fatal(err)
	}
	if !ok {
		break
	}
	log.Println(event.ID)
}
```

## Errors

Non-2xx API responses return `*tixkit.APIError`:

```go
event, err := client.Events.Get(ctx, "evt_missing")
if err != nil {
	var apiErr *tixkit.APIError
	if errors.As(err, &apiErr) {
		log.Printf("status=%d code=%s request=%s", apiErr.StatusCode, apiErr.Code, apiErr.RequestID)
	}
}
_ = event
```

## Webhooks

Use the raw request body and the `X-Tixkit-Signature` header:

```go
body, err := io.ReadAll(r.Body)
if err != nil {
	http.Error(w, "bad body", http.StatusBadRequest)
	return
}

signature := r.Header.Get("X-Tixkit-Signature")
if !tixkit.VerifyWebhookSignature(body, signature, os.Getenv("TIXKIT_WEBHOOK_SECRET")) {
	http.Error(w, "invalid signature", http.StatusUnauthorized)
	return
}
```

Signatures are HMAC-SHA256 over `timestamp.rawBody` and use the `t=...,v1=...` header format used by the JavaScript SDK.

## Example

A runnable checkout example is available at `packages/sdk-go/examples/checkout`:

```bash
cd packages/sdk-go
TIXKIT_API_KEY=tk_live_... TIXKIT_EVENT_ID=evt_... TIXKIT_TICKET_TYPE_ID=tt_... go run ./examples/checkout
```

## Validation

Run these from `packages/sdk-go`:

```bash
gofmt -w client.go errors.go pagination.go services.go types.go webhook.go client_test.go webhook_test.go examples/checkout/main.go
go test ./...
go vet ./...
go build ./examples/...
```

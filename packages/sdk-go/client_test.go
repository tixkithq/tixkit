package tixkit

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRequestBuildsHeadersPathAndQuery(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("method = %s", r.Method)
		}
		if r.URL.Path != "/v1/events" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.URL.Query().Get("limit"); got != "25" {
			t.Fatalf("limit = %s", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer tk_test" {
			t.Fatalf("authorization = %s", got)
		}
		if got := r.Header.Get("X-Tixkit-Version"); got != APIVersion {
			t.Fatalf("version = %s", got)
		}
		_ = json.NewEncoder(w).Encode(Page[Event]{
			Items: []Event{{ID: "evt_1", Title: "Launch"}},
		})
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	page, err := client.Events.List(context.Background(), &PaginationParams{Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != "evt_1" {
		t.Fatalf("unexpected page: %#v", page)
	}
}

func TestTicketTypeBatchUpdateNullableFieldsPreserveOmitSetAndClear(t *testing.T) {
	t.Parallel()

	requestNumber := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestNumber++
		if r.Method != http.MethodPatch {
			t.Fatalf("method = %s", r.Method)
		}
		if r.URL.Path != "/v1/ticket-types/tt_1/batch" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		ticketType, ok := body["ticketType"].(map[string]any)
		if !ok {
			t.Fatalf("ticketType = %#v", body["ticketType"])
		}
		nullableFields := []string{
			"minimumPriceCents",
			"salesStartAt",
			"salesEndAt",
			"eventOccurrenceId",
			"accessCodeHint",
		}
		switch requestNumber {
		case 1:
			for _, field := range nullableFields {
				value, present := ticketType[field]
				if !present || value != nil {
					t.Fatalf("clear %s = %#v, present = %t", field, value, present)
				}
			}
		case 2:
			expected := map[string]any{
				"minimumPriceCents": float64(2500),
				"salesStartAt":      "2026-08-01T10:00:00Z",
				"salesEndAt":        "2026-08-02T10:00:00Z",
				"eventOccurrenceId": "occ_1",
				"accessCodeHint":    "Members only",
			}
			for field, want := range expected {
				if got := ticketType[field]; got != want {
					t.Fatalf("set %s = %#v, want %#v", field, got, want)
				}
			}
		case 3:
			for _, field := range nullableFields {
				if value, present := ticketType[field]; present {
					t.Fatalf("omitted %s unexpectedly present as %#v", field, value)
				}
			}
		default:
			t.Fatalf("unexpected request %d", requestNumber)
		}
		_ = json.NewEncoder(w).Encode(TicketTypeBatchResult{TicketType: TicketType{ID: "tt_1"}})
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	clearResult, err := client.TicketTypes.UpdateBatchTyped(context.Background(), "tt_1", UpdateTicketTypeBatchRequest{
		TicketType: UpdateTicketTypeBatchTicketTypeRequest{
			MinimumPriceCents: NullInt(),
			SalesStartAt:      NullString(),
			SalesEndAt:        NullString(),
			EventOccurrenceID: NullString(),
			AccessCodeHint:    NullString(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if clearResult.TicketType.ID != "tt_1" {
		t.Fatalf("clear result = %#v", clearResult)
	}

	_, err = client.TicketTypes.UpdateBatchTyped(context.Background(), "tt_1", UpdateTicketTypeBatchRequest{
		TicketType: UpdateTicketTypeBatchTicketTypeRequest{
			MinimumPriceCents: NewNullableInt(2500),
			SalesStartAt:      NewNullableString("2026-08-01T10:00:00Z"),
			SalesEndAt:        NewNullableString("2026-08-02T10:00:00Z"),
			EventOccurrenceID: NewNullableString("occ_1"),
			AccessCodeHint:    NewNullableString("Members only"),
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	_, err = client.TicketTypes.UpdateBatchTyped(context.Background(), "tt_1", UpdateTicketTypeBatchRequest{
		TicketType: UpdateTicketTypeBatchTicketTypeRequest{Name: stringPointer("VIP")},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func stringPointer(value string) *string {
	return &value
}

func TestRetriesSafeRequestsOnServerErrors(t *testing.T) {
	t.Parallel()

	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt := atomic.AddInt32(&attempts, 1)
		if attempt == 1 {
			http.Error(w, `{"error":{"code":"TEMPORARY","message":"try again"}}`, http.StatusBadGateway)
			return
		}
		_ = json.NewEncoder(w).Encode(Event{ID: "evt_retry", Title: "Recovered"})
	}))
	defer server.Close()

	client, err := NewClient("tk_test", WithBaseURL(server.URL), WithMaxRetries(1), WithBackoff(func(int) time.Duration { return 0 }))
	if err != nil {
		t.Fatal(err)
	}
	event, err := client.Events.Get(context.Background(), "evt_retry")
	if err != nil {
		t.Fatal(err)
	}
	if event.ID != "evt_retry" {
		t.Fatalf("event = %#v", event)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("attempts = %d", got)
	}
}

func TestRetriesSafeRequestsOnTransportErrorsAndBackoff(t *testing.T) {
	t.Parallel()

	var attempts int32
	var backoffAttempts []int
	httpClient := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			attempt := atomic.AddInt32(&attempts, 1)
			if req.URL.String() != "https://api.test/v1/events/evt_retry" {
				t.Fatalf("url = %s", req.URL.String())
			}
			if attempt <= 2 {
				return nil, errors.New("temporary transport failure")
			}
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader(`{"id":"evt_retry","title":"Recovered"}`)),
				Request:    req,
			}, nil
		}),
	}

	client, err := NewClient(
		"tk_test",
		WithBaseURL("https://api.test"),
		WithHTTPClient(httpClient),
		WithMaxRetries(2),
		WithBackoff(func(attempt int) time.Duration {
			backoffAttempts = append(backoffAttempts, attempt)
			return 0
		}),
	)
	if err != nil {
		t.Fatal(err)
	}

	event, err := client.Events.Get(context.Background(), "evt_retry")
	if err != nil {
		t.Fatal(err)
	}
	if event.ID != "evt_retry" {
		t.Fatalf("event = %#v", event)
	}
	if got := atomic.LoadInt32(&attempts); got != 3 {
		t.Fatalf("attempts = %d", got)
	}
	if len(backoffAttempts) != 2 || backoffAttempts[0] != 0 || backoffAttempts[1] != 1 {
		t.Fatalf("backoff attempts = %#v", backoffAttempts)
	}
}

func TestDoesNotRetryUnsafeRequestWithoutIdempotencyKey(t *testing.T) {
	t.Parallel()

	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		http.Error(w, `{"error":{"code":"TEMPORARY","message":"try again"}}`, http.StatusBadGateway)
	}))
	defer server.Close()

	client, err := NewClient("tk_test", WithBaseURL(server.URL), WithMaxRetries(3), WithBackoff(func(int) time.Duration { return 0 }))
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Events.Create(context.Background(), CreateEventRequest{
		OrganizationID: "org_1",
		BrandID:        "br_1",
		Slug:           "launch",
		Title:          "Launch",
		Currency:       "USD",
		Timezone:       "America/New_York",
		StartsAt:       "2026-07-01T12:00:00Z",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("attempts = %d", got)
	}
}

func TestRetriesIdempotentWriteWithStableHeaderAndBody(t *testing.T) {
	t.Parallel()

	type seenRequest struct {
		idempotencyKey string
		body           CreateCheckoutSessionRequest
	}

	var attempts int32
	seen := make(chan seenRequest, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt := atomic.AddInt32(&attempts, 1)
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s", r.Method)
		}
		if r.URL.Path != "/v1/checkout/sessions" {
			t.Fatalf("path = %s", r.URL.Path)
		}

		var body CreateCheckoutSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		seen <- seenRequest{idempotencyKey: r.Header.Get("Idempotency-Key"), body: body}

		if attempt == 1 {
			http.Error(w, `{"error":{"code":"TEMPORARY","message":"try again"}}`, http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(CheckoutSession{ID: "cs_retry", EventID: "evt_1"})
	}))
	defer server.Close()

	client, err := NewClient("tk_test", WithBaseURL(server.URL), WithMaxRetries(1), WithBackoff(func(int) time.Duration { return 0 }))
	if err != nil {
		t.Fatal(err)
	}

	session, err := client.CheckoutSessions.Create(context.Background(), CreateCheckoutSessionRequest{
		EventID:        "evt_1",
		IdempotencyKey: "idem_retry_1",
		Items: []CheckoutItem{{
			TicketTypeID: "tt_1",
			Quantity:     2,
		}},
		Buyer: &Buyer{Email: "buyer@example.com"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if session.ID != "cs_retry" {
		t.Fatalf("session = %#v", session)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("attempts = %d", got)
	}

	first := <-seen
	second := <-seen
	for i, request := range []seenRequest{first, second} {
		if request.idempotencyKey != "idem_retry_1" {
			t.Fatalf("request %d idempotency key = %q", i+1, request.idempotencyKey)
		}
		if request.body.IdempotencyKey != "" {
			t.Fatalf("request %d leaked idempotency key into body: %#v", i+1, request.body)
		}
		if request.body.EventID != "evt_1" || len(request.body.Items) != 1 || request.body.Items[0].Quantity != 2 {
			t.Fatalf("request %d body = %#v", i+1, request.body)
		}
		if request.body.Buyer == nil || request.body.Buyer.Email != "buyer@example.com" {
			t.Fatalf("request %d buyer = %#v", i+1, request.body.Buyer)
		}
	}
}

func TestCheckInScanSendsRequiredIdempotencyKey(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/check-ins/scan" {
			t.Fatalf("request = %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Idempotency-Key"); got != "scan-tkt-1" {
			t.Fatalf("Idempotency-Key = %q", got)
		}
		if got := r.Header.Get("X-Device-Id"); got != "dev_1" {
			t.Fatalf("X-Device-Id = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"outcome":"accepted","ticketId":"tkt_1","message":"Check-in successful"}`))
	}))
	defer server.Close()

	client, err := NewClient("", WithBaseURL(server.URL), WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.CheckIn.Scan(context.Background(), ScanTicketRequest{
		CheckInListID:  "cil_1",
		QRPayload:      "signed-qr",
		ScannedAt:      "2026-06-01T12:00:00.000Z",
		DeviceID:       "dev_1",
		DeviceSecret:   "secret",
		IdempotencyKey: "scan-tkt-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != "accepted" || result.TicketID != "tkt_1" || result.Message != "Check-in successful" {
		t.Fatalf("result = %#v", result)
	}
}

func TestCheckoutCreateSendsIdempotencyHeader(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/checkout/sessions" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Idempotency-Key"); got != "idem_checkout_1" {
			t.Fatalf("idempotency key = %s", got)
		}
		var body CreateCheckoutSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.IdempotencyKey != "" {
			t.Fatalf("idempotency key leaked into body: %#v", body)
		}
		if body.EventID != "evt_1" || body.Items[0].TicketTypeID != "tt_1" {
			t.Fatalf("body = %#v", body)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(CheckoutSession{ID: "cs_1", EventID: "evt_1"})
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	session, err := client.CheckoutSessions.Create(context.Background(), CreateCheckoutSessionRequest{
		EventID:        "evt_1",
		IdempotencyKey: "idem_checkout_1",
		Items: []CheckoutItem{{
			TicketTypeID: "tt_1",
			Quantity:     2,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if session.ID != "cs_1" {
		t.Fatalf("session = %#v", session)
	}
}

func TestCheckoutCreateSendsResaleListingItems(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/checkout/sessions" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		var body CreateCheckoutSessionRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Items) != 1 || body.Items[0].ResaleListingID != "lst_1" || body.Items[0].Quantity != 1 {
			t.Fatalf("body = %#v", body)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(CheckoutSession{ID: "cs_resale", EventID: "evt_1"})
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	session, err := client.CheckoutSessions.Create(context.Background(), CreateCheckoutSessionRequest{
		EventID:        "evt_1",
		IdempotencyKey: "idem_checkout_resale_1",
		Items: []CheckoutItem{{
			ResaleListingID: "lst_1",
			Quantity:        1,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if session.ID != "cs_resale" {
		t.Fatalf("session = %#v", session)
	}
}

func TestBoxOfficeOrderSendsIdempotencyHeader(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/events/evt_1/box-office/orders" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Idempotency-Key"); got != "idem_box_1" {
			t.Fatalf("idempotency key = %s", got)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(BoxOfficeOrderResult{Order: Order{ID: "ord_1"}})
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	result, err := client.CheckoutSessions.CreateBoxOfficeOrder(context.Background(), "evt_1", BoxOfficeOrderRequest{
		TenderType:     "cash",
		IdempotencyKey: "idem_box_1",
		Items:          []CheckoutItem{{TicketTypeID: "tt_1", Quantity: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Order.ID != "ord_1" {
		t.Fatalf("result = %#v", result)
	}
}

func TestOrderGetDecodesEnrichedDetail(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("method = %s", r.Method)
		}
		if r.URL.Path != "/v1/orders/ord_1" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id":              "ord_1",
			"eventId":         "evt_1",
			"orderNumber":     "1001",
			"status":          "paid",
			"currency":        "USD",
			"buyerEmail":      "buyer@example.com",
			"lineItems":       []map[string]any{{"id": "li_1", "description": "General Admission", "quantity": 1}},
			"attendees":       []map[string]any{{"id": "att_1", "eventId": "evt_1", "orderId": "ord_1", "ticketTypeId": "tt_1", "email": "buyer@example.com", "status": "registered"}},
			"taxSnapshots":    []map[string]any{{"id": "tax_1", "taxCents": 100}},
			"checkoutAnswers": map[string]any{"buyerFields": map[string]any{"q_consent": true}, "attendeeFields": map[string]any{"tt_1": []any{map[string]any{"q_name": "Ada"}}}},
			"consentSnapshots": map[string]any{
				"q_consent": map[string]any{"consentVersion": "v1"},
			},
			"refunds":        []map[string]any{{"id": "rf_1", "orderId": "ord_1", "amountCents": 500, "currency": "USD", "status": "succeeded", "reason": "customer_request"}},
			"timeline":       []map[string]any{{"id": "evt_1", "type": "order.created", "description": "Order created"}},
			"deliveryStatus": map[string]any{"email": "pending", "tickets": "issued"},
		})
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	result, err := client.Orders.Get(context.Background(), "ord_1")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Attendees) != 1 || result.Attendees[0].ID != "att_1" {
		t.Fatalf("attendees = %#v", result.Attendees)
	}
	if len(result.Refunds) != 1 || result.Refunds[0].ID != "rf_1" {
		t.Fatalf("refunds = %#v", result.Refunds)
	}
	if got := result.CheckoutAnswers.BuyerFields["q_consent"]; got != true {
		t.Fatalf("buyer fields = %#v", result.CheckoutAnswers.BuyerFields)
	}
	if result.DeliveryStatus.Email != "pending" || result.DeliveryStatus.Tickets != "issued" {
		t.Fatalf("delivery status = %#v", result.DeliveryStatus)
	}
}

func TestWebhookCreateSendsRequiredIdempotencyKey(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/webhook-endpoints" {
			t.Fatalf("path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Idempotency-Key"); got != "webhook-create-stable-000001" {
			t.Fatalf("Idempotency-Key = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if _, exists := body["idempotencyKey"]; exists {
			t.Fatalf("idempotency key leaked into body: %#v", body)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(WebhookEndpoint{ID: "wh_1", Secret: "whsec_once"})
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	result, err := client.Webhooks.CreateEndpoint(context.Background(), CreateWebhookEndpointRequest{
		OrganizationID: "org_1",
		IdempotencyKey: "webhook-create-stable-000001",
		URL:            "https://hooks.example.test/tixkit",
		Events:         []string{"order.created"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != "wh_1" || result.Secret != "whsec_once" {
		t.Fatalf("result = %#v", result)
	}
}

func TestWebhookReplaySendsRequiredIdempotencyKeys(t *testing.T) {
	t.Parallel()

	requests := make(chan *http.Request, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Clone(r.Context())
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(ReplayWebhookEventResult{
			Queued:    true,
			EventID:   "whe_1",
			Endpoints: 1,
		})
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	if _, err := client.Webhooks.ReplayEndpointEvent(
		context.Background(),
		"wh_1",
		"whe_1",
		"replay-endpoint-1",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Webhooks.ReplayEvent(
		context.Background(),
		"whe_1",
		"replay-event-1",
	); err != nil {
		t.Fatal(err)
	}

	endpointRequest := <-requests
	if endpointRequest.URL.Path != "/v1/webhook-endpoints/wh_1/events/whe_1/replay" {
		t.Fatalf("endpoint replay path = %s", endpointRequest.URL.Path)
	}
	if got := endpointRequest.Header.Get("Idempotency-Key"); got != "replay-endpoint-1" {
		t.Fatalf("endpoint replay idempotency key = %s", got)
	}
	eventRequest := <-requests
	if eventRequest.URL.Path != "/v1/webhook-events/whe_1/replay" {
		t.Fatalf("event replay path = %s", eventRequest.URL.Path)
	}
	if got := eventRequest.Header.Get("Idempotency-Key"); got != "replay-event-1" {
		t.Fatalf("event replay idempotency key = %s", got)
	}
}

func TestOrderRefundSendsLifecycleFlagsAndDecodesQueuedResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s", r.Method)
		}
		if r.URL.Path != "/v1/orders/ord_1/refunds" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if got := r.Header.Get("Idempotency-Key"); got != "idem_refund_1" {
			t.Fatalf("idempotency key = %s", got)
		}
		var body RefundRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.IdempotencyKey != "" {
			t.Fatalf("idempotency key leaked into body: %#v", body)
		}
		if body.AmountCents != 2500 || body.Reason != "customer_request" || !body.VoidTickets || !body.RestoreInventory {
			t.Fatalf("body = %#v", body)
		}
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(RefundQueued{
			OrderID:      "ord_1",
			RefundAmount: 2500,
			Status:       "pending",
			Message:      "Refund workflow queued",
		})
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	result, err := client.Orders.Refund(context.Background(), "ord_1", RefundRequest{
		AmountCents:      2500,
		Reason:           "customer_request",
		VoidTickets:      true,
		RestoreInventory: true,
		IdempotencyKey:   "idem_refund_1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.OrderID != "ord_1" || result.RefundAmount != 2500 || result.Status != "pending" {
		t.Fatalf("result = %#v", result)
	}
}

func TestAttendeeUpdateSendsProfileFieldsOnly(t *testing.T) {
	t.Parallel()

	firstName := "Ada"
	lastName := "Lovelace"
	phone := "+15555550123"
	encoded, err := json.Marshal(UpdateAttendeeRequest{
		FirstName: &firstName,
		LastName:  &lastName,
		Phone:     &phone,
	})
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(encoded, &body); err != nil {
		t.Fatal(err)
	}
	if _, exists := body["status"]; exists {
		t.Fatalf("profile update contains lifecycle status: %#v", body)
	}
	if body["firstName"] != "Ada" || body["lastName"] != "Lovelace" || body["phone"] != "+15555550123" {
		t.Fatalf("body = %#v", body)
	}
}

func TestResaleRoutesSendExpectedHeadersAndBodies(t *testing.T) {
	t.Parallel()

	paths := make(chan string, 7)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.RequestURI()
		switch r.URL.Path {
		case "/v1/events/evt_1/resale-listings":
			if r.Method != http.MethodGet {
				t.Fatalf("list resale method = %s", r.Method)
			}
			if r.URL.Query().Get("limit") != "25" || r.URL.Query().Get("cursor") != "lst_0" {
				t.Fatalf("list resale query = %s", r.URL.RawQuery)
			}
			_ = json.NewEncoder(w).Encode(Page[TicketListing]{
				Items: []TicketListing{{ID: "lst_1", Status: "listed"}},
			})
		case "/v1/tickets/tkt_1/resale-listings":
			if r.Method != http.MethodPost {
				t.Fatalf("create resale method = %s", r.Method)
			}
			if got := r.Header.Get("Idempotency-Key"); got != "idem_create_1" {
				t.Fatalf("create resale idempotency key = %s", got)
			}
			var body CreateResaleListingRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.IdempotencyKey != "" || body.PriceCents != 5500 || body.ExpiresAt != "2026-07-01T00:00:00.000Z" {
				t.Fatalf("create resale body = %#v", body)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(TicketListing{ID: "lst_2", Status: "listed"})
		case "/v1/checkout/sessions/cs_1/tickets/tkt_1/resale-listing":
			if got := r.Header.Get("X-Checkout-Session-Token"); got != "client_1" {
				t.Fatalf("checkout resale token = %s", got)
			}
			if got := r.Header.Get("Idempotency-Key"); got != "idem_checkout_resale_1" {
				t.Fatalf("checkout resale idempotency key = %s", got)
			}
			var body CreateCheckoutTicketResaleListingRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.ClientToken != "" || body.IdempotencyKey != "" || body.PriceCents != 5600 {
				t.Fatalf("checkout resale body = %#v", body)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(TicketListing{ID: "lst_3", Status: "listed"})
		case "/v1/ticket-listings/lst_1/delist":
			if got := r.Header.Get("Idempotency-Key"); got != "idem_delist_1" {
				t.Fatalf("delist idempotency key = %s", got)
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if len(body) != 0 {
				t.Fatalf("delist body = %#v", body)
			}
			_ = json.NewEncoder(w).Encode(TicketListing{ID: "lst_1", Status: "delisted"})
		case "/v1/ticket-listings/lst_1/settlement":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "rst_1", "listingId": "lst_1", "tenantId": "ten_1", "organizationId": "org_1",
				"brandId": "br_1", "eventId": "evt_1", "sellerOrderId": "ord_seller_1",
				"buyerOrderId": "ord_buyer_1", "sellerTicketId": "tkt_seller_1", "buyerTicketId": "tkt_buyer_1",
				"currency": "USD", "grossCents": 5600, "feeCents": 600, "payableCents": 5000,
				"paidCents": 0, "reversedCents": 0, "recoveryCents": 0, "state": "pending",
				"termsVersion": "2026-07-16", "version": 1, "createdAt": "2026-07-16T00:00:00Z",
				"updatedAt": "2026-07-16T00:00:00Z", "entries": []any{},
			})
		case "/v1/ticket-listings/lst_1/settlement/payouts":
			if got := r.Header.Get("Idempotency-Key"); got != "idem_payout_1" {
				t.Fatalf("payout idempotency key = %s", got)
			}
			_ = json.NewEncoder(w).Encode(ResaleSettlement{ID: "rst_1", ListingID: "lst_1", State: "paid", Version: 2})
		case "/v1/ticket-listings/lst_1/settlement/reversals":
			if got := r.Header.Get("Idempotency-Key"); got != "idem_reversal_1" {
				t.Fatalf("reversal idempotency key = %s", got)
			}
			_ = json.NewEncoder(w).Encode(ResaleSettlement{ID: "rst_1", ListingID: "lst_1", State: "reversed", Version: 3})
		default:
			t.Fatalf("unexpected path = %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	listings, err := client.Events.ListResaleListings(context.Background(), "evt_1", &PaginationParams{Limit: 25, Cursor: "lst_0"})
	if err != nil {
		t.Fatal(err)
	}
	if len(listings.Items) != 1 || listings.Items[0].ID != "lst_1" {
		t.Fatalf("listings = %#v", listings)
	}
	if _, err := client.Tickets.CreateResaleListing(context.Background(), "tkt_1", CreateResaleListingRequest{
		PriceCents:     5500,
		ExpiresAt:      "2026-07-01T00:00:00.000Z",
		IdempotencyKey: "idem_create_1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.CheckoutSessions.CreateTicketResaleListing(context.Background(), "cs_1", "tkt_1", CreateCheckoutTicketResaleListingRequest{
		ClientToken:    "client_1",
		PriceCents:     5600,
		IdempotencyKey: "idem_checkout_resale_1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Tickets.DelistResaleListing(context.Background(), "lst_1", "idem_delist_1"); err != nil {
		t.Fatal(err)
	}
	settlement, err := client.Tickets.GetResaleSettlement(context.Background(), "lst_1")
	if err != nil {
		t.Fatal(err)
	}
	if settlement.SellerOrderID == nil || *settlement.SellerOrderID != "ord_seller_1" ||
		settlement.BuyerOrderID == nil || *settlement.BuyerOrderID != "ord_buyer_1" ||
		settlement.SellerTicketID == nil || *settlement.SellerTicketID != "tkt_seller_1" ||
		settlement.BuyerTicketID == nil || *settlement.BuyerTicketID != "tkt_buyer_1" {
		t.Fatalf("settlement identifiers = %#v", settlement)
	}
	if _, err := client.Tickets.RecordResaleSettlementPayout(context.Background(), "lst_1", RecordResaleSettlementPayoutRequest{AmountCents: 5000, Currency: "USD", ExpectedVersion: 1, Method: "bank_transfer", ExternalReference: "wire_1", IdempotencyKey: "idem_payout_1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Tickets.RecordResaleSettlementReversal(context.Background(), "lst_1", RecordResaleSettlementReversalRequest{AmountCents: 5000, Currency: "USD", ExpectedVersion: 2, Method: "accounting_adjustment", Reason: "refund", IdempotencyKey: "idem_reversal_1"}); err != nil {
		t.Fatal(err)
	}

	want := []string{
		"/v1/events/evt_1/resale-listings?cursor=lst_0&limit=25",
		"/v1/tickets/tkt_1/resale-listings",
		"/v1/checkout/sessions/cs_1/tickets/tkt_1/resale-listing",
		"/v1/ticket-listings/lst_1/delist",
		"/v1/ticket-listings/lst_1/settlement",
		"/v1/ticket-listings/lst_1/settlement/payouts",
		"/v1/ticket-listings/lst_1/settlement/reversals",
	}
	for index, expected := range want {
		if got := <-paths; got != expected {
			t.Fatalf("path %d = %s, want %s", index+1, got, expected)
		}
	}
}

func TestPublicEventPageRoutes(t *testing.T) {
	t.Parallel()

	paths := make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths <- r.URL.RequestURI()
		_ = json.NewEncoder(w).Encode(PublicContentPage{
			Document: PublicContentDocument{
				EventID:   "evt_1",
				Channel:   "event_page",
				Key:       "main",
				Name:      "Main event page",
				Locale:    "en",
				UpdatedAt: "2026-06-01T00:00:00.000Z",
			},
			Version: PublicContentVersion{
				VersionNumber: 3,
				PublishedAt:   "2026-06-02T00:00:00.000Z",
			},
			Page: PublicEventPage{
				Provider: "@puckeditor/core",
				PuckData: PuckData{
					Content: []PuckComponentData{{
						Type:  "Hero",
						Props: FlexibleObject{"id": "Hero-hero", "headline": "All Access"},
					}},
					Root: PuckRootData{Props: FlexibleObject{"title": "All Access"}},
				},
				Settings: FlexibleObject{"locale": "en"},
				Discovery: PublicEventDiscoveryCard{
					Title: "All Access",
					Tags:  []string{"music"},
				},
			},
		})
	}))
	defer server.Close()

	client, err := NewClient("", WithBaseURL(server.URL), WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}

	page, err := client.Public.GetContentPage(context.Background(), "evt_1", &PublicEventPageParams{Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Document.EventID != "evt_1" || page.Page.Discovery.Title != "All Access" {
		t.Fatalf("page = %#v", page)
	}
	if page.Page.Provider != "@puckeditor/core" || page.Page.PuckData.Content[0].Type != "Hero" {
		t.Fatalf("puck data = %#v", page.Page.PuckData)
	}
	if got := <-paths; got != "/v1/public/events/evt_1/content-page?locale=en" {
		t.Fatalf("content page path = %s", got)
	}

	if _, err := client.Public.GetEventPage(context.Background(), "evt_1", &PublicEventPageParams{Locale: "en"}); err != nil {
		t.Fatal(err)
	}
	if got := <-paths; got != "/v1/public/events/evt_1/page?locale=en" {
		t.Fatalf("event page path = %s", got)
	}

	if _, err := client.Public.GetEventPageBySlug(context.Background(), "all-access", PublicEventPageBySlugParams{Host: "events.example.com", Locale: "en"}); err != nil {
		t.Fatal(err)
	}
	if got := <-paths; got != "/v1/public/events/by-slug/all-access/page?host=events.example.com&locale=en" {
		t.Fatalf("slug page path = %s", got)
	}
}

func TestPublicEventDiscoveryCardRoute(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != "/v1/public/events/evt_1/discovery-card?locale=en" {
			t.Fatalf("path = %s", r.URL.RequestURI())
		}
		_ = json.NewEncoder(w).Encode(PublicEventDiscoveryCard{
			Title:     "All Access",
			Summary:   "Chicago",
			Tags:      []string{"music"},
			VenueName: "The Salt Shed",
		})
	}))
	defer server.Close()

	client, err := NewClient("", WithBaseURL(server.URL), WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}
	card, err := client.Public.GetEventDiscoveryCard(context.Background(), "evt_1", &PublicEventPageParams{Locale: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if card.Title != "All Access" || card.VenueName != "The Salt Shed" {
		t.Fatalf("card = %#v", card)
	}
}

func TestPublicResaleListingsRoute(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != "/v1/public/events/evt_1/resale-listings?cursor=lst_0&limit=25" {
			t.Fatalf("path = %s", r.URL.RequestURI())
		}
		_ = json.NewEncoder(w).Encode(Page[PublicTicketListing]{
			Items: []PublicTicketListing{{ID: "lst_1", Status: "listed", PriceCents: 5500}},
		})
	}))
	defer server.Close()

	client, err := NewClient("", WithBaseURL(server.URL), WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}
	page, err := client.Public.ListResaleListings(context.Background(), "evt_1", &PaginationParams{Cursor: "lst_0", Limit: 25})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].ID != "lst_1" {
		t.Fatalf("page = %#v", page)
	}
}

func TestErrorMapping(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"error":{"code":"VALIDATION_FAILED","message":"Invalid event","requestId":"req_123","details":{"field":"title"}}}`))
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	_, err := client.Events.Get(context.Background(), "evt_bad")
	if err == nil {
		t.Fatal("expected error")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiErr.StatusCode != http.StatusUnprocessableEntity || apiErr.Code != "VALIDATION_FAILED" || apiErr.RequestID != "req_123" {
		t.Fatalf("apiErr = %#v", apiErr)
	}
	if apiErr.Details["field"] != "title" {
		t.Fatalf("details = %#v", apiErr.Details)
	}
	if !strings.Contains(apiErr.Error(), "VALIDATION_FAILED") {
		t.Fatalf("error string = %s", apiErr.Error())
	}
}

func TestErrorMappingFallsBackForMalformedErrorBody(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte("rate limited"))
	}))
	defer server.Close()

	client := testClient(t, server.URL)
	_, err := client.Events.Get(context.Background(), "evt_rate_limited")
	if err == nil {
		t.Fatal("expected error")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiErr.StatusCode != http.StatusTooManyRequests || apiErr.Code != "HTTP_429" {
		t.Fatalf("apiErr = %#v", apiErr)
	}
	if apiErr.Message != "Request failed with status 429" {
		t.Fatalf("message = %q", apiErr.Message)
	}
	if apiErr.RequestID != "" || apiErr.Details != nil {
		t.Fatalf("unexpected metadata: %#v", apiErr)
	}
}

func TestCursorIterator(t *testing.T) {
	t.Parallel()

	calls := 0
	iterator := NewCursorIterator(func(ctx context.Context, cursor string) (*Page[Event], error) {
		calls++
		switch cursor {
		case "":
			return &Page[Event]{
				Items:      []Event{{ID: "evt_1"}},
				NextCursor: "cursor_2",
				HasMore:    true,
			}, nil
		case "cursor_2":
			return &Page[Event]{
				Items:   []Event{{ID: "evt_2"}},
				HasMore: false,
			}, nil
		default:
			t.Fatalf("unexpected cursor %q", cursor)
			return nil, nil
		}
	})

	items, err := iterator.All(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("calls = %d", calls)
	}
	if len(items) != 2 || items[0].ID != "evt_1" || items[1].ID != "evt_2" {
		t.Fatalf("items = %#v", items)
	}
}

func TestCursorIteratorStreamsAcrossEmptyAndLargePages(t *testing.T) {
	t.Parallel()

	var calls []string
	iterator := NewCursorIterator(func(ctx context.Context, cursor string) (*Page[Event], error) {
		calls = append(calls, cursor)
		switch cursor {
		case "":
			return &Page[Event]{
				Items:      nil,
				NextCursor: "cursor_1",
				HasMore:    true,
			}, nil
		case "cursor_1":
			return &Page[Event]{
				Items:      eventsRange(0, 75),
				NextCursor: "cursor_2",
				HasMore:    true,
			}, nil
		case "cursor_2":
			return &Page[Event]{
				Items:      eventsRange(75, 75),
				NextCursor: "cursor_3",
				HasMore:    true,
			}, nil
		case "cursor_3":
			return &Page[Event]{
				Items:   nil,
				HasMore: false,
			}, nil
		default:
			t.Fatalf("unexpected cursor %q", cursor)
			return nil, nil
		}
	})

	items, err := iterator.All(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(calls, ","); got != ",cursor_1,cursor_2,cursor_3" {
		t.Fatalf("calls = %#v", calls)
	}
	if len(items) != 150 {
		t.Fatalf("items len = %d", len(items))
	}
	for i, item := range items {
		want := "evt_" + strconv.Itoa(i)
		if item.ID != want {
			t.Fatalf("item %d id = %q", i, item.ID)
		}
	}
}

func TestCursorIteratorReturnsBufferedItemsBeforeFetcherErrorAndCanRetry(t *testing.T) {
	t.Parallel()

	cursor2Failures := 0
	iterator := NewCursorIterator(func(ctx context.Context, cursor string) (*Page[Event], error) {
		switch cursor {
		case "":
			return &Page[Event]{
				Items:      []Event{{ID: "evt_1"}, {ID: "evt_2"}},
				NextCursor: "cursor_2",
				HasMore:    true,
			}, nil
		case "cursor_2":
			if cursor2Failures == 0 {
				cursor2Failures++
				return nil, errors.New("temporary page failure")
			}
			return &Page[Event]{
				Items:   []Event{{ID: "evt_3"}},
				HasMore: false,
			}, nil
		default:
			t.Fatalf("unexpected cursor %q", cursor)
			return nil, nil
		}
	})

	assertNextEvent(t, iterator, "evt_1")
	assertNextEvent(t, iterator, "evt_2")
	if _, ok, err := iterator.Next(context.Background()); err == nil || ok {
		t.Fatalf("expected transient fetch error, ok=%v err=%v", ok, err)
	}
	assertNextEvent(t, iterator, "evt_3")
	if _, ok, err := iterator.Next(context.Background()); err != nil || ok {
		t.Fatalf("expected iterator to be drained, ok=%v err=%v", ok, err)
	}
}

func testClient(t *testing.T, baseURL string) *Client {
	t.Helper()
	client, err := NewClient("tk_test", WithBaseURL(baseURL), WithMaxRetries(0))
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func eventsRange(start int, count int) []Event {
	events := make([]Event, count)
	for i := range events {
		events[i] = Event{ID: "evt_" + strconv.Itoa(start+i)}
	}
	return events
}

func assertNextEvent(t *testing.T, iterator *CursorIterator[Event], want string) {
	t.Helper()
	item, ok, err := iterator.Next(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatalf("expected %s, got drained iterator", want)
	}
	if item.ID != want {
		t.Fatalf("item id = %q, want %q", item.ID, want)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

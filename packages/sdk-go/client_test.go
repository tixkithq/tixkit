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
				RenderedHTML:  `<main class="tixkit-event-page">All Access</main>`,
				RenderedText:  "All Access",
				PublishedAt:   "2026-06-02T00:00:00.000Z",
			},
			Page: PublicEventPage{
				HTML: "<main>All Access</main>",
				Text: "All Access",
				Headless: []PublicEventPageBlock{{
					Type:  "hero",
					ID:    "hero",
					Title: "All Access",
				}},
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

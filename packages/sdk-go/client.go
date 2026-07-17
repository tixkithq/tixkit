package tixkit

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// APIVersion is the Tixkit API contract version used by this SDK.
	APIVersion = "2026-08-19"

	defaultBaseURL    = "https://api.tixkit.com"
	defaultTimeout    = 30 * time.Second
	defaultMaxRetries = 3
	defaultMaxBackoff = 10 * time.Second
)

// Client is a context-aware Tixkit API client.
type Client struct {
	apiKey     string
	baseURL    string
	httpClient *http.Client
	timeout    time.Duration
	maxRetries int
	backoff    BackoffFunc

	Events           *EventsService
	TicketTypes      *TicketTypesService
	Tickets          *TicketsService
	CheckoutSessions *CheckoutSessionsService
	Orders           *OrdersService
	Refunds          *RefundsService
	Attendees        *AttendeesService
	CheckInLists     *CheckInListsService
	CheckIn          *CheckInService
	Questions        *QuestionsService
	Waitlist         *WaitlistService
	Reports          *ReportsService
	Exports          *ExportsService
	Webhooks         *WebhooksService
	APIKeys          *APIKeysService
	Public           *PublicService
}

// ClientOption configures a Client.
type ClientOption func(*clientConfig) error

type clientConfig struct {
	baseURL    string
	httpClient *http.Client
	timeout    time.Duration
	maxRetries int
	backoff    BackoffFunc
}

// BackoffFunc returns the delay before retry attempt attempt, where attempt is zero-based.
type BackoffFunc func(attempt int) time.Duration

// NewClient constructs a Tixkit client. apiKey may be empty for public endpoints.
func NewClient(apiKey string, options ...ClientOption) (*Client, error) {
	cfg := clientConfig{
		baseURL:    defaultBaseURL,
		httpClient: http.DefaultClient,
		timeout:    defaultTimeout,
		maxRetries: defaultMaxRetries,
		backoff:    defaultBackoff,
	}

	for _, option := range options {
		if option == nil {
			continue
		}
		if err := option(&cfg); err != nil {
			return nil, err
		}
	}

	cfg.baseURL = strings.TrimRight(cfg.baseURL, "/")
	if cfg.baseURL == "" {
		return nil, errors.New("tixkit: base URL is required")
	}
	parsed, err := url.Parse(cfg.baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("tixkit: invalid base URL %q", cfg.baseURL)
	}
	if cfg.httpClient == nil {
		cfg.httpClient = http.DefaultClient
	}
	if cfg.maxRetries < 0 {
		cfg.maxRetries = 0
	}
	if cfg.backoff == nil {
		cfg.backoff = defaultBackoff
	}

	client := &Client{
		apiKey:     apiKey,
		baseURL:    cfg.baseURL,
		httpClient: cfg.httpClient,
		timeout:    cfg.timeout,
		maxRetries: cfg.maxRetries,
		backoff:    cfg.backoff,
	}
	client.Events = &EventsService{client: client}
	client.TicketTypes = &TicketTypesService{client: client}
	client.Tickets = &TicketsService{client: client}
	client.CheckoutSessions = &CheckoutSessionsService{client: client}
	client.Orders = &OrdersService{client: client}
	client.Refunds = &RefundsService{client: client}
	client.Attendees = &AttendeesService{client: client}
	client.CheckInLists = &CheckInListsService{client: client}
	client.CheckIn = &CheckInService{client: client}
	client.Questions = &QuestionsService{client: client}
	client.Waitlist = &WaitlistService{client: client}
	client.Reports = &ReportsService{client: client}
	client.Exports = &ExportsService{client: client}
	client.Webhooks = &WebhooksService{client: client}
	client.APIKeys = &APIKeysService{client: client}
	client.Public = &PublicService{client: client}
	return client, nil
}

// WithBaseURL configures the API origin. The client always appends /v1.
func WithBaseURL(baseURL string) ClientOption {
	return func(cfg *clientConfig) error {
		cfg.baseURL = baseURL
		return nil
	}
}

// WithHTTPClient configures the HTTP transport.
func WithHTTPClient(httpClient *http.Client) ClientOption {
	return func(cfg *clientConfig) error {
		cfg.httpClient = httpClient
		return nil
	}
}

// WithTimeout configures the per-attempt timeout. Use 0 to disable SDK timeouts.
func WithTimeout(timeout time.Duration) ClientOption {
	return func(cfg *clientConfig) error {
		if timeout < 0 {
			return errors.New("tixkit: timeout cannot be negative")
		}
		cfg.timeout = timeout
		return nil
	}
}

// WithMaxRetries configures retries after the initial attempt.
func WithMaxRetries(maxRetries int) ClientOption {
	return func(cfg *clientConfig) error {
		cfg.maxRetries = maxRetries
		return nil
	}
}

// WithBackoff configures retry backoff.
func WithBackoff(backoff BackoffFunc) ClientOption {
	return func(cfg *clientConfig) error {
		cfg.backoff = backoff
		return nil
	}
}

type requestOptions struct {
	params         url.Values
	headers        http.Header
	idempotencyKey string
}

type requestOption func(*requestOptions)

func withParams(params url.Values) requestOption {
	return func(options *requestOptions) {
		if params == nil {
			return
		}
		if options.params == nil {
			options.params = make(url.Values)
		}
		for key, values := range params {
			for _, value := range values {
				if value != "" {
					options.params.Add(key, value)
				}
			}
		}
	}
}

func withHeaders(headers http.Header) requestOption {
	return func(options *requestOptions) {
		if headers == nil {
			return
		}
		if options.headers == nil {
			options.headers = make(http.Header)
		}
		for key, values := range headers {
			for _, value := range values {
				if value != "" {
					options.headers.Add(key, value)
				}
			}
		}
	}
}

func withIdempotencyKey(key string) requestOption {
	return func(options *requestOptions) {
		options.idempotencyKey = key
	}
}

func (c *Client) request(ctx context.Context, method string, path string, body any, out any, options ...requestOption) error {
	if ctx == nil {
		ctx = context.Background()
	}

	opts := requestOptions{}
	for _, option := range options {
		if option != nil {
			option(&opts)
		}
	}

	reqURL, err := c.requestURL(path, opts.params)
	if err != nil {
		return err
	}

	var bodyBytes []byte
	if body != nil {
		bodyBytes, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("tixkit: encode request body: %w", err)
		}
	}

	attempts := c.maxRetries + 1
	retryable := isSafeMethod(method) || opts.idempotencyKey != ""
	var lastErr error

	for attempt := 0; attempt < attempts; attempt++ {
		attemptCtx := ctx
		cancel := func() {}
		if c.timeout > 0 {
			attemptCtx, cancel = context.WithTimeout(ctx, c.timeout)
		}

		req, err := http.NewRequestWithContext(attemptCtx, method, reqURL, bytes.NewReader(bodyBytes))
		if err != nil {
			cancel()
			return err
		}
		c.applyHeaders(req, bodyBytes != nil, opts)

		resp, err := c.httpClient.Do(req)
		cancel()
		if err != nil {
			lastErr = err
			if !retryable || attempt == attempts-1 || ctx.Err() != nil {
				return err
			}
			if err := c.sleep(ctx, attempt); err != nil {
				return err
			}
			continue
		}

		err = decodeResponse(resp, out)
		if err == nil {
			return nil
		}
		lastErr = err

		var apiErr *APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode >= 500 && retryable && attempt < attempts-1 {
			if err := c.sleep(ctx, attempt); err != nil {
				return err
			}
			continue
		}
		return err
	}

	if lastErr != nil {
		return lastErr
	}
	return errors.New("tixkit: request failed")
}

func (c *Client) requestURL(path string, params url.Values) (string, error) {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	parsed, err := url.Parse(c.baseURL + "/v1" + path)
	if err != nil {
		return "", err
	}
	if params != nil {
		query := parsed.Query()
		for key, values := range params {
			for _, value := range values {
				query.Add(key, value)
			}
		}
		parsed.RawQuery = query.Encode()
	}
	return parsed.String(), nil
}

func (c *Client) applyHeaders(req *http.Request, hasBody bool, opts requestOptions) {
	req.Header.Set("X-Tixkit-Version", APIVersion)
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	if hasBody {
		req.Header.Set("Content-Type", "application/json")
	}
	if opts.idempotencyKey != "" {
		req.Header.Set("Idempotency-Key", opts.idempotencyKey)
	}
	for key, values := range opts.headers {
		req.Header.Del(key)
		for _, value := range values {
			req.Header.Add(key, value)
		}
	}
}

func (c *Client) sleep(ctx context.Context, attempt int) error {
	delay := c.backoff(attempt)
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func defaultBackoff(attempt int) time.Duration {
	if attempt < 0 {
		attempt = 0
	}
	delay := time.Second << attempt
	if delay > defaultMaxBackoff {
		return defaultMaxBackoff
	}
	return delay
}

func isSafeMethod(method string) bool {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}

func decodeResponse(resp *http.Response, out any) error {
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return newAPIError(resp.StatusCode, responseBody)
	}
	if len(bytes.TrimSpace(responseBody)) == 0 || out == nil {
		return nil
	}
	return json.Unmarshal(responseBody, out)
}

func escape(id string) string {
	return url.PathEscape(id)
}

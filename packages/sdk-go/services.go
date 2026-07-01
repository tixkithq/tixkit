package tixkit

import (
	"context"
	"net/http"
	"net/url"
	"strconv"
)

type EventsService struct{ client *Client }

type PublicService struct{ client *Client }

func (s *PublicService) GetEvent(ctx context.Context, eventID string) (*Event, error) {
	var out Event
	err := s.client.request(ctx, http.MethodGet, "/public/events/"+escape(eventID), nil, &out)
	return &out, err
}

func (s *PublicService) GetEventPage(ctx context.Context, eventID string, params *PublicEventPageParams) (*PublicContentPage, error) {
	var out PublicContentPage
	err := s.client.request(ctx, http.MethodGet, "/public/events/"+escape(eventID)+"/page", nil, &out, withParams(publicEventPageValues(params)))
	return &out, err
}

func (s *PublicService) GetContentPage(ctx context.Context, eventID string, params *PublicEventPageParams) (*PublicContentPage, error) {
	var out PublicContentPage
	err := s.client.request(ctx, http.MethodGet, "/public/events/"+escape(eventID)+"/content-page", nil, &out, withParams(publicEventPageValues(params)))
	return &out, err
}

func (s *PublicService) GetEventPageBySlug(ctx context.Context, slug string, params PublicEventPageBySlugParams) (*PublicContentPage, error) {
	values := url.Values{}
	values.Set("host", params.Host)
	if params.Locale != "" {
		values.Set("locale", params.Locale)
	}
	var out PublicContentPage
	err := s.client.request(ctx, http.MethodGet, "/public/events/by-slug/"+escape(slug)+"/page", nil, &out, withParams(values))
	return &out, err
}

func (s *PublicService) GetEventDiscoveryCard(ctx context.Context, eventID string, params *PublicEventPageParams) (*PublicEventDiscoveryCard, error) {
	var out PublicEventDiscoveryCard
	err := s.client.request(ctx, http.MethodGet, "/public/events/"+escape(eventID)+"/discovery-card", nil, &out, withParams(publicEventPageValues(params)))
	return &out, err
}

func (s *PublicService) ListResaleListings(ctx context.Context, eventID string, params *PaginationParams) (*Page[PublicTicketListing], error) {
	var out Page[PublicTicketListing]
	err := s.client.request(ctx, http.MethodGet, "/public/events/"+escape(eventID)+"/resale-listings", nil, &out, withParams(paginationValues(params)))
	return &out, err
}

func publicEventPageValues(params *PublicEventPageParams) url.Values {
	values := url.Values{}
	if params != nil && params.Locale != "" {
		values.Set("locale", params.Locale)
	}
	return values
}

func (s *EventsService) List(ctx context.Context, params *PaginationParams) (*Page[Event], error) {
	var out Page[Event]
	err := s.client.request(ctx, http.MethodGet, "/events", nil, &out, withParams(paginationValues(params)))
	return &out, err
}

func (s *EventsService) Get(ctx context.Context, eventID string) (*Event, error) {
	var out Event
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID), nil, &out)
	return &out, err
}

func (s *EventsService) Create(ctx context.Context, input CreateEventRequest) (*Event, error) {
	var out Event
	err := s.client.request(ctx, http.MethodPost, "/events", input, &out)
	return &out, err
}

func (s *EventsService) Update(ctx context.Context, eventID string, input UpdateEventRequest) (*Event, error) {
	var out Event
	err := s.client.request(ctx, http.MethodPatch, "/events/"+escape(eventID), input, &out)
	return &out, err
}

func (s *EventsService) Publish(ctx context.Context, eventID string) (*Event, error) {
	var out Event
	err := s.client.request(ctx, http.MethodPost, "/events/"+escape(eventID)+"/publish", nil, &out)
	return &out, err
}

func (s *EventsService) Pause(ctx context.Context, eventID string) (*Event, error) {
	var out Event
	err := s.client.request(ctx, http.MethodPost, "/events/"+escape(eventID)+"/pause", nil, &out)
	return &out, err
}

func (s *EventsService) Archive(ctx context.Context, eventID string) (*Event, error) {
	var out Event
	err := s.client.request(ctx, http.MethodPost, "/events/"+escape(eventID)+"/archive", nil, &out)
	return &out, err
}

func (s *EventsService) Availability(ctx context.Context, eventID string) (*Page[EventAvailability], error) {
	var out Page[EventAvailability]
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/availability", nil, &out)
	return &out, err
}

func (s *EventsService) ListResaleListings(ctx context.Context, eventID string, params *PaginationParams) (*Page[TicketListing], error) {
	var out Page[TicketListing]
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/resale-listings", nil, &out, withParams(paginationValues(params)))
	return &out, err
}

func (s *EventsService) ListOccurrences(ctx context.Context, eventID string) (*Page[EventOccurrence], error) {
	var out Page[EventOccurrence]
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/occurrences", nil, &out)
	return &out, err
}

func (s *EventsService) CreateOccurrence(ctx context.Context, eventID string, input CreateEventOccurrenceRequest) (*EventOccurrence, error) {
	var out EventOccurrence
	err := s.client.request(ctx, http.MethodPost, "/events/"+escape(eventID)+"/occurrences", input, &out)
	return &out, err
}

func (s *EventsService) UpdateOccurrence(ctx context.Context, eventID string, occurrenceID string, input UpdateEventOccurrenceRequest) (*EventOccurrence, error) {
	var out EventOccurrence
	err := s.client.request(ctx, http.MethodPatch, "/events/"+escape(eventID)+"/occurrences/"+escape(occurrenceID), input, &out)
	return &out, err
}

type TicketTypesService struct{ client *Client }

func (s *TicketTypesService) List(ctx context.Context, eventID string, params *PaginationParams) (*Page[TicketType], error) {
	var out Page[TicketType]
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/ticket-types", nil, &out, withParams(paginationValues(params)))
	return &out, err
}

func (s *TicketTypesService) Create(ctx context.Context, eventID string, input CreateTicketTypeRequest) (*TicketType, error) {
	var out TicketType
	err := s.client.request(ctx, http.MethodPost, "/events/"+escape(eventID)+"/ticket-types", input, &out)
	return &out, err
}

func (s *TicketTypesService) Update(ctx context.Context, ticketTypeID string, input UpdateTicketTypeRequest) (*TicketType, error) {
	var out TicketType
	err := s.client.request(ctx, http.MethodPatch, "/ticket-types/"+escape(ticketTypeID), input, &out)
	return &out, err
}

func (s *TicketTypesService) CreateBatch(ctx context.Context, eventID string, input TicketTypeBatchRequest) (*TicketTypeBatchResult, error) {
	var out TicketTypeBatchResult
	err := s.client.request(ctx, http.MethodPost, "/events/"+escape(eventID)+"/ticket-types/batch", input, &out)
	return &out, err
}

func (s *TicketTypesService) UpdateBatch(ctx context.Context, ticketTypeID string, input TicketTypeBatchRequest) (*TicketTypeBatchResult, error) {
	var out TicketTypeBatchResult
	err := s.client.request(ctx, http.MethodPatch, "/ticket-types/"+escape(ticketTypeID)+"/batch", input, &out)
	return &out, err
}

func (s *TicketTypesService) ListAccessRules(ctx context.Context, ticketTypeID string) (*Page[AccessRule], error) {
	var out Page[AccessRule]
	err := s.client.request(ctx, http.MethodGet, "/ticket-types/"+escape(ticketTypeID)+"/access-rules", nil, &out)
	return &out, err
}

func (s *TicketTypesService) CreateAccessRule(ctx context.Context, ticketTypeID string, input CreateAccessRuleRequest) (*AccessRule, error) {
	var out AccessRule
	err := s.client.request(ctx, http.MethodPost, "/ticket-types/"+escape(ticketTypeID)+"/access-rules", input, &out)
	return &out, err
}

func (s *TicketTypesService) DeleteAccessRule(ctx context.Context, accessRuleID string) error {
	return s.client.request(ctx, http.MethodDelete, "/access-rules/"+escape(accessRuleID), nil, nil)
}

type TicketsService struct{ client *Client }

func (s *TicketsService) CreateResaleListing(ctx context.Context, ticketID string, input CreateResaleListingRequest) (*TicketListing, error) {
	var out TicketListing
	err := s.client.request(ctx, http.MethodPost, "/tickets/"+escape(ticketID)+"/resale-listings", input, &out, withIdempotencyKey(input.IdempotencyKey))
	return &out, err
}

func (s *TicketsService) DelistResaleListing(ctx context.Context, listingID string, idempotencyKey string) (*TicketListing, error) {
	var out TicketListing
	err := s.client.request(ctx, http.MethodPost, "/ticket-listings/"+escape(listingID)+"/delist", map[string]any{}, &out, withIdempotencyKey(idempotencyKey))
	return &out, err
}

func (s *TicketsService) CompleteResaleListing(ctx context.Context, listingID string, input CompleteResaleListingRequest) (*TicketResaleCompletion, error) {
	var out TicketResaleCompletion
	err := s.client.request(ctx, http.MethodPost, "/ticket-listings/"+escape(listingID)+"/complete", input, &out, withIdempotencyKey(input.IdempotencyKey))
	return &out, err
}

type CheckoutSessionsService struct{ client *Client }

func (s *CheckoutSessionsService) Create(ctx context.Context, input CreateCheckoutSessionRequest) (*CheckoutSession, error) {
	var out CheckoutSession
	err := s.client.request(ctx, http.MethodPost, "/checkout/sessions", input, &out, withIdempotencyKey(input.IdempotencyKey))
	return &out, err
}

func (s *CheckoutSessionsService) Get(ctx context.Context, sessionID string, options *CheckoutSessionGetOptions) (*CheckoutSession, error) {
	var out CheckoutSession
	headers := http.Header{}
	params := url.Values{}
	if options != nil {
		if options.ClientToken != "" {
			headers.Set("X-Checkout-Session-Token", options.ClientToken)
		}
		if options.PaymentIntentClientSecret != "" {
			params.Set("payment_intent_client_secret", options.PaymentIntentClientSecret)
		}
	}
	err := s.client.request(ctx, http.MethodGet, "/checkout/sessions/"+escape(sessionID), nil, &out, withHeaders(headers), withParams(params))
	return &out, err
}

func (s *CheckoutSessionsService) WalletPasses(ctx context.Context, sessionID string, clientToken string) (*CheckoutWalletPasses, error) {
	var out CheckoutWalletPasses
	headers := http.Header{}
	if clientToken != "" {
		headers.Set("X-Checkout-Session-Token", clientToken)
	}
	err := s.client.request(ctx, http.MethodGet, "/checkout/sessions/"+escape(sessionID)+"/wallet-passes", nil, &out, withHeaders(headers))
	return &out, err
}

func (s *CheckoutSessionsService) CreateTicketResaleListing(ctx context.Context, sessionID string, ticketID string, input CreateCheckoutTicketResaleListingRequest) (*TicketListing, error) {
	var out TicketListing
	headers := http.Header{}
	if input.ClientToken != "" {
		headers.Set("X-Checkout-Session-Token", input.ClientToken)
	}
	err := s.client.request(
		ctx,
		http.MethodPost,
		"/checkout/sessions/"+escape(sessionID)+"/tickets/"+escape(ticketID)+"/resale-listing",
		input,
		&out,
		withHeaders(headers),
		withIdempotencyKey(input.IdempotencyKey),
	)
	return &out, err
}

func (s *CheckoutSessionsService) Update(ctx context.Context, sessionID string, input UpdateCheckoutSessionRequest) (*CheckoutSession, error) {
	var out CheckoutSession
	headers := http.Header{}
	if input.ClientToken != "" {
		headers.Set("X-Checkout-Session-Token", input.ClientToken)
	}
	err := s.client.request(ctx, http.MethodPatch, "/checkout/sessions/"+escape(sessionID), input, &out, withHeaders(headers))
	return &out, err
}

func (s *CheckoutSessionsService) Confirm(ctx context.Context, sessionID string, input ConfirmCheckoutSessionRequest) (*CheckoutConfirmResult, error) {
	var out CheckoutConfirmResult
	headers := http.Header{}
	if input.ClientToken != "" {
		headers.Set("X-Checkout-Session-Token", input.ClientToken)
	}
	err := s.client.request(ctx, http.MethodPost, "/checkout/sessions/"+escape(sessionID)+"/confirm", input, &out, withHeaders(headers), withIdempotencyKey(input.IdempotencyKey))
	return &out, err
}

func (s *CheckoutSessionsService) CreateBoxOfficeOrder(ctx context.Context, eventID string, input BoxOfficeOrderRequest) (*BoxOfficeOrderResult, error) {
	var out BoxOfficeOrderResult
	err := s.client.request(ctx, http.MethodPost, "/events/"+escape(eventID)+"/box-office/orders", input, &out, withIdempotencyKey(input.IdempotencyKey))
	return &out, err
}

type OrdersService struct{ client *Client }

func (s *OrdersService) List(ctx context.Context, params *OrderListParams) (*Page[Order], error) {
	var out Page[Order]
	values := paginationValues(nil)
	if params != nil {
		values = params.PaginationParams.values()
		if params.EventID != "" {
			values.Set("eventId", params.EventID)
		}
		if params.Status != "" {
			values.Set("status", params.Status)
		}
	}
	err := s.client.request(ctx, http.MethodGet, "/orders", nil, &out, withParams(values))
	return &out, err
}

func (s *OrdersService) Get(ctx context.Context, orderID string) (*OrderDetail, error) {
	var out OrderDetail
	err := s.client.request(ctx, http.MethodGet, "/orders/"+escape(orderID), nil, &out)
	return &out, err
}

func (s *OrdersService) Cancel(ctx context.Context, orderID string) (*Order, error) {
	var out Order
	err := s.client.request(ctx, http.MethodPost, "/orders/"+escape(orderID)+"/cancel", nil, &out)
	return &out, err
}

func (s *OrdersService) Invoice(ctx context.Context, orderID string) (*InvoiceDocument, error) {
	var out InvoiceDocument
	err := s.client.request(ctx, http.MethodGet, "/orders/"+escape(orderID)+"/invoice", nil, &out)
	return &out, err
}

func (s *OrdersService) DownloadInvoice(ctx context.Context, orderID string) (*InvoiceDocument, error) {
	var out InvoiceDocument
	err := s.client.request(ctx, http.MethodGet, "/orders/"+escape(orderID)+"/invoice/download", nil, &out)
	return &out, err
}

func (s *OrdersService) ListPaymentCompensations(ctx context.Context, params *PaginationParams) (*Page[PaymentCompensation], error) {
	var out Page[PaymentCompensation]
	err := s.client.request(ctx, http.MethodGet, "/payment-compensations", nil, &out, withParams(paginationValues(params)))
	return &out, err
}

func (s *OrdersService) Refund(ctx context.Context, orderID string, input RefundRequest) (*RefundQueued, error) {
	var out RefundQueued
	err := s.client.request(ctx, http.MethodPost, "/orders/"+escape(orderID)+"/refunds", input, &out, withIdempotencyKey(input.IdempotencyKey))
	return &out, err
}

type RefundsService struct{ client *Client }

func (s *RefundsService) Create(ctx context.Context, orderID string, input RefundRequest) (*RefundQueued, error) {
	var out RefundQueued
	err := s.client.request(ctx, http.MethodPost, "/orders/"+escape(orderID)+"/refunds", input, &out, withIdempotencyKey(input.IdempotencyKey))
	return &out, err
}

type AttendeesService struct{ client *Client }

func (s *AttendeesService) ListForEvent(ctx context.Context, eventID string, params *PaginationParams) (*Page[Attendee], error) {
	var out Page[Attendee]
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/attendees", nil, &out, withParams(paginationValues(params)))
	return &out, err
}

func (s *AttendeesService) List(ctx context.Context, params *AttendeeListParams) (*Page[Attendee], error) {
	var out Page[Attendee]
	values := paginationValues(nil)
	if params != nil {
		values = params.PaginationParams.values()
		if params.EventID != "" {
			values.Set("eventId", params.EventID)
		}
		if params.Status != "" {
			values.Set("status", params.Status)
		}
	}
	err := s.client.request(ctx, http.MethodGet, "/attendees", nil, &out, withParams(values))
	return &out, err
}

func (s *AttendeesService) Update(ctx context.Context, attendeeID string, input UpdateAttendeeRequest) (*Attendee, error) {
	var out Attendee
	err := s.client.request(ctx, http.MethodPatch, "/attendees/"+escape(attendeeID), input, &out)
	return &out, err
}

type CheckInListsService struct{ client *Client }

func (s *CheckInListsService) List(ctx context.Context, eventID string, params *PaginationParams) (*Page[CheckInList], error) {
	var out Page[CheckInList]
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/check-in-lists", nil, &out, withParams(paginationValues(params)))
	return &out, err
}

func (s *CheckInListsService) Manifest(ctx context.Context, eventID string, checkInListID string, deviceID string, deviceSecret string) (*OfflineManifest, error) {
	var out OfflineManifest
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/check-in-lists/"+escape(checkInListID)+"/manifest", nil, &out, withHeaders(deviceHeaders(deviceID, deviceSecret)))
	return &out, err
}

type CheckInService struct{ client *Client }

func (s *CheckInService) Scan(ctx context.Context, input ScanTicketRequest) (*ScanResult, error) {
	var out ScanResult
	err := s.client.request(ctx, http.MethodPost, "/check-ins/scan", input, &out, withHeaders(deviceHeaders(input.DeviceID, input.DeviceSecret)))
	return &out, err
}

func (s *CheckInService) Sync(ctx context.Context, input SyncScansRequest) (*SyncScanResult, error) {
	var out SyncScanResult
	err := s.client.request(ctx, http.MethodPost, "/check-ins/sync", input, &out, withHeaders(deviceHeaders(input.DeviceID, input.DeviceSecret)), withIdempotencyKey(input.IdempotencyKey))
	return &out, err
}

type QuestionsService struct{ client *Client }

func (s *QuestionsService) List(ctx context.Context, eventID string) (*Page[Question], error) {
	var out Page[Question]
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/questions", nil, &out)
	return &out, err
}

func (s *QuestionsService) Create(ctx context.Context, eventID string, input CreateQuestionRequest) (*Question, error) {
	var out Question
	err := s.client.request(ctx, http.MethodPost, "/events/"+escape(eventID)+"/questions", input, &out)
	return &out, err
}

func (s *QuestionsService) Update(ctx context.Context, questionID string, input UpdateQuestionRequest) (*Question, error) {
	var out Question
	err := s.client.request(ctx, http.MethodPatch, "/questions/"+escape(questionID), input, &out)
	return &out, err
}

func (s *QuestionsService) Reorder(ctx context.Context, eventID string, questions []ReorderQuestionInput) (*Page[Question], error) {
	var out Page[Question]
	err := s.client.request(ctx, http.MethodPost, "/events/"+escape(eventID)+"/questions/reorder", map[string]any{"questions": questions}, &out)
	return &out, err
}

func (s *QuestionsService) Delete(ctx context.Context, questionID string) error {
	return s.client.request(ctx, http.MethodDelete, "/questions/"+escape(questionID), nil, nil)
}

type WaitlistService struct{ client *Client }

func (s *WaitlistService) List(ctx context.Context, eventID string) (*WaitlistListResult, error) {
	var out WaitlistListResult
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/waitlist", nil, &out)
	return &out, err
}

func (s *WaitlistService) UpdateSettings(ctx context.Context, eventID string, input WaitlistSettings) (*WaitlistSettings, error) {
	var out WaitlistSettings
	err := s.client.request(ctx, http.MethodPatch, "/events/"+escape(eventID)+"/waitlist/settings", input, &out)
	return &out, err
}

func (s *WaitlistService) OfferEntry(ctx context.Context, eventID string, entryID string, input OfferWaitlistEntryRequest) (*WaitlistOffer, error) {
	var out WaitlistOffer
	err := s.client.request(ctx, http.MethodPost, "/events/"+escape(eventID)+"/waitlist/"+escape(entryID)+"/offer", input, &out)
	return &out, err
}

func (s *WaitlistService) JoinPublic(ctx context.Context, eventID string, input JoinWaitlistRequest) (*WaitlistEntry, error) {
	var out WaitlistEntry
	err := s.client.request(ctx, http.MethodPost, "/public/events/"+escape(eventID)+"/waitlist", input, &out)
	return &out, err
}

func (s *WaitlistService) Claim(ctx context.Context, token string) (*WaitlistEntry, error) {
	var out WaitlistEntry
	err := s.client.request(ctx, http.MethodGet, "/public/waitlist/claims/"+escape(token), nil, &out)
	return &out, err
}

type ReportsService struct{ client *Client }

func (s *ReportsService) Sales(ctx context.Context, eventID string, params *SalesReportParams) (*SalesReport, error) {
	var out SalesReport
	values := url.Values{}
	if params != nil {
		if params.From != "" {
			values.Set("from", params.From)
		}
		if params.To != "" {
			values.Set("to", params.To)
		}
	}
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/reports/sales", nil, &out, withParams(values))
	return &out, err
}

func (s *ReportsService) Tax(ctx context.Context, eventID string) (*TaxReport, error) {
	var out TaxReport
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/reports/tax", nil, &out)
	return &out, err
}

func (s *ReportsService) Attendance(ctx context.Context, eventID string) (*AttendanceReport, error) {
	var out AttendanceReport
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/reports/attendance", nil, &out)
	return &out, err
}

func (s *ReportsService) Promo(ctx context.Context, eventID string) (*PromoReport, error) {
	var out PromoReport
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/reports/promo", nil, &out)
	return &out, err
}

func (s *ReportsService) Conversion(ctx context.Context, eventID string) (*ConversionReport, error) {
	var out ConversionReport
	err := s.client.request(ctx, http.MethodGet, "/events/"+escape(eventID)+"/reports/conversion", nil, &out)
	return &out, err
}

func (s *ReportsService) Affiliate(ctx context.Context, organizationID string) (*AffiliateReport, error) {
	var out AffiliateReport
	err := s.client.request(ctx, http.MethodGet, "/organizations/"+escape(organizationID)+"/reports/affiliate", nil, &out)
	return &out, err
}

type ExportsService struct{ client *Client }

func (s *ExportsService) Create(ctx context.Context, input CreateExportRequest) (*ExportJobQueued, error) {
	var out ExportJobQueued
	err := s.client.request(ctx, http.MethodPost, "/exports", input, &out, withIdempotencyKey(input.IdempotencyKey))
	return &out, err
}

func (s *ExportsService) Get(ctx context.Context, exportID string) (*ExportJob, error) {
	var out ExportJob
	err := s.client.request(ctx, http.MethodGet, "/exports/"+escape(exportID), nil, &out)
	return &out, err
}

func (s *ExportsService) Events(ctx context.Context, exportID string) (FlexibleObject, error) {
	var out FlexibleObject
	err := s.client.request(ctx, http.MethodGet, "/exports/"+escape(exportID)+"/events", nil, &out)
	return out, err
}

func (s *ExportsService) Download(ctx context.Context, exportID string) (*ExportDownload, error) {
	var out ExportDownload
	err := s.client.request(ctx, http.MethodGet, "/exports/"+escape(exportID)+"/download", nil, &out)
	return &out, err
}

type WebhooksService struct{ client *Client }

func (s *WebhooksService) ListEndpoints(ctx context.Context, params *PaginationParams) (*Page[WebhookEndpoint], error) {
	var out Page[WebhookEndpoint]
	err := s.client.request(ctx, http.MethodGet, "/webhook-endpoints", nil, &out, withParams(paginationValues(params)))
	return &out, err
}

func (s *WebhooksService) CreateEndpoint(ctx context.Context, input CreateWebhookEndpointRequest) (*WebhookEndpoint, error) {
	var out WebhookEndpoint
	err := s.client.request(ctx, http.MethodPost, "/webhook-endpoints", input, &out)
	return &out, err
}

func (s *WebhooksService) UpdateEndpoint(ctx context.Context, endpointID string, input UpdateWebhookEndpointRequest) (*WebhookEndpoint, error) {
	var out WebhookEndpoint
	err := s.client.request(ctx, http.MethodPatch, "/webhook-endpoints/"+escape(endpointID), input, &out)
	return &out, err
}

func (s *WebhooksService) ListEvents(ctx context.Context, endpointID string, params *PaginationParams) (*Page[WebhookEvent], error) {
	var out Page[WebhookEvent]
	err := s.client.request(ctx, http.MethodGet, "/webhook-endpoints/"+escape(endpointID)+"/events", nil, &out, withParams(paginationValues(params)))
	return &out, err
}

func (s *WebhooksService) ReplayEndpointEvent(ctx context.Context, endpointID string, eventID string) (*ReplayWebhookEventResult, error) {
	var out ReplayWebhookEventResult
	err := s.client.request(ctx, http.MethodPost, "/webhook-endpoints/"+escape(endpointID)+"/events/"+escape(eventID)+"/replay", nil, &out)
	return &out, err
}

func (s *WebhooksService) ReplayEvent(ctx context.Context, eventID string) (*ReplayWebhookEventResult, error) {
	var out ReplayWebhookEventResult
	err := s.client.request(ctx, http.MethodPost, "/webhook-events/"+escape(eventID)+"/replay", nil, &out)
	return &out, err
}

type APIKeysService struct{ client *Client }

func (s *APIKeysService) List(ctx context.Context, params *PaginationParams) (*Page[APIKey], error) {
	var out Page[APIKey]
	err := s.client.request(ctx, http.MethodGet, "/api-keys", nil, &out, withParams(paginationValues(params)))
	return &out, err
}

func (s *APIKeysService) Create(ctx context.Context, input CreateAPIKeyRequest) (*APIKey, error) {
	var out APIKey
	err := s.client.request(ctx, http.MethodPost, "/api-keys", input, &out)
	return &out, err
}

func (s *APIKeysService) Revoke(ctx context.Context, keyID string) error {
	return s.client.request(ctx, http.MethodDelete, "/api-keys/"+escape(keyID), nil, nil)
}

func paginationValues(params *PaginationParams) url.Values {
	if params == nil {
		return url.Values{}
	}
	return params.values()
}

func deviceHeaders(deviceID string, deviceSecret string) http.Header {
	headers := http.Header{}
	if deviceID != "" {
		headers.Set("X-Device-Id", deviceID)
	}
	if deviceSecret != "" {
		headers.Set("X-Device-Secret", deviceSecret)
	}
	return headers
}

func setInt(values url.Values, key string, value int) {
	if value > 0 {
		values.Set(key, strconv.Itoa(value))
	}
}

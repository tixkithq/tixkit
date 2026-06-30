package tixkit

// FlexibleObject is used for API fields whose keys are tenant-defined.
type FlexibleObject map[string]any

type Buyer struct {
	Email     string `json:"email,omitempty"`
	FirstName string `json:"firstName,omitempty"`
	LastName  string `json:"lastName,omitempty"`
	Phone     string `json:"phone,omitempty"`
}

type Event struct {
	ID             string         `json:"id"`
	TenantID       string         `json:"tenantId,omitempty"`
	OrganizationID string         `json:"organizationId,omitempty"`
	BrandID        string         `json:"brandId,omitempty"`
	Slug           string         `json:"slug,omitempty"`
	Title          string         `json:"title"`
	Description    string         `json:"description,omitempty"`
	Currency       string         `json:"currency,omitempty"`
	Timezone       string         `json:"timezone,omitempty"`
	StartsAt       string         `json:"startsAt,omitempty"`
	EndsAt         string         `json:"endsAt,omitempty"`
	Status         string         `json:"status,omitempty"`
	Visibility     string         `json:"visibility,omitempty"`
	Capacity       int            `json:"capacity,omitempty"`
	CoverImageURL  string         `json:"coverImageUrl,omitempty"`
	ExternalURL    string         `json:"externalUrl,omitempty"`
	Venue          FlexibleObject `json:"venue,omitempty"`
	SEO            FlexibleObject `json:"seo,omitempty"`
	ResalePolicy   *ResalePolicy  `json:"resalePolicy,omitempty"`
	CreatedAt      string         `json:"createdAt,omitempty"`
	UpdatedAt      string         `json:"updatedAt,omitempty"`
}

type ResalePolicy struct {
	Enabled          bool     `json:"enabled"`
	MaxMultiplier    float64  `json:"maxMultiplier"`
	MaxAbsoluteCents *int     `json:"maxAbsoluteCents,omitempty"`
	Currency         *string  `json:"currency,omitempty"`
	Sources          []string `json:"sources,omitempty"`
}

type CreateEventRequest struct {
	OrganizationID string         `json:"organizationId"`
	BrandID        string         `json:"brandId"`
	Slug           string         `json:"slug"`
	Title          string         `json:"title"`
	Currency       string         `json:"currency"`
	Timezone       string         `json:"timezone"`
	StartsAt       string         `json:"startsAt"`
	EndsAt         string         `json:"endsAt,omitempty"`
	Description    string         `json:"description,omitempty"`
	Visibility     string         `json:"visibility,omitempty"`
	Capacity       int            `json:"capacity,omitempty"`
	CoverImageURL  string         `json:"coverImageUrl,omitempty"`
	ExternalURL    string         `json:"externalUrl,omitempty"`
	Venue          FlexibleObject `json:"venue,omitempty"`
	SEO            FlexibleObject `json:"seo,omitempty"`
}

type UpdateEventRequest struct {
	Title         *string        `json:"title,omitempty"`
	Description   *string        `json:"description,omitempty"`
	Currency      *string        `json:"currency,omitempty"`
	Status        *string        `json:"status,omitempty"`
	Timezone      *string        `json:"timezone,omitempty"`
	StartsAt      *string        `json:"startsAt,omitempty"`
	EndsAt        *string        `json:"endsAt,omitempty"`
	Visibility    *string        `json:"visibility,omitempty"`
	Capacity      *int           `json:"capacity,omitempty"`
	CoverImageURL *string        `json:"coverImageUrl,omitempty"`
	ExternalURL   *string        `json:"externalUrl,omitempty"`
	Venue         FlexibleObject `json:"venue,omitempty"`
	SEO           FlexibleObject `json:"seo,omitempty"`
}

type EventOccurrence struct {
	ID        string         `json:"id"`
	EventID   string         `json:"eventId,omitempty"`
	Title     string         `json:"title,omitempty"`
	StartsAt  string         `json:"startsAt,omitempty"`
	EndsAt    string         `json:"endsAt,omitempty"`
	Timezone  string         `json:"timezone,omitempty"`
	Venue     FlexibleObject `json:"venue,omitempty"`
	Capacity  int            `json:"capacity,omitempty"`
	SortOrder int            `json:"sortOrder,omitempty"`
	Status    string         `json:"status,omitempty"`
	CreatedAt string         `json:"createdAt,omitempty"`
	UpdatedAt string         `json:"updatedAt,omitempty"`
}

type EventAvailability struct {
	TicketTypeID      string `json:"ticketTypeId"`
	EventOccurrenceID string `json:"eventOccurrenceId,omitempty"`
	Available         int    `json:"available"`
	Total             int    `json:"total"`
	Reserved          int    `json:"reserved"`
	Sold              int    `json:"sold"`
	Status            string `json:"status"`
}

type PublicTicketListing struct {
	ID             string `json:"id"`
	EventID        string `json:"eventId,omitempty"`
	TicketTypeID   string `json:"ticketTypeId,omitempty"`
	TicketTypeName string `json:"ticketTypeName,omitempty"`
	Status         string `json:"status"`
	PriceCents     int    `json:"priceCents"`
	Currency       string `json:"currency"`
	FaceValueCents int    `json:"faceValueCents"`
	ExpiresAt      string `json:"expiresAt,omitempty"`
	CreatedAt      string `json:"createdAt,omitempty"`
	UpdatedAt      string `json:"updatedAt,omitempty"`
}

type PublicContentPage struct {
	Document PublicContentDocument `json:"document"`
	Version  PublicContentVersion  `json:"version"`
	Page     PublicEventPage       `json:"page"`
}

type PublicContentDocument struct {
	EventID   string `json:"eventId"`
	Channel   string `json:"channel"`
	Key       string `json:"key"`
	Name      string `json:"name"`
	Locale    string `json:"locale"`
	UpdatedAt string `json:"updatedAt"`
}

type PublicContentVersion struct {
	VersionNumber int    `json:"versionNumber"`
	Subject       string `json:"subject,omitempty"`
	PreviewText   string `json:"previewText,omitempty"`
	RenderedHTML  string `json:"renderedHtml,omitempty"`
	RenderedText  string `json:"renderedText,omitempty"`
	PublishedAt   string `json:"publishedAt,omitempty"`
}

type PublicEventPage struct {
	HTML      string                   `json:"html"`
	Text      string                   `json:"text"`
	Headless  []PublicEventPageBlock   `json:"headless"`
	Discovery PublicEventDiscoveryCard `json:"discovery"`
}

type PublicEventPageBlock struct {
	Type     string           `json:"type"`
	ID       string           `json:"id"`
	Title    string           `json:"title,omitempty"`
	Text     string           `json:"text,omitempty"`
	HTML     string           `json:"html,omitempty"`
	ImageURL string           `json:"imageUrl,omitempty"`
	ImageAlt string           `json:"imageAlt,omitempty"`
	Links    []PublicPageLink `json:"links,omitempty"`
	Items    []any            `json:"items,omitempty"`
}

type PublicPageLink struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

type PublicEventDiscoveryCard struct {
	Title      string   `json:"title"`
	Summary    string   `json:"summary"`
	Category   string   `json:"category,omitempty"`
	Tags       []string `json:"tags"`
	ImageURL   string   `json:"imageUrl,omitempty"`
	StartsAt   string   `json:"startsAt,omitempty"`
	VenueName  string   `json:"venueName,omitempty"`
	PublicPath string   `json:"publicPath,omitempty"`
}

type PublicEventPageParams struct {
	Locale string
}

type PublicEventPageBySlugParams struct {
	Host   string
	Locale string
}

type CreateEventOccurrenceRequest struct {
	Title     string         `json:"title"`
	StartsAt  string         `json:"startsAt"`
	EndsAt    string         `json:"endsAt"`
	Timezone  string         `json:"timezone"`
	Venue     FlexibleObject `json:"venue,omitempty"`
	Capacity  *int           `json:"capacity,omitempty"`
	SortOrder int            `json:"sortOrder,omitempty"`
	Status    string         `json:"status,omitempty"`
}

type UpdateEventOccurrenceRequest struct {
	Title     *string        `json:"title,omitempty"`
	StartsAt  *string        `json:"startsAt,omitempty"`
	EndsAt    *string        `json:"endsAt,omitempty"`
	Timezone  *string        `json:"timezone,omitempty"`
	Venue     FlexibleObject `json:"venue,omitempty"`
	Capacity  *int           `json:"capacity,omitempty"`
	SortOrder *int           `json:"sortOrder,omitempty"`
	Status    *string        `json:"status,omitempty"`
}

type TicketType struct {
	ID                 string `json:"id"`
	EventID            string `json:"eventId,omitempty"`
	EventOccurrenceID  string `json:"eventOccurrenceId,omitempty"`
	InventoryPoolID    string `json:"inventoryPoolId,omitempty"`
	Name               string `json:"name"`
	Description        string `json:"description,omitempty"`
	Kind               string `json:"kind,omitempty"`
	Currency           string `json:"currency,omitempty"`
	PriceCents         int    `json:"priceCents,omitempty"`
	MinimumPriceCents  int    `json:"minimumPriceCents,omitempty"`
	QuantityTotal      int    `json:"quantityTotal,omitempty"`
	QuantitySold       int    `json:"quantitySold,omitempty"`
	MinPerOrder        int    `json:"minPerOrder,omitempty"`
	MaxPerOrder        int    `json:"maxPerOrder,omitempty"`
	SalesStartAt       string `json:"salesStartAt,omitempty"`
	SalesEndAt         string `json:"salesEndAt,omitempty"`
	Status             string `json:"status,omitempty"`
	Visibility         string `json:"visibility,omitempty"`
	RequiresAccessCode bool   `json:"requiresAccessCode,omitempty"`
	AccessCodeHint     string `json:"accessCodeHint,omitempty"`
	SortOrder          int    `json:"sortOrder,omitempty"`
}

type CreateTicketTypeRequest struct {
	Name               string `json:"name"`
	Description        string `json:"description,omitempty"`
	Kind               string `json:"kind,omitempty"`
	Currency           string `json:"currency,omitempty"`
	PriceCents         int    `json:"priceCents,omitempty"`
	MinimumPriceCents  int    `json:"minimumPriceCents,omitempty"`
	QuantityTotal      int    `json:"quantityTotal,omitempty"`
	EventOccurrenceID  string `json:"eventOccurrenceId,omitempty"`
	InventoryPoolID    string `json:"inventoryPoolId,omitempty"`
	MinPerOrder        int    `json:"minPerOrder,omitempty"`
	MaxPerOrder        int    `json:"maxPerOrder,omitempty"`
	SalesStartAt       string `json:"salesStartAt,omitempty"`
	SalesEndAt         string `json:"salesEndAt,omitempty"`
	Visibility         string `json:"visibility,omitempty"`
	RequiresAccessCode bool   `json:"requiresAccessCode,omitempty"`
	AccessCodeHint     string `json:"accessCodeHint,omitempty"`
}

type UpdateTicketTypeRequest struct {
	Name               *string `json:"name,omitempty"`
	Description        *string `json:"description,omitempty"`
	Kind               *string `json:"kind,omitempty"`
	Currency           *string `json:"currency,omitempty"`
	PriceCents         *int    `json:"priceCents,omitempty"`
	MinimumPriceCents  *int    `json:"minimumPriceCents,omitempty"`
	EventOccurrenceID  *string `json:"eventOccurrenceId,omitempty"`
	InventoryPoolID    *string `json:"inventoryPoolId,omitempty"`
	MinPerOrder        *int    `json:"minPerOrder,omitempty"`
	MaxPerOrder        *int    `json:"maxPerOrder,omitempty"`
	SalesStartAt       *string `json:"salesStartAt,omitempty"`
	SalesEndAt         *string `json:"salesEndAt,omitempty"`
	Status             *string `json:"status,omitempty"`
	Visibility         *string `json:"visibility,omitempty"`
	RequiresAccessCode *bool   `json:"requiresAccessCode,omitempty"`
	AccessCodeHint     *string `json:"accessCodeHint,omitempty"`
	SortOrder          *int    `json:"sortOrder,omitempty"`
}

type InventoryPoolRequest struct {
	Name           string `json:"name"`
	TotalCapacity  int    `json:"totalCapacity"`
	HoldTTLSeconds int    `json:"holdTtlSeconds,omitempty"`
}

type TicketTypeBatchRequest struct {
	TicketType    CreateTicketTypeRequest   `json:"ticketType"`
	InventoryPool *InventoryPoolRequest     `json:"inventoryPool,omitempty"`
	AccessRules   []CreateAccessRuleRequest `json:"accessRules,omitempty"`
}

type TicketTypeBatchResult struct {
	TicketType    TicketType     `json:"ticketType"`
	InventoryPool *InventoryPool `json:"inventoryPool,omitempty"`
	AccessRules   []AccessRule   `json:"accessRules,omitempty"`
}

type InventoryPool struct {
	ID             string `json:"id"`
	EventID        string `json:"eventId,omitempty"`
	Name           string `json:"name"`
	TotalCapacity  int    `json:"totalCapacity"`
	ReservedCount  int    `json:"reservedCount,omitempty"`
	SoldCount      int    `json:"soldCount,omitempty"`
	HoldTTLSeconds int    `json:"holdTtlSeconds,omitempty"`
	CreatedAt      string `json:"createdAt,omitempty"`
	UpdatedAt      string `json:"updatedAt,omitempty"`
}

type AccessRule struct {
	ID           string `json:"id"`
	TicketTypeID string `json:"ticketTypeId,omitempty"`
	Type         string `json:"type"`
	Value        string `json:"value"`
	MaxUses      int    `json:"maxUses,omitempty"`
	UsesCount    int    `json:"usesCount,omitempty"`
	ExpiresAt    string `json:"expiresAt,omitempty"`
	CreatedAt    string `json:"createdAt,omitempty"`
	UpdatedAt    string `json:"updatedAt,omitempty"`
}

type CreateAccessRuleRequest struct {
	Type      string `json:"type"`
	Value     string `json:"value"`
	MaxUses   int    `json:"maxUses,omitempty"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

type CheckoutItem struct {
	TicketTypeID    string           `json:"ticketTypeId,omitempty"`
	OccurrenceID    string           `json:"occurrenceId,omitempty"`
	ProductID       string           `json:"productId,omitempty"`
	ResaleListingID string           `json:"resaleListingId,omitempty"`
	Quantity        int              `json:"quantity"`
	UnitAmountCents int              `json:"unitAmountCents,omitempty"`
	AttendeeFields  []FlexibleObject `json:"attendeeFields,omitempty"`
}

type CreateCheckoutSessionRequest struct {
	EventID            string         `json:"eventId"`
	Items              []CheckoutItem `json:"items"`
	DiscountCode       string         `json:"discountCode,omitempty"`
	AffiliateCode      string         `json:"affiliateCode,omitempty"`
	TrackingID         string         `json:"trackingId,omitempty"`
	BuyerFields        FlexibleObject `json:"buyerFields,omitempty"`
	Buyer              *Buyer         `json:"buyer,omitempty"`
	SuccessURL         string         `json:"successUrl,omitempty"`
	CancelURL          string         `json:"cancelUrl,omitempty"`
	AccessCode         string         `json:"accessCode,omitempty"`
	WaitlistClaimToken string         `json:"waitlistClaimToken,omitempty"`
	IdempotencyKey     string         `json:"-"`
}

type CheckoutSessionGetOptions struct {
	ClientToken               string
	PaymentIntentClientSecret string
}

type CheckoutSession struct {
	ID            string         `json:"id"`
	EventID       string         `json:"eventId,omitempty"`
	Status        string         `json:"status,omitempty"`
	Currency      string         `json:"currency,omitempty"`
	SubtotalCents int            `json:"subtotalCents,omitempty"`
	DiscountCents int            `json:"discountCents,omitempty"`
	FeeCents      int            `json:"feeCents,omitempty"`
	TaxCents      int            `json:"taxCents,omitempty"`
	TotalCents    int            `json:"totalCents,omitempty"`
	ClientToken   string         `json:"clientToken,omitempty"`
	ClientSecret  string         `json:"clientSecret,omitempty"`
	CheckoutURL   string         `json:"checkoutUrl,omitempty"`
	SuccessURL    string         `json:"successUrl,omitempty"`
	CancelURL     string         `json:"cancelUrl,omitempty"`
	Buyer         *Buyer         `json:"buyer,omitempty"`
	Items         []CheckoutItem `json:"items,omitempty"`
	CreatedAt     string         `json:"createdAt,omitempty"`
	UpdatedAt     string         `json:"updatedAt,omitempty"`
}

type UpdateCheckoutSessionRequest struct {
	ClientToken string `json:"-"`
	Buyer       *Buyer `json:"buyer,omitempty"`
	SuccessURL  string `json:"successUrl,omitempty"`
	CancelURL   string `json:"cancelUrl,omitempty"`
}

type ConfirmCheckoutSessionRequest struct {
	ClientToken     string `json:"-"`
	PaymentMethodID string `json:"paymentMethodId,omitempty"`
	IdempotencyKey  string `json:"-"`
}

type CheckoutConfirmResult struct {
	Status       string           `json:"status"`
	Session      *CheckoutSession `json:"session,omitempty"`
	Order        *Order           `json:"order,omitempty"`
	PaymentState string           `json:"paymentState,omitempty"`
}

type CheckoutWalletPasses struct {
	Tickets []CheckoutWalletPassTicket `json:"tickets"`
}

type CheckoutWalletPassTicket struct {
	TicketID            string         `json:"ticketId"`
	TicketCode          string         `json:"ticketCode,omitempty"`
	AttendeeID          string         `json:"attendeeId,omitempty"`
	WalletPassID        string         `json:"walletPassId,omitempty"`
	FaceValueCents      int            `json:"faceValueCents,omitempty"`
	Currency            string         `json:"currency,omitempty"`
	ResaleEnabled       bool           `json:"resaleEnabled,omitempty"`
	ResaleMaxPriceCents int            `json:"resaleMaxPriceCents,omitempty"`
	ActiveResaleListing *TicketListing `json:"activeResaleListing,omitempty"`
	AppleURL            string         `json:"appleUrl,omitempty"`
	GoogleURL           string         `json:"googleUrl,omitempty"`
}

type CreateCheckoutTicketResaleListingRequest struct {
	ClientToken    string `json:"-"`
	PriceCents     int    `json:"priceCents"`
	ExpiresAt      string `json:"expiresAt,omitempty"`
	IdempotencyKey string `json:"-"`
}

type BoxOfficeBuyer struct {
	Email     string `json:"email,omitempty"`
	FirstName string `json:"firstName,omitempty"`
	LastName  string `json:"lastName,omitempty"`
	Phone     string `json:"phone,omitempty"`
}

type BoxOfficeOrderRequest struct {
	Items          []CheckoutItem  `json:"items"`
	TenderType     string          `json:"tenderType"`
	AmountCents    int             `json:"amountCents,omitempty"`
	Buyer          *BoxOfficeBuyer `json:"buyer,omitempty"`
	BuyerFields    FlexibleObject  `json:"buyerFields,omitempty"`
	Notes          string          `json:"notes,omitempty"`
	IdempotencyKey string          `json:"-"`
}

type BoxOfficeOrderResult struct {
	Order     Order      `json:"order"`
	Tickets   []Ticket   `json:"tickets,omitempty"`
	Attendees []Attendee `json:"attendees,omitempty"`
}

type Order struct {
	ID                string `json:"id"`
	TenantID          string `json:"tenantId,omitempty"`
	OrganizationID    string `json:"organizationId,omitempty"`
	BrandID           string `json:"brandId,omitempty"`
	EventID           string `json:"eventId,omitempty"`
	CheckoutSessionID string `json:"checkoutSessionId,omitempty"`
	OrderNumber       string `json:"orderNumber,omitempty"`
	Status            string `json:"status,omitempty"`
	Currency          string `json:"currency,omitempty"`
	BuyerEmail        string `json:"buyerEmail,omitempty"`
	BuyerFirstName    string `json:"buyerFirstName,omitempty"`
	BuyerLastName     string `json:"buyerLastName,omitempty"`
	BuyerPhone        string `json:"buyerPhone,omitempty"`
	SubtotalCents     int    `json:"subtotalCents,omitempty"`
	DiscountCents     int    `json:"discountCents,omitempty"`
	FeeCents          int    `json:"feeCents,omitempty"`
	TaxCents          int    `json:"taxCents,omitempty"`
	TotalCents        int    `json:"totalCents,omitempty"`
	RefundedCents     int    `json:"refundedCents,omitempty"`
	PaymentProvider   string `json:"paymentProvider,omitempty"`
	PaymentIntentID   string `json:"paymentIntentId,omitempty"`
	SalesChannel      string `json:"salesChannel,omitempty"`
	TenderType        string `json:"tenderType,omitempty"`
	PaidAt            string `json:"paidAt,omitempty"`
	CancelledAt       string `json:"cancelledAt,omitempty"`
	RefundedAt        string `json:"refundedAt,omitempty"`
	CreatedAt         string `json:"createdAt,omitempty"`
	UpdatedAt         string `json:"updatedAt,omitempty"`
}

type OrderDetail struct {
	Order
	LineItems    []OrderLineItem      `json:"lineItems,omitempty"`
	Timeline     []OrderTimelineEvent `json:"timeline,omitempty"`
	Invoice      *Invoice             `json:"invoice,omitempty"`
	TaxSnapshots []TaxSnapshot        `json:"taxSnapshots,omitempty"`
}

type OrderLineItem struct {
	ID                string `json:"id"`
	OrderID           string `json:"orderId,omitempty"`
	TicketTypeID      string `json:"ticketTypeId,omitempty"`
	ProductID         string `json:"productId,omitempty"`
	ResaleListingID   string `json:"resaleListingId,omitempty"`
	EventOccurrenceID string `json:"eventOccurrenceId,omitempty"`
	AttendeeID        string `json:"attendeeId,omitempty"`
	Description       string `json:"description,omitempty"`
	Quantity          int    `json:"quantity"`
	Currency          string `json:"currency,omitempty"`
	UnitPriceCents    int    `json:"unitPriceCents,omitempty"`
	SubtotalCents     int    `json:"subtotalCents,omitempty"`
	DiscountCents     int    `json:"discountCents,omitempty"`
	FeeCents          int    `json:"feeCents,omitempty"`
	TaxCents          int    `json:"taxCents,omitempty"`
	TotalCents        int    `json:"totalCents,omitempty"`
	CreatedAt         string `json:"createdAt,omitempty"`
	UpdatedAt         string `json:"updatedAt,omitempty"`
}

type OrderTimelineEvent struct {
	ID          string         `json:"id"`
	OrderID     string         `json:"orderId,omitempty"`
	Type        string         `json:"type"`
	Description string         `json:"description,omitempty"`
	ActorID     string         `json:"actorId,omitempty"`
	Metadata    FlexibleObject `json:"metadata,omitempty"`
	CreatedAt   string         `json:"createdAt,omitempty"`
}

type Invoice struct {
	ID            string         `json:"id"`
	OrderID       string         `json:"orderId,omitempty"`
	InvoiceNumber string         `json:"invoiceNumber,omitempty"`
	Status        string         `json:"status,omitempty"`
	Currency      string         `json:"currency,omitempty"`
	SubtotalCents int            `json:"subtotalCents,omitempty"`
	TaxCents      int            `json:"taxCents,omitempty"`
	TotalCents    int            `json:"totalCents,omitempty"`
	Metadata      FlexibleObject `json:"metadata,omitempty"`
	IssuedAt      string         `json:"issuedAt,omitempty"`
	CreatedAt     string         `json:"createdAt,omitempty"`
	UpdatedAt     string         `json:"updatedAt,omitempty"`
}

type InvoiceDocument struct {
	Invoice
	DownloadURL string `json:"downloadUrl,omitempty"`
	ExpiresAt   string `json:"expiresAt,omitempty"`
}

type TaxSnapshot struct {
	ID                 string         `json:"id"`
	OrderID            string         `json:"orderId,omitempty"`
	OrderLineItemID    string         `json:"orderLineItemId,omitempty"`
	EventID            string         `json:"eventId,omitempty"`
	Type               string         `json:"type,omitempty"`
	Provider           string         `json:"provider,omitempty"`
	TaxRuleName        string         `json:"taxRuleName,omitempty"`
	Rate               float64        `json:"rate,omitempty"`
	Currency           string         `json:"currency,omitempty"`
	TaxableAmountCents int            `json:"taxableAmountCents,omitempty"`
	TaxCents           int            `json:"taxCents,omitempty"`
	Inclusive          bool           `json:"inclusive,omitempty"`
	AppliedTo          string         `json:"appliedTo,omitempty"`
	Metadata           FlexibleObject `json:"metadata,omitempty"`
	CreatedAt          string         `json:"createdAt,omitempty"`
}

type OrderListParams struct {
	PaginationParams
	EventID string
	Status  string
}

type RefundRequest struct {
	AmountCents      int    `json:"amountCents,omitempty"`
	Reason           string `json:"reason"`
	RestoreInventory bool   `json:"restoreInventory,omitempty"`
	VoidTickets      bool   `json:"voidTickets,omitempty"`
	IdempotencyKey   string `json:"-"`
}

type Refund struct {
	ID               string         `json:"id"`
	TenantID         string         `json:"tenantId,omitempty"`
	OrderID          string         `json:"orderId,omitempty"`
	PaymentIntentID  string         `json:"paymentIntentId,omitempty"`
	Provider         string         `json:"provider,omitempty"`
	ProviderRefundID string         `json:"providerRefundId,omitempty"`
	Status           string         `json:"status,omitempty"`
	Reason           string         `json:"reason,omitempty"`
	Currency         string         `json:"currency,omitempty"`
	AmountCents      int            `json:"amountCents,omitempty"`
	Metadata         FlexibleObject `json:"metadata,omitempty"`
	CreatedAt        string         `json:"createdAt,omitempty"`
	UpdatedAt        string         `json:"updatedAt,omitempty"`
}

type Attendee struct {
	ID                string         `json:"id"`
	TenantID          string         `json:"tenantId,omitempty"`
	EventID           string         `json:"eventId,omitempty"`
	EventOccurrenceID string         `json:"eventOccurrenceId,omitempty"`
	OrderID           string         `json:"orderId,omitempty"`
	TicketID          string         `json:"ticketId,omitempty"`
	TicketTypeID      string         `json:"ticketTypeId,omitempty"`
	FirstName         string         `json:"firstName,omitempty"`
	LastName          string         `json:"lastName,omitempty"`
	Email             string         `json:"email,omitempty"`
	Phone             string         `json:"phone,omitempty"`
	Status            string         `json:"status,omitempty"`
	CustomAnswers     FlexibleObject `json:"customAnswers,omitempty"`
	CheckedInAt       string         `json:"checkedInAt,omitempty"`
	CheckInDeviceID   string         `json:"checkInDeviceId,omitempty"`
	CreatedAt         string         `json:"createdAt,omitempty"`
	UpdatedAt         string         `json:"updatedAt,omitempty"`
}

type AttendeeListParams struct {
	PaginationParams
	EventID string
	Status  string
}

type UpdateAttendeeRequest struct {
	FirstName *string `json:"firstName,omitempty"`
	LastName  *string `json:"lastName,omitempty"`
	Email     *string `json:"email,omitempty"`
	Phone     *string `json:"phone,omitempty"`
	Status    *string `json:"status,omitempty"`
}

type Ticket struct {
	ID                  string `json:"id"`
	TenantID            string `json:"tenantId,omitempty"`
	EventID             string `json:"eventId,omitempty"`
	EventOccurrenceID   string `json:"eventOccurrenceId,omitempty"`
	OrderID             string `json:"orderId,omitempty"`
	TicketTypeID        string `json:"ticketTypeId,omitempty"`
	AttendeeID          string `json:"attendeeId,omitempty"`
	Code                string `json:"code,omitempty"`
	QRHash              string `json:"qrHash,omitempty"`
	QRPayload           string `json:"qrPayload,omitempty"`
	Status              string `json:"status,omitempty"`
	CheckedInAt         string `json:"checkedInAt,omitempty"`
	CheckedInByDeviceID string `json:"checkedInByDeviceId,omitempty"`
	TransferredAt       string `json:"transferredAt,omitempty"`
	TransferredToEmail  string `json:"transferredToEmail,omitempty"`
	WalletPassID        string `json:"walletPassId,omitempty"`
	CreatedAt           string `json:"createdAt,omitempty"`
	UpdatedAt           string `json:"updatedAt,omitempty"`
}

type TicketListing struct {
	ID             string `json:"id"`
	TenantID       string `json:"tenantId,omitempty"`
	EventID        string `json:"eventId,omitempty"`
	TicketID       string `json:"ticketId,omitempty"`
	SellerID       string `json:"sellerId,omitempty"`
	Status         string `json:"status,omitempty"`
	PriceCents     int    `json:"priceCents,omitempty"`
	Currency       string `json:"currency,omitempty"`
	FaceValueCents int    `json:"faceValueCents,omitempty"`
	SoldToID       string `json:"soldToId,omitempty"`
	ExpiresAt      string `json:"expiresAt,omitempty"`
	SoldAt         string `json:"soldAt,omitempty"`
	CreatedAt      string `json:"createdAt,omitempty"`
	UpdatedAt      string `json:"updatedAt,omitempty"`
}

type CreateResaleListingRequest struct {
	PriceCents     int    `json:"priceCents"`
	ExpiresAt      string `json:"expiresAt,omitempty"`
	IdempotencyKey string `json:"-"`
}

type CompleteResaleListingRequest struct {
	BuyerID                  string `json:"buyerId"`
	BuyerEmail               string `json:"buyerEmail"`
	BuyerFirstName           string `json:"buyerFirstName,omitempty"`
	BuyerLastName            string `json:"buyerLastName,omitempty"`
	BuyerPhone               string `json:"buyerPhone,omitempty"`
	ExternalPaymentReference string `json:"externalPaymentReference,omitempty"`
	IdempotencyKey           string `json:"-"`
}

type TicketResaleCompletion struct {
	Listing       TicketListing `json:"listing"`
	SellerTicket  Ticket        `json:"sellerTicket"`
	BuyerTicket   Ticket        `json:"buyerTicket"`
	BuyerAttendee Attendee      `json:"buyerAttendee"`
}

type CheckInList struct {
	ID            string   `json:"id"`
	EventID       string   `json:"eventId,omitempty"`
	Name          string   `json:"name"`
	Status        string   `json:"status,omitempty"`
	TicketTypeIDs []string `json:"ticketTypeIds,omitempty"`
	CreatedAt     string   `json:"createdAt,omitempty"`
	UpdatedAt     string   `json:"updatedAt,omitempty"`
}

type OfflineManifest struct {
	CheckInListID string         `json:"checkInListId,omitempty"`
	EventID       string         `json:"eventId,omitempty"`
	GeneratedAt   string         `json:"generatedAt,omitempty"`
	ExpiresAt     string         `json:"expiresAt,omitempty"`
	Tickets       []Ticket       `json:"tickets,omitempty"`
	Signature     string         `json:"signature,omitempty"`
	Metadata      FlexibleObject `json:"metadata,omitempty"`
}

type ScanTicketRequest struct {
	CheckInListID string `json:"checkInListId"`
	QRPayload     string `json:"qrPayload"`
	ScannedAt     string `json:"scannedAt"`
	Offline       bool   `json:"offline,omitempty"`
	DeviceID      string `json:"deviceId,omitempty"`
	DeviceSecret  string `json:"-"`
}

type ScanResult struct {
	Status    string    `json:"status"`
	Message   string    `json:"message,omitempty"`
	Ticket    *Ticket   `json:"ticket,omitempty"`
	Attendee  *Attendee `json:"attendee,omitempty"`
	ScannedAt string    `json:"scannedAt,omitempty"`
}

type OfflineScan struct {
	QRHash    string `json:"qrHash"`
	ScannedAt string `json:"scannedAt"`
	Offline   bool   `json:"offline"`
}

type SyncScansRequest struct {
	CheckInListID  string        `json:"checkInListId"`
	DeviceID       string        `json:"deviceId,omitempty"`
	Scans          []OfflineScan `json:"scans"`
	DeviceSecret   string        `json:"-"`
	IdempotencyKey string        `json:"-"`
}

type SyncScanResult struct {
	Accepted []ScanResult   `json:"accepted,omitempty"`
	Rejected []ScanResult   `json:"rejected,omitempty"`
	Summary  FlexibleObject `json:"summary,omitempty"`
}

type Question struct {
	ID                    string         `json:"id"`
	EventID               string         `json:"eventId,omitempty"`
	TicketTypeID          string         `json:"ticketTypeId,omitempty"`
	Type                  string         `json:"type"`
	Label                 string         `json:"label"`
	Description           string         `json:"description,omitempty"`
	Placeholder           string         `json:"placeholder,omitempty"`
	Required              bool           `json:"required,omitempty"`
	Options               []string       `json:"options,omitempty"`
	AppliesTo             string         `json:"appliesTo,omitempty"`
	SortOrder             int            `json:"sortOrder,omitempty"`
	ValidationPattern     string         `json:"validationPattern,omitempty"`
	IsConsentField        bool           `json:"isConsentField,omitempty"`
	ConsentText           string         `json:"consentText,omitempty"`
	ConsentVersion        string         `json:"consentVersion,omitempty"`
	ConditionalVisibility FlexibleObject `json:"conditionalVisibility,omitempty"`
	CreatedAt             string         `json:"createdAt,omitempty"`
	UpdatedAt             string         `json:"updatedAt,omitempty"`
}

type CreateQuestionRequest struct {
	Type                  string         `json:"type"`
	Label                 string         `json:"label"`
	Description           string         `json:"description,omitempty"`
	Placeholder           string         `json:"placeholder,omitempty"`
	Required              bool           `json:"required,omitempty"`
	Options               []string       `json:"options,omitempty"`
	AppliesTo             string         `json:"appliesTo,omitempty"`
	TicketTypeID          string         `json:"ticketTypeId,omitempty"`
	SortOrder             int            `json:"sortOrder,omitempty"`
	ValidationPattern     string         `json:"validationPattern,omitempty"`
	IsConsentField        bool           `json:"isConsentField,omitempty"`
	ConsentText           string         `json:"consentText,omitempty"`
	ConsentVersion        string         `json:"consentVersion,omitempty"`
	ConditionalVisibility FlexibleObject `json:"conditionalVisibility,omitempty"`
}

type UpdateQuestionRequest CreateQuestionRequest

type ReorderQuestionInput struct {
	ID        string `json:"id"`
	SortOrder int    `json:"sortOrder"`
}

type WaitlistEntry struct {
	ID             string `json:"id"`
	EventID        string `json:"eventId,omitempty"`
	TicketTypeID   string `json:"ticketTypeId,omitempty"`
	Email          string `json:"email,omitempty"`
	FirstName      string `json:"firstName,omitempty"`
	LastName       string `json:"lastName,omitempty"`
	Phone          string `json:"phone,omitempty"`
	Quantity       int    `json:"quantity,omitempty"`
	Status         string `json:"status,omitempty"`
	OfferedAt      string `json:"offeredAt,omitempty"`
	OfferExpiresAt string `json:"offerExpiresAt,omitempty"`
	ClaimedAt      string `json:"claimedAt,omitempty"`
	CancelledAt    string `json:"cancelledAt,omitempty"`
	CreatedAt      string `json:"createdAt,omitempty"`
	UpdatedAt      string `json:"updatedAt,omitempty"`
}

type WaitlistSettings struct {
	AutoOfferEnabled bool `json:"autoOfferEnabled"`
	OfferTTLMinutes  int  `json:"offerTtlMinutes"`
}

type WaitlistListResult struct {
	Items    []WaitlistEntry  `json:"items"`
	Settings WaitlistSettings `json:"settings"`
}

type JoinWaitlistRequest struct {
	Email        string `json:"email"`
	FirstName    string `json:"firstName,omitempty"`
	LastName     string `json:"lastName,omitempty"`
	Phone        string `json:"phone,omitempty"`
	Quantity     int    `json:"quantity,omitempty"`
	TicketTypeID string `json:"ticketTypeId,omitempty"`
}

type WaitlistOffer struct {
	Entry      WaitlistEntry `json:"entry"`
	ClaimToken string        `json:"claimToken,omitempty"`
	ClaimURL   string        `json:"claimUrl,omitempty"`
	ExpiresAt  string        `json:"expiresAt,omitempty"`
}

type OfferWaitlistEntryRequest struct {
	ExpiresInMinutes int `json:"expiresInMinutes,omitempty"`
}

type PaymentCompensation struct {
	ID                string         `json:"id"`
	CheckoutSessionID string         `json:"checkoutSessionId,omitempty"`
	Status            string         `json:"status,omitempty"`
	AmountCents       int            `json:"amountCents,omitempty"`
	Currency          string         `json:"currency,omitempty"`
	Reason            string         `json:"reason,omitempty"`
	Metadata          FlexibleObject `json:"metadata,omitempty"`
	CreatedAt         string         `json:"createdAt,omitempty"`
	UpdatedAt         string         `json:"updatedAt,omitempty"`
}

type SalesReportParams struct {
	From string
	To   string
}

type SalesReport struct {
	EventID                  string         `json:"eventId,omitempty"`
	Range                    FlexibleObject `json:"range,omitempty"`
	Currency                 string         `json:"currency,omitempty"`
	GrossSalesCents          int            `json:"grossSalesCents,omitempty"`
	NetRevenueCents          int            `json:"netRevenueCents,omitempty"`
	RefundsCents             int            `json:"refundsCents,omitempty"`
	FeesCents                int            `json:"feesCents,omitempty"`
	TaxCents                 int            `json:"taxCents,omitempty"`
	OrdersCount              int            `json:"ordersCount,omitempty"`
	PaidOrdersCount          int            `json:"paidOrdersCount,omitempty"`
	TicketsSold              int            `json:"ticketsSold,omitempty"`
	CheckIns                 int            `json:"checkIns,omitempty"`
	ConversionRate           float64        `json:"conversionRate,omitempty"`
	GrossSalesByChannelCents FlexibleObject `json:"grossSalesByChannelCents,omitempty"`
}

type TaxReport struct {
	EventID                string           `json:"eventId,omitempty"`
	Currency               string           `json:"currency,omitempty"`
	TotalTaxCollectedCents int              `json:"totalTaxCollectedCents,omitempty"`
	Breakdown              []FlexibleObject `json:"breakdown,omitempty"`
}

type AttendanceReport struct {
	EventID               string           `json:"eventId,omitempty"`
	TotalAttendees        int              `json:"totalAttendees,omitempty"`
	CheckedIn             int              `json:"checkedIn,omitempty"`
	NotCheckedIn          int              `json:"notCheckedIn,omitempty"`
	CheckInRate           float64          `json:"checkInRate,omitempty"`
	BreakdownByTicketType []FlexibleObject `json:"breakdownByTicketType,omitempty"`
}

type PromoReport struct {
	EventID       string           `json:"eventId,omitempty"`
	DiscountCodes []FlexibleObject `json:"discountCodes,omitempty"`
}

type ConversionReport struct {
	EventID           string  `json:"eventId,omitempty"`
	WidgetViews       int     `json:"widgetViews,omitempty"`
	CheckoutStarted   int     `json:"checkoutStarted,omitempty"`
	CheckoutCompleted int     `json:"checkoutCompleted,omitempty"`
	ConversionRate    float64 `json:"conversionRate,omitempty"`
}

type AffiliateReport struct {
	OrganizationID string           `json:"organizationId,omitempty"`
	Affiliates     []FlexibleObject `json:"affiliates,omitempty"`
}

type CreateExportRequest struct {
	EventID        string         `json:"eventId,omitempty"`
	Type           string         `json:"type"`
	Format         string         `json:"format"`
	Filters        FlexibleObject `json:"filters,omitempty"`
	IdempotencyKey string         `json:"-"`
}

type ExportJob struct {
	ID          string `json:"id,omitempty"`
	ExportID    string `json:"exportId,omitempty"`
	EventID     string `json:"eventId,omitempty"`
	Type        string `json:"type,omitempty"`
	Format      string `json:"format,omitempty"`
	Status      string `json:"status,omitempty"`
	FileURL     string `json:"fileUrl,omitempty"`
	DownloadURL string `json:"downloadUrl,omitempty"`
	CreatedAt   string `json:"createdAt,omitempty"`
	CompletedAt string `json:"completedAt,omitempty"`
}

type ExportJobQueued struct {
	ExportID string `json:"exportId"`
	Status   string `json:"status"`
}

type ExportDownload struct {
	DownloadURL string `json:"downloadUrl"`
	ExpiresAt   string `json:"expiresAt"`
}

type WebhookEndpoint struct {
	ID             string   `json:"id"`
	TenantID       string   `json:"tenantId,omitempty"`
	OrganizationID string   `json:"organizationId,omitempty"`
	URL            string   `json:"url"`
	Events         []string `json:"events"`
	Description    string   `json:"description,omitempty"`
	Status         string   `json:"status,omitempty"`
	Secret         string   `json:"secret,omitempty"`
	CreatedAt      string   `json:"createdAt,omitempty"`
	UpdatedAt      string   `json:"updatedAt,omitempty"`
}

type CreateWebhookEndpointRequest struct {
	OrganizationID string   `json:"organizationId"`
	URL            string   `json:"url"`
	Events         []string `json:"events"`
	Description    string   `json:"description,omitempty"`
}

type UpdateWebhookEndpointRequest struct {
	URL         *string  `json:"url,omitempty"`
	Events      []string `json:"events,omitempty"`
	Status      *string  `json:"status,omitempty"`
	Description *string  `json:"description,omitempty"`
}

type WebhookEvent struct {
	ID                  string         `json:"id"`
	TenantID            string         `json:"tenantId,omitempty"`
	OrganizationID      string         `json:"organizationId,omitempty"`
	EndpointID          string         `json:"endpointId,omitempty"`
	RequestedEndpointID string         `json:"requestedEndpointId,omitempty"`
	EventID             string         `json:"eventId,omitempty"`
	Type                string         `json:"type,omitempty"`
	EventType           string         `json:"eventType,omitempty"`
	Status              string         `json:"status,omitempty"`
	StatusCode          int            `json:"statusCode,omitempty"`
	AttemptCount        int            `json:"attemptCount,omitempty"`
	DeliveryID          string         `json:"deliveryId,omitempty"`
	DeliveryKey         string         `json:"deliveryKey,omitempty"`
	Payload             FlexibleObject `json:"payload,omitempty"`
	DeliveredAt         string         `json:"deliveredAt,omitempty"`
	CreatedAt           string         `json:"createdAt,omitempty"`
}

type ReplayWebhookEventResult struct {
	Queued     bool   `json:"queued,omitempty"`
	Message    string `json:"message,omitempty"`
	EventID    string `json:"eventId"`
	EndpointID string `json:"endpointId,omitempty"`
	Endpoints  int    `json:"endpoints,omitempty"`
}

type APIKey struct {
	ID             string   `json:"id"`
	TenantID       string   `json:"tenantId,omitempty"`
	OrganizationID string   `json:"organizationId,omitempty"`
	Name           string   `json:"name"`
	KeyPrefix      string   `json:"keyPrefix,omitempty"`
	Secret         string   `json:"secret,omitempty"`
	Scopes         []string `json:"scopes"`
	BrandIDs       []string `json:"brandIds,omitempty"`
	EventIDs       []string `json:"eventIds,omitempty"`
	ExpiresAt      string   `json:"expiresAt,omitempty"`
	LastUsedAt     string   `json:"lastUsedAt,omitempty"`
	RevokedAt      string   `json:"revokedAt,omitempty"`
	CreatedAt      string   `json:"createdAt,omitempty"`
	UpdatedAt      string   `json:"updatedAt,omitempty"`
}

type CreateAPIKeyRequest struct {
	OrganizationID string   `json:"organizationId"`
	Name           string   `json:"name"`
	Scopes         []string `json:"scopes"`
	BrandIDs       []string `json:"brandIds,omitempty"`
	EventIDs       []string `json:"eventIds,omitempty"`
	ExpiresAt      string   `json:"expiresAt,omitempty"`
}

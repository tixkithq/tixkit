export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Tixkit API',
    version: '2026-01-01',
    description: 'Headless white-label event commerce platform API',
    license: { name: 'MIT' },
  },
  servers: [
    { url: 'https://api.tixkit.com/v1', description: 'Production' },
    { url: 'http://localhost:4000/v1', description: 'Local development' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
      ApiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
        description: 'Bearer tk_<key>',
      },
      ScannerDeviceAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Device-Id',
        description: 'Scanner device authentication via X-Device-Id and X-Device-Secret headers',
      },
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'Prevents duplicate mutations when retrying failed requests',
      },
      RequiredIdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string' },
        description: 'Required for idempotent mutations',
      },
      CheckoutSessionToken: {
        name: 'X-Checkout-Session-Token',
        in: 'header',
        required: true,
        schema: { type: 'string' },
        description:
          'Client token returned when the checkout session is created; required to read public session details',
      },
      OptionalCheckoutSessionToken: {
        name: 'X-Checkout-Session-Token',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description:
          'Client token returned when the checkout session is created. GET session recovery may alternatively use payment_intent_client_secret for pending payment sessions.',
      },
      PaymentIntentClientSecret: {
        name: 'payment_intent_client_secret',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description:
          'Stripe PaymentIntent client secret accepted only for recovering pending_payment checkout sessions when the checkout session token is unavailable.',
      },
      ScannerDeviceSecret: {
        name: 'X-Device-Secret',
        in: 'header',
        required: true,
        schema: { type: 'string' },
        description: 'Scanner device secret returned once when the scanner device is created',
      },
      OptionalScannerDeviceSecret: {
        name: 'X-Device-Secret',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'Required when using ScannerDeviceAuth',
      },
      Cursor: {
        name: 'cursor',
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: 'Opaque cursor returned as nextCursor by the previous page',
      },
      Limit: {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
    schemas: {
      ApiError: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              details: { type: 'object' },
              requestId: { type: 'string' },
            },
            required: ['code', 'message', 'requestId'],
          },
        },
        required: ['error'],
      },
      Event: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          slug: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'published', 'paused', 'ended', 'archived'] },
          currency: { type: 'string', minLength: 3, maxLength: 3 },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          timezone: { type: 'string' },
          visibility: { type: 'string', enum: ['public', 'unlisted', 'private'] },
          description: { type: 'string' },
          capacity: { type: 'integer' },
          venue: { type: 'object' },
          seo: { type: 'object' },
          coverImageUrl: { type: 'string', format: 'uri' },
          externalUrl: { type: 'string', format: 'uri' },
        },
        required: ['id', 'title', 'slug', 'status', 'currency', 'startsAt', 'timezone'],
      },
      EventPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Event' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      TicketType: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventId: { type: 'string' },
          eventOccurrenceId: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['free', 'paid', 'donation'] },
          status: { type: 'string', enum: ['draft', 'active', 'paused', 'sold_out', 'ended'] },
          visibility: { type: 'string', enum: ['public', 'hidden', 'locked'] },
          currency: { type: 'string' },
          priceCents: { type: 'integer' },
          minimumPriceCents: { type: 'integer' },
          minPerOrder: { type: 'integer' },
          maxPerOrder: { type: 'integer' },
          requiresAccessCode: { type: 'boolean' },
          inventoryPoolId: { type: 'string' },
        },
        required: ['id', 'name', 'kind', 'currency', 'priceCents'],
      },
      EventOccurrence: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventId: { type: 'string' },
          title: { type: 'string' },
          startsAt: { type: 'string', format: 'date-time' },
          endsAt: { type: 'string', format: 'date-time' },
          timezone: { type: 'string' },
          venue: { type: 'object' },
          capacity: { type: ['integer', 'null'] },
          sortOrder: { type: 'integer' },
          status: { type: 'string', enum: ['scheduled', 'cancelled', 'completed'] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'eventId',
          'title',
          'startsAt',
          'endsAt',
          'timezone',
          'sortOrder',
          'status',
        ],
      },
      EventOccurrencePage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/EventOccurrence' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items'],
      },
      MarketingIntegration: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          organizationId: { type: 'string' },
          brandId: { type: 'string' },
          eventId: { type: 'string' },
          provider: { type: 'string', enum: ['ga4', 'meta_pixel', 'generic_tag'] },
          config: {
            type: 'object',
            additionalProperties: true,
            description:
              'GA4 uses measurementId, Meta Pixel uses pixelId, generic tags use an HTTPS pixelUrl.',
          },
          consentRequired: { type: 'boolean' },
          status: { type: 'string', enum: ['active', 'disabled'] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['provider', 'config', 'consentRequired', 'status'],
      },
      MarketingIntegrationPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/MarketingIntegration' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      TicketTypePage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/TicketType' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      WaitlistEntry: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventId: { type: 'string' },
          ticketTypeId: { type: 'string' },
          email: { type: 'string', format: 'email' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          phone: { type: 'string' },
          quantity: { type: 'integer', minimum: 1 },
          status: {
            type: 'string',
            enum: ['joined', 'offered', 'claimed', 'cancelled', 'expired'],
          },
          offerExpiresAt: { type: 'string', format: 'date-time' },
          offeredAt: { type: 'string', format: 'date-time' },
          claimedAt: { type: 'string', format: 'date-time' },
          cancelledAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'eventId',
          'ticketTypeId',
          'email',
          'quantity',
          'status',
          'createdAt',
          'updatedAt',
        ],
      },
      WaitlistEntryPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/WaitlistEntry' } },
          settings: { $ref: '#/components/schemas/WaitlistSettings' },
        },
        required: ['items', 'settings'],
      },
      WaitlistSettings: {
        type: 'object',
        properties: {
          autoOfferEnabled: { type: 'boolean' },
          offerTtlMinutes: { type: 'integer', minimum: 5, maximum: 10080 },
        },
        required: ['autoOfferEnabled', 'offerTtlMinutes'],
      },
      JoinWaitlistRequest: {
        type: 'object',
        properties: {
          ticketTypeId: { type: 'string' },
          email: { type: 'string', format: 'email' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          phone: { type: 'string' },
          quantity: { type: 'integer', minimum: 1, maximum: 20, default: 1 },
        },
        required: ['ticketTypeId', 'email'],
      },
      WaitlistOffer: {
        type: 'object',
        properties: {
          entry: { $ref: '#/components/schemas/WaitlistEntry' },
          claimToken: { type: 'string' },
        },
        required: ['entry', 'claimToken'],
      },
      AccessRule: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ticketTypeId: { type: 'string' },
          type: { type: 'string', enum: ['code', 'email_domain'] },
          value: { type: 'string' },
          maxUses: { type: 'integer' },
          usesCount: { type: 'integer' },
          expiresAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'ticketTypeId', 'type', 'value', 'usesCount'],
      },
      AccessRulePage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/AccessRule' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      TicketTypeBatchResult: {
        type: 'object',
        properties: {
          ticketType: { $ref: '#/components/schemas/TicketType' },
          accessRules: { type: 'array', items: { $ref: '#/components/schemas/AccessRule' } },
        },
        required: ['ticketType', 'accessRules'],
      },
      CreateTicketTypeBatch: {
        type: 'object',
        properties: {
          ticketType: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              kind: { type: 'string', enum: ['free', 'paid', 'donation'] },
              visibility: { type: 'string', enum: ['public', 'hidden', 'locked'] },
              currency: { type: 'string' },
              priceCents: { type: 'integer' },
              minimumPriceCents: { type: 'integer', nullable: true },
              salesStartAt: { type: 'string', format: 'date-time' },
              salesEndAt: { type: 'string', format: 'date-time' },
              minPerOrder: { type: 'integer' },
              maxPerOrder: { type: 'integer' },
              inventoryPoolId: { type: 'string' },
              requiresAccessCode: { type: 'boolean' },
              accessCodeHint: { type: 'string', nullable: true },
            },
            required: ['name', 'kind', 'currency', 'priceCents'],
          },
          inventoryPool: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              totalCapacity: { type: 'integer' },
              holdTtlSeconds: { type: 'integer' },
            },
            required: ['name', 'totalCapacity'],
          },
          accessRules: { type: 'array', items: { $ref: '#/components/schemas/AccessRuleCreate' } },
        },
        required: ['ticketType'],
      },
      UpdateTicketTypeBatch: {
        type: 'object',
        properties: {
          ticketType: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              kind: { type: 'string', enum: ['free', 'paid', 'donation'] },
              status: { type: 'string', enum: ['draft', 'active', 'paused', 'sold_out', 'ended'] },
              visibility: { type: 'string', enum: ['public', 'hidden', 'locked'] },
              currency: { type: 'string' },
              priceCents: { type: 'integer' },
              minimumPriceCents: { type: 'integer', nullable: true },
              salesStartAt: { type: 'string', format: 'date-time', nullable: true },
              salesEndAt: { type: 'string', format: 'date-time', nullable: true },
              minPerOrder: { type: 'integer' },
              maxPerOrder: { type: 'integer' },
              inventoryPoolId: { type: 'string' },
              requiresAccessCode: { type: 'boolean' },
              accessCodeHint: { type: 'string', nullable: true },
              sortOrder: { type: 'integer' },
            },
          },
          accessRules: { type: 'array', items: { $ref: '#/components/schemas/AccessRuleCreate' } },
        },
        required: ['ticketType'],
      },
      AccessRuleCreate: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['code', 'email_domain'] },
          value: { type: 'string' },
          maxUses: { type: 'integer', nullable: true },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
        },
        required: ['type', 'value'],
      },
      ProductCategory: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventId: { type: 'string' },
          name: { type: 'string' },
          sortOrder: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'eventId', 'name', 'sortOrder'],
      },
      ProductCategoryPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/ProductCategory' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      Product: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          priceCents: { type: 'integer' },
          currency: { type: 'string' },
          categoryId: { type: 'string' },
          maxPerOrder: { type: 'integer' },
          availableFrom: { type: 'string', format: 'date-time' },
          availableUntil: { type: 'string', format: 'date-time' },
          status: { type: 'string', enum: ['active', 'inactive'] },
          sortOrder: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'eventId',
          'name',
          'priceCents',
          'currency',
          'maxPerOrder',
          'status',
          'sortOrder',
        ],
      },
      ProductPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Product' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      AvailabilityResult: {
        type: 'object',
        properties: {
          ticketTypeId: { type: 'string' },
          eventOccurrenceId: { type: 'string' },
          available: { type: 'integer' },
          total: { type: 'integer' },
          reserved: { type: 'integer' },
          sold: { type: 'integer' },
          status: { type: 'string' },
        },
        required: ['ticketTypeId', 'available', 'total', 'status'],
      },
      AvailabilityPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/AvailabilityResult' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      PublicAvailabilityItem: {
        type: 'object',
        properties: {
          ticketTypeId: { type: 'string' },
          eventOccurrenceId: { type: 'string' },
          name: { type: 'string' },
          kind: { type: 'string', enum: ['free', 'paid', 'donation'] },
          priceCents: { type: 'integer' },
          currency: { type: 'string' },
          minimumPriceCents: { type: 'integer' },
          minPerOrder: { type: 'integer' },
          maxPerOrder: { type: 'integer' },
          available: { type: 'integer' },
          status: { type: 'string' },
          requiresAccessCode: { type: 'boolean' },
          accessCodeHint: { type: 'string' },
          description: { type: 'string' },
          salesStartAt: { type: 'string', format: 'date-time' },
          salesEndAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'ticketTypeId',
          'name',
          'kind',
          'priceCents',
          'currency',
          'minPerOrder',
          'maxPerOrder',
          'available',
          'status',
          'requiresAccessCode',
        ],
      },
      PublicQuestionsResponse: {
        type: 'object',
        properties: {
          buyerQuestions: { type: 'array', items: { $ref: '#/components/schemas/Question' } },
          attendeeQuestions: { type: 'array', items: { $ref: '#/components/schemas/Question' } },
        },
        required: ['buyerQuestions', 'attendeeQuestions'],
      },
      CheckoutSession: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventId: { type: 'string' },
          brandId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['open', 'pending_payment', 'completed', 'expired', 'cancelled'],
          },
          currency: { type: 'string' },
          clientToken: { type: 'string' },
          quote: {
            type: 'object',
            properties: {
              totalCents: { type: 'integer' },
              subtotalCents: { type: 'integer' },
              discountCents: { type: 'integer' },
              taxCents: { type: 'integer' },
              feeCents: { type: 'integer' },
              lineItems: { type: 'array', items: { type: 'object' } },
            },
            required: ['totalCents', 'subtotalCents', 'discountCents', 'taxCents', 'feeCents'],
          },
          paymentIntentId: { type: 'string' },
          clientSecret: { type: 'string' },
          successUrl: { type: 'string' },
          cancelUrl: { type: 'string' },
          orderId: { type: 'string' },
          paymentCompensation: { $ref: '#/components/schemas/PaymentCompensation' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'eventId', 'status', 'currency', 'quote', 'expiresAt'],
      },
      CheckoutWalletPasses: {
        type: 'object',
        properties: {
          tickets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ticketId: { type: 'string' },
                ticketCode: { type: 'string' },
                appleUrl: { type: 'string', format: 'uri' },
                googleUrl: { type: 'string', format: 'uri' },
              },
              required: ['ticketId', 'ticketCode'],
            },
          },
        },
        required: ['tickets'],
      },
      CreateUploadArtifact: {
        type: 'object',
        properties: {
          purpose: { type: 'string', enum: ['checkout_answer', 'brand_logo', 'user_avatar'] },
          fileName: { type: 'string', minLength: 1, maxLength: 255 },
          contentType: { type: 'string', minLength: 1, maxLength: 255 },
          sizeBytes: { type: 'integer', minimum: 1 },
          brandId: { type: 'string' },
          eventId: { type: 'string' },
          metadata: { type: 'object', additionalProperties: true },
        },
        required: ['purpose', 'fileName', 'contentType', 'sizeBytes'],
      },
      PublicCreateUploadArtifact: {
        type: 'object',
        properties: {
          fileName: { type: 'string', minLength: 1, maxLength: 255 },
          contentType: { type: 'string', minLength: 1, maxLength: 255 },
          sizeBytes: { type: 'integer', minimum: 1 },
          questionId: { type: 'string' },
        },
        required: ['fileName', 'contentType', 'sizeBytes'],
      },
      UploadArtifactTicket: {
        type: 'object',
        properties: {
          artifactId: { type: 'string' },
          uploadUrl: { type: 'string', format: 'uri' },
          uploadHeaders: { type: 'object', additionalProperties: { type: 'string' } },
          completeUrl: { type: 'string' },
          completeToken: { type: 'string' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
        required: ['artifactId', 'uploadUrl', 'uploadHeaders', 'completeUrl', 'expiresAt'],
      },
      PublicCompleteUploadArtifact: {
        type: 'object',
        properties: {
          token: { type: 'string', minLength: 1 },
        },
        required: ['token'],
      },
      CompleteUploadArtifact: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      UploadArtifactCompleteResult: {
        type: 'object',
        properties: {
          artifactId: { type: 'string' },
          status: { type: 'string' },
          scanStatus: { type: 'string' },
        },
        required: ['artifactId', 'status', 'scanStatus'],
      },
      UploadArtifactDownload: {
        type: 'object',
        properties: {
          downloadUrl: { type: 'string', format: 'uri' },
        },
        required: ['downloadUrl'],
      },
      CheckoutConfirmCompleted: {
        type: 'object',
        properties: {
          order: { $ref: '#/components/schemas/Order' },
          sessionId: { type: 'string' },
          status: { type: 'string', enum: ['completed'] },
        },
        required: ['order', 'sessionId', 'status'],
      },
      CheckoutConfirmPending: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          status: { type: 'string', enum: ['pending_payment'] },
          paymentIntentId: { type: 'string' },
          clientSecret: { type: 'string' },
          totalCents: { type: 'integer' },
          currency: { type: 'string' },
        },
        required: ['sessionId', 'status', 'paymentIntentId', 'totalCents', 'currency'],
      },
      Order: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          orderNumber: { type: 'string' },
          status: {
            type: 'string',
            enum: [
              'draft',
              'pending_payment',
              'paid',
              'partially_refunded',
              'refunded',
              'cancelled',
              'expired',
              'disputed',
            ],
          },
          currency: { type: 'string' },
          subtotalCents: { type: 'integer' },
          discountCents: { type: 'integer' },
          taxCents: { type: 'integer' },
          feeCents: { type: 'integer' },
          totalCents: { type: 'integer' },
          refundedCents: { type: 'integer' },
          buyerEmail: { type: 'string' },
          buyerFirstName: { type: 'string' },
          buyerLastName: { type: 'string' },
          paidAt: { type: 'string', format: 'date-time' },
          refundedAt: { type: 'string', format: 'date-time' },
          cancelledAt: { type: 'string', format: 'date-time' },
          lineItems: {
            type: 'array',
            items: { $ref: '#/components/schemas/OrderLineItem' },
          },
          invoice: { $ref: '#/components/schemas/Invoice' },
          taxSnapshots: { type: 'array', items: { $ref: '#/components/schemas/TaxSnapshot' } },
          timeline: {
            type: 'array',
            items: { $ref: '#/components/schemas/OrderTimelineEvent' },
          },
        },
        required: ['id', 'orderNumber', 'status', 'currency', 'totalCents', 'buyerEmail'],
      },
      OrderPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Order' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      PaymentCompensation: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          checkoutSessionId: { type: 'string' },
          paymentIntentId: { type: ['string', 'null'] },
          provider: { type: 'string' },
          providerIntentId: { type: 'string' },
          amountCents: { type: 'integer' },
          currency: { type: 'string' },
          action: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'succeeded', 'failed', 'manual_review', 'already_ordered'],
          },
          providerCompensationId: { type: ['string', 'null'] },
          attempts: { type: 'integer' },
          reason: { type: 'string' },
          lastError: { type: ['string', 'null'] },
          metadata: { type: 'object', additionalProperties: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'provider',
          'providerIntentId',
          'action',
          'status',
          'attempts',
          'reason',
          'updatedAt',
        ],
      },
      PaymentCompensationPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/PaymentCompensation' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      OrderLineItem: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ticketTypeId: { type: 'string' },
          eventOccurrenceId: { type: 'string' },
          productId: { type: 'string' },
          description: { type: 'string' },
          quantity: { type: 'integer' },
          unitPriceCents: { type: 'integer' },
          subtotalCents: { type: 'integer' },
          totalCents: { type: 'integer' },
        },
        required: ['id', 'description', 'quantity', 'unitPriceCents', 'totalCents'],
      },
      TaxSnapshot: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          orderId: { type: 'string' },
          orderLineItemId: { type: 'string' },
          eventId: { type: 'string' },
          taxRuleId: { type: 'string' },
          taxRuleName: { type: 'string' },
          rate: { type: 'integer' },
          type: { type: 'string', enum: ['inclusive', 'exclusive'] },
          appliedTo: { type: 'string', enum: ['ticket', 'fee', 'all'] },
          taxableAmountCents: { type: 'integer' },
          taxCents: { type: 'integer' },
          currency: { type: 'string' },
          inclusive: { type: 'boolean' },
          provider: { type: 'string' },
          providerCalculationId: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'orderId',
          'orderLineItemId',
          'eventId',
          'taxRuleName',
          'rate',
          'type',
          'appliedTo',
          'taxableAmountCents',
          'taxCents',
          'currency',
          'inclusive',
          'provider',
          'createdAt',
        ],
      },
      Invoice: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          orderId: { type: 'string' },
          invoiceNumber: { type: 'string' },
          status: { type: 'string', enum: ['issued', 'void'] },
          currency: { type: 'string' },
          subtotalCents: { type: 'integer' },
          discountCents: { type: 'integer' },
          taxCents: { type: 'integer' },
          feeCents: { type: 'integer' },
          totalCents: { type: 'integer' },
          refundedCents: { type: 'integer' },
          buyerEmail: { type: 'string' },
          buyerName: { type: 'string' },
          buyerTaxId: { type: 'string' },
          sellerName: { type: 'string' },
          sellerTaxId: { type: 'string' },
          reverseCharge: { type: 'boolean' },
          issuedAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'orderId',
          'invoiceNumber',
          'status',
          'currency',
          'subtotalCents',
          'discountCents',
          'taxCents',
          'feeCents',
          'totalCents',
          'refundedCents',
          'buyerEmail',
          'sellerName',
          'reverseCharge',
          'issuedAt',
        ],
      },
      InvoiceDocument: {
        type: 'object',
        properties: {
          invoice: { $ref: '#/components/schemas/Invoice' },
          order: { $ref: '#/components/schemas/Order' },
          lineItems: { type: 'array', items: { $ref: '#/components/schemas/OrderLineItem' } },
          taxSnapshots: { type: 'array', items: { $ref: '#/components/schemas/TaxSnapshot' } },
        },
        required: ['invoice', 'order', 'lineItems', 'taxSnapshots'],
      },
      OrderTimelineEvent: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          description: { type: 'string' },
          actorId: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'type', 'description', 'createdAt'],
      },
      Refund: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          orderId: { type: 'string' },
          providerRefundId: { type: 'string' },
          amountCents: { type: 'integer' },
          currency: { type: 'string' },
          status: { type: 'string' },
          reason: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'orderId', 'amountCents', 'currency', 'status', 'reason'],
      },
      ApiKey: {
        type: 'object',
        description: 'API key. The full key is only returned once at creation time.',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          keyPrefix: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          lastUsedAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'name', 'keyPrefix', 'scopes'],
      },
      ApiKeyPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/ApiKey' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      ApiKeyCreated: {
        type: 'object',
        description: 'API key with the full key shown only at creation.',
        allOf: [
          { $ref: '#/components/schemas/ApiKey' },
          {
            type: 'object',
            properties: {
              apiKey: {
                type: 'string',
                description: 'Full API key (tk_...). Store securely; never returned again.',
              },
            },
            required: ['apiKey'],
          },
        ],
      },
      ScannerDevice: {
        type: 'object',
        description: 'Scanner device. The secret is only returned once at creation time.',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          deviceId: { type: 'string' },
          status: { type: 'string', enum: ['active', 'revoked'] },
          eventIds: { type: 'array', items: { type: 'string' } },
          lastSeenAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'name', 'deviceId', 'status'],
      },
      ScannerDevicePage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/ScannerDevice' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      ScannerDeviceCreated: {
        type: 'object',
        description: 'Scanner device with the secret shown only at creation.',
        allOf: [
          { $ref: '#/components/schemas/ScannerDevice' },
          {
            type: 'object',
            properties: {
              secret: {
                type: 'string',
                description: 'Device secret. Store securely; never returned again.',
              },
            },
            required: ['secret'],
          },
        ],
      },
      ScannerDeviceRevoked: {
        type: 'object',
        properties: {
          deviceId: { type: 'string' },
          status: { type: 'string', enum: ['revoked'] },
        },
        required: ['deviceId', 'status'],
      },
      Organization: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          name: { type: 'string' },
          slug: { type: 'string' },
          clerkOrganizationId: { type: 'string' },
          status: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'tenantId', 'name', 'slug', 'status'],
      },
      OrganizationPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Organization' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      Brand: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          organizationId: { type: 'string' },
          name: { type: 'string' },
          slug: { type: 'string' },
          status: { type: 'string' },
          theme: { type: 'object' },
          supportUrl: { type: 'string' },
          legalUrls: { type: 'object' },
          whiteLabel: { type: 'boolean' },
          paymentAccountId: {
            type: 'string',
            nullable: true,
            description: 'Payment account bound to this brand for paid checkout routing.',
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'tenantId', 'organizationId', 'name', 'slug', 'status'],
      },
      BrandPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Brand' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      BrandDomain: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          brandId: { type: 'string' },
          domain: { type: 'string' },
          isPrimary: { type: 'boolean' },
          isVerified: { type: 'boolean' },
          verificationToken: { type: 'string' },
          sslStatus: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'brandId', 'domain', 'isPrimary', 'isVerified', 'sslStatus'],
      },
      InventoryPool: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventId: { type: 'string' },
          name: { type: 'string' },
          totalCapacity: { type: 'integer' },
          reservedCount: { type: 'integer' },
          soldCount: { type: 'integer' },
          holdTtlSeconds: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'eventId', 'name', 'totalCapacity', 'reservedCount', 'soldCount'],
      },
      Attendee: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          orderId: { type: 'string' },
          eventId: { type: 'string' },
          ticketTypeId: { type: 'string' },
          ticketId: { type: 'string' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          status: { type: 'string' },
          customAnswers: { type: 'object' },
          checkedInAt: { type: 'string', format: 'date-time' },
          checkInDeviceId: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'tenantId', 'orderId', 'eventId', 'ticketTypeId', 'email', 'status'],
      },
      AttendeePage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Attendee' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      Ticket: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          orderId: { type: 'string' },
          attendeeId: { type: 'string' },
          eventId: { type: 'string' },
          ticketTypeId: { type: 'string' },
          status: { type: 'string' },
          code: { type: 'string' },
          qrPayload: { type: 'string' },
          qrHash: { type: 'string' },
          transferredToEmail: { type: 'string' },
          transferredAt: { type: 'string', format: 'date-time' },
          checkedInAt: { type: 'string', format: 'date-time' },
          checkedInByDeviceId: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'tenantId',
          'orderId',
          'attendeeId',
          'eventId',
          'ticketTypeId',
          'status',
          'code',
          'qrPayload',
          'qrHash',
        ],
      },
      CheckInList: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventId: { type: 'string' },
          name: { type: 'string' },
          ticketTypeIds: { type: 'array', items: { type: 'string' } },
          status: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'eventId', 'name', 'ticketTypeIds', 'status'],
      },
      CheckInListPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/CheckInList' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      OfflineManifest: {
        type: 'object',
        properties: {
          eventId: { type: 'string' },
          checkInListId: { type: 'string' },
          generatedAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          keyId: { type: 'string' },
          signature: {
            type: 'string',
            description: 'HMAC-SHA256 signature of the manifest payload',
          },
          tickets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ticketId: { type: 'string' },
                ticketTypeId: { type: 'string' },
                attendeeName: { type: 'string' },
                qrHash: { type: 'string' },
                status: { type: 'string' },
              },
              required: ['ticketId', 'ticketTypeId', 'attendeeName', 'qrHash', 'status'],
            },
          },
        },
        required: [
          'eventId',
          'checkInListId',
          'generatedAt',
          'expiresAt',
          'keyId',
          'signature',
          'tickets',
        ],
      },
      ScanResult: {
        type: 'object',
        properties: {
          outcome: {
            type: 'string',
            enum: [
              'accepted',
              'duplicate',
              'invalid',
              'revoked',
              'not_found',
              'wrong_event',
              'wrong_list',
            ],
          },
          ticketId: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['outcome', 'message'],
      },
      SyncScanResult: {
        type: 'object',
        properties: {
          accepted: { type: 'integer' },
          duplicates: { type: 'integer' },
          invalid: { type: 'integer' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                qrHash: { type: 'string' },
                outcome: { type: 'string' },
              },
            },
          },
        },
        required: ['accepted', 'duplicates', 'invalid', 'results'],
      },
      AuditLog: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          organizationId: { type: ['string', 'null'] },
          brandId: { type: ['string', 'null'] },
          actorType: { type: 'string' },
          actorId: { type: 'string' },
          action: { type: 'string' },
          resourceType: { type: 'string' },
          resourceId: { type: 'string' },
          diffSummary: { type: ['object', 'null'] },
          requestId: { type: ['string', 'null'] },
          ip: { type: ['string', 'null'] },
          userAgent: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'tenantId',
          'actorType',
          'actorId',
          'action',
          'resourceType',
          'resourceId',
          'createdAt',
        ],
      },
      WebhookEndpoint: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          organizationId: { type: 'string' },
          url: { type: 'string' },
          description: { type: 'string' },
          events: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['active', 'disabled'] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'organizationId', 'url', 'events', 'status'],
      },
      WebhookEndpointCreated: {
        type: 'object',
        description: 'Webhook endpoint with the signing secret shown only at creation.',
        allOf: [
          { $ref: '#/components/schemas/WebhookEndpoint' },
          {
            type: 'object',
            properties: {
              secret: {
                type: 'string',
                description: 'Endpoint signing secret. Store securely; never returned again.',
              },
            },
            required: ['secret'],
          },
        ],
      },
      WebhookEndpointPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/WebhookEndpoint' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      SalesReport: {
        type: 'object',
        properties: {
          eventId: { type: 'string' },
          currency: { type: 'string' },
          grossSalesCents: { type: 'integer' },
          netRevenueCents: { type: 'integer' },
          refundsCents: { type: 'integer' },
          feesCents: { type: 'integer' },
          taxCents: { type: 'integer' },
          ticketsSold: { type: 'integer' },
          checkIns: { type: 'integer' },
          ordersCount: { type: 'integer' },
          paidOrdersCount: { type: 'integer' },
          range: { type: 'object' },
        },
        required: [
          'eventId',
          'currency',
          'grossSalesCents',
          'netRevenueCents',
          'refundsCents',
          'feesCents',
          'taxCents',
          'ticketsSold',
          'checkIns',
          'ordersCount',
          'paidOrdersCount',
        ],
      },
      TaxReport: {
        type: 'object',
        properties: {
          eventId: { type: 'string' },
          currency: { type: 'string' },
          totalTaxCollectedCents: { type: 'integer' },
          breakdown: { type: 'array', items: { type: 'object' } },
        },
        required: ['eventId', 'currency', 'totalTaxCollectedCents', 'breakdown'],
      },
      ExportJobQueued: {
        type: 'object',
        properties: {
          exportId: { type: 'string' },
          status: { type: 'string', enum: ['pending'] },
        },
        required: ['exportId', 'status'],
      },
      AuditLogPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/AuditLog' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      PrivacyRequestInput: {
        type: 'object',
        properties: {
          organizationId: { type: 'string' },
          brandId: { type: 'string' },
          subjectType: { type: 'string', enum: ['buyer', 'attendee'] },
          subjectId: { type: 'string' },
          subjectEmail: { type: 'string', format: 'email' },
        },
        required: ['organizationId', 'subjectType'],
      },
      PrivacyRequest: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          organizationId: { type: 'string' },
          brandId: { type: ['string', 'null'] },
          requestType: { type: 'string', enum: ['export', 'erasure'] },
          subjectType: { type: 'string', enum: ['buyer', 'attendee'] },
          subjectId: { type: ['string', 'null'] },
          subjectEmail: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
          requestedBy: { type: 'string' },
          result: { type: ['object', 'null'] },
          error: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
        },
        required: [
          'id',
          'tenantId',
          'organizationId',
          'requestType',
          'subjectType',
          'status',
          'requestedBy',
          'createdAt',
        ],
      },
      PrivacyRequestPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/PrivacyRequest' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      MessageQueued: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          eventId: { type: 'string' },
          templateKey: { type: 'string' },
          channel: { type: 'string', enum: ['email'] },
          queued: { type: 'integer' },
          jobIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['message', 'eventId', 'templateKey', 'channel', 'queued', 'jobIds'],
      },
      WebhookReplayQueued: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          eventId: { type: 'string' },
          endpoints: { type: 'integer' },
        },
        required: ['message', 'eventId', 'endpoints'],
      },
      WebhookEndpointReplayQueued: {
        type: 'object',
        properties: {
          queued: { type: 'boolean' },
          eventId: { type: 'string' },
          endpointId: { type: 'string' },
        },
        required: ['queued', 'eventId', 'endpointId'],
      },
      PaymentAccount: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          organizationId: { type: 'string' },
          provider: { type: 'string', enum: ['stripe', 'stripe_connect'] },
          providerAccountId: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'active', 'restricted', 'disabled'] },
          defaultCurrency: { type: 'string' },
          detailsSubmitted: { type: 'boolean' },
          chargesEnabled: { type: 'boolean' },
          payoutsEnabled: { type: 'boolean' },
          requirements: { type: 'object', additionalProperties: true },
          disabledReason: { type: ['string', 'null'] },
          onboardingUrl: { type: 'string', format: 'uri' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'organizationId',
          'provider',
          'providerAccountId',
          'status',
          'defaultCurrency',
          'detailsSubmitted',
          'chargesEnabled',
          'payoutsEnabled',
          'requirements',
          'disabledReason',
        ],
      },
      PaymentAccountPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/PaymentAccount' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      Question: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          eventId: { type: 'string' },
          ticketTypeId: { type: 'string' },
          type: {
            type: 'string',
            enum: [
              'text',
              'textarea',
              'email',
              'phone',
              'select',
              'multiselect',
              'checkbox',
              'date',
              'file',
              'waiver',
            ],
          },
          label: { type: 'string' },
          description: { type: 'string' },
          required: { type: 'boolean' },
          appliesTo: { type: 'string', enum: ['buyer', 'attendee', 'both'] },
          options: { type: 'array', items: { type: 'string' } },
          placeholder: { type: 'string' },
          validationPattern: { type: 'string' },
          conditionalVisibility: { type: 'object' },
          sortOrder: { type: 'integer' },
          isConsentField: { type: 'boolean' },
          consentText: { type: 'string' },
          consentVersion: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: [
          'id',
          'eventId',
          'type',
          'label',
          'required',
          'appliesTo',
          'sortOrder',
          'isConsentField',
        ],
      },
      QuestionPage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Question' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      ReorderQuestionsRequest: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                sortOrder: { type: 'integer' },
              },
              required: ['id', 'sortOrder'],
            },
          },
        },
        required: ['questions'],
      },
      RefundQueued: {
        type: 'object',
        properties: {
          orderId: { type: 'string' },
          refundAmount: { type: 'integer' },
          status: { type: 'string', enum: ['pending'] },
          message: { type: 'string' },
        },
        required: ['orderId', 'refundAmount', 'status', 'message'],
      },
      OAuthApplication: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          tenantId: { type: 'string' },
          organizationId: { type: 'string' },
          name: { type: 'string' },
          clientId: { type: 'string' },
          redirectUris: { type: 'array', items: { type: 'string' } },
          scopes: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: ['active', 'disabled', 'revoked'] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'organizationId', 'name', 'clientId', 'redirectUris', 'scopes', 'status'],
      },
      OAuthApplicationCreated: {
        type: 'object',
        description: 'OAuth application with the client secret shown only at creation.',
        allOf: [
          { $ref: '#/components/schemas/OAuthApplication' },
          {
            type: 'object',
            properties: {
              clientSecret: {
                type: 'string',
                description: 'Client secret. Store securely; never returned again.',
              },
            },
            required: ['clientSecret'],
          },
        ],
      },
      OAuthTokenResponse: {
        type: 'object',
        properties: {
          access_token: { type: 'string' },
          token_type: { type: 'string', enum: ['Bearer'] },
          expires_in: { type: 'integer' },
          scope: { type: 'string' },
          refresh_token: { type: 'string' },
        },
        required: ['access_token', 'token_type', 'expires_in', 'scope'],
      },
    },
  },
  paths: {
    '/health': {
      servers: [
        { url: 'https://api.tixkit.com', description: 'Production operational root' },
        { url: 'http://localhost:4000', description: 'Local operational root' },
      ],
      get: { summary: 'Health check', responses: { '200': { description: 'OK' } } },
    },
    '/organizations': {
      get: {
        summary: 'List organizations',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of organizations',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/OrganizationPage' } },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
      post: {
        summary: 'Create organization',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  slug: { type: 'string' },
                  clerkOrganizationId: { type: 'string' },
                },
                required: ['name', 'slug'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Organization created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Organization' } },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '409': {
            description: 'Slug already in use',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/brands': {
      get: {
        summary: 'List brands',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of brands',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/BrandPage' } } },
          },
        },
      },
      post: {
        summary: 'Create brand',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  organizationId: { type: 'string' },
                  name: { type: 'string' },
                  slug: { type: 'string' },
                  theme: { type: 'object' },
                  whiteLabel: { type: 'boolean' },
                },
                required: ['organizationId', 'name', 'slug'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Brand created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } },
          },
        },
      },
    },
    '/brands/{brandId}': {
      patch: {
        summary: 'Update brand',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  slug: { type: 'string' },
                  status: { type: 'string', enum: ['draft', 'active', 'suspended'] },
                  theme: { type: 'object' },
                  supportUrl: { type: 'string', format: 'uri' },
                  legalUrls: { type: 'object' },
                  whiteLabel: { type: 'boolean' },
                  paymentAccountId: {
                    type: 'string',
                    nullable: true,
                    description:
                      'Bind a payment account to this brand for paid checkout routing. Must belong to the same tenant and organization.',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Brand updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } },
          },
        },
      },
    },
    '/brands/{brandId}/domains': {
      post: {
        summary: 'Add brand domain',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  domain: { type: 'string' },
                  isPrimary: { type: 'boolean' },
                },
                required: ['domain'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Brand domain created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/BrandDomain' } },
            },
          },
        },
      },
    },
    '/events': {
      get: {
        summary: 'List events',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of events',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/EventPage' } } },
          },
        },
      },
      post: {
        summary: 'Create event',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  organizationId: { type: 'string' },
                  brandId: { type: 'string' },
                  slug: { type: 'string' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  currency: { type: 'string', minLength: 3, maxLength: 3 },
                  timezone: { type: 'string' },
                  startsAt: { type: 'string', format: 'date-time' },
                  endsAt: { type: 'string', format: 'date-time' },
                  venue: { type: 'object' },
                  visibility: { type: 'string', enum: ['public', 'unlisted', 'private'] },
                  seo: { type: 'object' },
                  capacity: { type: 'integer' },
                  coverImageUrl: { type: 'string', format: 'uri' },
                  externalUrl: { type: 'string', format: 'uri' },
                },
                required: [
                  'organizationId',
                  'brandId',
                  'slug',
                  'title',
                  'currency',
                  'timezone',
                  'startsAt',
                ],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Event created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
          },
        },
      },
    },
    '/events/{eventId}': {
      get: {
        summary: 'Get event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Event details',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
          },
        },
      },
      patch: {
        summary: 'Update event',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  description: { type: 'string' },
                  currency: { type: 'string', minLength: 3, maxLength: 3 },
                  timezone: { type: 'string' },
                  startsAt: { type: 'string', format: 'date-time' },
                  endsAt: { type: 'string', format: 'date-time', nullable: true },
                  venue: { type: 'object', nullable: true },
                  visibility: { type: 'string', enum: ['public', 'unlisted', 'private'] },
                  seo: { type: 'object' },
                  capacity: { type: 'integer', nullable: true },
                  coverImageUrl: { type: 'string', format: 'uri', nullable: true },
                  externalUrl: { type: 'string', format: 'uri', nullable: true },
                  status: { type: 'string', enum: ['draft', 'published', 'paused', 'archived'] },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Event updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
          },
        },
      },
    },
    '/events/{eventId}/publish': {
      post: {
        summary: 'Publish event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Event published',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
          },
          '404': {
            description: 'Event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/pause': {
      post: {
        summary: 'Pause event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Event paused',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
          },
          '404': {
            description: 'Event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/archive': {
      post: {
        summary: 'Archive event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Event archived',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
          },
          '404': {
            description: 'Event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/ticket-types': {
      get: {
        summary: 'List ticket types',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of ticket types',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/TicketTypePage' } },
            },
          },
        },
      },
      post: {
        summary: 'Create ticket type',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  kind: { type: 'string', enum: ['free', 'paid', 'donation'] },
                  visibility: { type: 'string', enum: ['public', 'hidden', 'locked'] },
                  currency: { type: 'string' },
                  priceCents: { type: 'integer' },
                  minimumPriceCents: { type: 'integer' },
                  salesStartAt: { type: 'string', format: 'date-time' },
                  salesEndAt: { type: 'string', format: 'date-time' },
                  minPerOrder: { type: 'integer' },
                  maxPerOrder: { type: 'integer' },
                  inventoryPoolId: { type: 'string' },
                  requiresAccessCode: { type: 'boolean' },
                  accessCodeHint: { type: 'string' },
                  eventOccurrenceId: { type: ['string', 'null'] },
                },
                required: ['name', 'kind', 'currency', 'priceCents', 'inventoryPoolId'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Ticket type created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/TicketType' } },
            },
          },
        },
      },
    },
    '/events/{eventId}/ticket-types/batch': {
      post: {
        summary: 'Create ticket type with inventory pool and access rules atomically',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateTicketTypeBatch' } },
          },
        },
        responses: {
          '201': {
            description: 'Ticket type and access rules created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TicketTypeBatchResult' },
              },
            },
          },
        },
      },
    },
    '/events/{eventId}/occurrences': {
      get: {
        summary: 'List event occurrences',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Event occurrences',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/EventOccurrencePage' } },
            },
          },
        },
      },
      post: {
        summary: 'Create event occurrence',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  startsAt: { type: 'string', format: 'date-time' },
                  endsAt: { type: 'string', format: 'date-time' },
                  timezone: { type: 'string' },
                  venue: { type: 'object' },
                  capacity: { type: ['integer', 'null'] },
                  sortOrder: { type: 'integer' },
                  status: { type: 'string', enum: ['scheduled', 'cancelled', 'completed'] },
                },
                required: ['title', 'startsAt', 'endsAt', 'timezone'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Event occurrence created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/EventOccurrence' } },
            },
          },
        },
      },
    },
    '/events/{eventId}/occurrences/{occurrenceId}': {
      patch: {
        summary: 'Update event occurrence',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/EventOccurrence' } },
          },
        },
        responses: {
          '200': {
            description: 'Event occurrence updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/EventOccurrence' } },
            },
          },
        },
      },
    },
    '/events/{eventId}/marketing-integrations': {
      get: {
        summary: 'List event marketing integrations',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'eventId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Event marketing integrations',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MarketingIntegrationPage' },
              },
            },
          },
        },
      },
    },
    '/events/{eventId}/marketing-integrations/{provider}': {
      put: {
        summary: 'Create or update an event marketing integration',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'eventId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'provider',
            in: 'path',
            required: true,
            schema: { type: 'string', enum: ['ga4', 'meta_pixel', 'generic_tag'] },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  config: { type: 'object', additionalProperties: true },
                  consentRequired: { type: 'boolean', default: true },
                  status: { type: 'string', enum: ['active', 'disabled'], default: 'active' },
                },
                required: ['config'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Marketing integration saved',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MarketingIntegration' } },
            },
          },
        },
      },
    },
    '/events/{eventId}/waitlist': {
      get: {
        summary: 'List waitlist entries for an event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Waitlist entries',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WaitlistEntryPage' } },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/waitlist/{entryId}/offer': {
      post: {
        summary: 'Create a time-bounded waitlist offer',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  expiresInMinutes: { type: 'integer', minimum: 5, maximum: 10080, default: 1440 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Waitlist offer token',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WaitlistOffer' } },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Event or waitlist entry not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '409': {
            description: 'No capacity is available for an offer',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/waitlist/settings': {
      patch: {
        summary: 'Update event waitlist auto-offer settings',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/WaitlistSettings' } },
          },
        },
        responses: {
          '200': {
            description: 'Waitlist settings',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WaitlistSettings' } },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/ticket-types/{ticketTypeId}': {
      patch: {
        summary: 'Update ticket type',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  kind: { type: 'string', enum: ['free', 'paid', 'donation'] },
                  status: {
                    type: 'string',
                    enum: ['draft', 'active', 'paused', 'sold_out', 'ended'],
                  },
                  visibility: { type: 'string', enum: ['public', 'hidden', 'locked'] },
                  currency: { type: 'string' },
                  priceCents: { type: 'integer' },
                  minimumPriceCents: { type: 'integer', nullable: true },
                  salesStartAt: { type: 'string', format: 'date-time', nullable: true },
                  salesEndAt: { type: 'string', format: 'date-time', nullable: true },
                  minPerOrder: { type: 'integer' },
                  maxPerOrder: { type: 'integer' },
                  inventoryPoolId: { type: 'string' },
                  requiresAccessCode: { type: 'boolean' },
                  accessCodeHint: { type: 'string', nullable: true },
                  sortOrder: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Ticket type updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/TicketType' } },
            },
          },
        },
      },
    },
    '/ticket-types/{ticketTypeId}/batch': {
      patch: {
        summary: 'Update ticket type and append access rules atomically',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/UpdateTicketTypeBatch' } },
          },
        },
        responses: {
          '200': {
            description: 'Ticket type updated and access rules returned',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TicketTypeBatchResult' },
              },
            },
          },
        },
      },
    },
    '/ticket-types/{ticketTypeId}/access-rules': {
      get: {
        summary: 'List access rules for a ticket type',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Access rules',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AccessRulePage' } },
            },
          },
        },
      },
      post: {
        summary: 'Create access rule for a ticket type',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['code', 'email_domain'] },
                  value: { type: 'string' },
                  maxUses: { type: 'integer', nullable: true },
                  expiresAt: { type: 'string', format: 'date-time', nullable: true },
                },
                required: ['type', 'value'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Access rule created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AccessRule' } },
            },
          },
        },
      },
    },
    '/access-rules/{accessRuleId}': {
      delete: {
        summary: 'Delete access rule',
        security: [{ BearerAuth: [] }],
        responses: { '204': { description: 'Access rule deleted' } },
      },
    },
    '/events/{eventId}/inventory-pools': {
      get: {
        summary: 'List inventory pools',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Page of inventory pools',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: { type: 'array', items: { $ref: '#/components/schemas/InventoryPool' } },
                    nextCursor: { type: 'string', nullable: true },
                    hasMore: { type: 'boolean' },
                  },
                  required: ['items'],
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Create inventory pool',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  totalCapacity: { type: 'integer' },
                  holdTtlSeconds: { type: 'integer' },
                },
                required: ['name', 'totalCapacity'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Inventory pool created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/InventoryPool' } },
            },
          },
        },
      },
    },
    '/events/{eventId}/product-categories': {
      get: {
        summary: 'List product categories',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of product categories',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ProductCategoryPage' } },
            },
          },
        },
      },
      post: {
        summary: 'Create product category',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  sortOrder: { type: 'integer' },
                },
                required: ['name'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Product category created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ProductCategory' } },
            },
          },
        },
      },
    },
    '/events/{eventId}/products': {
      get: {
        summary: 'List products',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of products',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ProductPage' } },
            },
          },
        },
      },
      post: {
        summary: 'Create product',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  priceCents: { type: 'integer' },
                  currency: { type: 'string' },
                  categoryId: { type: 'string' },
                  maxPerOrder: { type: 'integer' },
                  availableFrom: { type: 'string', format: 'date-time' },
                  availableUntil: { type: 'string', format: 'date-time' },
                  status: { type: 'string', enum: ['active', 'inactive'] },
                  sortOrder: { type: 'integer' },
                },
                required: ['name', 'priceCents', 'currency'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Product created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } },
          },
        },
      },
    },
    '/products/{productId}': {
      patch: {
        summary: 'Update product',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string', nullable: true },
                  priceCents: { type: 'integer' },
                  currency: { type: 'string' },
                  categoryId: { type: 'string', nullable: true },
                  maxPerOrder: { type: 'integer' },
                  availableFrom: { type: 'string', format: 'date-time', nullable: true },
                  availableUntil: { type: 'string', format: 'date-time', nullable: true },
                  status: { type: 'string', enum: ['active', 'inactive'] },
                  sortOrder: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Product updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } },
          },
        },
      },
    },
    '/events/{eventId}/availability': {
      get: {
        summary: 'Get availability',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Availability per ticket type',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AvailabilityPage' } },
            },
          },
        },
      },
    },
    '/public/events/{eventId}': {
      get: {
        summary: 'Get public event details (no auth)',
        responses: {
          '200': {
            description: 'Event details (hidden ticket types excluded)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
          },
        },
      },
    },
    '/public/events/by-slug/{slug}': {
      get: {
        summary: 'Get public event details by slug for a verified custom domain (no auth)',
        parameters: [
          {
            name: 'slug',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'host',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            description: 'Verified custom-domain hostname for the event brand',
          },
        ],
        responses: {
          '200': {
            description: 'Event details for the verified custom-domain slug',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } },
          },
          '404': { description: 'No matching published event for the custom domain' },
        },
      },
    },
    '/public/events/{eventId}/availability': {
      get: {
        summary: 'Get public availability (no auth, hidden excluded)',
        responses: {
          '200': {
            description: 'Buyer-facing ticket availability',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/PublicAvailabilityItem' },
                },
              },
            },
          },
        },
      },
    },
    '/public/events/{eventId}/occurrences': {
      get: {
        summary: 'List public event occurrences',
        responses: {
          '200': {
            description: 'Published event occurrences',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/EventOccurrencePage' } },
            },
          },
        },
      },
    },
    '/public/events/{eventId}/marketing-integrations': {
      get: {
        summary: 'List active public marketing integrations',
        responses: {
          '200': {
            description: 'Public browser-safe marketing integrations',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MarketingIntegrationPage' },
              },
            },
          },
        },
      },
    },
    '/public/events/{eventId}/access-code': {
      post: {
        summary: 'Validate an access code or buyer email for locked ticket types (no auth)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  ticketTypeIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
                  accessCode: { type: 'string' },
                  buyerEmail: { type: 'string', format: 'email' },
                },
                required: ['ticketTypeIds'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Access code validated',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    valid: { type: 'boolean' },
                    ticketTypeIds: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['valid', 'ticketTypeIds'],
                },
              },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/public/events/{eventId}/waitlist': {
      post: {
        summary: 'Join a sold-out ticket waitlist',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/JoinWaitlistRequest' } },
          },
        },
        responses: {
          '201': {
            description: 'Waitlist entry',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WaitlistEntry' } },
            },
          },
          '400': {
            description: 'Validation error or ticket not sold out',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Event or ticket type not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/public/waitlist/claims/{token}': {
      get: {
        summary: 'Resolve a waitlist claim token',
        responses: {
          '200': {
            description: 'Offered waitlist entry',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WaitlistEntry' } },
            },
          },
          '404': {
            description: 'Claim token not found or expired',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/public/events/{eventId}/upload-artifacts': {
      post: {
        summary: 'Create a public checkout upload artifact ticket',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PublicCreateUploadArtifact' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Signed upload ticket',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/UploadArtifactTicket' } },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/public/events/{eventId}/widget-impressions': {
      post: {
        summary: 'Record a deduped widget impression for conversion reporting',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  visitorId: { type: 'string', minLength: 8, maxLength: 128 },
                  instanceId: { type: 'string', maxLength: 128 },
                  trackingId: { type: 'string', maxLength: 255 },
                  affiliateCode: { type: 'string', maxLength: 128 },
                  host: { type: 'string', maxLength: 255 },
                  pageUrl: { type: 'string', maxLength: 2048 },
                  referrer: { type: 'string', maxLength: 2048 },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Impression persisted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { tracked: { type: 'boolean' }, deduped: { type: 'boolean' } },
                  required: ['tracked', 'deduped'],
                },
              },
            },
          },
          '200': {
            description: 'Impression already counted for this visitor/day',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { tracked: { type: 'boolean' }, deduped: { type: 'boolean' } },
                  required: ['tracked', 'deduped'],
                },
              },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/public/upload-artifacts/{artifactId}/complete': {
      post: {
        summary: 'Complete and scan a public checkout upload artifact',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PublicCompleteUploadArtifact' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Upload completed and scanned clean',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UploadArtifactCompleteResult' },
              },
            },
          },
          '400': {
            description: 'Validation error or blocked upload',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Upload artifact not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/checkout/sessions': {
      post: {
        summary: 'Create checkout session (public, Idempotency-Key required)',
        parameters: [{ $ref: '#/components/parameters/RequiredIdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  eventId: { type: 'string' },
                  items: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      properties: {
                        ticketTypeId: { type: 'string' },
                        occurrenceId: { type: 'string' },
                        productId: { type: 'string' },
                        quantity: { type: 'integer', minimum: 1 },
                        unitAmountCents: { type: 'integer' },
                        attendeeFields: { type: 'array', items: { type: 'object' } },
                      },
                      oneOf: [
                        {
                          required: ['ticketTypeId', 'quantity'],
                          not: { required: ['productId'] },
                        },
                        {
                          required: ['productId', 'quantity'],
                          not: { required: ['ticketTypeId'] },
                        },
                      ],
                    },
                  },
                  discountCode: { type: 'string' },
                  affiliateCode: { type: 'string' },
                  trackingId: { type: 'string' },
                  accessCode: { type: 'string' },
                  waitlistClaimToken: { type: 'string' },
                  buyer: {
                    type: 'object',
                    properties: {
                      email: { type: 'string', format: 'email' },
                      firstName: { type: 'string' },
                      lastName: { type: 'string' },
                      phone: { type: 'string' },
                    },
                  },
                  buyerFields: {
                    type: 'object',
                    additionalProperties: true,
                  },
                  successUrl: { type: 'string', format: 'uri' },
                  cancelUrl: { type: 'string', format: 'uri' },
                },
                required: ['eventId', 'items'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Checkout session created',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CheckoutSession' } },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '409': {
            description: 'Insufficient inventory or event not published',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '410': {
            description: 'Event sales ended',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/upload-artifacts': {
      post: {
        summary: 'Create a signed upload artifact ticket',
        security: [{ BearerAuth: [] }, { ApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateUploadArtifact' },
            },
          },
        },
        responses: {
          '201': {
            description: 'Signed upload ticket',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/UploadArtifactTicket' } },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Brand or event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/upload-artifacts/{artifactId}/complete': {
      post: {
        summary: 'Complete and scan an upload artifact',
        security: [{ BearerAuth: [] }, { ApiKey: [] }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CompleteUploadArtifact' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Upload completed and scanned clean',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UploadArtifactCompleteResult' },
              },
            },
          },
          '400': {
            description: 'Validation error or blocked upload',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Upload artifact not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/upload-artifacts/{artifactId}/download': {
      get: {
        summary: 'Get a signed download URL for a completed upload artifact',
        security: [{ BearerAuth: [] }, { ApiKey: [] }],
        responses: {
          '200': {
            description: 'Signed download URL',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UploadArtifactDownload' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Upload artifact not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/checkout/sessions/{sessionId}': {
      get: {
        summary: 'Get checkout session',
        parameters: [
          { $ref: '#/components/parameters/OptionalCheckoutSessionToken' },
          { $ref: '#/components/parameters/PaymentIntentClientSecret' },
        ],
        responses: {
          '200': {
            description: 'Redacted checkout session details',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CheckoutSession' } },
            },
          },
        },
      },
      patch: {
        summary: 'Update checkout session',
        parameters: [{ $ref: '#/components/parameters/CheckoutSessionToken' }],
        responses: {
          '200': {
            description: 'Checkout session updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CheckoutSession' } },
            },
          },
        },
      },
    },
    '/checkout/sessions/{sessionId}/wallet-passes': {
      get: {
        summary: 'List active wallet pass links for a checkout session',
        parameters: [{ $ref: '#/components/parameters/CheckoutSessionToken' }],
        responses: {
          '200': {
            description: 'Active Apple Wallet and Google Wallet links grouped by ticket',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CheckoutWalletPasses' } },
            },
          },
        },
      },
    },
    '/wallet-passes/{passId}/apple.pkpass': {
      get: {
        summary: 'Download an Apple Wallet pass package',
        responses: {
          '200': {
            description: 'Apple Wallet pass package',
            content: {
              'application/vnd.apple.pkpass': {
                schema: { type: 'string', format: 'binary' },
              },
            },
          },
          '404': {
            description: 'Wallet pass not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '503': {
            description: 'Wallet pass signing unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/checkout/sessions/{sessionId}/confirm': {
      post: {
        summary: 'Confirm checkout (public, Idempotency-Key required)',
        parameters: [
          { $ref: '#/components/parameters/RequiredIdempotencyKey' },
          { $ref: '#/components/parameters/CheckoutSessionToken' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  paymentMethodId: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Checkout confirmed (completed or pending_payment)',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    { $ref: '#/components/schemas/CheckoutConfirmCompleted' },
                    { $ref: '#/components/schemas/CheckoutConfirmPending' },
                  ],
                },
              },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Session not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '409': {
            description: 'Session expired or cancelled',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '410': {
            description: 'Session expired',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '402': {
            description: 'PAYMENT_FAILED',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '503': {
            description: 'SERVICE_UNAVAILABLE',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/orders': {
      get: {
        summary: 'List orders',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
          { name: 'organizationId', in: 'query', schema: { type: 'string' } },
          { name: 'eventId', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Page of orders',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderPage' } } },
          },
        },
      },
    },
    '/payment-compensations': {
      get: {
        summary: 'List orphan payment compensations',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['pending', 'succeeded', 'failed', 'manual_review', 'already_ordered'],
            },
          },
          { name: 'checkoutSessionId', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Page of orphan payment compensations',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PaymentCompensationPage' },
              },
            },
          },
        },
      },
    },
    '/orders/{orderId}': {
      get: {
        summary: 'Get order',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Order details',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
        },
      },
    },
    '/orders/{orderId}/invoice': {
      get: {
        summary: 'Get invoice document',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Invoice document',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/InvoiceDocument' } },
            },
          },
        },
      },
    },
    '/orders/{orderId}/invoice/download': {
      get: {
        summary: 'Download invoice JSON document',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Downloadable invoice JSON',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/InvoiceDocument' } },
            },
          },
        },
      },
    },
    '/orders/{orderId}/cancel': {
      post: {
        summary: 'Cancel order',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Order cancelled',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          '404': {
            description: 'Order not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '409': {
            description: 'Order cannot be cancelled',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/orders/{orderId}/refunds': {
      post: {
        summary: 'Create refund',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/RequiredIdempotencyKey' }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  amountCents: { type: 'integer' },
                  reason: { type: 'string' },
                  voidTickets: { type: 'boolean' },
                  restoreInventory: { type: 'boolean' },
                },
                required: ['reason'],
              },
            },
          },
        },
        responses: {
          '202': {
            description: 'Refund workflow queued',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RefundQueued' } },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Order not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '409': {
            description: 'Order is not refundable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/attendees': {
      get: {
        summary: 'List attendees for an event',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of attendees',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AttendeePage' } },
            },
          },
        },
      },
    },
    '/attendees': {
      get: {
        summary: 'List all attendees across the tenant (cross-event)',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of attendees',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AttendeePage' } },
            },
          },
        },
      },
    },
    '/attendees/{attendeeId}': {
      patch: {
        summary: 'Update attendee',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Attendee updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Attendee' } } },
          },
        },
      },
    },
    '/tickets/{ticketId}/transfer': {
      post: {
        summary: 'Transfer ticket',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/RequiredIdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { toEmail: { type: 'string' } },
                required: ['toEmail'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Ticket transferred',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Ticket' } } },
          },
        },
      },
    },
    '/events/{eventId}/check-in-lists': {
      get: {
        summary: 'List check-in lists',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of check-in lists',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CheckInListPage' } },
            },
          },
        },
      },
    },
    '/events/{eventId}/check-in-lists/{checkInListId}/manifest': {
      get: {
        summary: 'Download offline check-in manifest',
        security: [{ ScannerDeviceAuth: [] }, { BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/OptionalScannerDeviceSecret' }],
        responses: {
          '200': {
            description: 'Offline manifest',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/OfflineManifest' } },
            },
          },
        },
      },
    },
    '/check-ins/scan': {
      post: {
        summary: 'Scan ticket (scanner device auth)',
        security: [{ ScannerDeviceAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/ScannerDeviceSecret' },
          { $ref: '#/components/parameters/IdempotencyKey' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  checkInListId: { type: 'string' },
                  qrPayload: {
                    type: 'string',
                    description: 'Signed canonical QR payload generated by Tixkit',
                  },
                  scannedAt: { type: 'string', format: 'date-time' },
                  offline: { type: 'boolean' },
                },
                required: ['checkInListId', 'qrPayload', 'scannedAt'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Scan result',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScanResult' } },
            },
          },
        },
      },
    },
    '/check-ins/sync': {
      post: {
        summary: 'Sync offline scans (scanner device auth)',
        security: [{ ScannerDeviceAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/ScannerDeviceSecret' },
          { $ref: '#/components/parameters/RequiredIdempotencyKey' },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  checkInListId: { type: 'string' },
                  scans: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        qrHash: { type: 'string' },
                        scannedAt: { type: 'string', format: 'date-time' },
                        offline: { type: 'boolean' },
                      },
                      required: ['qrHash', 'scannedAt', 'offline'],
                    },
                  },
                },
                required: ['checkInListId', 'scans'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Sync results',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SyncScanResult' } },
            },
          },
        },
      },
    },
    '/api-keys': {
      get: {
        summary: 'List API keys',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of API keys (hashed_key never returned)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiKeyPage' } },
            },
          },
        },
      },
      post: {
        summary: 'Create API key',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  organizationId: { type: 'string' },
                  name: { type: 'string' },
                  scopes: { type: 'array', items: { type: 'string' } },
                  brandIds: { type: 'array', items: { type: 'string' } },
                  eventIds: { type: 'array', items: { type: 'string' } },
                  expiresAt: { type: 'string', format: 'date-time' },
                },
                required: ['organizationId', 'name', 'scopes'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'API key created (full key shown only once)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ApiKeyCreated' } },
            },
          },
        },
      },
    },
    '/api-keys/{keyId}': {
      delete: {
        summary: 'Revoke API key',
        security: [{ BearerAuth: [] }],
        responses: { '204': { description: 'API key revoked' } },
      },
    },
    '/scanner-devices': {
      get: {
        summary: 'List scanner devices',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of scanner devices (hashed_secret never returned)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScannerDevicePage' } },
            },
          },
        },
      },
      post: {
        summary: 'Create scanner device',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  organizationId: { type: 'string' },
                  name: { type: 'string' },
                  eventIds: { type: 'array', items: { type: 'string' } },
                },
                required: ['organizationId', 'name'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Scanner device created (secret shown only once)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScannerDeviceCreated' } },
            },
          },
        },
      },
    },
    '/scanner-devices/{deviceId}/revoke': {
      post: {
        summary: 'Revoke scanner device',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Scanner device revoked',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ScannerDeviceRevoked' } },
            },
          },
        },
      },
    },
    '/events/{eventId}/reports/sales': {
      get: {
        summary: 'Get sales report',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'from',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
          },
        ],
        responses: {
          '200': {
            description: 'Sales metrics',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SalesReport' } },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/reports/tax': {
      get: {
        summary: 'Get tax report',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Tax metrics',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/TaxReport' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/reports/attendance': {
      get: {
        summary: 'Get attendance report',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Attendance metrics',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    totalAttendees: { type: 'number' },
                    checkedInAttendees: { type: 'number' },
                    noShowAttendees: { type: 'number' },
                    checkInRatePercentage: { type: 'number' },
                    scanLogsTimeline: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { date: { type: 'string' }, scans: { type: 'number' } },
                        required: ['date', 'scans'],
                      },
                    },
                  },
                  required: [
                    'totalAttendees',
                    'checkedInAttendees',
                    'noShowAttendees',
                    'checkInRatePercentage',
                    'scanLogsTimeline',
                  ],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/reports/promo': {
      get: {
        summary: 'Get promo code report',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Promo code metrics',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    promoCodeId: { type: 'string' },
                    code: { type: 'string' },
                    uses: { type: 'number' },
                    discountAmountCents: { type: 'number' },
                    revenueAttributedCents: { type: 'number' },
                  },
                  required: [
                    'promoCodeId',
                    'code',
                    'uses',
                    'discountAmountCents',
                    'revenueAttributedCents',
                  ],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/reports/conversion': {
      get: {
        summary: 'Get conversion report',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Conversion funnel metrics',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    eventId: { type: 'string' },
                    widgetViews: { type: 'number' },
                    checkoutStarted: { type: 'number' },
                    checkoutCompleted: { type: 'number' },
                    conversionRate: { type: 'number' },
                  },
                  required: [
                    'eventId',
                    'widgetViews',
                    'checkoutStarted',
                    'checkoutCompleted',
                    'conversionRate',
                  ],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/organizations/{organizationId}/reports/affiliate': {
      get: {
        summary: 'Get affiliate attribution report',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Affiliate metrics',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    affiliateId: { type: 'string' },
                    code: { type: 'string' },
                    linkClicks: { type: 'number' },
                    ordersAttributed: { type: 'number' },
                    revenueAttributedCents: { type: 'number' },
                    commissionEarnedCents: { type: 'number' },
                  },
                  required: [
                    'affiliateId',
                    'code',
                    'linkClicks',
                    'ordersAttributed',
                    'revenueAttributedCents',
                    'commissionEarnedCents',
                  ],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/me': {
      get: {
        summary: 'Get the authenticated principal (identity introspection)',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Current principal and permissions',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    tenantId: { type: 'string' },
                    type: { type: 'string' },
                    scopes: { type: 'array', items: { type: 'string' } },
                    organizationIds: { type: 'array', items: { type: 'string' } },
                    permissions: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/organizations/{organizationId}': {
      patch: {
        summary: 'Update organization',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  slug: { type: 'string' },
                  clerkOrganizationId: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Organization updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Organization' } },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Organization not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/organizations/{organizationId}/members': {
      get: {
        summary: 'List organization members',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of organization members',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      organizationId: { type: 'string' },
                      name: { type: 'string' },
                      email: { type: 'string' },
                      role: { type: 'string' },
                      status: { type: 'string' },
                      invitedAt: { type: 'string', format: 'date-time' },
                      joinedAt: { type: 'string', format: 'date-time', nullable: true },
                    },
                  },
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Organization not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/organizations/{organizationId}/members/invitations': {
      post: {
        summary: 'Invite a member to the organization',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email' },
                  role: { type: 'string', enum: ['owner', 'admin', 'organizer', 'viewer'] },
                },
                required: ['email'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Invitation created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    organizationId: { type: 'string' },
                    name: { type: 'string' },
                    email: { type: 'string' },
                    role: { type: 'string' },
                    status: { type: 'string' },
                    invitedAt: { type: 'string', format: 'date-time' },
                    joinedAt: { type: 'string', format: 'date-time', nullable: true },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Organization not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/organizations/{organizationId}/payment-accounts': {
      get: {
        summary: 'List payment accounts for an organization',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Page of payment accounts',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PaymentAccountPage' } },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Organization not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/organizations/{organizationId}/payment-accounts/stripe-connect': {
      post: {
        summary: 'Create or return the Stripe Connect payment account for an organization',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Existing active Stripe payment account returned',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PaymentAccount' } },
            },
          },
          '201': {
            description: 'Stripe Connect payment account created with onboarding link',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PaymentAccount' } },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Organization not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '400': {
            description: 'Stripe Connect onboarding is not configured for this environment',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/organizations/{organizationId}/payment-accounts/{paymentAccountId}/stripe-connect/refresh': {
      post: {
        summary: 'Refresh Stripe Connect payment account status and return a fresh account link',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Payment account status refreshed from Stripe',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PaymentAccount' } },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Organization or payment account not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '400': {
            description: 'Stripe Connect status refresh is not configured for this environment',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/organizations/{organizationId}/billing': {
      get: {
        summary: 'Get billing overview for an organization',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Billing overview',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    organizationId: { type: 'string' },
                    plan: { type: 'string' },
                    status: { type: 'string' },
                    ticketsThisMonth: { type: 'integer' },
                  },
                  required: ['organizationId', 'plan', 'status', 'ticketsThisMonth'],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Organization not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/questions': {
      get: {
        summary: 'List custom questions for an event',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of questions',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/QuestionPage' } },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
      post: {
        summary: 'Create a custom question',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: [
                      'text',
                      'textarea',
                      'email',
                      'phone',
                      'select',
                      'multiselect',
                      'checkbox',
                      'date',
                      'file',
                      'waiver',
                    ],
                  },
                  label: { type: 'string' },
                  description: { type: 'string' },
                  required: { type: 'boolean' },
                  appliesTo: { type: 'string', enum: ['buyer', 'attendee', 'both'] },
                  ticketTypeId: { type: 'string' },
                  options: { type: 'array', items: { type: 'string' } },
                  placeholder: { type: 'string' },
                  validationPattern: { type: 'string' },
                  conditionalVisibility: { type: 'object' },
                  sortOrder: { type: 'integer' },
                  isConsentField: { type: 'boolean' },
                  consentText: { type: 'string' },
                  consentVersion: { type: 'string' },
                },
                required: ['type', 'label'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Question created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Question' } } },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/questions/reorder': {
      post: {
        summary: 'Atomically reorder custom questions for an event',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ReorderQuestionsRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Questions reordered',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/QuestionPage' } },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Event or question not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/questions/{questionId}': {
      patch: {
        summary: 'Update a custom question',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: [
                      'text',
                      'textarea',
                      'email',
                      'phone',
                      'select',
                      'multiselect',
                      'checkbox',
                      'date',
                      'file',
                      'waiver',
                    ],
                  },
                  label: { type: 'string' },
                  description: { type: 'string' },
                  required: { type: 'boolean' },
                  appliesTo: { type: 'string', enum: ['buyer', 'attendee', 'both'] },
                  options: { type: 'array', items: { type: 'string' } },
                  placeholder: { type: 'string' },
                  validationPattern: { type: 'string' },
                  sortOrder: { type: 'integer' },
                  isConsentField: { type: 'boolean' },
                  consentText: { type: 'string' },
                  consentVersion: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Question updated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Question' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Question not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
      delete: {
        summary: 'Delete a custom question',
        security: [{ BearerAuth: [] }],
        responses: {
          '204': { description: 'Question deleted' },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Question not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/public/brands/{brandId}': {
      get: {
        summary: 'Get public brand details (no auth)',
        responses: {
          '200': {
            description: 'Brand details',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } },
          },
          '404': {
            description: 'Brand not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/public/events/{eventId}/questions': {
      get: {
        summary: 'Get public custom questions (no auth)',
        responses: {
          '200': {
            description: 'Buyer and attendee question lists',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PublicQuestionsResponse' },
              },
            },
          },
          '404': {
            description: 'Event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/exports': {
      post: {
        summary: 'Queue export (Idempotency-Key required)',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/RequiredIdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  eventId: { type: 'string' },
                  type: {
                    type: 'string',
                    enum: ['attendees', 'orders', 'scan_logs', 'sales', 'tax', 'tickets'],
                  },
                  format: { type: 'string', enum: ['csv', 'xlsx', 'json'] },
                  filters: { type: 'object' },
                },
                required: ['type', 'format'],
              },
            },
          },
        },
        responses: {
          '202': {
            description: 'Export queued',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ExportJobQueued' } },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/exports/{exportId}': {
      get: {
        summary: 'Get export job status',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Export job status',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    exportId: { type: 'string' },
                    eventId: { type: 'string' },
                    type: { type: 'string' },
                    format: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'completed', 'failed'] },
                    fileUrl: { type: 'string', nullable: true },
                    downloadUrl: { type: 'string', nullable: true },
                    createdAt: { type: 'string', format: 'date-time' },
                    completedAt: { type: 'string', format: 'date-time', nullable: true },
                  },
                  required: ['exportId', 'type', 'format', 'status', 'createdAt'],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Export job not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/exports/{exportId}/events': {
      get: {
        summary: 'Stream export job events (Server-Sent Events)',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'Last-Event-ID',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description: 'Resume the SSE stream from the last received event id',
          },
        ],
        responses: {
          '200': {
            description: 'Server-Sent Events stream of export job status updates',
            content: {
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description: 'SSE stream; each event is an export job status payload',
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Export job not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/exports/{exportId}/download': {
      get: {
        summary: 'Download a completed export file',
        security: [{ BearerAuth: [] }],
        responses: {
          '302': { description: 'Redirect to the signed export file URL' },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Export job not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '409': {
            description: 'Export is not ready for download',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/messages': {
      get: {
        summary: 'List message campaigns for an event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of campaign summaries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          eventId: { type: 'string' },
                          tenantId: { type: 'string' },
                          brandId: { type: 'string' },
                          templateKey: { type: 'string' },
                          channel: { type: 'string', enum: ['email', 'sms', 'both'] },
                          status: { type: 'string' },
                          audience: {
                            type: 'string',
                            enum: ['all_attendees', 'checked_in', 'not_checked_in', 'custom'],
                          },
                          audienceKey: {
                            type: 'string',
                            enum: ['all', 'checked_in', 'not_checked_in', 'specific'],
                          },
                          audienceAttendeeIds: { type: 'array', items: { type: 'string' } },
                          audienceLabel: { type: 'string' },
                          audienceCount: { type: 'integer' },
                          queuedEmailJobs: { type: 'integer' },
                          queuedSmsJobs: { type: 'integer' },
                          suppressedRecipients: { type: 'integer' },
                          consentExclusions: { type: 'integer' },
                          skippedRecipients: { type: 'integer' },
                          createdAt: { type: 'string', format: 'date-time' },
                          updatedAt: { type: 'string', format: 'date-time' },
                        },
                      },
                    },
                  },
                  required: ['items'],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
      post: {
        summary: 'Queue event email message',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  eventId: { type: 'string' },
                  templateKey: { type: 'string' },
                  audience: {
                    type: 'string',
                    enum: ['all', 'checked_in', 'not_checked_in', 'specific'],
                  },
                  attendeeIds: { type: 'array', items: { type: 'string' } },
                  variables: { type: 'object' },
                  channel: { type: 'string', enum: ['email', 'sms', 'both'] },
                },
                required: ['templateKey', 'audience', 'channel'],
              },
            },
          },
        },
        responses: {
          '501': {
            description: 'Email campaign delivery is not wired yet',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/audit-logs': {
      get: {
        summary: 'List scoped admin audit log entries',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
          {
            name: 'organizationId',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          { name: 'brandId', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'action', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'resourceType', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'actorId', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Page of audit log entries',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AuditLogPage' } },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/privacy/requests': {
      get: {
        summary: 'List GDPR data export and erasure requests',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
          {
            name: 'organizationId',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          { name: 'brandId', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'requestType',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['export', 'erasure'] },
          },
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
          },
        ],
        responses: {
          '200': {
            description: 'Page of privacy requests',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PrivacyRequestPage' } },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/privacy/requests/{requestId}': {
      get: {
        summary: 'Get GDPR request status and result',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Privacy request status',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PrivacyRequest' } },
            },
          },
          '404': {
            description: 'Privacy request not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/privacy/data-exports': {
      post: {
        summary: 'Queue GDPR data export request (Idempotency-Key required)',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/RequiredIdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/PrivacyRequestInput' } },
          },
        },
        responses: {
          '202': {
            description: 'Privacy export queued',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PrivacyRequest' } },
            },
          },
        },
      },
    },
    '/privacy/erasures': {
      post: {
        summary: 'Queue GDPR erasure request (Idempotency-Key required)',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/RequiredIdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/PrivacyRequestInput' } },
          },
        },
        responses: {
          '202': {
            description: 'Privacy erasure queued',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PrivacyRequest' } },
            },
          },
        },
      },
    },
    '/events/{eventId}/messages/preview': {
      post: {
        summary: 'Preview eligible message recipients',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  templateKey: { type: 'string' },
                  audience: {
                    type: 'string',
                    enum: ['all', 'checked_in', 'not_checked_in', 'specific'],
                  },
                  attendeeIds: { type: 'array', items: { type: 'string' } },
                  channel: { type: 'string', enum: ['email', 'sms', 'both'] },
                },
                required: ['templateKey', 'audience', 'channel'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Recipient preview using send-time eligibility rules',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    audience: {
                      type: 'string',
                      enum: ['all_attendees', 'checked_in', 'not_checked_in', 'custom'],
                    },
                    audienceCount: { type: 'integer' },
                    eligibleCount: { type: 'integer' },
                    suppressedRecipients: { type: 'integer' },
                    consentExclusions: { type: 'integer' },
                    skippedRecipients: { type: 'integer' },
                    recipients: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          name: { type: 'string' },
                          email: { type: 'string' },
                          phone: { type: 'string' },
                          status: { type: 'string' },
                        },
                        required: ['id', 'name', 'status'],
                      },
                    },
                  },
                  required: [
                    'audience',
                    'audienceCount',
                    'eligibleCount',
                    'suppressedRecipients',
                    'consentExclusions',
                    'skippedRecipients',
                    'recipients',
                  ],
                },
              },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}': {
      get: {
        summary: 'Get message campaign detail',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Campaign detail with jobs and deliveries',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Campaign not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/jobs': {
      get: {
        summary: 'List message jobs for a campaign',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of email/SMS jobs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { items: { type: 'array', items: { type: 'object' } } },
                  required: ['items'],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Campaign not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/jobs/{channel}/{jobId}': {
      get: {
        summary: 'Get a single message job',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Message job detail',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Job not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/delivery-logs': {
      get: {
        summary: 'List delivery logs for a campaign',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of email/SMS delivery logs',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { items: { type: 'array', items: { type: 'object' } } },
                  required: ['items'],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Campaign not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/delivery-logs/{channel}/{deliveryId}': {
      get: {
        summary: 'Get a single delivery log',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Delivery log detail',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Delivery log not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/provider-events': {
      get: {
        summary: 'List provider events for a campaign',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'List of SMS provider events',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { items: { type: 'array', items: { type: 'object' } } },
                  required: ['items'],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Campaign not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/provider-events/{providerEventId}': {
      get: {
        summary: 'Get a single provider event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Provider event detail',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Provider event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/oauth-applications': {
      get: {
        summary: 'List OAuth applications',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of OAuth applications',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/OAuthApplication' },
                    },
                    nextCursor: { type: ['string', 'null'] },
                    hasMore: { type: 'boolean' },
                  },
                  required: ['items', 'nextCursor', 'hasMore'],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
      post: {
        summary: 'Create OAuth application',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  organizationId: { type: 'string' },
                  name: { type: 'string' },
                  redirectUris: { type: 'array', items: { type: 'string', format: 'uri' } },
                  scopes: { type: 'array', items: { type: 'string' } },
                  tokenExpirationSeconds: { type: 'integer' },
                },
                required: ['organizationId', 'name', 'redirectUris', 'scopes'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'OAuth application created (client secret shown only once)',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OAuthApplicationCreated' },
              },
            },
          },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/oauth-applications/{appId}': {
      delete: {
        summary: 'Delete OAuth application',
        security: [{ BearerAuth: [] }],
        responses: {
          '204': { description: 'OAuth application deleted' },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Application not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/oauth/authorize': {
      get: {
        summary: 'Authorize OAuth application and redirect with authorization code',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'response_type',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['code'] },
          },
          { name: 'client_id', in: 'query', required: true, schema: { type: 'string' } },
          {
            name: 'redirect_uri',
            in: 'query',
            required: true,
            schema: { type: 'string', format: 'uri' },
          },
          { name: 'scope', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'state', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: { '302': { description: 'Redirect with code and optional state' } },
      },
    },
    '/oauth/token': {
      post: {
        summary: 'Exchange authorization code or refresh token for OAuth access token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  grant_type: { type: 'string', enum: ['authorization_code', 'refresh_token'] },
                  client_id: { type: 'string' },
                  client_secret: { type: 'string' },
                  code: { type: 'string' },
                  redirect_uri: { type: 'string', format: 'uri' },
                  refresh_token: { type: 'string' },
                },
                required: ['grant_type', 'client_id', 'client_secret'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'OAuth token response',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/OAuthTokenResponse' } },
            },
          },
        },
      },
    },
    '/oauth/revoke': {
      post: {
        summary: 'Revoke OAuth access or refresh token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  client_id: { type: 'string' },
                  client_secret: { type: 'string' },
                  token: { type: 'string' },
                },
                required: ['client_id', 'client_secret', 'token'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Token revoked',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { revoked: { type: 'boolean' } },
                  required: ['revoked'],
                },
              },
            },
          },
        },
      },
    },
    '/webhook-endpoints': {
      get: {
        summary: 'List webhook endpoints',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of endpoints',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WebhookEndpointPage' } },
            },
          },
        },
      },
      post: {
        summary: 'Create webhook endpoint',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  organizationId: { type: 'string' },
                  url: { type: 'string', format: 'uri' },
                  events: { type: 'array', items: { type: 'string' } },
                  description: { type: 'string' },
                },
                required: ['organizationId', 'url', 'events'],
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Endpoint created with one-time signing secret',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WebhookEndpointCreated' },
              },
            },
          },
        },
      },
    },
    '/webhook-endpoints/{endpointId}': {
      patch: {
        summary: 'Update webhook endpoint',
        security: [{ BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  url: { type: 'string', format: 'uri' },
                  events: { type: 'array', items: { type: 'string' } },
                  status: { type: 'string', enum: ['active', 'disabled'] },
                  description: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Endpoint updated',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WebhookEndpoint' } },
            },
          },
        },
      },
    },
    '/webhook-endpoints/{endpointId}/events': {
      get: {
        summary: 'List webhook delivery events for an endpoint',
        description:
          'Returns delivery events in newest-first delivery creation order. Use nextCursor opaquely as the next cursor value.',
        security: [{ BearerAuth: [] }],
        parameters: [
          { $ref: '#/components/parameters/Cursor' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: {
          '200': {
            description: 'Page of webhook delivery events',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          eventId: { type: 'string' },
                          deliveryId: { type: 'string' },
                          endpointId: { type: ['string', 'null'] },
                          requestedEndpointId: { type: 'string' },
                          eventType: { type: 'string' },
                          status: { type: 'string' },
                          statusCode: { type: 'integer' },
                          attemptCount: { type: 'integer' },
                          deliveredAt: { type: 'string', format: 'date-time', nullable: true },
                          createdAt: { type: 'string', format: 'date-time' },
                        },
                      },
                    },
                    nextCursor: { type: ['string', 'null'] },
                    hasMore: { type: 'boolean' },
                  },
                  required: ['items', 'nextCursor', 'hasMore'],
                },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Endpoint not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/webhook-endpoints/{endpointId}/events/{eventId}/replay': {
      post: {
        summary: 'Replay webhook event to one endpoint',
        description:
          'Queues one webhook delivery for the selected endpoint when the endpoint is active and subscribed to the event type.',
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'endpointId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'eventId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '202': {
            description: 'Endpoint webhook replay queued',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WebhookEndpointReplayQueued' },
              },
            },
          },
          '400': {
            description: 'Endpoint inactive or not subscribed to this event type',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '401': {
            description: 'Unauthorized',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '403': {
            description: 'Forbidden',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '404': {
            description: 'Endpoint or event not found',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/webhook-events/{eventId}/replay': {
      post: {
        summary: 'Replay webhook event',
        security: [{ BearerAuth: [] }],
        responses: {
          '202': {
            description: 'Webhook replay queued',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/WebhookReplayQueued' } },
            },
          },
        },
      },
    },
    '/webhooks/stripe': {
      post: {
        summary: 'Stripe webhook (Stripe-Signature header verified)',
        responses: { '200': { description: 'Webhook received' } },
      },
    },
    '/webhooks/clerk': {
      post: {
        summary: 'Clerk webhook (Svix headers verified)',
        responses: { '200': { description: 'Webhook received' } },
      },
    },
    '/webhooks/telnyx/sms': {
      post: {
        summary: 'Telnyx SMS webhook (Ed25519 signature verified when configured)',
        responses: {
          '200': { description: 'Webhook received' },
          '400': {
            description: 'Invalid webhook or signature',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '503': {
            description: 'Webhook verification not configured',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/webhooks/email/{provider}': {
      post: {
        summary: 'Email provider feedback webhook (HMAC SHA-256 signature verified)',
        parameters: [
          {
            name: 'provider',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Email provider key, for example postmark, sendgrid, ses, mailgun, or smtp',
          },
        ],
        responses: {
          '200': { description: 'Webhook received' },
          '400': {
            description: 'Invalid webhook or signature',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
          '503': {
            description: 'Webhook verification or delivery reconciliation not ready',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
  },
} as const;

export type OpenApiSpec = typeof openApiSpec;

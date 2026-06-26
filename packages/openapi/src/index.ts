export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'GateKit API',
    version: '2026-01-01',
    description: 'Headless white-label event commerce platform API',
    license: { name: 'MIT' },
  },
  servers: [
    { url: 'https://api.gatekit.com/v1', description: 'Production' },
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
        description: 'Bearer gk_<key>',
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
        description: 'Client token returned when the checkout session is created; required to read public session details',
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
      TicketTypePage: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/TicketType' } },
          nextCursor: { type: ['string', 'null'] },
          hasMore: { type: 'boolean' },
        },
        required: ['items', 'nextCursor', 'hasMore'],
      },
      AvailabilityResult: {
        type: 'object',
        properties: {
          ticketTypeId: { type: 'string' },
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
          status: { type: 'string', enum: ['open', 'pending_payment', 'completed', 'expired', 'cancelled'] },
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
          expiresAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'eventId', 'status', 'currency', 'quote', 'expiresAt'],
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
            enum: ['draft', 'pending_payment', 'paid', 'partially_refunded', 'refunded', 'cancelled', 'expired', 'disputed'],
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
      OrderLineItem: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          ticketTypeId: { type: 'string' },
          description: { type: 'string' },
          quantity: { type: 'integer' },
          unitPriceCents: { type: 'integer' },
          subtotalCents: { type: 'integer' },
          totalCents: { type: 'integer' },
        },
        required: ['id', 'description', 'quantity', 'unitPriceCents', 'totalCents'],
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
              apiKey: { type: 'string', description: 'Full API key (gk_...). Store securely; never returned again.' },
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
              secret: { type: 'string', description: 'Device secret. Store securely; never returned again.' },
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
          paymentAccountId: { type: 'string', nullable: true, description: 'Payment account bound to this brand for paid checkout routing.' },
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
        required: ['id', 'tenantId', 'orderId', 'attendeeId', 'eventId', 'ticketTypeId', 'status', 'code', 'qrPayload', 'qrHash'],
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
          signature: { type: 'string', description: 'HMAC-SHA256 signature of the manifest payload' },
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
        required: ['eventId', 'checkInListId', 'generatedAt', 'expiresAt', 'keyId', 'signature', 'tickets'],
      },
      ScanResult: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['accepted', 'duplicate', 'invalid', 'revoked', 'not_found', 'wrong_event', 'wrong_list'] },
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
          actorType: { type: 'string' },
          actorId: { type: 'string' },
          action: { type: 'string' },
          resourceType: { type: 'string' },
          resourceId: { type: 'string' },
          ip: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'actorType', 'actorId', 'action', 'resourceType', 'resourceId'],
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
              secret: { type: 'string', description: 'Endpoint signing secret. Store securely; never returned again.' },
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
        required: ['eventId', 'currency', 'grossSalesCents', 'netRevenueCents', 'refundsCents', 'feesCents', 'taxCents', 'ticketsSold', 'checkIns', 'ordersCount', 'paidOrdersCount'],
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
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
        required: ['id', 'organizationId', 'provider', 'providerAccountId', 'status', 'defaultCurrency'],
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
          type: { type: 'string', enum: ['text', 'textarea', 'email', 'phone', 'select', 'multiselect', 'checkbox', 'date', 'file', 'waiver'] },
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
        required: ['id', 'eventId', 'type', 'label', 'required', 'appliesTo', 'sortOrder', 'isConsentField'],
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
              clientSecret: { type: 'string', description: 'Client secret. Store securely; never returned again.' },
            },
            required: ['clientSecret'],
          },
        ],
      },
    },
  },
  paths: {
    '/health': {
      get: { summary: 'Health check', responses: { '200': { description: 'OK' } } },
    },
    '/organizations': {
      get: {
        summary: 'List organizations',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: {
          '200': { description: 'Page of organizations', content: { 'application/json': { schema: { $ref: '#/components/schemas/OrganizationPage' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '201': { description: 'Organization created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Organization' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '409': { description: 'Slug already in use', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/brands': {
      get: {
        summary: 'List brands',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'Page of brands', content: { 'application/json': { schema: { $ref: '#/components/schemas/BrandPage' } } } } },
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
        responses: { '201': { description: 'Brand created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } } } },
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
                  paymentAccountId: { type: 'string', nullable: true, description: 'Bind a payment account to this brand for paid checkout routing. Must belong to the same tenant and organization.' },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Brand updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } } } },
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
        responses: { '201': { description: 'Brand domain created', content: { 'application/json': { schema: { $ref: '#/components/schemas/BrandDomain' } } } } },
      },
    },
    '/events': {
      get: {
        summary: 'List events',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'Page of events', content: { 'application/json': { schema: { $ref: '#/components/schemas/EventPage' } } } } },
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
                },
                required: ['organizationId', 'brandId', 'slug', 'title', 'currency', 'timezone', 'startsAt'],
              },
            },
          },
        },
        responses: { '201': { description: 'Event created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } } },
      },
    },
    '/events/{eventId}': {
      get: { summary: 'Get event', security: [{ BearerAuth: [] }], responses: { '200': { description: 'Event details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } } } },
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
                  visibility: { type: 'string', enum: ['public', 'unlisted', 'private'] },
                  capacity: { type: 'integer', nullable: true },
                  status: { type: 'string', enum: ['draft', 'published', 'paused', 'archived'] },
                },
              },
            },
          },
        },
        responses: { '200': { description: 'Event updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } } },
      },
    },
    '/events/{eventId}/publish': {
      post: {
        summary: 'Publish event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Event published', content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } },
          '404': { description: 'Event not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/pause': {
      post: {
        summary: 'Pause event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Event paused', content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } },
          '404': { description: 'Event not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/archive': {
      post: {
        summary: 'Archive event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Event archived', content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } },
          '404': { description: 'Event not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/ticket-types': {
      get: {
        summary: 'List ticket types',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'Page of ticket types', content: { 'application/json': { schema: { $ref: '#/components/schemas/TicketTypePage' } } } } },
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
                },
                required: ['name', 'kind', 'currency', 'priceCents', 'inventoryPoolId'],
              },
            },
          },
        },
        responses: { '201': { description: 'Ticket type created', content: { 'application/json': { schema: { $ref: '#/components/schemas/TicketType' } } } } },
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
            },
          },
        },
        responses: { '200': { description: 'Ticket type updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/TicketType' } } } } },
      },
    },
    '/events/{eventId}/inventory-pools': {
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
        responses: { '201': { description: 'Inventory pool created', content: { 'application/json': { schema: { $ref: '#/components/schemas/InventoryPool' } } } } },
      },
    },
    '/events/{eventId}/availability': {
      get: { summary: 'Get availability', security: [{ BearerAuth: [] }], responses: { '200': { description: 'Availability per ticket type', content: { 'application/json': { schema: { $ref: '#/components/schemas/AvailabilityPage' } } } } } },
    },
    '/public/events/{eventId}': {
      get: { summary: 'Get public event details (no auth)', responses: { '200': { description: 'Event details (hidden ticket types excluded)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Event' } } } } } },
    },
    '/public/events/{eventId}/availability': {
      get: { summary: 'Get public availability (no auth, hidden excluded)', responses: { '200': { description: 'Buyer-facing ticket availability', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/PublicAvailabilityItem' } } } } } } },
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
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Event not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
                        quantity: { type: 'integer', minimum: 1 },
                        unitAmountCents: { type: 'integer' },
                        attendeeFields: { type: 'array', items: { type: 'object' } },
                      },
                      required: ['ticketTypeId', 'quantity'],
                    },
                  },
                  discountCode: { type: 'string' },
                  affiliateCode: { type: 'string' },
                  trackingId: { type: 'string' },
                  accessCode: { type: 'string' },
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
          '201': { description: 'Checkout session created', content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckoutSession' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Event not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '409': { description: 'Insufficient inventory or event not published', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '410': { description: 'Event sales ended', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/checkout/sessions/{sessionId}': {
      get: {
        summary: 'Get checkout session',
        parameters: [{ $ref: '#/components/parameters/CheckoutSessionToken' }],
        responses: { '200': { description: 'Redacted checkout session details', content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckoutSession' } } } } },
      },
      patch: {
        summary: 'Update checkout session',
        parameters: [{ $ref: '#/components/parameters/CheckoutSessionToken' }],
        responses: { '200': { description: 'Checkout session updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckoutSession' } } } } },
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
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Session not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '409': { description: 'Session expired or cancelled', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '410': { description: 'Session expired', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '402': { description: 'PAYMENT_FAILED', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '503': { description: 'SERVICE_UNAVAILABLE', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/orders': {
      get: {
        summary: 'List orders',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'Page of orders', content: { 'application/json': { schema: { $ref: '#/components/schemas/OrderPage' } } } } },
      },
    },
    '/orders/{orderId}': {
      get: { summary: 'Get order', security: [{ BearerAuth: [] }], responses: { '200': { description: 'Order details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } } },
    },
    '/orders/{orderId}/cancel': {
      post: {
        summary: 'Cancel order',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Order cancelled', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
          '404': { description: 'Order not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '409': { description: 'Order cannot be cancelled', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '202': { description: 'Refund workflow queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/RefundQueued' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Order not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '409': { description: 'Order is not refundable', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/attendees': {
      get: {
        summary: 'List attendees for an event',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'Page of attendees', content: { 'application/json': { schema: { $ref: '#/components/schemas/AttendeePage' } } } } },
      },
    },
    '/attendees': {
      get: {
        summary: 'List all attendees across the tenant (cross-event)',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'Page of attendees', content: { 'application/json': { schema: { $ref: '#/components/schemas/AttendeePage' } } } } },
      },
    },
    '/attendees/{attendeeId}': {
      patch: { summary: 'Update attendee', security: [{ BearerAuth: [] }], responses: { '200': { description: 'Attendee updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Attendee' } } } } } },
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
        responses: { '200': { description: 'Ticket transferred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ticket' } } } } },
      },
    },
    '/events/{eventId}/check-in-lists': {
      get: {
        summary: 'List check-in lists',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'Page of check-in lists', content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckInListPage' } } } } },
      },
    },
    '/events/{eventId}/check-in-lists/{checkInListId}/manifest': {
      get: {
        summary: 'Download offline check-in manifest',
        security: [{ ScannerDeviceAuth: [] }, { BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/OptionalScannerDeviceSecret' }],
        responses: { '200': { description: 'Offline manifest', content: { 'application/json': { schema: { $ref: '#/components/schemas/OfflineManifest' } } } } },
      },
    },
    '/check-ins/scan': {
      post: {
        summary: 'Scan ticket (scanner device auth)',
        security: [{ ScannerDeviceAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/ScannerDeviceSecret' }, { $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  checkInListId: { type: 'string' },
                  qrPayload: { type: 'string', description: 'Signed canonical QR payload generated by GateKit' },
                  scannedAt: { type: 'string', format: 'date-time' },
                  offline: { type: 'boolean' },
                },
                required: ['checkInListId', 'qrPayload', 'scannedAt'],
              },
            },
          },
        },
        responses: { '200': { description: 'Scan result', content: { 'application/json': { schema: { $ref: '#/components/schemas/ScanResult' } } } } },
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
        responses: { '200': { description: 'Sync results', content: { 'application/json': { schema: { $ref: '#/components/schemas/SyncScanResult' } } } } },
      },
    },
    '/api-keys': {
      get: {
        summary: 'List API keys',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'Page of API keys (hashed_key never returned)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKeyPage' } } } } },
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
        responses: { '201': { description: 'API key created (full key shown only once)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiKeyCreated' } } } } },
      },
    },
    '/api-keys/{keyId}': {
      delete: { summary: 'Revoke API key', security: [{ BearerAuth: [] }], responses: { '204': { description: 'API key revoked' } } },
    },
    '/scanner-devices': {
      get: {
        summary: 'List scanner devices',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'Page of scanner devices (hashed_secret never returned)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ScannerDevicePage' } } } } },
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
        responses: { '201': { description: 'Scanner device created (secret shown only once)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ScannerDeviceCreated' } } } } },
      },
    },
    '/scanner-devices/{deviceId}/revoke': {
      post: {
        summary: 'Revoke scanner device',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': {
            description: 'Scanner device revoked',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ScannerDeviceRevoked' } } },
          },
        },
      },
    },
    '/events/{eventId}/reports/sales': {
      get: {
        summary: 'Get sales report',
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
        ],
        responses: {
          '200': { description: 'Sales metrics', content: { 'application/json': { schema: { $ref: '#/components/schemas/SalesReport' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/reports/tax': {
      get: {
        summary: 'Get tax report',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Tax metrics', content: { 'application/json': { schema: { $ref: '#/components/schemas/TaxReport' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/reports/attendance': {
      get: {
        summary: 'Get attendance report',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Attendance metrics', content: { 'application/json': { schema: { type: 'object', properties: { totalAttendees: { type: 'number' }, checkedInAttendees: { type: 'number' }, noShowAttendees: { type: 'number' }, checkInRatePercentage: { type: 'number' }, scanLogsTimeline: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, scans: { type: 'number' } }, required: ['date', 'scans'] } } }, required: ['totalAttendees', 'checkedInAttendees', 'noShowAttendees', 'checkInRatePercentage', 'scanLogsTimeline'] } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/reports/promo': {
      get: {
        summary: 'Get promo code report',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Promo code metrics', content: { 'application/json': { schema: { type: 'object', properties: { promoCodeId: { type: 'string' }, code: { type: 'string' }, uses: { type: 'number' }, discountAmountCents: { type: 'number' }, revenueAttributedCents: { type: 'number' } }, required: ['promoCodeId', 'code', 'uses', 'discountAmountCents', 'revenueAttributedCents'] } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/reports/conversion': {
      get: {
        summary: 'Get conversion report',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Conversion funnel metrics', content: { 'application/json': { schema: { type: 'object', properties: { eventId: { type: 'string' }, checkoutStarted: { type: 'number' }, checkoutCompleted: { type: 'number' }, conversionRate: { type: 'number' } }, required: ['eventId', 'checkoutStarted', 'checkoutCompleted', 'conversionRate'] } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/organizations/{organizationId}/reports/affiliate': {
      get: {
        summary: 'Get affiliate attribution report',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Affiliate metrics', content: { 'application/json': { schema: { type: 'object', properties: { affiliateId: { type: 'string' }, code: { type: 'string' }, linkClicks: { type: 'number' }, ordersAttributed: { type: 'number' }, revenueAttributedCents: { type: 'number' }, commissionEarnedCents: { type: 'number' } }, required: ['affiliateId', 'code', 'linkClicks', 'ordersAttributed', 'revenueAttributedCents', 'commissionEarnedCents'] } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '200': { description: 'Organization updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Organization' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Organization not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Organization not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Organization not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/organizations/{organizationId}/payment-accounts': {
      get: {
        summary: 'List payment accounts for an organization',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Page of payment accounts', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentAccountPage' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Organization not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/organizations/{organizationId}/payment-accounts/stripe-connect': {
      post: {
        summary: 'Create or return the Stripe Connect payment account for an organization',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Existing active Stripe payment account returned', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentAccount' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Organization not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '422': { description: 'Stripe Connect onboarding is not configured for this environment', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Organization not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/questions': {
      get: {
        summary: 'List custom questions for an event',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: {
          '200': { description: 'Page of questions', content: { 'application/json': { schema: { $ref: '#/components/schemas/QuestionPage' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
                  type: { type: 'string', enum: ['text', 'textarea', 'email', 'phone', 'select', 'multiselect', 'checkbox', 'date', 'file', 'waiver'] },
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
          '201': { description: 'Question created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Question' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '200': { description: 'Questions reordered', content: { 'application/json': { schema: { $ref: '#/components/schemas/QuestionPage' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Event or question not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
                  type: { type: 'string', enum: ['text', 'textarea', 'email', 'phone', 'select', 'multiselect', 'checkbox', 'date', 'file', 'waiver'] },
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
          '200': { description: 'Question updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/Question' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Question not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
      delete: {
        summary: 'Delete a custom question',
        security: [{ BearerAuth: [] }],
        responses: {
          '204': { description: 'Question deleted' },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Question not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/public/brands/{brandId}': {
      get: {
        summary: 'Get public brand details (no auth)',
        responses: {
          '200': { description: 'Brand details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } } },
          '404': { description: 'Brand not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/public/events/{eventId}/questions': {
      get: {
        summary: 'Get public custom questions (no auth)',
        responses: {
          '200': { description: 'Buyer and attendee question lists', content: { 'application/json': { schema: { $ref: '#/components/schemas/PublicQuestionsResponse' } } } },
          '404': { description: 'Event not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
                  type: { type: 'string', enum: ['attendees', 'orders', 'scan_logs', 'sales', 'tax', 'tickets'] },
                  format: { type: 'string', enum: ['csv', 'xlsx', 'json'] },
                  filters: { type: 'object' },
                },
                required: ['type', 'format'],
              },
            },
          },
        },
        responses: {
          '202': { description: 'Export queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/ExportJobQueued' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Export job not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
                schema: { type: 'string', description: 'SSE stream; each event is an export job status payload' },
              },
            },
          },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Export job not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/exports/{exportId}/download': {
      get: {
        summary: 'Download a completed export file',
        security: [{ BearerAuth: [] }],
        responses: {
          '302': { description: 'Redirect to the signed export file URL' },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Export job not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '409': { description: 'Export is not ready for download', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
                  audience: { type: 'string', enum: ['all', 'checked_in', 'not_checked_in', 'specific'] },
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
          '501': { description: 'Email campaign delivery is not wired yet', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}': {
      get: {
        summary: 'Get message campaign detail',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Campaign detail with jobs and deliveries', content: { 'application/json': { schema: { type: 'object' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Campaign not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/jobs': {
      get: {
        summary: 'List message jobs for a campaign',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'List of email/SMS jobs', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'] } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Campaign not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/jobs/{channel}/{jobId}': {
      get: {
        summary: 'Get a single message job',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Message job detail', content: { 'application/json': { schema: { type: 'object' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Job not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/delivery-logs': {
      get: {
        summary: 'List delivery logs for a campaign',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'List of email/SMS delivery logs', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'] } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Campaign not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/delivery-logs/{channel}/{deliveryId}': {
      get: {
        summary: 'Get a single delivery log',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Delivery log detail', content: { 'application/json': { schema: { type: 'object' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Delivery log not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/provider-events': {
      get: {
        summary: 'List provider events for a campaign',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'List of SMS provider events', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } } }, required: ['items'] } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Campaign not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/events/{eventId}/messages/{campaignId}/provider-events/{providerEventId}': {
      get: {
        summary: 'Get a single provider event',
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Provider event detail', content: { 'application/json': { schema: { type: 'object' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Provider event not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/oauth-applications': {
      get: {
        summary: 'List OAuth applications',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: {
          '200': { description: 'Page of OAuth applications', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/OAuthApplication' } }, nextCursor: { type: ['string', 'null'] }, hasMore: { type: 'boolean' } }, required: ['items', 'nextCursor', 'hasMore'] } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
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
          '201': { description: 'OAuth application created (client secret shown only once)', content: { 'application/json': { schema: { $ref: '#/components/schemas/OAuthApplicationCreated' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/oauth-applications/{appId}': {
      delete: {
        summary: 'Delete OAuth application',
        security: [{ BearerAuth: [] }],
        responses: {
          '204': { description: 'OAuth application deleted' },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Application not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/webhook-endpoints': {
      get: {
        summary: 'List webhook endpoints',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
        responses: { '200': { description: 'Page of endpoints', content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookEndpointPage' } } } } },
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
        responses: { '201': { description: 'Endpoint created with one-time signing secret', content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookEndpointCreated' } } } } },
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
        responses: { '200': { description: 'Endpoint updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookEndpoint' } } } } },
      },
    },
    '/webhook-endpoints/{endpointId}/events': {
      get: {
        summary: 'List webhook delivery events for an endpoint',
        security: [{ BearerAuth: [] }],
        parameters: [{ $ref: '#/components/parameters/Cursor' }, { $ref: '#/components/parameters/Limit' }],
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
                          endpointId: { type: 'string' },
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
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '403': { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '404': { description: 'Endpoint not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
    '/webhook-events/{eventId}/replay': {
      post: {
        summary: 'Replay webhook event',
        security: [{ BearerAuth: [] }],
        responses: { '202': { description: 'Webhook replay queued', content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookReplayQueued' } } } } },
      },
    },
    '/webhooks/stripe': {
      post: { summary: 'Stripe webhook (Stripe-Signature header verified)', responses: { '200': { description: 'Webhook received' } } },
    },
    '/webhooks/clerk': {
      post: { summary: 'Clerk webhook (Svix headers verified)', responses: { '200': { description: 'Webhook received' } } },
    },
    '/webhooks/telnyx/sms': {
      post: {
        summary: 'Telnyx SMS webhook (Ed25519 signature verified when configured)',
        responses: {
          '200': { description: 'Webhook received' },
          '400': { description: 'Invalid webhook or signature', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
          '503': { description: 'Webhook verification not configured', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
        },
      },
    },
  },
} as const;

export type OpenApiSpec = typeof openApiSpec;

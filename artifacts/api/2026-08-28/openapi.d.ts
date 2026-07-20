/* Generated from Tixkit OpenAPI 2026-08-28. Do not edit. */

export interface paths {
    "/health": {
        get: {
            responses: {
                "200": Record<string, never>;
            };
        };
    };
    "/bootstrap-context": {
        get: {
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["BootstrapContext"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/organizations": {
        get: {
            responses: {
                "200": {
                    content: {
                        "application/json": Array<components["schemas"]["Organization"]>;
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                        slug: string;
                        clerkOrganizationId?: string;
                        boxOfficeSettings?: components["schemas"]["BoxOfficeSettings"];
                        eventDefaults?: components["schemas"]["EventDefaults"];
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["Organization"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/brands": {
        get: {
            responses: {
                "200": {
                    content: {
                        "application/json": Array<components["schemas"]["Brand"]>;
                    };
                };
            };
        };
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        name: string;
                        slug: string;
                        theme?: Record<string, unknown>;
                        whiteLabel?: boolean;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["Brand"];
                    };
                };
            };
        };
    };
    "/brands/{brandId}": {
        patch: {
            parameters: {
                path: {
                    brandId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: string;
                        slug?: string;
                        status?: "draft" | "active" | "suspended";
                        theme?: Record<string, unknown>;
                        supportUrl?: string;
                        legalUrls?: Record<string, unknown>;
                        whiteLabel?: boolean;
                        paymentAccountId?: string | null;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Brand"];
                    };
                };
            };
        };
    };
    "/brands/{brandId}/domains": {
        post: {
            parameters: {
                path: {
                    brandId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        domain: string;
                        isPrimary?: boolean;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["BrandDomain"];
                    };
                };
            };
        };
    };
    "/brands/{brandId}/email-sender-identities": {
        get: {
            parameters: {
                path: {
                    brandId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Array<components["schemas"]["BrandSenderIdentity"]>;
                    };
                };
            };
        };
    };
    "/venues": {
        get: {
            parameters: {
                query: {
                    organizationId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Array<components["schemas"]["SavedVenue"]>;
                    };
                };
            };
        };
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        name: string;
                        address: Record<string, unknown>;
                        timezone?: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["SavedVenue"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/venues/{venueId}": {
        delete: {
            parameters: {
                path: {
                    venueId: string;
                };
            };
            responses: {
                "204": Record<string, never>;
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        patch: {
            parameters: {
                path: {
                    venueId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: string;
                        address?: Record<string, unknown>;
                        timezone?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["SavedVenue"];
                    };
                };
            };
        };
    };
    "/onboarding-events": {
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        stage: "onboarding_started" | "starting_point_selected" | "preset_creation" | "recovery" | "autosave_failure" | "stale_version_conflict";
                        outcome: "started" | "blank" | "free" | "paid" | "donation" | "multiple" | "duplicate" | "attempted" | "completed" | "failed";
                        reasonCode?: "none" | "request_failed" | "stale_event_version";
                    };
                };
            };
            responses: {
                "204": Record<string, never>;
            };
        };
    };
    "/events": {
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    direction?: "next" | "prev";
                    limit?: number;
                    search?: string;
                    sort?: string;
                    includeFacets?: boolean;
                    includeTotal?: boolean;
                    organizationId?: string;
                    brandId?: string;
                    status?: string;
                    title?: string;
                    startsAtFrom?: string;
                    startsAtTo?: string;
                    createdAtFrom?: string;
                    createdAtTo?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["EventPage"];
                    };
                };
            };
        };
        post: {
            parameters: {
                header?: {
                    "Idempotency-Key"?: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        brandId: string;
                        slug: string;
                        title: string;
                        description?: string;
                        currency: string;
                        timezone: string;
                        startsAt: string;
                        endsAt?: string;
                        venue?: Record<string, unknown>;
                        venueId?: string | null;
                        visibility?: "public" | "unlisted" | "private";
                        seo?: {
                            title?: string;
                            description?: string;
                        };
                        capacity?: number;
                        minimumAge?: number | null;
                        externalUrl?: string;
                        startingPoint?: "blank" | "free" | "paid" | "donation" | "multiple";
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["Event"];
                    };
                };
            };
        };
    };
    "/events/{eventId}": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Event"];
                    };
                };
            };
        };
        patch: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        title?: string;
                        description?: string;
                        currency?: string;
                        timezone?: string;
                        startsAt?: string;
                        endsAt?: string | null;
                        venue?: Record<string, unknown> | null;
                        visibility?: "public" | "unlisted" | "private";
                        seo?: {
                            title?: string;
                            description?: string;
                            imageUrl?: string;
                        };
                        capacity?: number | null;
                        minimumAge?: number | null;
                        coverImageUrl?: string | null;
                        externalUrl?: string | null;
                        coverImageAlt?: string | null;
                        seoUseCoverImage?: boolean;
                        lastSetupSection?: string | null;
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Event"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["StaleEventVersionError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/duplicate": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
                header?: {
                    "Idempotency-Key"?: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["DuplicateEventRequest"];
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["Event"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/publish": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Event"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["LaunchReadinessFailedError"] | components["schemas"]["StaleEventVersionError"] | components["schemas"]["EventArchivedError"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}/readiness": {
        get: {
            parameters: {
                path: {
                    organizationId: string;
                };
                query: {
                    brandId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["WorkspaceReadiness"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}/dashboard-actions": {
        get: {
            parameters: {
                path: {
                    organizationId: string;
                };
                query: {
                    brandId: string;
                    limit?: number;
                    cursor?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["DashboardActionFeed"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/launch-readiness": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["EventLaunchReadiness"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/operational-health": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            eventId: string;
                            organizationFailedWebhookDeliveries: number;
                            failedExports: number;
                            checkedAt: string;
                        };
                    };
                };
            };
        };
    };
    "/events/{eventId}/setup-section": {
        put: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        section: "basics" | "schedule" | "sales" | "media" | "marketing-fields";
                    };
                };
            };
            responses: {
                "200": Record<string, never>;
            };
        };
    };
    "/events/{eventId}/readiness-acknowledgements/{stepId}": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                    stepId: string;
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["ReadinessAcknowledgement"];
                    };
                };
            };
        };
        delete: {
            parameters: {
                path: {
                    eventId: string;
                    stepId: string;
                };
            };
            responses: {
                "204": Record<string, never>;
            };
        };
    };
    "/events/{eventId}/pause": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Event"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/archive": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Event"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/ticket-types": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["TicketTypePage"];
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                        description?: string;
                        kind: "free" | "paid" | "donation";
                        visibility?: "public" | "hidden" | "locked";
                        currency: string;
                        priceCents: number;
                        minimumPriceCents?: number;
                        salesStartAt?: string;
                        salesEndAt?: string;
                        minPerOrder?: number;
                        maxPerOrder?: number;
                        inventoryPoolId: string;
                        requiresAccessCode?: boolean;
                        accessCodeHint?: string;
                        eventOccurrenceId?: string | null;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["TicketType"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/ticket-types/batch": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["CreateTicketTypeBatch"];
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["TicketTypeBatchResult"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/code-format": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            eventId: string;
                            codeFormat: {
                                symbology: "qr" | "code128" | "pdf417" | "aztec" | "data_matrix";
                                payloadFormat: "signed_v1" | "compact_v2";
                                rotating?: {
                                    timeStepSeconds: number;
                                    toleranceWindows: number;
                                    digits?: number;
                                };
                            };
                            scannerContractVersion: string;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        put: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        symbology?: "qr" | "code128" | "pdf417" | "aztec" | "data_matrix";
                        payloadFormat?: "signed_v1" | "compact_v2";
                        rotating?: {
                            timeStepSeconds: number;
                            toleranceWindows: number;
                            digits?: number;
                        };
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            eventId: string;
                            codeFormat: {
                                [key: string]: unknown;
                            };
                            scannerContractVersion: string;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/occurrences": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["EventOccurrencePage"];
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        title: string;
                        startsAt: string;
                        endsAt: string;
                        timezone: string;
                        venue?: Record<string, unknown>;
                        capacity?: number | null;
                        sortOrder?: number;
                        status?: "scheduled" | "cancelled" | "completed";
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["EventOccurrence"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/occurrences/{occurrenceId}": {
        patch: {
            parameters: {
                path: {
                    eventId: string;
                    occurrenceId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["EventOccurrence"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["EventOccurrence"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/marketing-integrations": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MarketingIntegrationPage"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/marketing-integrations/{provider}": {
        put: {
            parameters: {
                path: {
                    eventId: string;
                    provider: "ga4" | "meta_pixel" | "generic_tag";
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        config: components["schemas"]["Ga4MarketingIntegrationConfig"] | components["schemas"]["MetaPixelMarketingIntegrationConfig"] | components["schemas"]["GenericTagMarketingIntegrationConfig"];
                        consentRequired?: boolean;
                        status?: "active" | "disabled";
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MarketingIntegration"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/waitlist": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["WaitlistEntryPage"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/waitlist/{entryId}/offer": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                    entryId: string;
                };
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expiresInMinutes?: number;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["WaitlistOffer"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/waitlist/settings": {
        patch: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["WaitlistSettings"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["WaitlistSettings"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/ticket-types/{ticketTypeId}": {
        patch: {
            parameters: {
                path: {
                    ticketTypeId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: string;
                        description?: string;
                        kind?: "free" | "paid" | "donation";
                        status?: "draft" | "active" | "paused" | "sold_out" | "ended";
                        visibility?: "public" | "hidden" | "locked";
                        currency?: string;
                        priceCents?: number;
                        minimumPriceCents?: number | null;
                        salesStartAt?: string | null;
                        salesEndAt?: string | null;
                        minPerOrder?: number;
                        maxPerOrder?: number;
                        inventoryPoolId?: string;
                        requiresAccessCode?: boolean;
                        accessCodeHint?: string | null;
                        sortOrder?: number;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["TicketType"];
                    };
                };
            };
        };
    };
    "/ticket-types/{ticketTypeId}/batch": {
        patch: {
            parameters: {
                path: {
                    ticketTypeId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["UpdateTicketTypeBatch"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["TicketTypeBatchResult"];
                    };
                };
            };
        };
    };
    "/ticket-types/{ticketTypeId}/access-rules": {
        get: {
            parameters: {
                path: {
                    ticketTypeId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AccessRulePage"];
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    ticketTypeId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        type: "code" | "email_domain";
                        value: string;
                        maxUses?: number | null;
                        expiresAt?: string | null;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["AccessRule"];
                    };
                };
            };
        };
    };
    "/access-rules/{accessRuleId}": {
        delete: {
            parameters: {
                path: {
                    accessRuleId: string;
                };
            };
            responses: {
                "204": Record<string, never>;
            };
        };
    };
    "/events/{eventId}/inventory-pools": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["InventoryPool"]>;
                            nextCursor?: string | null;
                            hasMore?: boolean;
                        };
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                        totalCapacity: number;
                        holdTtlSeconds?: number;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["InventoryPool"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/product-categories": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ProductCategoryPage"];
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                        sortOrder?: number;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["ProductCategory"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/products": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ProductPage"];
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                        description?: string;
                        priceCents: number;
                        currency: string;
                        categoryId?: string;
                        maxPerOrder?: number;
                        availableFrom?: string;
                        availableUntil?: string;
                        status?: "active" | "inactive";
                        sortOrder?: number;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["Product"];
                    };
                };
            };
        };
    };
    "/products/{productId}": {
        patch: {
            parameters: {
                path: {
                    productId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: string;
                        description?: string | null;
                        priceCents?: number;
                        currency?: string;
                        categoryId?: string | null;
                        maxPerOrder?: number;
                        availableFrom?: string | null;
                        availableUntil?: string | null;
                        status?: "active" | "inactive";
                        sortOrder?: number;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Product"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/availability": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AvailabilityPage"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicEvent"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/revision": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicEventRevision"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/by-slug/{slug}": {
        get: {
            parameters: {
                path: {
                    slug: string;
                };
                query: {
                    host: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicEvent"];
                    };
                };
                "404": Record<string, never>;
            };
        };
    };
    "/public/events/{eventId}/availability": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    products?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Array<components["schemas"]["PublicAvailabilityItem"]>;
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/bootstrap": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    products?: string;
                    resaleListingId?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicCheckoutBootstrap"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/resale-listings": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicTicketListingPage"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/occurrences": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["EventOccurrencePage"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/marketing-integrations": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MarketingIntegrationPage"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/access-code": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        ticketTypeIds: Array<string>;
                        accessCode?: string;
                        buyerEmail?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            valid: boolean;
                            ticketTypeIds: Array<string>;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/waitlist": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["JoinWaitlistRequest"];
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["WaitlistEntry"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/waitlist/claims/{token}": {
        get: {
            parameters: {
                path: {
                    token: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["WaitlistEntry"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/upload-artifacts": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["PublicCreateUploadArtifact"];
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["UploadArtifactTicket"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/widget-impressions": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        visitorId?: string;
                        instanceId?: string;
                        trackingId?: string;
                        affiliateCode?: string;
                        host?: string;
                        pageUrl?: string;
                        referrer?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            tracked: boolean;
                            deduped: boolean;
                        };
                    };
                };
                "201": {
                    content: {
                        "application/json": {
                            tracked: boolean;
                            deduped: boolean;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/rum": {
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        schemaVersion: "tixkit-rum-v1";
                        surface: "checkout" | "event-page";
                        metric: "LCP";
                        value: number;
                    } | {
                        schemaVersion: "tixkit-rum-v1";
                        surface: "checkout" | "event-page";
                        metric: "INP";
                        value: number;
                    } | {
                        schemaVersion: "tixkit-rum-v1";
                        surface: "checkout" | "event-page";
                        metric: "CLS";
                        value: number;
                    };
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": {
                            accepted: true;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "413": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "429": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/upload-artifacts/{artifactId}/complete": {
        post: {
            parameters: {
                path: {
                    artifactId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["PublicCompleteUploadArtifact"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["UploadArtifactCompleteResult"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/content-email-images/{artifactId}": {
        get: {
            parameters: {
                path: {
                    artifactId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/octet-stream": string;
                    };
                    headers: {
                        "Content-Type": string;
                        "Content-Disposition": string;
                        "Cache-Control": string;
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/content-event-page-images/{artifactId}": {
        get: {
            parameters: {
                path: {
                    artifactId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/octet-stream": string;
                    };
                    headers: {
                        "Content-Type": string;
                        "Content-Disposition": string;
                        "Cache-Control": string;
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/brand-logos/{artifactId}": {
        get: {
            parameters: {
                path: {
                    artifactId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/octet-stream": string;
                    };
                    headers: {
                        "Content-Type": string;
                        "Content-Disposition": string;
                        "Cache-Control": string;
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/media": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Array<components["schemas"]["EventMediaAsset"]>;
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/media/renditions/{renditionId}": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    renditionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "image/webp": string;
                    };
                    headers: {
                        ETag: string;
                        "Cache-Control": string;
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/media/{role}": {
        put: {
            parameters: {
                path: {
                    eventId: string;
                    role: "poster" | "cover" | "social";
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AttachEventMedia"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["EventMediaAsset"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        delete: {
            parameters: {
                path: {
                    eventId: string;
                    role: "poster" | "cover" | "social";
                };
            };
            responses: {
                "204": Record<string, never>;
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/event-media/renditions/{renditionId}": {
        get: {
            parameters: {
                path: {
                    renditionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "image/webp": string;
                    };
                    headers: {
                        "Cache-Control": string;
                        ETag: string;
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/box-office/orders": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["BoxOfficeOrderInput"];
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["BoxOfficeOrderResult"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/checkout/sessions": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                    "X-Tixkit-Test-Order"?: "1";
                };
            };
            requestBody: {
                content: {
                    "application/json": ({
                        eventId: string;
                        items: Array<({
                            ticketTypeId?: string;
                            occurrenceId?: string;
                            productId?: string;
                            resaleListingId?: string;
                            quantity?: number;
                            unitAmountCents?: number;
                            attendeeFields?: Array<{
                                dateOfBirth?: string;
                                [key: string]: unknown;
                            }>;
                        }) & ({
                            ticketTypeId: unknown;
                            quantity: unknown;
                            productId?: never;
                            resaleListingId?: never;
                        } | {
                            productId: unknown;
                            quantity: unknown;
                            ticketTypeId?: never;
                            resaleListingId?: never;
                        } | {
                            quantity: 1;
                            resaleListingId: unknown;
                            ticketTypeId?: never;
                            productId?: never;
                            occurrenceId?: never;
                            unitAmountCents?: never;
                            attendeeFields?: never;
                        })>;
                        discountCode?: string;
                        affiliateCode?: string;
                        trackingId?: string;
                        accessCode?: string;
                        waitlistClaimToken?: string;
                        buyer: {
                            email: string;
                            firstName?: string;
                            lastName?: string;
                            phone?: string;
                            dateOfBirth?: string;
                        };
                        buyerFields?: {
                            [key: string]: unknown;
                        };
                        resaleTermsAcceptance?: components["schemas"]["ResaleTermsAcceptance"];
                        successUrl?: string;
                        cancelUrl?: string;
                    }) & (unknown & unknown);
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["CheckoutSession"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "410": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/upload-artifacts": {
        post: {
            requestBody: {
                content: {
                    "application/json": components["schemas"]["CreateUploadArtifact"];
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["UploadArtifactTicket"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/upload-artifacts/{artifactId}/complete": {
        post: {
            parameters: {
                path: {
                    artifactId: string;
                };
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["CompleteUploadArtifact"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["UploadArtifactCompleteResult"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/upload-artifacts/{artifactId}/download": {
        get: {
            parameters: {
                path: {
                    artifactId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["UploadArtifactDownload"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/checkout/sessions/{sessionId}": {
        get: {
            parameters: {
                path: {
                    sessionId: string;
                };
                header?: {
                    "X-Checkout-Session-Token"?: string;
                };
                query?: {
                    payment_intent_client_secret?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["CheckoutSession"];
                    };
                };
            };
        };
        patch: {
            parameters: {
                path: {
                    sessionId: string;
                };
                header: {
                    "X-Checkout-Session-Token": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["CheckoutSessionUpdateInput"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["CheckoutSession"];
                    };
                };
            };
        };
    };
    "/checkout/sessions/{sessionId}/handoff": {
        post: {
            parameters: {
                path: {
                    sessionId: string;
                };
                header: {
                    "X-Checkout-Session-Token": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["CheckoutHostedHandoff"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/checkout/sessions/{sessionId}/handoff/exchange": {
        post: {
            parameters: {
                path: {
                    sessionId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        handoff: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["CheckoutSession"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/checkout/sessions/{sessionId}/wallet-passes": {
        get: {
            parameters: {
                path: {
                    sessionId: string;
                };
                header: {
                    "X-Checkout-Session-Token": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["CheckoutWalletPasses"];
                    };
                };
            };
        };
    };
    "/checkout/sessions/{sessionId}/tickets/{ticketId}/resale-listing": {
        post: {
            parameters: {
                path: {
                    sessionId: string;
                    ticketId: string;
                };
                header: {
                    "X-Checkout-Session-Token": string;
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        priceCents: number;
                        expiresAt?: string;
                        termsAcceptance: components["schemas"]["ResaleTermsAcceptance"];
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["TicketListing"];
                    };
                };
            };
        };
    };
    "/wallet-passes/{passId}/apple.pkpass": {
        get: {
            parameters: {
                path: {
                    passId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/vnd.apple.pkpass": string;
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/checkout/sessions/{sessionId}/confirm": {
        post: {
            parameters: {
                path: {
                    sessionId: string;
                };
                header: {
                    "Idempotency-Key": string;
                    "X-Checkout-Session-Token": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        paymentMethodId?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["CheckoutConfirmCompleted"] | components["schemas"]["CheckoutConfirmPending"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "402": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "410": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/orders": {
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    direction?: "next" | "prev";
                    limit?: number;
                    search?: string;
                    sort?: string;
                    includeFacets?: boolean;
                    includeTotal?: boolean;
                    organizationId?: string;
                    eventId?: string;
                    status?: string;
                    salesChannel?: string;
                    paymentProvider?: string;
                    refundState?: boolean;
                    totalCentsMin?: number;
                    totalCentsMax?: number;
                    createdAtFrom?: string;
                    createdAtTo?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["OrderPage"];
                    };
                };
            };
        };
    };
    "/payment-compensations": {
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                    status?: "pending" | "succeeded" | "failed" | "manual_review" | "already_ordered";
                    checkoutSessionId?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PaymentCompensationPage"];
                    };
                };
            };
        };
    };
    "/orders/{orderId}": {
        get: {
            parameters: {
                path: {
                    orderId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["OrderDetail"];
                    };
                };
            };
        };
    };
    "/orders/{orderId}/invoice": {
        get: {
            parameters: {
                path: {
                    orderId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["InvoiceDocument"];
                    };
                };
            };
        };
    };
    "/orders/{orderId}/invoice/download": {
        get: {
            parameters: {
                path: {
                    orderId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["InvoiceDocument"];
                    };
                };
            };
        };
    };
    "/orders/{orderId}/cancel": {
        post: {
            parameters: {
                path: {
                    orderId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Order"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/orders/{orderId}/refunds": {
        post: {
            parameters: {
                path: {
                    orderId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody?: {
                content: {
                    "application/json": {
                        amountCents?: number;
                        reason: string;
                        voidTickets?: boolean;
                        restoreInventory?: boolean;
                    };
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["RefundQueued"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/attendees": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    cursor?: string;
                    direction?: "next" | "prev";
                    limit?: number;
                    search?: string;
                    sort?: string;
                    includeFacets?: boolean;
                    includeTotal?: boolean;
                    checkInListId?: string;
                    eventOccurrenceId?: string;
                    status?: string;
                    checkInStatus?: string;
                    createdAtFrom?: string;
                    createdAtTo?: string;
                    checkedInAtFrom?: string;
                    checkedInAtTo?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AttendeePage"];
                    };
                };
            };
        };
    };
    "/attendees": {
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    direction?: "next" | "prev";
                    limit?: number;
                    search?: string;
                    sort?: string;
                    includeFacets?: boolean;
                    includeTotal?: boolean;
                    organizationId?: string;
                    brandId?: string;
                    eventId?: string;
                    status?: string;
                    checkInStatus?: string;
                    createdAtFrom?: string;
                    createdAtTo?: string;
                    checkedInAtFrom?: string;
                    checkedInAtTo?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AttendeePage"];
                    };
                };
            };
        };
    };
    "/attendees/{attendeeId}": {
        patch: {
            parameters: {
                path: {
                    attendeeId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AttendeeUpdateInput"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Attendee"];
                    };
                };
            };
        };
    };
    "/tickets/{ticketId}/transfer": {
        post: {
            parameters: {
                path: {
                    ticketId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        toEmail: string;
                        dateOfBirth?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Ticket"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/fee-policy": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["EventFeePolicy"];
                    };
                };
            };
        };
        put: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["UpdateEventFeePolicyInput"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["EventFeePolicy"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/resale-policy": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ResalePolicy"];
                    };
                };
            };
        };
        put: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["ResalePolicy"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ResalePolicy"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/resale-listings": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["TicketListingPage"];
                    };
                };
            };
        };
    };
    "/tickets/{ticketId}/resale-listings": {
        post: {
            parameters: {
                path: {
                    ticketId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        priceCents: number;
                        expiresAt?: string;
                        termsAcceptance: components["schemas"]["ResaleTermsAcceptance"];
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["TicketListing"];
                    };
                };
            };
        };
    };
    "/ticket-listings/{listingId}/delist": {
        post: {
            parameters: {
                path: {
                    listingId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["TicketListing"];
                    };
                };
            };
        };
    };
    "/ticket-listings/{listingId}/complete": {
        post: {
            parameters: {
                path: {
                    listingId: string;
                };
            };
            responses: {
                "410": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                    headers: {
                        Deprecation: "@1784160000";
                        Link: "</v1/checkout/sessions>; rel=\"successor-version\"";
                    };
                };
            };
        };
    };
    "/ticket-listings/{listingId}/settlement": {
        get: {
            parameters: {
                path: {
                    listingId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ResaleSettlement"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/ticket-listings/{listingId}/settlement/payouts": {
        post: {
            parameters: {
                path: {
                    listingId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        amountCents: number;
                        currency: string;
                        expectedVersion: number;
                        method: "bank_transfer" | "payment_provider" | "accounting_adjustment";
                        externalReference: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ResaleSettlement"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/ticket-listings/{listingId}/settlement/reversals": {
        post: {
            parameters: {
                path: {
                    listingId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        amountCents: number;
                        currency: string;
                        expectedVersion: number;
                        method: "bank_transfer" | "payment_provider" | "accounting_adjustment";
                        reason: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ResaleSettlement"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/check-in-lists": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                header?: {
                    "X-Device-Secret"?: string;
                };
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["CheckInListPage"];
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                        ticketTypeIds?: Array<string>;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["CheckInList"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/check-in-lists/{checkInListId}/manifest": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    checkInListId: string;
                };
                query?: {
                    version?: 1 | 2;
                };
                header?: {
                    "X-Device-Secret"?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["OfflineManifest"];
                    };
                };
                "400": Record<string, never>;
            };
        };
    };
    "/events/{eventId}/check-in-manifest-keys": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                header?: {
                    "X-Device-Secret"?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["OfflineManifestVerificationKeySet"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/events/{eventId}/check-in-lists/{checkInListId}/activity": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    checkInListId: string;
                };
                query?: {
                    since?: string;
                    afterId?: string;
                    limit?: number;
                };
                header?: {
                    "X-Device-Secret"?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<{
                                id: string;
                                checkInListId: string;
                                ticketId: string | null;
                                deviceId: string;
                                outcome: string;
                                scannedAt: string;
                                offline: boolean;
                                attendeeName: string | null;
                                attendeeEmail: string | null;
                                ticketTypeId: string | null;
                            }>;
                            summary: {
                                checkedIn: number;
                                remaining: number;
                                total: number;
                                acceptedScans: number;
                            };
                            nextCursor?: string;
                        };
                    };
                };
            };
        };
    };
    "/events/{eventId}/check-in-lists/{checkInListId}/activity/stream": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    checkInListId: string;
                };
                header?: {
                    "Last-Event-ID"?: string;
                    "X-Device-Secret"?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "text/event-stream": string;
                    };
                };
            };
        };
    };
    "/check-ins/scan": {
        post: {
            parameters: {
                header: {
                    "X-Device-Secret"?: string;
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        checkInListId: string;
                        qrPayload: string;
                        scannedAt: string;
                        offline?: boolean;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ScanResult"];
                    };
                };
                "400": Record<string, never>;
            };
        };
    };
    "/check-ins/sync": {
        post: {
            parameters: {
                header: {
                    "X-Device-Secret": string;
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        checkInListId: string;
                        scans: Array<{
                            qrHash: string;
                            scannedAt: string;
                            offline: boolean;
                        }>;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["SyncScanResult"];
                    };
                };
            };
        };
    };
    "/check-ins/bulk-sync-jobs": {
        post: {
            parameters: {
                header: {
                    "X-Device-Secret": string;
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        checkInListId: string;
                        deviceId?: string;
                        totalChunks: number;
                        totalScans?: number;
                    };
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["BulkSyncJob"];
                    };
                };
            };
        };
    };
    "/check-ins/bulk-sync-jobs/{jobId}/chunks/{sequence}": {
        put: {
            parameters: {
                path: {
                    jobId: string;
                    sequence: number;
                };
                header: {
                    "X-Device-Secret": string;
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        scans: Array<{
                            qrHash: string;
                            scannedAt: string;
                            offline: boolean;
                        }>;
                    };
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["BulkSyncChunk"];
                    };
                };
            };
        };
    };
    "/check-ins/bulk-sync-jobs/{jobId}": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
                header: {
                    "X-Device-Secret": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["BulkSyncJob"];
                    };
                };
            };
        };
    };
    "/check-ins/bulk-sync-jobs/{jobId}/chunks": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
                header: {
                    "X-Device-Secret": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["BulkSyncChunkList"];
                    };
                };
            };
        };
    };
    "/api-keys": {
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ApiKeyPage"];
                    };
                };
            };
        };
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        name: string;
                        scopes: Array<string>;
                        brandIds?: Array<string>;
                        eventIds?: Array<string>;
                        expiresAt?: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["ApiKeyCreated"];
                    };
                };
            };
        };
    };
    "/api-keys/{keyId}": {
        delete: {
            parameters: {
                path: {
                    keyId: string;
                };
            };
            responses: {
                "204": Record<string, never>;
            };
        };
    };
    "/agent-principals": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        id: string;
                        kind: "third_party" | "self_hosted";
                        capabilities: Array<"events.read" | "events.prepare" | "events.execute" | "readiness.read" | "content.prepare">;
                        maximumAutonomy: "read" | "recommend" | "prepare" | "execute_with_approval";
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["AgentPrincipal"] | components["schemas"]["AgentPrincipal20260802"] | components["schemas"]["AgentPrincipal20260803"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent-principals/{id}": {
        get: {
            parameters: {
                path: {
                    id: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentPrincipal"] | components["schemas"]["AgentPrincipal20260802"] | components["schemas"]["AgentPrincipal20260803"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent-principals/{id}/revoke": {
        post: {
            parameters: {
                path: {
                    id: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            id: string;
                            state: "revoked";
                        };
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent-principals/{id}/oauth-clients": {
        post: {
            parameters: {
                path: {
                    id: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        name: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentOAuthClient"];
                    };
                };
                "201": {
                    content: {
                        "application/json": components["schemas"]["AgentOAuthClientCreated"];
                    };
                    headers: {
                        "Cache-Control": "no-store";
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent-principals/{id}/oauth-clients/{clientId}/revoke": {
        post: {
            parameters: {
                path: {
                    id: string;
                    clientId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            id: string;
                            status: "revoked";
                        };
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/plans": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        definition: components["schemas"]["AgentPlanDefinition"];
                        actionBindings: Array<{
                            stepId: components["schemas"]["AgentPlanProtocol_id"];
                            actionId: components["schemas"]["AgentPlanProtocol_id"];
                        }>;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["PersistedAgentPlan"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/plans/{planId}": {
        get: {
            parameters: {
                path: {
                    planId: components["schemas"]["AgentPlanProtocol_id"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PersistedAgentPlan"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/plans/{planId}/transitions": {
        post: {
            parameters: {
                path: {
                    planId: components["schemas"]["AgentPlanProtocol_id"];
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedStateVersion: number;
                        status: "prepared" | "awaiting_approval" | "executing" | "succeeded" | "failed" | "cancelled" | "expired" | "compensated";
                        stepStates: Array<components["schemas"]["AgentPlanProtocol_stepState"]>;
                        reasonCode: components["schemas"]["AgentPlanProtocol_reasonCode"];
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PersistedAgentPlan"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/actions": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        kind: "event.publish";
                        delegationGrantId: string;
                        resourceId: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentAction"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/readiness": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        delegationGrantId: string;
                        resourceId: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentReadinessReadAction"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/readiness/{actionId}": {
        get: {
            parameters: {
                path: {
                    actionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentReadinessReadAction"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/events": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        delegationGrantId: string;
                        resourceId: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentEventReadAction"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/events/{actionId}": {
        get: {
            parameters: {
                path: {
                    actionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentEventReadAction"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/reports": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        delegationGrantId: string;
                        resourceId: string;
                        from?: string;
                        to?: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentReportReadAction"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/reports/{actionId}": {
        get: {
            parameters: {
                path: {
                    actionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentReportReadAction"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/event-preparations": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        delegationGrantId: string;
                        resourceId: string;
                        changes: components["schemas"]["AgentEventPrepareChanges"];
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentEventPrepareAction"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/event-preparations/{actionId}": {
        get: {
            parameters: {
                path: {
                    actionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentEventPrepareAction"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/content-preparations": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        delegationGrantId: string;
                        resourceId: string;
                        content: components["schemas"]["AgentSafeEventPageContent"];
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentContentPrepareAction"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/content-preparations/{actionId}": {
        get: {
            parameters: {
                path: {
                    actionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentContentPrepareAction"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/campaign-preparations": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": ({
                        delegationGrantId: string;
                        resourceId: string;
                        audience: "all" | "checked_in" | "not_checked_in" | "specific";
                        attendeeIds?: Array<string>;
                        channel: "email" | "sms" | "both";
                        emailTemplateKey?: string;
                        smsTemplateKey?: string;
                    }) & (unknown & unknown & unknown);
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentCampaignPrepareAction"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/campaign-preparations/{actionId}": {
        get: {
            parameters: {
                path: {
                    actionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentCampaignPrepareAction"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/event-updates": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        delegationGrantId: string;
                        resourceId: string;
                        changes: components["schemas"]["AgentEventPrepareChanges"];
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentEventUpdateAction"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/event-updates/{actionId}": {
        get: {
            parameters: {
                path: {
                    actionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentEventUpdateAction"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/event-updates/{actionId}/approvals": {
        post: {
            parameters: {
                path: {
                    actionId: string;
                };
                header: {
                    "Idempotency-Key": string;
                    "X-Tixkit-Confirmation": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        actionDigest: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["AgentEventUpdateApproval"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/event-updates/{actionId}/approvals/{approvalId}/revoke": {
        post: {
            parameters: {
                path: {
                    actionId: string;
                    approvalId: string;
                };
                header: {
                    "Idempotency-Key": string;
                    "X-Tixkit-Confirmation": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        actionDigest: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentEventUpdateApproval"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/event-updates/{actionId}/executions": {
        post: {
            parameters: {
                path: {
                    actionId: string;
                };
                header: {
                    "Idempotency-Key": string;
                    "X-Tixkit-Confirmation": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        approvalId: string;
                        actionDigest: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentEventUpdateExecution"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/event-updates/{actionId}/executions/{executionId}": {
        get: {
            parameters: {
                path: {
                    actionId: string;
                    executionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentEventUpdateExecutionEvidence"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/actions/{actionId}": {
        get: {
            parameters: {
                path: {
                    actionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PreparedAgentAction"];
                    };
                };
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/actions/{actionId}/approvals": {
        post: {
            parameters: {
                path: {
                    actionId: string;
                };
                header: {
                    "Idempotency-Key": string;
                    "X-Tixkit-Confirmation": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        actionDigest: string;
                        planSha256?: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["AgentApproval"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/actions/{actionId}/approvals/{approvalId}/revoke": {
        post: {
            parameters: {
                path: {
                    actionId: string;
                    approvalId: string;
                };
                header: {
                    "Idempotency-Key": string;
                    "X-Tixkit-Confirmation": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        actionDigest: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentApproval"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/actions/{actionId}/executions": {
        post: {
            parameters: {
                path: {
                    actionId: string;
                };
                header: {
                    "Idempotency-Key": string;
                    "X-Tixkit-Confirmation": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        approvalId: string;
                        actionDigest: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentExecution"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent/actions/{actionId}/executions/{executionId}": {
        get: {
            parameters: {
                path: {
                    actionId: string;
                    executionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentExecutionEvidence"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent/session": {
        get: {
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentSession"] | components["schemas"]["AgentSession20260802"] | components["schemas"]["AgentSession20260803"];
                    };
                };
                "401": Record<string, never>;
                "404": Record<string, never>;
            };
        };
    };
    "/agent-delegations": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        id: string;
                        agentPrincipalId: string;
                        capabilities: Array<"events.read" | "events.prepare" | "events.execute" | "readiness.read" | "content.prepare">;
                        resourceScopes: Array<string>;
                        expiresAt: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["AgentDelegation"] | components["schemas"]["AgentDelegation20260802"] | components["schemas"]["AgentDelegation20260803"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent-delegations/{id}/revoke": {
        post: {
            parameters: {
                path: {
                    id: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            id: string;
                            revoked: true;
                        };
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent-memory": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AgentMemoryCreateRequest"];
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["AgentMemoryEntry"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent-memory/inspect": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AgentMemoryNamespaceRequestBody"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            entries: Array<components["schemas"]["AgentMemoryEntry"]>;
                        };
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent-memory/export": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AgentMemoryNamespaceRequestBody"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentMemoryExportBundle"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent-memory/{id}": {
        patch: {
            parameters: {
                path: {
                    id: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AgentMemoryCorrectRequest"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AgentMemoryEntry"];
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/agent-memory/{id}/delete": {
        post: {
            parameters: {
                path: {
                    id: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["AgentMemoryDeleteRequest"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            id: string;
                            deleted: true;
                        };
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "409": Record<string, never>;
            };
        };
    };
    "/scanner-devices": {
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ScannerDevicePage"];
                    };
                };
            };
        };
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        name: string;
                        eventIds?: Array<string>;
                        scopes?: Array<"checkins.read" | "checkins.write">;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["ScannerDeviceCreated"];
                    };
                };
            };
        };
    };
    "/scanner-devices/{deviceId}/revoke": {
        post: {
            parameters: {
                path: {
                    deviceId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ScannerDeviceRevoked"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/reports/sales": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    from?: string;
                    to?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["SalesReport"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/reports/tax": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    from?: string;
                    to?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["TaxReport"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/reports/attendance": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AttendanceReport"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/reports/promo": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PromoReport"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/reports/conversion": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            eventId: string;
                            widgetViews: number;
                            checkoutStarted: number;
                            checkoutCompleted: number;
                            conversionRate: number;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}/reports/affiliate": {
        get: {
            parameters: {
                path: {
                    organizationId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AffiliateReport"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/me": {
        get: {
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            id?: string;
                            tenantId?: string;
                            type?: string;
                            scopes?: Array<string>;
                            organizationIds?: Array<string>;
                            permissions?: Array<string>;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}": {
        patch: {
            parameters: {
                path: {
                    organizationId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name?: string;
                        slug?: string;
                        clerkOrganizationId?: string | null;
                        boxOfficeSettings?: components["schemas"]["BoxOfficeSettings"];
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Organization"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}/members": {
        get: {
            parameters: {
                path: {
                    organizationId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Array<{
                            id: string;
                            organizationId: string;
                            name: string;
                            email: string;
                            role: string;
                            status: string;
                            invitedAt: string;
                            joinedAt: string | null;
                            brandIds: Array<string>;
                            eventIds: Array<string>;
                        }>;
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}/members/invitations": {
        post: {
            parameters: {
                path: {
                    organizationId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        email: string;
                        role?: "admin" | "organizer" | "viewer" | "door_staff" | "door_staff_sales";
                        brandIds?: Array<string>;
                        eventIds?: Array<string>;
                        returnTo?: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": {
                            id: string;
                            organizationId: string;
                            name: string;
                            email: string;
                            role: string;
                            status: string;
                            invitedAt: string;
                            joinedAt: string | null;
                            brandIds: Array<string>;
                            eventIds: Array<string>;
                            invitationDelivery: "queued";
                            invitationProvider: string;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}/members/{memberId}": {
        patch: {
            parameters: {
                path: {
                    organizationId: string;
                    memberId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        role: "admin" | "organizer" | "viewer" | "door_staff" | "door_staff_sales";
                        brandIds?: Array<string>;
                        eventIds?: Array<string>;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            id: string;
                            organizationId: string;
                            name: string;
                            email: string;
                            role: string;
                            status: string;
                            invitedAt: string;
                            joinedAt: string | null;
                            brandIds: Array<string>;
                            eventIds: Array<string>;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}/payment-accounts": {
        get: {
            parameters: {
                path: {
                    organizationId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Array<components["schemas"]["PaymentAccount"]>;
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}/payment-accounts/stripe-connect": {
        post: {
            parameters: {
                path: {
                    organizationId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PaymentAccount"];
                    };
                };
                "201": {
                    content: {
                        "application/json": components["schemas"]["PaymentAccount"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}/payment-accounts/{paymentAccountId}/stripe-connect/refresh": {
        post: {
            parameters: {
                path: {
                    organizationId: string;
                    paymentAccountId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PaymentAccount"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/organizations/{organizationId}/billing": {
        get: {
            parameters: {
                path: {
                    organizationId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            organizationId: string;
                            plan: string;
                            status: string;
                            ticketsThisMonth: number;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/questions": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["QuestionPage"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        type: "text" | "textarea" | "email" | "phone" | "select" | "multiselect" | "checkbox" | "date" | "file" | "waiver";
                        label: string;
                        description?: string;
                        required?: boolean;
                        appliesTo?: "buyer" | "attendee" | "both";
                        ticketTypeId?: string;
                        options?: Array<string>;
                        placeholder?: string;
                        validationPattern?: string;
                        conditionalVisibility?: Record<string, unknown>;
                        sortOrder?: number;
                        isConsentField?: boolean;
                        consentText?: string;
                        consentVersion?: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["Question"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/questions/reorder": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["ReorderQuestionsRequest"];
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["QuestionPage"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/questions/{questionId}": {
        delete: {
            parameters: {
                path: {
                    questionId: string;
                };
            };
            responses: {
                "204": Record<string, never>;
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        patch: {
            parameters: {
                path: {
                    questionId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        type?: "text" | "textarea" | "email" | "phone" | "select" | "multiselect" | "checkbox" | "date" | "file" | "waiver";
                        label?: string;
                        description?: string;
                        required?: boolean;
                        appliesTo?: "buyer" | "attendee" | "both";
                        ticketTypeId?: string | null;
                        options?: Array<string>;
                        placeholder?: string;
                        validationPattern?: string;
                        conditionalVisibility?: Record<string, unknown> | null;
                        sortOrder?: number;
                        isConsentField?: boolean;
                        consentText?: string;
                        consentVersion?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Question"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/brands/{brandId}": {
        get: {
            parameters: {
                path: {
                    brandId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["Brand"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/questions": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicQuestionsResponse"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/exports": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        eventId?: string;
                        type: "attendees" | "orders" | "scan_logs" | "sales" | "tax" | "tickets";
                        format: "csv" | "xlsx" | "json";
                        filters?: Record<string, unknown>;
                    };
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["ExportJobQueued"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/exports/{exportId}": {
        get: {
            parameters: {
                path: {
                    exportId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ExportJob"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/exports/{exportId}/events": {
        get: {
            parameters: {
                path: {
                    exportId: string;
                };
                header?: {
                    "Last-Event-ID"?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "text/event-stream": string;
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/exports/{exportId}/download": {
        get: {
            parameters: {
                path: {
                    exportId: string;
                };
            };
            responses: {
                "302": Record<string, never>;
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/messages": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<{
                                id?: string;
                                eventId?: string;
                                tenantId?: string;
                                brandId?: string;
                                templateKey?: string;
                                emailTemplateKey?: string;
                                smsTemplateKey?: string;
                                channel?: "email" | "sms" | "both";
                                status?: string;
                                audience?: "all_attendees" | "checked_in" | "not_checked_in" | "custom";
                                audienceKey?: "all" | "checked_in" | "not_checked_in" | "specific";
                                audienceAttendeeIds?: Array<string>;
                                audienceLabel?: string;
                                audienceCount?: number;
                                queuedEmailJobs?: number;
                                queuedSmsJobs?: number;
                                suppressedRecipients?: number;
                                consentExclusions?: number;
                                skippedRecipients?: number;
                                createdAt?: string;
                                updatedAt?: string;
                            }>;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        emailTemplateKey: string;
                        audience: "all" | "checked_in" | "not_checked_in" | "specific";
                        attendeeIds?: Array<string>;
                        variables?: {
                            [key: string]: unknown;
                        };
                        scheduledAt?: string;
                        channel: "email";
                    } | {
                        smsTemplateKey: string;
                        audience: "all" | "checked_in" | "not_checked_in" | "specific";
                        attendeeIds?: Array<string>;
                        variables?: {
                            [key: string]: unknown;
                        };
                        scheduledAt?: string;
                        channel: "sms";
                    } | {
                        emailTemplateKey: string;
                        smsTemplateKey: string;
                        audience: "all" | "checked_in" | "not_checked_in" | "specific";
                        attendeeIds?: Array<string>;
                        variables?: {
                            [key: string]: unknown;
                        };
                        scheduledAt?: string;
                        channel: "both";
                    };
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["MessageQueued"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/audit-logs": {
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    direction?: "next" | "prev";
                    limit?: number;
                    search?: string;
                    sort?: string;
                    includeFacets?: boolean;
                    includeTotal?: boolean;
                    organizationId?: string;
                    brandId?: string;
                    action?: string;
                    resourceType?: string;
                    actorId?: string;
                    createdAtFrom?: string;
                    createdAtTo?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["AuditLogPage"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/privacy/requests": {
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    direction?: "next" | "prev";
                    limit?: number;
                    search?: string;
                    sort?: string;
                    includeFacets?: boolean;
                    includeTotal?: boolean;
                    organizationId?: string;
                    brandId?: string;
                    requestType?: "export" | "erasure";
                    status?: "pending" | "processing" | "completed" | "failed";
                    subjectType?: string;
                    createdAtFrom?: string;
                    createdAtTo?: string;
                    completedAtFrom?: string;
                    completedAtTo?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PrivacyRequestPage"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/privacy/requests/{requestId}": {
        get: {
            parameters: {
                path: {
                    requestId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PrivacyRequest"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/privacy/data-exports": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["PrivacyRequestInput"];
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["PrivacyRequest"];
                    };
                };
            };
        };
    };
    "/privacy/erasures": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": components["schemas"]["PrivacyRequestInput"];
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["PrivacyRequest"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/messages/preview": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        audience: "all" | "checked_in" | "not_checked_in" | "specific";
                        attendeeIds?: Array<string>;
                        channel: "email" | "sms" | "both";
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            audience: "all_attendees" | "checked_in" | "not_checked_in" | "custom";
                            audienceCount: number;
                            eligibleCount: number;
                            suppressedRecipients: number;
                            consentExclusions: number;
                            skippedRecipients: number;
                            recipients: Array<{
                                id: string;
                                name: string;
                                email?: string;
                                phone?: string;
                                status: string;
                            }>;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/content-documents": {
        get: {
            parameters: {
                query?: {
                    channel?: string;
                    brandId?: string;
                    eventId?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ContentDocumentPage"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        brandId: string;
                        eventId?: string;
                        channel: "event_page" | "email" | "sms" | "imessage" | "social_invite";
                        key: string;
                        name: string;
                        locale?: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["ContentDocument"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/content-documents/migrate-event-page-puck": {
        post: {
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            documentsScanned: number;
                            versionsChecked: number;
                            versionsMigrated: number;
                            migrated: Array<{
                                documentId?: string;
                                versionId?: string;
                                versionNumber?: number;
                            }>;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/content-documents/{documentId}": {
        get: {
            parameters: {
                path: {
                    documentId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ContentDocument"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        patch: {
            parameters: {
                path: {
                    documentId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ContentDocument"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/content-documents/{documentId}/duplicate": {
        post: {
            parameters: {
                path: {
                    documentId: string;
                };
            };
            requestBody?: {
                content: {
                    "application/json": {
                        key?: string;
                        name?: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": {
                            document: components["schemas"]["ContentDocument"];
                            versions: Array<components["schemas"]["ContentDocumentVersion"]>;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/content-documents/{documentId}/versions": {
        get: {
            parameters: {
                path: {
                    documentId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ContentDocumentVersionPage"];
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    documentId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        subject?: string;
                        previewText?: string;
                        contentJson?: components["schemas"]["EventPageDocumentV2"] | components["schemas"]["EmailTemplateDocument"] | components["schemas"]["SmsTemplateDocument"] | {
                            [key: string]: unknown;
                        };
                        renderedHtml?: string;
                        renderedText?: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["ContentDocumentVersion"];
                    };
                };
            };
        };
    };
    "/content-documents/{documentId}/preview": {
        post: {
            parameters: {
                path: {
                    documentId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        versionId?: string;
                        subject?: string;
                        renderedHtml?: string;
                        renderedText?: string;
                        contentJson?: components["schemas"]["EventPageDocumentV2"] | components["schemas"]["EmailTemplateDocument"] | components["schemas"]["SmsTemplateDocument"] | {
                            [key: string]: unknown;
                        };
                        context?: {
                            [key: string]: unknown;
                        };
                        optOutToken?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ContentPreview"];
                    };
                };
            };
        };
    };
    "/content-documents/{documentId}/versions/{versionId}/publish": {
        post: {
            parameters: {
                path: {
                    documentId: string;
                    versionId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            document: components["schemas"]["ContentDocument"];
                            version: components["schemas"]["ContentDocumentVersion"];
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/content-documents/{documentId}/archive": {
        post: {
            parameters: {
                path: {
                    documentId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["ContentDocument"];
                    };
                };
            };
        };
    };
    "/content-documents/{documentId}/test-sends": {
        post: {
            parameters: {
                path: {
                    documentId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        versionId: string;
                        recipient: string;
                        context?: {
                            [key: string]: unknown;
                        };
                        optOutToken?: string;
                    };
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": {
                            testSend: components["schemas"]["ContentTestSend"];
                            output: components["schemas"]["ContentRenderOutput"];
                            renderArtifact: components["schemas"]["ContentRenderArtifact"];
                        };
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/page": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    locale?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicContentPage"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/page-bootstrap": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    locale?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicEventPageBootstrap"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/content-page": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    locale?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicContentPage"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/by-slug/{slug}/page": {
        get: {
            parameters: {
                path: {
                    slug: string;
                };
                query: {
                    host: string;
                    locale?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicContentPage"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/by-slug/{slug}/page-bootstrap": {
        get: {
            parameters: {
                path: {
                    slug: string;
                };
                query: {
                    host: string;
                    locale?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicEventPageBootstrap"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/public/events/{eventId}/discovery-card": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                };
                query?: {
                    locale?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PublicEventDiscoveryCard"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/messages/render-preview": {
        post: {
            parameters: {
                path: {
                    eventId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        channel?: "email" | "sms";
                        subjectTemplate?: string;
                        htmlTemplate?: string;
                        textTemplate?: string;
                        context?: {
                            [key: string]: unknown;
                        };
                        optOutToken?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            channel: "email" | "sms";
                            subject: string;
                            html: string;
                            text?: string;
                            segments?: {
                                segments?: number;
                                encoding?: "gsm" | "unicode";
                                charsPerSegment?: number;
                                unitsUsed?: number;
                                remaining?: number;
                            };
                            validation: {
                                valid: boolean;
                                unknownTags: Array<string>;
                            };
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/messages/{campaignId}": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    campaignId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": Record<string, unknown>;
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/messages/{campaignId}/jobs": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    campaignId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["MessageJobEnvelope"]>;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/messages/{campaignId}/jobs/{channel}/{jobId}": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    campaignId: string;
                    channel: string;
                    jobId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MessageJobEnvelope"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/messages/{campaignId}/delivery-logs": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    campaignId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["MessageDeliveryLogEnvelope"]>;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/messages/{campaignId}/delivery-logs/{channel}/{deliveryId}": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    campaignId: string;
                    channel: string;
                    deliveryId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MessageDeliveryLogEnvelope"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/messages/{campaignId}/provider-events": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    campaignId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["MessageProviderEventEnvelope"]>;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/events/{eventId}/messages/{campaignId}/provider-events/{providerEventId}": {
        get: {
            parameters: {
                path: {
                    eventId: string;
                    campaignId: string;
                    providerEventId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MessageProviderEventEnvelope"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/oauth-applications": {
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["OAuthApplication"]>;
                            nextCursor: string | null;
                            hasMore: boolean;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        name: string;
                        redirectUris: Array<string>;
                        scopes: Array<string>;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["OAuthApplicationCreated"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/oauth-applications/{appId}": {
        delete: {
            parameters: {
                path: {
                    appId: string;
                };
            };
            responses: {
                "204": Record<string, never>;
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/oauth/authorize": {
        get: {
            parameters: {
                query: {
                    response_type: "code";
                    client_id: string;
                    redirect_uri: string;
                    scope?: string;
                    state?: string;
                };
            };
            responses: {
                "302": Record<string, never>;
            };
        };
    };
    "/oauth/token": {
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        grant_type: "authorization_code" | "refresh_token" | "client_credentials";
                        client_id?: string;
                        client_secret?: string;
                        code?: string;
                        redirect_uri?: string;
                        refresh_token?: string;
                    };
                    "application/x-www-form-urlencoded": {
                        grant_type: "authorization_code" | "refresh_token" | "client_credentials";
                        client_id?: string;
                        client_secret?: string;
                        code?: string;
                        redirect_uri?: string;
                        refresh_token?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["OAuthTokenResponse"];
                    };
                    headers: {
                        "Cache-Control": "no-store";
                    };
                };
            };
        };
    };
    "/oauth/revoke": {
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        client_id: string;
                        client_secret: string;
                        token: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            revoked: boolean;
                        };
                    };
                };
            };
        };
    };
    "/migration-adapters": {
        get: {
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["MigrationAdapterCatalogEntry"]>;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-credentials": {
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        sourceSystem: string;
                        secretReference: string;
                        expiresAt: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": {
                            id: string;
                            organizationId: string;
                            sourceSystem: string;
                            status: string;
                            expiresAt: string;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-credentials/{credentialId}": {
        delete: {
            parameters: {
                path: {
                    credentialId: string;
                };
                query: {
                    organizationId: string;
                };
            };
            responses: {
                "204": Record<string, never>;
            };
        };
    };
    "/portable-export-authorizations": {
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        expiresAt: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": {
                            authorizationId: string;
                            tenantId: string;
                            organizationId: string;
                            grantedByPrincipalId: string;
                            grantedAt: string;
                            expiresAt: string;
                            scope: "tenant-historical-portability";
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/portable-export-authorizations/{authorizationId}/revoke": {
        post: {
            parameters: {
                path: {
                    authorizationId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                    };
                };
            };
            responses: {
                "204": Record<string, never>;
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/portable-delta-exports": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        parentExportJobId: string;
                        cutoverFreeze?: {
                            frozenAt: string;
                            receiptSha256: string;
                        };
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/vnd.tixkit.portable+json": string;
                    };
                    headers: {
                        "X-Tixkit-Portable-Job-Id": string;
                        "Content-Disposition": string;
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/portable-exports": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        mode?: "configuration";
                    } | {
                        organizationId: string;
                        mode: "historical";
                        authorizationId: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/vnd.tixkit.portable+json": string;
                    };
                    headers: {
                        "X-Tixkit-Portable-Job-Id": string;
                        "Content-Disposition": string;
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/portable-migration-jobs": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        sourceSystem: "tixkit-portable";
                        adapterVersion: "tixkit-portable-bundle-v2" | "tixkit-portable-bundle-v1";
                        mode?: "dry-run";
                        configuration: {
                            sourceMode: "official-export";
                            sourceSystem: "tixkit-portable";
                            artifactIds: Array<string>;
                        };
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["MigrationJob"];
                    };
                };
            };
        };
    };
    "/migration-jobs": {
        get: {
            parameters: {
                query?: {
                    organizationId?: string;
                    limit?: number;
                    offset?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["MigrationJob"]>;
                        };
                    };
                };
            };
        };
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": ({
                        organizationId: string;
                        sourceSystem: string;
                        adapterVersion: string;
                        mode?: "dry-run" | "commit";
                        configuration: components["schemas"]["MigrationPreparationConfiguration"];
                        credentialId?: string;
                    }) & ({
                        sourceSystem?: "generic-csv";
                        configuration?: {
                            sourceMode: "official-export";
                            sourceSystem: "generic-csv";
                        };
                        credentialId?: never;
                    } | {
                        sourceSystem?: "pretix";
                        configuration?: {
                            sourceMode: "official-export";
                            sourceSystem: "pretix";
                        };
                        credentialId?: never;
                    } | {
                        sourceSystem?: "hi-events";
                        configuration?: {
                            sourceMode: "official-export";
                            sourceSystem: "hi-events";
                        };
                        credentialId?: never;
                    } | {
                        sourceSystem?: "eventbrite";
                        configuration?: {
                            sourceMode: "official-export";
                            sourceSystem: "eventbrite";
                        };
                        credentialId?: never;
                    } | {
                        sourceSystem?: "ticket-tailor";
                        configuration?: {
                            sourceMode: "official-export";
                            sourceSystem: "ticket-tailor";
                        };
                        credentialId?: never;
                    } | {
                        sourceSystem?: "pretix";
                        configuration?: {
                            sourceMode: "official-api";
                            sourceSystem: "pretix";
                        };
                        credentialId: unknown;
                    } | {
                        sourceSystem?: "hi-events";
                        configuration?: {
                            sourceMode: "official-api";
                            sourceSystem: "hi-events";
                        };
                        credentialId: unknown;
                    } | {
                        sourceSystem?: "eventbrite";
                        configuration?: {
                            sourceMode: "official-api";
                            sourceSystem: "eventbrite";
                        };
                        credentialId: unknown;
                    } | {
                        sourceSystem?: "ticket-tailor";
                        configuration?: {
                            sourceMode: "official-api";
                            sourceSystem: "ticket-tailor";
                        };
                        credentialId: unknown;
                    });
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["MigrationJob"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-mappings": {
        get: {
            parameters: {
                query: {
                    organizationId: string;
                    sourceSystem?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["MigrationMapping"]>;
                        };
                    };
                };
            };
        };
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        sourceSystem: string;
                        name: string;
                        entityType: string;
                        mapping: {
                            [key: string]: string | Array<string>;
                        };
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["MigrationMapping"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MigrationJob"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/files": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["MigrationFile"]>;
                        };
                    };
                };
            };
        };
        post: {
            parameters: {
                path: {
                    jobId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        uploadArtifactId: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["MigrationFile"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/rows": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
                query?: {
                    limit?: number;
                    entityType?: string;
                    status?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["MigrationRow"]>;
                        };
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/conflicts": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
                query?: {
                    limit?: number;
                    offset?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["MigrationConflict"]>;
                        };
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/events": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
                query?: {
                    afterSequence?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<components["schemas"]["MigrationEvent"]>;
                        };
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/dry-run": {
        post: {
            parameters: {
                path: {
                    jobId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MigrationDryRunResult"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/prepare": {
        post: {
            parameters: {
                path: {
                    jobId: string;
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["MigrationStarted"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/report": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MigrationReport"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/report/download": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MigrationReport"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/portable-rebindings": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PortableImportRebindingStatus"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/portable-rebindings/{portableId}": {
        put: {
            parameters: {
                path: {
                    jobId: string;
                    portableId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        destinationReference: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PortableImportRebinding"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/portable-approval": {
        post: {
            parameters: {
                path: {
                    jobId: string;
                };
                header: {
                    "Idempotency-Key": string;
                    "x-tixkit-confirmation": string;
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["PortableImportApproval"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/portable-approvals/{approvalId}/revoke": {
        post: {
            parameters: {
                path: {
                    jobId: string;
                    approvalId: string;
                };
                header: {
                    "x-tixkit-confirmation": string;
                };
            };
            requestBody?: {
                content: {
                    "application/json": {
                        reason?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PortableImportApprovalRevocation"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/activate": {
        post: {
            parameters: {
                path: {
                    jobId: string;
                };
                header: {
                    "x-tixkit-confirmation": string;
                };
            };
            requestBody?: {
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["PortableImportActivated"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/commit": {
        post: {
            parameters: {
                path: {
                    jobId: string;
                };
                header: {
                    "x-tixkit-confirmation": string;
                };
            };
            requestBody?: {
                content: {
                    "application/json": {
                        cutoverProof: components["schemas"]["PortableCutoverProof"];
                    };
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["MigrationStarted"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/pause": {
        post: {
            parameters: {
                path: {
                    jobId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["MigrationActionAccepted"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/resume": {
        post: {
            parameters: {
                path: {
                    jobId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["MigrationActionAccepted"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/cancel": {
        post: {
            parameters: {
                path: {
                    jobId: string;
                };
                header: {
                    "Idempotency-Key": string;
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["MigrationActionAccepted"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/rollback-assessment": {
        get: {
            parameters: {
                path: {
                    jobId: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["MigrationRollbackAssessment"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/migration-jobs/{jobId}/rollback": {
        post: {
            parameters: {
                path: {
                    jobId: string;
                };
                header: {
                    "Idempotency-Key": string;
                    "x-tixkit-confirmation": string;
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["MigrationActionAccepted"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/webhook-endpoints": {
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                    organizationId?: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["WebhookEndpointPage"];
                    };
                };
            };
        };
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        url: string;
                        events: Array<components["schemas"]["WebhookEventType"]>;
                        description?: string;
                    };
                };
            };
            responses: {
                "201": {
                    content: {
                        "application/json": components["schemas"]["WebhookEndpointCreated"];
                    };
                    headers: {
                        "Cache-Control": "private, no-store";
                        Pragma: "no-cache";
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/webhook-endpoints/{endpointId}": {
        patch: {
            parameters: {
                path: {
                    endpointId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        url?: string;
                        events?: Array<components["schemas"]["WebhookEventType"]>;
                        status?: "active" | "disabled";
                        description?: string | null;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": components["schemas"]["WebhookEndpoint"];
                    };
                };
            };
        };
    };
    "/webhook-endpoints/{endpointId}/test": {
        post: {
            parameters: {
                path: {
                    endpointId: string;
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": {
                            queued: true;
                            test: true;
                            eventId: string;
                            endpointId: string;
                        };
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "429": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": {
                            queued: false;
                            test: true;
                            eventId: string;
                            endpointId: string;
                            error: {
                                code: "TEMPORAL_UNAVAILABLE";
                                message: string;
                            };
                        };
                    };
                };
            };
        };
    };
    "/webhook-endpoints/{endpointId}/events": {
        get: {
            parameters: {
                path: {
                    endpointId: string;
                };
                query?: {
                    cursor?: string;
                    limit?: number;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            items: Array<{
                                id?: string;
                                eventId?: string;
                                deliveryId?: string;
                                endpointId?: string | null;
                                requestedEndpointId?: string;
                                deliveryKey?: string;
                                eventType?: string;
                                status?: string;
                                statusCode?: number;
                                attemptCount?: number;
                                deliveredAt?: string | null;
                                createdAt?: string;
                            }>;
                            nextCursor: string | null;
                            hasMore: boolean;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/webhook-endpoints/{endpointId}/events/{eventId}/replay": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
                path: {
                    endpointId: string;
                    eventId: string;
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["WebhookEndpointReplayQueued"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["WebhookEndpointReplayUnavailable"];
                    };
                };
            };
        };
    };
    "/webhook-events/{eventId}/replay": {
        post: {
            parameters: {
                header: {
                    "Idempotency-Key": string;
                };
                path: {
                    eventId: string;
                };
            };
            responses: {
                "202": {
                    content: {
                        "application/json": components["schemas"]["WebhookReplayQueued"];
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "409": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["WebhookReplayUnavailable"];
                    };
                };
            };
        };
    };
    "/webhooks/stripe": {
        post: {
            responses: {
                "200": Record<string, never>;
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/webhooks/clerk": {
        post: {
            responses: {
                "200": Record<string, never>;
            };
        };
    };
    "/webhooks/telnyx/sms": {
        post: {
            responses: {
                "200": Record<string, never>;
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/webhooks/email/{provider}": {
        post: {
            parameters: {
                path: {
                    provider: string;
                };
            };
            responses: {
                "200": Record<string, never>;
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "503": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/short-links": {
        get: {
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            links: Array<{
                                id: string;
                                slug: string;
                                destinationUrl: string;
                                clicks: number;
                                createdAt?: string;
                            }>;
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
        post: {
            requestBody: {
                content: {
                    "application/json": {
                        destinationUrl: string;
                        slug?: string;
                        brandId?: string;
                        utmParams?: {
                            [key: string]: string;
                        };
                        expiresAt?: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            id: string;
                            slug: string;
                            destinationUrl: string;
                            utmParams?: {
                                [key: string]: string;
                            };
                            clicks: number;
                            createdAt?: string;
                        };
                    };
                };
                "400": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/short-links/{id}/clicks": {
        get: {
            parameters: {
                path: {
                    id: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            id: string;
                            totalClicks: number;
                            byDay: {
                                [key: string]: number;
                            };
                        };
                    };
                };
                "401": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "403": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
    "/provider-incidents/{evidenceId}/reveal": {
        post: {
            parameters: {
                path: {
                    evidenceId: string;
                };
            };
            requestBody: {
                content: {
                    "application/json": {
                        organizationId: string;
                        reason: string;
                    };
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            requestId: string;
                        };
                    };
                    headers: {
                        "Cache-Control": "no-store";
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "404": Record<string, never>;
                "429": Record<string, never>;
                "503": Record<string, never>;
            };
        };
    };
    "/provider-incidents": {
        get: {
            parameters: {
                query: {
                    organizationId: string;
                    correlationSha256: string;
                };
            };
            responses: {
                "200": {
                    content: {
                        "application/json": {
                            evidence: Array<{
                                evidenceId: string;
                                provider: string;
                                operation: string;
                                correlationSha256: string;
                                capturedAt: string;
                                expiresAt: string;
                            }>;
                        };
                    };
                    headers: {
                        "Cache-Control": "no-store";
                    };
                };
                "400": Record<string, never>;
                "401": Record<string, never>;
                "403": Record<string, never>;
                "429": Record<string, never>;
                "503": Record<string, never>;
            };
        };
    };
    "/s/{slug}": {
        get: {
            parameters: {
                path: {
                    slug: string;
                };
            };
            responses: {
                "302": Record<string, never>;
                "404": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
                "410": {
                    content: {
                        "application/json": components["schemas"]["ApiError"];
                    };
                };
            };
        };
    };
}

export type operations = {
    getHealth: {
        responses: {
            "200": Record<string, never>;
        };
    };
    getBootstrapContext: {
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["BootstrapContext"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getOrganizations: {
        responses: {
            "200": {
                content: {
                    "application/json": Array<components["schemas"]["Organization"]>;
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postOrganizations: {
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    slug: string;
                    clerkOrganizationId?: string;
                    boxOfficeSettings?: components["schemas"]["BoxOfficeSettings"];
                    eventDefaults?: components["schemas"]["EventDefaults"];
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["Organization"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getBrands: {
        responses: {
            "200": {
                content: {
                    "application/json": Array<components["schemas"]["Brand"]>;
                };
            };
        };
    };
    postBrands: {
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    name: string;
                    slug: string;
                    theme?: Record<string, unknown>;
                    whiteLabel?: boolean;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["Brand"];
                };
            };
        };
    };
    patchBrandsByBrandId: {
        parameters: {
            path: {
                brandId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    slug?: string;
                    status?: "draft" | "active" | "suspended";
                    theme?: Record<string, unknown>;
                    supportUrl?: string;
                    legalUrls?: Record<string, unknown>;
                    whiteLabel?: boolean;
                    paymentAccountId?: string | null;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Brand"];
                };
            };
        };
    };
    postBrandsByBrandIdDomains: {
        parameters: {
            path: {
                brandId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    domain: string;
                    isPrimary?: boolean;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["BrandDomain"];
                };
            };
        };
    };
    getBrandsByBrandIdEmailSenderIdentities: {
        parameters: {
            path: {
                brandId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": Array<components["schemas"]["BrandSenderIdentity"]>;
                };
            };
        };
    };
    listSavedVenues: {
        parameters: {
            query: {
                organizationId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": Array<components["schemas"]["SavedVenue"]>;
                };
            };
        };
    };
    createSavedVenue: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    name: string;
                    address: Record<string, unknown>;
                    timezone?: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["SavedVenue"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    deleteSavedVenue: {
        parameters: {
            path: {
                venueId: string;
            };
        };
        responses: {
            "204": Record<string, never>;
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    updateSavedVenue: {
        parameters: {
            path: {
                venueId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    address?: Record<string, unknown>;
                    timezone?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["SavedVenue"];
                };
            };
        };
    };
    reportOnboardingEvent: {
        requestBody: {
            content: {
                "application/json": {
                    stage: "onboarding_started" | "starting_point_selected" | "preset_creation" | "recovery" | "autosave_failure" | "stale_version_conflict";
                    outcome: "started" | "blank" | "free" | "paid" | "donation" | "multiple" | "duplicate" | "attempted" | "completed" | "failed";
                    reasonCode?: "none" | "request_failed" | "stale_event_version";
                };
            };
        };
        responses: {
            "204": Record<string, never>;
        };
    };
    getEvents: {
        parameters: {
            query?: {
                cursor?: string;
                direction?: "next" | "prev";
                limit?: number;
                search?: string;
                sort?: string;
                includeFacets?: boolean;
                includeTotal?: boolean;
                organizationId?: string;
                brandId?: string;
                status?: string;
                title?: string;
                startsAtFrom?: string;
                startsAtTo?: string;
                createdAtFrom?: string;
                createdAtTo?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["EventPage"];
                };
            };
        };
    };
    postEvents: {
        parameters: {
            header?: {
                "Idempotency-Key"?: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    brandId: string;
                    slug: string;
                    title: string;
                    description?: string;
                    currency: string;
                    timezone: string;
                    startsAt: string;
                    endsAt?: string;
                    venue?: Record<string, unknown>;
                    venueId?: string | null;
                    visibility?: "public" | "unlisted" | "private";
                    seo?: {
                        title?: string;
                        description?: string;
                    };
                    capacity?: number;
                    minimumAge?: number | null;
                    externalUrl?: string;
                    startingPoint?: "blank" | "free" | "paid" | "donation" | "multiple";
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["Event"];
                };
            };
        };
    };
    getEventsByEventId: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Event"];
                };
            };
        };
    };
    patchEventsByEventId: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    title?: string;
                    description?: string;
                    currency?: string;
                    timezone?: string;
                    startsAt?: string;
                    endsAt?: string | null;
                    venue?: Record<string, unknown> | null;
                    visibility?: "public" | "unlisted" | "private";
                    seo?: {
                        title?: string;
                        description?: string;
                        imageUrl?: string;
                    };
                    capacity?: number | null;
                    minimumAge?: number | null;
                    coverImageUrl?: string | null;
                    externalUrl?: string | null;
                    coverImageAlt?: string | null;
                    seoUseCoverImage?: boolean;
                    lastSetupSection?: string | null;
                    expectedVersion: number;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Event"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["StaleEventVersionError"];
                };
            };
        };
    };
    postEventsByEventIdDuplicate: {
        parameters: {
            path: {
                eventId: string;
            };
            header?: {
                "Idempotency-Key"?: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DuplicateEventRequest"];
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["Event"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postEventsByEventIdPublish: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Event"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["LaunchReadinessFailedError"] | components["schemas"]["StaleEventVersionError"] | components["schemas"]["EventArchivedError"];
                };
            };
        };
    };
    getOrganizationsByOrganizationIdReadiness: {
        parameters: {
            path: {
                organizationId: string;
            };
            query: {
                brandId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["WorkspaceReadiness"];
                };
            };
        };
    };
    getOrganizationsByOrganizationIdDashboardActions: {
        parameters: {
            path: {
                organizationId: string;
            };
            query: {
                brandId: string;
                limit?: number;
                cursor?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["DashboardActionFeed"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdLaunchReadiness: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["EventLaunchReadiness"];
                };
            };
        };
    };
    getEventsByEventIdOperationalHealth: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        eventId: string;
                        organizationFailedWebhookDeliveries: number;
                        failedExports: number;
                        checkedAt: string;
                    };
                };
            };
        };
    };
    putEventsByEventIdSetupSection: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    section: "basics" | "schedule" | "sales" | "media" | "marketing-fields";
                };
            };
        };
        responses: {
            "200": Record<string, never>;
        };
    };
    postEventsByEventIdReadinessAcknowledgementsByStepId: {
        parameters: {
            path: {
                eventId: string;
                stepId: string;
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["ReadinessAcknowledgement"];
                };
            };
        };
    };
    deleteEventsByEventIdReadinessAcknowledgementsByStepId: {
        parameters: {
            path: {
                eventId: string;
                stepId: string;
            };
        };
        responses: {
            "204": Record<string, never>;
        };
    };
    postEventsByEventIdPause: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Event"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postEventsByEventIdArchive: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Event"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdTicketTypes: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["TicketTypePage"];
                };
            };
        };
    };
    postEventsByEventIdTicketTypes: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    description?: string;
                    kind: "free" | "paid" | "donation";
                    visibility?: "public" | "hidden" | "locked";
                    currency: string;
                    priceCents: number;
                    minimumPriceCents?: number;
                    salesStartAt?: string;
                    salesEndAt?: string;
                    minPerOrder?: number;
                    maxPerOrder?: number;
                    inventoryPoolId: string;
                    requiresAccessCode?: boolean;
                    accessCodeHint?: string;
                    eventOccurrenceId?: string | null;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["TicketType"];
                };
            };
        };
    };
    postEventsByEventIdTicketTypesBatch: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateTicketTypeBatch"];
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["TicketTypeBatchResult"];
                };
            };
        };
    };
    getEventsByEventIdCodeFormat: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        eventId: string;
                        codeFormat: {
                            symbology: "qr" | "code128" | "pdf417" | "aztec" | "data_matrix";
                            payloadFormat: "signed_v1" | "compact_v2";
                            rotating?: {
                                timeStepSeconds: number;
                                toleranceWindows: number;
                                digits?: number;
                            };
                        };
                        scannerContractVersion: string;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    putEventsByEventIdCodeFormat: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    symbology?: "qr" | "code128" | "pdf417" | "aztec" | "data_matrix";
                    payloadFormat?: "signed_v1" | "compact_v2";
                    rotating?: {
                        timeStepSeconds: number;
                        toleranceWindows: number;
                        digits?: number;
                    };
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        eventId: string;
                        codeFormat: {
                            [key: string]: unknown;
                        };
                        scannerContractVersion: string;
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdOccurrences: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["EventOccurrencePage"];
                };
            };
        };
    };
    postEventsByEventIdOccurrences: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    title: string;
                    startsAt: string;
                    endsAt: string;
                    timezone: string;
                    venue?: Record<string, unknown>;
                    capacity?: number | null;
                    sortOrder?: number;
                    status?: "scheduled" | "cancelled" | "completed";
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["EventOccurrence"];
                };
            };
        };
    };
    patchEventsByEventIdOccurrencesByOccurrenceId: {
        parameters: {
            path: {
                eventId: string;
                occurrenceId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EventOccurrence"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["EventOccurrence"];
                };
            };
        };
    };
    getEventsByEventIdMarketingIntegrations: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MarketingIntegrationPage"];
                };
            };
        };
    };
    putEventsByEventIdMarketingIntegrationsByProvider: {
        parameters: {
            path: {
                eventId: string;
                provider: "ga4" | "meta_pixel" | "generic_tag";
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    config: components["schemas"]["Ga4MarketingIntegrationConfig"] | components["schemas"]["MetaPixelMarketingIntegrationConfig"] | components["schemas"]["GenericTagMarketingIntegrationConfig"];
                    consentRequired?: boolean;
                    status?: "active" | "disabled";
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MarketingIntegration"];
                };
            };
        };
    };
    getEventsByEventIdWaitlist: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["WaitlistEntryPage"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postEventsByEventIdWaitlistByEntryIdOffer: {
        parameters: {
            path: {
                eventId: string;
                entryId: string;
            };
        };
        requestBody?: {
            content: {
                "application/json": {
                    expiresInMinutes?: number;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["WaitlistOffer"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    patchEventsByEventIdWaitlistSettings: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["WaitlistSettings"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["WaitlistSettings"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    patchTicketTypesByTicketTypeId: {
        parameters: {
            path: {
                ticketTypeId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    description?: string;
                    kind?: "free" | "paid" | "donation";
                    status?: "draft" | "active" | "paused" | "sold_out" | "ended";
                    visibility?: "public" | "hidden" | "locked";
                    currency?: string;
                    priceCents?: number;
                    minimumPriceCents?: number | null;
                    salesStartAt?: string | null;
                    salesEndAt?: string | null;
                    minPerOrder?: number;
                    maxPerOrder?: number;
                    inventoryPoolId?: string;
                    requiresAccessCode?: boolean;
                    accessCodeHint?: string | null;
                    sortOrder?: number;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["TicketType"];
                };
            };
        };
    };
    patchTicketTypesByTicketTypeIdBatch: {
        parameters: {
            path: {
                ticketTypeId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateTicketTypeBatch"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["TicketTypeBatchResult"];
                };
            };
        };
    };
    getTicketTypesByTicketTypeIdAccessRules: {
        parameters: {
            path: {
                ticketTypeId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AccessRulePage"];
                };
            };
        };
    };
    postTicketTypesByTicketTypeIdAccessRules: {
        parameters: {
            path: {
                ticketTypeId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    type: "code" | "email_domain";
                    value: string;
                    maxUses?: number | null;
                    expiresAt?: string | null;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["AccessRule"];
                };
            };
        };
    };
    deleteAccessRulesByAccessRuleId: {
        parameters: {
            path: {
                accessRuleId: string;
            };
        };
        responses: {
            "204": Record<string, never>;
        };
    };
    getEventsByEventIdInventoryPools: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["InventoryPool"]>;
                        nextCursor?: string | null;
                        hasMore?: boolean;
                    };
                };
            };
        };
    };
    postEventsByEventIdInventoryPools: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    totalCapacity: number;
                    holdTtlSeconds?: number;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["InventoryPool"];
                };
            };
        };
    };
    getEventsByEventIdProductCategories: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ProductCategoryPage"];
                };
            };
        };
    };
    postEventsByEventIdProductCategories: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    sortOrder?: number;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["ProductCategory"];
                };
            };
        };
    };
    getEventsByEventIdProducts: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ProductPage"];
                };
            };
        };
    };
    postEventsByEventIdProducts: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    description?: string;
                    priceCents: number;
                    currency: string;
                    categoryId?: string;
                    maxPerOrder?: number;
                    availableFrom?: string;
                    availableUntil?: string;
                    status?: "active" | "inactive";
                    sortOrder?: number;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["Product"];
                };
            };
        };
    };
    patchProductsByProductId: {
        parameters: {
            path: {
                productId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    description?: string | null;
                    priceCents?: number;
                    currency?: string;
                    categoryId?: string | null;
                    maxPerOrder?: number;
                    availableFrom?: string | null;
                    availableUntil?: string | null;
                    status?: "active" | "inactive";
                    sortOrder?: number;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Product"];
                };
            };
        };
    };
    getEventsByEventIdAvailability: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AvailabilityPage"];
                };
            };
        };
    };
    getPublicEventsByEventId: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicEvent"];
                };
            };
        };
    };
    getPublicEventsByEventIdRevision: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicEventRevision"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicEventsBySlugBySlug: {
        parameters: {
            path: {
                slug: string;
            };
            query: {
                host: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicEvent"];
                };
            };
            "404": Record<string, never>;
        };
    };
    getPublicEventsByEventIdAvailability: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                products?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": Array<components["schemas"]["PublicAvailabilityItem"]>;
                };
            };
        };
    };
    getPublicEventsByEventIdBootstrap: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                products?: string;
                resaleListingId?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicCheckoutBootstrap"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicEventsByEventIdResaleListings: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicTicketListingPage"];
                };
            };
        };
    };
    getPublicEventsByEventIdOccurrences: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["EventOccurrencePage"];
                };
            };
        };
    };
    getPublicEventsByEventIdMarketingIntegrations: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MarketingIntegrationPage"];
                };
            };
        };
    };
    postPublicEventsByEventIdAccessCode: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    ticketTypeIds: Array<string>;
                    accessCode?: string;
                    buyerEmail?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        valid: boolean;
                        ticketTypeIds: Array<string>;
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postPublicEventsByEventIdWaitlist: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["JoinWaitlistRequest"];
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["WaitlistEntry"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicWaitlistClaimsByToken: {
        parameters: {
            path: {
                token: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["WaitlistEntry"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postPublicEventsByEventIdUploadArtifacts: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PublicCreateUploadArtifact"];
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["UploadArtifactTicket"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postPublicEventsByEventIdWidgetImpressions: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    visitorId?: string;
                    instanceId?: string;
                    trackingId?: string;
                    affiliateCode?: string;
                    host?: string;
                    pageUrl?: string;
                    referrer?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        tracked: boolean;
                        deduped: boolean;
                    };
                };
            };
            "201": {
                content: {
                    "application/json": {
                        tracked: boolean;
                        deduped: boolean;
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    submitRumWebVital: {
        requestBody: {
            content: {
                "application/json": {
                    schemaVersion: "tixkit-rum-v1";
                    surface: "checkout" | "event-page";
                    metric: "LCP";
                    value: number;
                } | {
                    schemaVersion: "tixkit-rum-v1";
                    surface: "checkout" | "event-page";
                    metric: "INP";
                    value: number;
                } | {
                    schemaVersion: "tixkit-rum-v1";
                    surface: "checkout" | "event-page";
                    metric: "CLS";
                    value: number;
                };
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": {
                        accepted: true;
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "413": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "429": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postPublicUploadArtifactsByArtifactIdComplete: {
        parameters: {
            path: {
                artifactId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PublicCompleteUploadArtifact"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["UploadArtifactCompleteResult"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicContentEmailImagesByArtifactId: {
        parameters: {
            path: {
                artifactId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/octet-stream": string;
                };
                headers: {
                    "Content-Type": string;
                    "Content-Disposition": string;
                    "Cache-Control": string;
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicContentEventPageImagesByArtifactId: {
        parameters: {
            path: {
                artifactId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/octet-stream": string;
                };
                headers: {
                    "Content-Type": string;
                    "Content-Disposition": string;
                    "Cache-Control": string;
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicBrandLogosByArtifactId: {
        parameters: {
            path: {
                artifactId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/octet-stream": string;
                };
                headers: {
                    "Content-Type": string;
                    "Content-Disposition": string;
                    "Cache-Control": string;
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdMedia: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": Array<components["schemas"]["EventMediaAsset"]>;
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdMediaRenditionsByRenditionId: {
        parameters: {
            path: {
                eventId: string;
                renditionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "image/webp": string;
                };
                headers: {
                    ETag: string;
                    "Cache-Control": string;
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    putEventsByEventIdMediaByRole: {
        parameters: {
            path: {
                eventId: string;
                role: "poster" | "cover" | "social";
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AttachEventMedia"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["EventMediaAsset"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    deleteEventsByEventIdMediaByRole: {
        parameters: {
            path: {
                eventId: string;
                role: "poster" | "cover" | "social";
            };
        };
        responses: {
            "204": Record<string, never>;
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicEventMediaRenditionsByRenditionId: {
        parameters: {
            path: {
                renditionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "image/webp": string;
                };
                headers: {
                    "Cache-Control": string;
                    ETag: string;
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postEventsByEventIdBoxOfficeOrders: {
        parameters: {
            path: {
                eventId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["BoxOfficeOrderInput"];
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["BoxOfficeOrderResult"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postCheckoutSessions: {
        parameters: {
            header: {
                "Idempotency-Key": string;
                "X-Tixkit-Test-Order"?: "1";
            };
        };
        requestBody: {
            content: {
                "application/json": ({
                    eventId: string;
                    items: Array<({
                        ticketTypeId?: string;
                        occurrenceId?: string;
                        productId?: string;
                        resaleListingId?: string;
                        quantity?: number;
                        unitAmountCents?: number;
                        attendeeFields?: Array<{
                            dateOfBirth?: string;
                            [key: string]: unknown;
                        }>;
                    }) & ({
                        ticketTypeId: unknown;
                        quantity: unknown;
                        productId?: never;
                        resaleListingId?: never;
                    } | {
                        productId: unknown;
                        quantity: unknown;
                        ticketTypeId?: never;
                        resaleListingId?: never;
                    } | {
                        quantity: 1;
                        resaleListingId: unknown;
                        ticketTypeId?: never;
                        productId?: never;
                        occurrenceId?: never;
                        unitAmountCents?: never;
                        attendeeFields?: never;
                    })>;
                    discountCode?: string;
                    affiliateCode?: string;
                    trackingId?: string;
                    accessCode?: string;
                    waitlistClaimToken?: string;
                    buyer: {
                        email: string;
                        firstName?: string;
                        lastName?: string;
                        phone?: string;
                        dateOfBirth?: string;
                    };
                    buyerFields?: {
                        [key: string]: unknown;
                    };
                    resaleTermsAcceptance?: components["schemas"]["ResaleTermsAcceptance"];
                    successUrl?: string;
                    cancelUrl?: string;
                }) & (unknown & unknown);
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["CheckoutSession"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "410": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postUploadArtifacts: {
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateUploadArtifact"];
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["UploadArtifactTicket"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postUploadArtifactsByArtifactIdComplete: {
        parameters: {
            path: {
                artifactId: string;
            };
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["CompleteUploadArtifact"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["UploadArtifactCompleteResult"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getUploadArtifactsByArtifactIdDownload: {
        parameters: {
            path: {
                artifactId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["UploadArtifactDownload"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getCheckoutSessionsBySessionId: {
        parameters: {
            path: {
                sessionId: string;
            };
            header?: {
                "X-Checkout-Session-Token"?: string;
            };
            query?: {
                payment_intent_client_secret?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["CheckoutSession"];
                };
            };
        };
    };
    patchCheckoutSessionsBySessionId: {
        parameters: {
            path: {
                sessionId: string;
            };
            header: {
                "X-Checkout-Session-Token": string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CheckoutSessionUpdateInput"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["CheckoutSession"];
                };
            };
        };
    };
    postCheckoutSessionsBySessionIdHandoff: {
        parameters: {
            path: {
                sessionId: string;
            };
            header: {
                "X-Checkout-Session-Token": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["CheckoutHostedHandoff"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postCheckoutSessionsBySessionIdHandoffExchange: {
        parameters: {
            path: {
                sessionId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    handoff: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["CheckoutSession"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getCheckoutSessionsBySessionIdWalletPasses: {
        parameters: {
            path: {
                sessionId: string;
            };
            header: {
                "X-Checkout-Session-Token": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["CheckoutWalletPasses"];
                };
            };
        };
    };
    postCheckoutSessionsBySessionIdTicketsByTicketIdResaleListing: {
        parameters: {
            path: {
                sessionId: string;
                ticketId: string;
            };
            header: {
                "X-Checkout-Session-Token": string;
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    priceCents: number;
                    expiresAt?: string;
                    termsAcceptance: components["schemas"]["ResaleTermsAcceptance"];
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["TicketListing"];
                };
            };
        };
    };
    getWalletPassesByPassIdApplePkpass: {
        parameters: {
            path: {
                passId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/vnd.apple.pkpass": string;
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postCheckoutSessionsBySessionIdConfirm: {
        parameters: {
            path: {
                sessionId: string;
            };
            header: {
                "Idempotency-Key": string;
                "X-Checkout-Session-Token": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    paymentMethodId?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["CheckoutConfirmCompleted"] | components["schemas"]["CheckoutConfirmPending"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "402": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "410": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getOrders: {
        parameters: {
            query?: {
                cursor?: string;
                direction?: "next" | "prev";
                limit?: number;
                search?: string;
                sort?: string;
                includeFacets?: boolean;
                includeTotal?: boolean;
                organizationId?: string;
                eventId?: string;
                status?: string;
                salesChannel?: string;
                paymentProvider?: string;
                refundState?: boolean;
                totalCentsMin?: number;
                totalCentsMax?: number;
                createdAtFrom?: string;
                createdAtTo?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["OrderPage"];
                };
            };
        };
    };
    getPaymentCompensations: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                status?: "pending" | "succeeded" | "failed" | "manual_review" | "already_ordered";
                checkoutSessionId?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PaymentCompensationPage"];
                };
            };
        };
    };
    getOrdersByOrderId: {
        parameters: {
            path: {
                orderId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["OrderDetail"];
                };
            };
        };
    };
    getOrdersByOrderIdInvoice: {
        parameters: {
            path: {
                orderId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["InvoiceDocument"];
                };
            };
        };
    };
    getOrdersByOrderIdInvoiceDownload: {
        parameters: {
            path: {
                orderId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["InvoiceDocument"];
                };
            };
        };
    };
    postOrdersByOrderIdCancel: {
        parameters: {
            path: {
                orderId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Order"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postOrdersByOrderIdRefunds: {
        parameters: {
            path: {
                orderId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody?: {
            content: {
                "application/json": {
                    amountCents?: number;
                    reason: string;
                    voidTickets?: boolean;
                    restoreInventory?: boolean;
                };
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["RefundQueued"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdAttendees: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                cursor?: string;
                direction?: "next" | "prev";
                limit?: number;
                search?: string;
                sort?: string;
                includeFacets?: boolean;
                includeTotal?: boolean;
                checkInListId?: string;
                eventOccurrenceId?: string;
                status?: string;
                checkInStatus?: string;
                createdAtFrom?: string;
                createdAtTo?: string;
                checkedInAtFrom?: string;
                checkedInAtTo?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AttendeePage"];
                };
            };
        };
    };
    getAttendees: {
        parameters: {
            query?: {
                cursor?: string;
                direction?: "next" | "prev";
                limit?: number;
                search?: string;
                sort?: string;
                includeFacets?: boolean;
                includeTotal?: boolean;
                organizationId?: string;
                brandId?: string;
                eventId?: string;
                status?: string;
                checkInStatus?: string;
                createdAtFrom?: string;
                createdAtTo?: string;
                checkedInAtFrom?: string;
                checkedInAtTo?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AttendeePage"];
                };
            };
        };
    };
    patchAttendeesByAttendeeId: {
        parameters: {
            path: {
                attendeeId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AttendeeUpdateInput"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Attendee"];
                };
            };
        };
    };
    postTicketsByTicketIdTransfer: {
        parameters: {
            path: {
                ticketId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    toEmail: string;
                    dateOfBirth?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Ticket"];
                };
            };
        };
    };
    getEventsByEventIdFeePolicy: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["EventFeePolicy"];
                };
            };
        };
    };
    putEventsByEventIdFeePolicy: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateEventFeePolicyInput"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["EventFeePolicy"];
                };
            };
        };
    };
    getEventsByEventIdResalePolicy: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ResalePolicy"];
                };
            };
        };
    };
    putEventsByEventIdResalePolicy: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResalePolicy"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ResalePolicy"];
                };
            };
        };
    };
    getEventsByEventIdResaleListings: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["TicketListingPage"];
                };
            };
        };
    };
    postTicketsByTicketIdResaleListings: {
        parameters: {
            path: {
                ticketId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    priceCents: number;
                    expiresAt?: string;
                    termsAcceptance: components["schemas"]["ResaleTermsAcceptance"];
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["TicketListing"];
                };
            };
        };
    };
    postTicketListingsByListingIdDelist: {
        parameters: {
            path: {
                listingId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["TicketListing"];
                };
            };
        };
    };
    postTicketListingsByListingIdComplete: {
        parameters: {
            path: {
                listingId: string;
            };
        };
        responses: {
            "410": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
                headers: {
                    Deprecation: "@1784160000";
                    Link: "</v1/checkout/sessions>; rel=\"successor-version\"";
                };
            };
        };
    };
    getTicketListingsByListingIdSettlement: {
        parameters: {
            path: {
                listingId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ResaleSettlement"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postTicketListingsByListingIdSettlementPayouts: {
        parameters: {
            path: {
                listingId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    amountCents: number;
                    currency: string;
                    expectedVersion: number;
                    method: "bank_transfer" | "payment_provider" | "accounting_adjustment";
                    externalReference: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ResaleSettlement"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postTicketListingsByListingIdSettlementReversals: {
        parameters: {
            path: {
                listingId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    amountCents: number;
                    currency: string;
                    expectedVersion: number;
                    method: "bank_transfer" | "payment_provider" | "accounting_adjustment";
                    reason: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ResaleSettlement"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdCheckInLists: {
        parameters: {
            path: {
                eventId: string;
            };
            header?: {
                "X-Device-Secret"?: string;
            };
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["CheckInListPage"];
                };
            };
        };
    };
    postEventsByEventIdCheckInLists: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    ticketTypeIds?: Array<string>;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["CheckInList"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdCheckInListsByCheckInListIdManifest: {
        parameters: {
            path: {
                eventId: string;
                checkInListId: string;
            };
            query?: {
                version?: 1 | 2;
            };
            header?: {
                "X-Device-Secret"?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["OfflineManifest"];
                };
            };
            "400": Record<string, never>;
        };
    };
    getEventsByEventIdCheckInManifestKeys: {
        parameters: {
            path: {
                eventId: string;
            };
            header?: {
                "X-Device-Secret"?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["OfflineManifestVerificationKeySet"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    getEventsByEventIdCheckInListsByCheckInListIdActivity: {
        parameters: {
            path: {
                eventId: string;
                checkInListId: string;
            };
            query?: {
                since?: string;
                afterId?: string;
                limit?: number;
            };
            header?: {
                "X-Device-Secret"?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<{
                            id: string;
                            checkInListId: string;
                            ticketId: string | null;
                            deviceId: string;
                            outcome: string;
                            scannedAt: string;
                            offline: boolean;
                            attendeeName: string | null;
                            attendeeEmail: string | null;
                            ticketTypeId: string | null;
                        }>;
                        summary: {
                            checkedIn: number;
                            remaining: number;
                            total: number;
                            acceptedScans: number;
                        };
                        nextCursor?: string;
                    };
                };
            };
        };
    };
    getEventsByEventIdCheckInListsByCheckInListIdActivityStream: {
        parameters: {
            path: {
                eventId: string;
                checkInListId: string;
            };
            header?: {
                "Last-Event-ID"?: string;
                "X-Device-Secret"?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "text/event-stream": string;
                };
            };
        };
    };
    postCheckInsScan: {
        parameters: {
            header: {
                "X-Device-Secret"?: string;
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    checkInListId: string;
                    qrPayload: string;
                    scannedAt: string;
                    offline?: boolean;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ScanResult"];
                };
            };
            "400": Record<string, never>;
        };
    };
    postCheckInsSync: {
        parameters: {
            header: {
                "X-Device-Secret": string;
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    checkInListId: string;
                    scans: Array<{
                        qrHash: string;
                        scannedAt: string;
                        offline: boolean;
                    }>;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["SyncScanResult"];
                };
            };
        };
    };
    postCheckInsBulkSyncJobs: {
        parameters: {
            header: {
                "X-Device-Secret": string;
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    checkInListId: string;
                    deviceId?: string;
                    totalChunks: number;
                    totalScans?: number;
                };
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["BulkSyncJob"];
                };
            };
        };
    };
    putCheckInsBulkSyncJobsByJobIdChunksBySequence: {
        parameters: {
            path: {
                jobId: string;
                sequence: number;
            };
            header: {
                "X-Device-Secret": string;
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    scans: Array<{
                        qrHash: string;
                        scannedAt: string;
                        offline: boolean;
                    }>;
                };
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["BulkSyncChunk"];
                };
            };
        };
    };
    getCheckInsBulkSyncJobsByJobId: {
        parameters: {
            path: {
                jobId: string;
            };
            header: {
                "X-Device-Secret": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["BulkSyncJob"];
                };
            };
        };
    };
    getCheckInsBulkSyncJobsByJobIdChunks: {
        parameters: {
            path: {
                jobId: string;
            };
            header: {
                "X-Device-Secret": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["BulkSyncChunkList"];
                };
            };
        };
    };
    getApiKeys: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ApiKeyPage"];
                };
            };
        };
    };
    postApiKeys: {
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    name: string;
                    scopes: Array<string>;
                    brandIds?: Array<string>;
                    eventIds?: Array<string>;
                    expiresAt?: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["ApiKeyCreated"];
                };
            };
        };
    };
    deleteApiKeysByKeyId: {
        parameters: {
            path: {
                keyId: string;
            };
        };
        responses: {
            "204": Record<string, never>;
        };
    };
    postAgentPrincipals: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    id: string;
                    kind: "third_party" | "self_hosted";
                    capabilities: Array<"events.read" | "events.prepare" | "events.execute" | "readiness.read" | "content.prepare">;
                    maximumAutonomy: "read" | "recommend" | "prepare" | "execute_with_approval";
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["AgentPrincipal"] | components["schemas"]["AgentPrincipal20260802"] | components["schemas"]["AgentPrincipal20260803"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentPrincipalsById: {
        parameters: {
            path: {
                id: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentPrincipal"] | components["schemas"]["AgentPrincipal20260802"] | components["schemas"]["AgentPrincipal20260803"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentPrincipalsByIdRevoke: {
        parameters: {
            path: {
                id: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        id: string;
                        state: "revoked";
                    };
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentPrincipalsByIdOauthClients: {
        parameters: {
            path: {
                id: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    name: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentOAuthClient"];
                };
            };
            "201": {
                content: {
                    "application/json": components["schemas"]["AgentOAuthClientCreated"];
                };
                headers: {
                    "Cache-Control": "no-store";
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentPrincipalsByIdOauthClientsByClientIdRevoke: {
        parameters: {
            path: {
                id: string;
                clientId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        id: string;
                        status: "revoked";
                    };
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentPlans: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    definition: components["schemas"]["AgentPlanDefinition"];
                    actionBindings: Array<{
                        stepId: components["schemas"]["AgentPlanProtocol_id"];
                        actionId: components["schemas"]["AgentPlanProtocol_id"];
                    }>;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["PersistedAgentPlan"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentPlansByPlanId: {
        parameters: {
            path: {
                planId: components["schemas"]["AgentPlanProtocol_id"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PersistedAgentPlan"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentPlansByPlanIdTransitions: {
        parameters: {
            path: {
                planId: components["schemas"]["AgentPlanProtocol_id"];
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    expectedStateVersion: number;
                    status: "prepared" | "awaiting_approval" | "executing" | "succeeded" | "failed" | "cancelled" | "expired" | "compensated";
                    stepStates: Array<components["schemas"]["AgentPlanProtocol_stepState"]>;
                    reasonCode: components["schemas"]["AgentPlanProtocol_reasonCode"];
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PersistedAgentPlan"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentActions: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    kind: "event.publish";
                    delegationGrantId: string;
                    resourceId: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentAction"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentReadiness: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    delegationGrantId: string;
                    resourceId: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentReadinessReadAction"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentReadinessByActionId: {
        parameters: {
            path: {
                actionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentReadinessReadAction"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentEvents: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    delegationGrantId: string;
                    resourceId: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentEventReadAction"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentEventsByActionId: {
        parameters: {
            path: {
                actionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentEventReadAction"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentReports: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    delegationGrantId: string;
                    resourceId: string;
                    from?: string;
                    to?: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentReportReadAction"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentReportsByActionId: {
        parameters: {
            path: {
                actionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentReportReadAction"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentEventPreparations: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    delegationGrantId: string;
                    resourceId: string;
                    changes: components["schemas"]["AgentEventPrepareChanges"];
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentEventPrepareAction"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentEventPreparationsByActionId: {
        parameters: {
            path: {
                actionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentEventPrepareAction"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentContentPreparations: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    delegationGrantId: string;
                    resourceId: string;
                    content: components["schemas"]["AgentSafeEventPageContent"];
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentContentPrepareAction"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentContentPreparationsByActionId: {
        parameters: {
            path: {
                actionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentContentPrepareAction"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentCampaignPreparations: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": ({
                    delegationGrantId: string;
                    resourceId: string;
                    audience: "all" | "checked_in" | "not_checked_in" | "specific";
                    attendeeIds?: Array<string>;
                    channel: "email" | "sms" | "both";
                    emailTemplateKey?: string;
                    smsTemplateKey?: string;
                }) & (unknown & unknown & unknown);
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentCampaignPrepareAction"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentCampaignPreparationsByActionId: {
        parameters: {
            path: {
                actionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentCampaignPrepareAction"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentEventUpdates: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    delegationGrantId: string;
                    resourceId: string;
                    changes: components["schemas"]["AgentEventPrepareChanges"];
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentEventUpdateAction"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentEventUpdatesByActionId: {
        parameters: {
            path: {
                actionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentEventUpdateAction"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentEventUpdatesByActionIdApprovals: {
        parameters: {
            path: {
                actionId: string;
            };
            header: {
                "Idempotency-Key": string;
                "X-Tixkit-Confirmation": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    actionDigest: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["AgentEventUpdateApproval"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentEventUpdatesByActionIdApprovalsByApprovalIdRevoke: {
        parameters: {
            path: {
                actionId: string;
                approvalId: string;
            };
            header: {
                "Idempotency-Key": string;
                "X-Tixkit-Confirmation": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    actionDigest: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentEventUpdateApproval"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentEventUpdatesByActionIdExecutions: {
        parameters: {
            path: {
                actionId: string;
            };
            header: {
                "Idempotency-Key": string;
                "X-Tixkit-Confirmation": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    approvalId: string;
                    actionDigest: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentEventUpdateExecution"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentEventUpdatesByActionIdExecutionsByExecutionId: {
        parameters: {
            path: {
                actionId: string;
                executionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentEventUpdateExecutionEvidence"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    getAgentActionsByActionId: {
        parameters: {
            path: {
                actionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PreparedAgentAction"];
                };
            };
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentActionsByActionIdApprovals: {
        parameters: {
            path: {
                actionId: string;
            };
            header: {
                "Idempotency-Key": string;
                "X-Tixkit-Confirmation": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    actionDigest: string;
                    planSha256?: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["AgentApproval"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentActionsByActionIdApprovalsByApprovalIdRevoke: {
        parameters: {
            path: {
                actionId: string;
                approvalId: string;
            };
            header: {
                "Idempotency-Key": string;
                "X-Tixkit-Confirmation": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    actionDigest: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentApproval"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentActionsByActionIdExecutions: {
        parameters: {
            path: {
                actionId: string;
            };
            header: {
                "Idempotency-Key": string;
                "X-Tixkit-Confirmation": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    approvalId: string;
                    actionDigest: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentExecution"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getAgentActionsByActionIdExecutionsByExecutionId: {
        parameters: {
            path: {
                actionId: string;
                executionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentExecutionEvidence"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    getAgentSession: {
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentSession"] | components["schemas"]["AgentSession20260802"] | components["schemas"]["AgentSession20260803"];
                };
            };
            "401": Record<string, never>;
            "404": Record<string, never>;
        };
    };
    postAgentDelegations: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    id: string;
                    agentPrincipalId: string;
                    capabilities: Array<"events.read" | "events.prepare" | "events.execute" | "readiness.read" | "content.prepare">;
                    resourceScopes: Array<string>;
                    expiresAt: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["AgentDelegation"] | components["schemas"]["AgentDelegation20260802"] | components["schemas"]["AgentDelegation20260803"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentDelegationsByIdRevoke: {
        parameters: {
            path: {
                id: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        id: string;
                        revoked: true;
                    };
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentMemory: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentMemoryCreateRequest"];
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["AgentMemoryEntry"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentMemoryInspect: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentMemoryNamespaceRequestBody"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        entries: Array<components["schemas"]["AgentMemoryEntry"]>;
                    };
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentMemoryExport: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentMemoryNamespaceRequestBody"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentMemoryExportBundle"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    patchAgentMemoryById: {
        parameters: {
            path: {
                id: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentMemoryCorrectRequest"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AgentMemoryEntry"];
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    postAgentMemoryByIdDelete: {
        parameters: {
            path: {
                id: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AgentMemoryDeleteRequest"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        id: string;
                        deleted: true;
                    };
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "409": Record<string, never>;
        };
    };
    getScannerDevices: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ScannerDevicePage"];
                };
            };
        };
    };
    postScannerDevices: {
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    name: string;
                    eventIds?: Array<string>;
                    scopes?: Array<"checkins.read" | "checkins.write">;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["ScannerDeviceCreated"];
                };
            };
        };
    };
    postScannerDevicesByDeviceIdRevoke: {
        parameters: {
            path: {
                deviceId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ScannerDeviceRevoked"];
                };
            };
        };
    };
    getEventsByEventIdReportsSales: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                from?: string;
                to?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["SalesReport"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdReportsTax: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                from?: string;
                to?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["TaxReport"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdReportsAttendance: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AttendanceReport"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdReportsPromo: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PromoReport"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdReportsConversion: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        eventId: string;
                        widgetViews: number;
                        checkoutStarted: number;
                        checkoutCompleted: number;
                        conversionRate: number;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getOrganizationsByOrganizationIdReportsAffiliate: {
        parameters: {
            path: {
                organizationId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AffiliateReport"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getMe: {
        responses: {
            "200": {
                content: {
                    "application/json": {
                        id?: string;
                        tenantId?: string;
                        type?: string;
                        scopes?: Array<string>;
                        organizationIds?: Array<string>;
                        permissions?: Array<string>;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    patchOrganizationsByOrganizationId: {
        parameters: {
            path: {
                organizationId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    slug?: string;
                    clerkOrganizationId?: string | null;
                    boxOfficeSettings?: components["schemas"]["BoxOfficeSettings"];
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Organization"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getOrganizationsByOrganizationIdMembers: {
        parameters: {
            path: {
                organizationId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": Array<{
                        id: string;
                        organizationId: string;
                        name: string;
                        email: string;
                        role: string;
                        status: string;
                        invitedAt: string;
                        joinedAt: string | null;
                        brandIds: Array<string>;
                        eventIds: Array<string>;
                    }>;
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postOrganizationsByOrganizationIdMembersInvitations: {
        parameters: {
            path: {
                organizationId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    email: string;
                    role?: "admin" | "organizer" | "viewer" | "door_staff" | "door_staff_sales";
                    brandIds?: Array<string>;
                    eventIds?: Array<string>;
                    returnTo?: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": {
                        id: string;
                        organizationId: string;
                        name: string;
                        email: string;
                        role: string;
                        status: string;
                        invitedAt: string;
                        joinedAt: string | null;
                        brandIds: Array<string>;
                        eventIds: Array<string>;
                        invitationDelivery: "queued";
                        invitationProvider: string;
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    patchOrganizationsByOrganizationIdMembersByMemberId: {
        parameters: {
            path: {
                organizationId: string;
                memberId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    role: "admin" | "organizer" | "viewer" | "door_staff" | "door_staff_sales";
                    brandIds?: Array<string>;
                    eventIds?: Array<string>;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        id: string;
                        organizationId: string;
                        name: string;
                        email: string;
                        role: string;
                        status: string;
                        invitedAt: string;
                        joinedAt: string | null;
                        brandIds: Array<string>;
                        eventIds: Array<string>;
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getOrganizationsByOrganizationIdPaymentAccounts: {
        parameters: {
            path: {
                organizationId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": Array<components["schemas"]["PaymentAccount"]>;
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postOrganizationsByOrganizationIdPaymentAccountsStripeConnect: {
        parameters: {
            path: {
                organizationId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PaymentAccount"];
                };
            };
            "201": {
                content: {
                    "application/json": components["schemas"]["PaymentAccount"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postOrganizationsByOrganizationIdPaymentAccountsByPaymentAccountIdStripeConnectRefresh: {
        parameters: {
            path: {
                organizationId: string;
                paymentAccountId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PaymentAccount"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getOrganizationsByOrganizationIdBilling: {
        parameters: {
            path: {
                organizationId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        organizationId: string;
                        plan: string;
                        status: string;
                        ticketsThisMonth: number;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdQuestions: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["QuestionPage"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postEventsByEventIdQuestions: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    type: "text" | "textarea" | "email" | "phone" | "select" | "multiselect" | "checkbox" | "date" | "file" | "waiver";
                    label: string;
                    description?: string;
                    required?: boolean;
                    appliesTo?: "buyer" | "attendee" | "both";
                    ticketTypeId?: string;
                    options?: Array<string>;
                    placeholder?: string;
                    validationPattern?: string;
                    conditionalVisibility?: Record<string, unknown>;
                    sortOrder?: number;
                    isConsentField?: boolean;
                    consentText?: string;
                    consentVersion?: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["Question"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postEventsByEventIdQuestionsReorder: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ReorderQuestionsRequest"];
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["QuestionPage"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    deleteQuestionsByQuestionId: {
        parameters: {
            path: {
                questionId: string;
            };
        };
        responses: {
            "204": Record<string, never>;
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    patchQuestionsByQuestionId: {
        parameters: {
            path: {
                questionId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    type?: "text" | "textarea" | "email" | "phone" | "select" | "multiselect" | "checkbox" | "date" | "file" | "waiver";
                    label?: string;
                    description?: string;
                    required?: boolean;
                    appliesTo?: "buyer" | "attendee" | "both";
                    ticketTypeId?: string | null;
                    options?: Array<string>;
                    placeholder?: string;
                    validationPattern?: string;
                    conditionalVisibility?: Record<string, unknown> | null;
                    sortOrder?: number;
                    isConsentField?: boolean;
                    consentText?: string;
                    consentVersion?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Question"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicBrandsByBrandId: {
        parameters: {
            path: {
                brandId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["Brand"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicEventsByEventIdQuestions: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicQuestionsResponse"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postExports: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    eventId?: string;
                    type: "attendees" | "orders" | "scan_logs" | "sales" | "tax" | "tickets";
                    format: "csv" | "xlsx" | "json";
                    filters?: Record<string, unknown>;
                };
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["ExportJobQueued"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getExportsByExportId: {
        parameters: {
            path: {
                exportId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ExportJob"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getExportsByExportIdEvents: {
        parameters: {
            path: {
                exportId: string;
            };
            header?: {
                "Last-Event-ID"?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "text/event-stream": string;
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getExportsByExportIdDownload: {
        parameters: {
            path: {
                exportId: string;
            };
        };
        responses: {
            "302": Record<string, never>;
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdMessages: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<{
                            id?: string;
                            eventId?: string;
                            tenantId?: string;
                            brandId?: string;
                            templateKey?: string;
                            emailTemplateKey?: string;
                            smsTemplateKey?: string;
                            channel?: "email" | "sms" | "both";
                            status?: string;
                            audience?: "all_attendees" | "checked_in" | "not_checked_in" | "custom";
                            audienceKey?: "all" | "checked_in" | "not_checked_in" | "specific";
                            audienceAttendeeIds?: Array<string>;
                            audienceLabel?: string;
                            audienceCount?: number;
                            queuedEmailJobs?: number;
                            queuedSmsJobs?: number;
                            suppressedRecipients?: number;
                            consentExclusions?: number;
                            skippedRecipients?: number;
                            createdAt?: string;
                            updatedAt?: string;
                        }>;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postEventsByEventIdMessages: {
        parameters: {
            path: {
                eventId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    emailTemplateKey: string;
                    audience: "all" | "checked_in" | "not_checked_in" | "specific";
                    attendeeIds?: Array<string>;
                    variables?: {
                        [key: string]: unknown;
                    };
                    scheduledAt?: string;
                    channel: "email";
                } | {
                    smsTemplateKey: string;
                    audience: "all" | "checked_in" | "not_checked_in" | "specific";
                    attendeeIds?: Array<string>;
                    variables?: {
                        [key: string]: unknown;
                    };
                    scheduledAt?: string;
                    channel: "sms";
                } | {
                    emailTemplateKey: string;
                    smsTemplateKey: string;
                    audience: "all" | "checked_in" | "not_checked_in" | "specific";
                    attendeeIds?: Array<string>;
                    variables?: {
                        [key: string]: unknown;
                    };
                    scheduledAt?: string;
                    channel: "both";
                };
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["MessageQueued"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getAuditLogs: {
        parameters: {
            query?: {
                cursor?: string;
                direction?: "next" | "prev";
                limit?: number;
                search?: string;
                sort?: string;
                includeFacets?: boolean;
                includeTotal?: boolean;
                organizationId?: string;
                brandId?: string;
                action?: string;
                resourceType?: string;
                actorId?: string;
                createdAtFrom?: string;
                createdAtTo?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["AuditLogPage"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPrivacyRequests: {
        parameters: {
            query?: {
                cursor?: string;
                direction?: "next" | "prev";
                limit?: number;
                search?: string;
                sort?: string;
                includeFacets?: boolean;
                includeTotal?: boolean;
                organizationId?: string;
                brandId?: string;
                requestType?: "export" | "erasure";
                status?: "pending" | "processing" | "completed" | "failed";
                subjectType?: string;
                createdAtFrom?: string;
                createdAtTo?: string;
                completedAtFrom?: string;
                completedAtTo?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PrivacyRequestPage"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPrivacyRequestsByRequestId: {
        parameters: {
            path: {
                requestId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PrivacyRequest"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postPrivacyDataExports: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PrivacyRequestInput"];
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["PrivacyRequest"];
                };
            };
        };
    };
    postPrivacyErasures: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PrivacyRequestInput"];
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["PrivacyRequest"];
                };
            };
        };
    };
    postEventsByEventIdMessagesPreview: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    audience: "all" | "checked_in" | "not_checked_in" | "specific";
                    attendeeIds?: Array<string>;
                    channel: "email" | "sms" | "both";
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        audience: "all_attendees" | "checked_in" | "not_checked_in" | "custom";
                        audienceCount: number;
                        eligibleCount: number;
                        suppressedRecipients: number;
                        consentExclusions: number;
                        skippedRecipients: number;
                        recipients: Array<{
                            id: string;
                            name: string;
                            email?: string;
                            phone?: string;
                            status: string;
                        }>;
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getContentDocuments: {
        parameters: {
            query?: {
                channel?: string;
                brandId?: string;
                eventId?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ContentDocumentPage"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postContentDocuments: {
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    brandId: string;
                    eventId?: string;
                    channel: "event_page" | "email" | "sms" | "imessage" | "social_invite";
                    key: string;
                    name: string;
                    locale?: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["ContentDocument"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postContentDocumentsMigrateEventPagePuck: {
        responses: {
            "200": {
                content: {
                    "application/json": {
                        documentsScanned: number;
                        versionsChecked: number;
                        versionsMigrated: number;
                        migrated: Array<{
                            documentId?: string;
                            versionId?: string;
                            versionNumber?: number;
                        }>;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getContentDocumentsByDocumentId: {
        parameters: {
            path: {
                documentId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ContentDocument"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    patchContentDocumentsByDocumentId: {
        parameters: {
            path: {
                documentId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ContentDocument"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postContentDocumentsByDocumentIdDuplicate: {
        parameters: {
            path: {
                documentId: string;
            };
        };
        requestBody?: {
            content: {
                "application/json": {
                    key?: string;
                    name?: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": {
                        document: components["schemas"]["ContentDocument"];
                        versions: Array<components["schemas"]["ContentDocumentVersion"]>;
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getContentDocumentsByDocumentIdVersions: {
        parameters: {
            path: {
                documentId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ContentDocumentVersionPage"];
                };
            };
        };
    };
    postContentDocumentsByDocumentIdVersions: {
        parameters: {
            path: {
                documentId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    subject?: string;
                    previewText?: string;
                    contentJson?: components["schemas"]["EventPageDocumentV2"] | components["schemas"]["EmailTemplateDocument"] | components["schemas"]["SmsTemplateDocument"] | {
                        [key: string]: unknown;
                    };
                    renderedHtml?: string;
                    renderedText?: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["ContentDocumentVersion"];
                };
            };
        };
    };
    postContentDocumentsByDocumentIdPreview: {
        parameters: {
            path: {
                documentId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    versionId?: string;
                    subject?: string;
                    renderedHtml?: string;
                    renderedText?: string;
                    contentJson?: components["schemas"]["EventPageDocumentV2"] | components["schemas"]["EmailTemplateDocument"] | components["schemas"]["SmsTemplateDocument"] | {
                        [key: string]: unknown;
                    };
                    context?: {
                        [key: string]: unknown;
                    };
                    optOutToken?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ContentPreview"];
                };
            };
        };
    };
    postContentDocumentsByDocumentIdVersionsByVersionIdPublish: {
        parameters: {
            path: {
                documentId: string;
                versionId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        document: components["schemas"]["ContentDocument"];
                        version: components["schemas"]["ContentDocumentVersion"];
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postContentDocumentsByDocumentIdArchive: {
        parameters: {
            path: {
                documentId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["ContentDocument"];
                };
            };
        };
    };
    postContentDocumentsByDocumentIdTestSends: {
        parameters: {
            path: {
                documentId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    versionId: string;
                    recipient: string;
                    context?: {
                        [key: string]: unknown;
                    };
                    optOutToken?: string;
                };
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": {
                        testSend: components["schemas"]["ContentTestSend"];
                        output: components["schemas"]["ContentRenderOutput"];
                        renderArtifact: components["schemas"]["ContentRenderArtifact"];
                    };
                };
            };
        };
    };
    getPublicEventsByEventIdPage: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                locale?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicContentPage"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicEventsByEventIdPageBootstrap: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                locale?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicEventPageBootstrap"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicEventsByEventIdContentPage: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                locale?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicContentPage"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicEventsBySlugBySlugPage: {
        parameters: {
            path: {
                slug: string;
            };
            query: {
                host: string;
                locale?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicContentPage"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicEventsBySlugBySlugPageBootstrap: {
        parameters: {
            path: {
                slug: string;
            };
            query: {
                host: string;
                locale?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicEventPageBootstrap"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getPublicEventsByEventIdDiscoveryCard: {
        parameters: {
            path: {
                eventId: string;
            };
            query?: {
                locale?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PublicEventDiscoveryCard"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postEventsByEventIdMessagesRenderPreview: {
        parameters: {
            path: {
                eventId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    channel?: "email" | "sms";
                    subjectTemplate?: string;
                    htmlTemplate?: string;
                    textTemplate?: string;
                    context?: {
                        [key: string]: unknown;
                    };
                    optOutToken?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        channel: "email" | "sms";
                        subject: string;
                        html: string;
                        text?: string;
                        segments?: {
                            segments?: number;
                            encoding?: "gsm" | "unicode";
                            charsPerSegment?: number;
                            unitsUsed?: number;
                            remaining?: number;
                        };
                        validation: {
                            valid: boolean;
                            unknownTags: Array<string>;
                        };
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdMessagesByCampaignId: {
        parameters: {
            path: {
                eventId: string;
                campaignId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": Record<string, unknown>;
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdMessagesByCampaignIdJobs: {
        parameters: {
            path: {
                eventId: string;
                campaignId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["MessageJobEnvelope"]>;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdMessagesByCampaignIdJobsByChannelByJobId: {
        parameters: {
            path: {
                eventId: string;
                campaignId: string;
                channel: string;
                jobId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MessageJobEnvelope"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdMessagesByCampaignIdDeliveryLogs: {
        parameters: {
            path: {
                eventId: string;
                campaignId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["MessageDeliveryLogEnvelope"]>;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdMessagesByCampaignIdDeliveryLogsByChannelByDeliveryId: {
        parameters: {
            path: {
                eventId: string;
                campaignId: string;
                channel: string;
                deliveryId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MessageDeliveryLogEnvelope"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdMessagesByCampaignIdProviderEvents: {
        parameters: {
            path: {
                eventId: string;
                campaignId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["MessageProviderEventEnvelope"]>;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getEventsByEventIdMessagesByCampaignIdProviderEventsByProviderEventId: {
        parameters: {
            path: {
                eventId: string;
                campaignId: string;
                providerEventId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MessageProviderEventEnvelope"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getOauthApplications: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["OAuthApplication"]>;
                        nextCursor: string | null;
                        hasMore: boolean;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postOauthApplications: {
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    name: string;
                    redirectUris: Array<string>;
                    scopes: Array<string>;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["OAuthApplicationCreated"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    deleteOauthApplicationsByAppId: {
        parameters: {
            path: {
                appId: string;
            };
        };
        responses: {
            "204": Record<string, never>;
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getOauthAuthorize: {
        parameters: {
            query: {
                response_type: "code";
                client_id: string;
                redirect_uri: string;
                scope?: string;
                state?: string;
            };
        };
        responses: {
            "302": Record<string, never>;
        };
    };
    postOauthToken: {
        requestBody: {
            content: {
                "application/json": {
                    grant_type: "authorization_code" | "refresh_token" | "client_credentials";
                    client_id?: string;
                    client_secret?: string;
                    code?: string;
                    redirect_uri?: string;
                    refresh_token?: string;
                };
                "application/x-www-form-urlencoded": {
                    grant_type: "authorization_code" | "refresh_token" | "client_credentials";
                    client_id?: string;
                    client_secret?: string;
                    code?: string;
                    redirect_uri?: string;
                    refresh_token?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["OAuthTokenResponse"];
                };
                headers: {
                    "Cache-Control": "no-store";
                };
            };
        };
    };
    postOauthRevoke: {
        requestBody: {
            content: {
                "application/json": {
                    client_id: string;
                    client_secret: string;
                    token: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        revoked: boolean;
                    };
                };
            };
        };
    };
    listMigrationAdapters: {
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["MigrationAdapterCatalogEntry"]>;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createMigrationCredential: {
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    sourceSystem: string;
                    secretReference: string;
                    expiresAt: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": {
                        id: string;
                        organizationId: string;
                        sourceSystem: string;
                        status: string;
                        expiresAt: string;
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    revokeMigrationCredential: {
        parameters: {
            path: {
                credentialId: string;
            };
            query: {
                organizationId: string;
            };
        };
        responses: {
            "204": Record<string, never>;
        };
    };
    grantPortableHistoricalExportAuthorization: {
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    expiresAt: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": {
                        authorizationId: string;
                        tenantId: string;
                        organizationId: string;
                        grantedByPrincipalId: string;
                        grantedAt: string;
                        expiresAt: string;
                        scope: "tenant-historical-portability";
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    revokePortableHistoricalExportAuthorization: {
        parameters: {
            path: {
                authorizationId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                };
            };
        };
        responses: {
            "204": Record<string, never>;
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createPortableDeltaExport: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    parentExportJobId: string;
                    cutoverFreeze?: {
                        frozenAt: string;
                        receiptSha256: string;
                    };
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/vnd.tixkit.portable+json": string;
                };
                headers: {
                    "X-Tixkit-Portable-Job-Id": string;
                    "Content-Disposition": string;
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createPortableExport: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    mode?: "configuration";
                } | {
                    organizationId: string;
                    mode: "historical";
                    authorizationId: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/vnd.tixkit.portable+json": string;
                };
                headers: {
                    "X-Tixkit-Portable-Job-Id": string;
                    "Content-Disposition": string;
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    createPortableMigrationJob: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    sourceSystem: "tixkit-portable";
                    adapterVersion: "tixkit-portable-bundle-v2" | "tixkit-portable-bundle-v1";
                    mode?: "dry-run";
                    configuration: {
                        sourceMode: "official-export";
                        sourceSystem: "tixkit-portable";
                        artifactIds: Array<string>;
                    };
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["MigrationJob"];
                };
            };
        };
    };
    listMigrationJobs: {
        parameters: {
            query?: {
                organizationId?: string;
                limit?: number;
                offset?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["MigrationJob"]>;
                    };
                };
            };
        };
    };
    createMigrationJob: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": ({
                    organizationId: string;
                    sourceSystem: string;
                    adapterVersion: string;
                    mode?: "dry-run" | "commit";
                    configuration: components["schemas"]["MigrationPreparationConfiguration"];
                    credentialId?: string;
                }) & ({
                    sourceSystem?: "generic-csv";
                    configuration?: {
                        sourceMode: "official-export";
                        sourceSystem: "generic-csv";
                    };
                    credentialId?: never;
                } | {
                    sourceSystem?: "pretix";
                    configuration?: {
                        sourceMode: "official-export";
                        sourceSystem: "pretix";
                    };
                    credentialId?: never;
                } | {
                    sourceSystem?: "hi-events";
                    configuration?: {
                        sourceMode: "official-export";
                        sourceSystem: "hi-events";
                    };
                    credentialId?: never;
                } | {
                    sourceSystem?: "eventbrite";
                    configuration?: {
                        sourceMode: "official-export";
                        sourceSystem: "eventbrite";
                    };
                    credentialId?: never;
                } | {
                    sourceSystem?: "ticket-tailor";
                    configuration?: {
                        sourceMode: "official-export";
                        sourceSystem: "ticket-tailor";
                    };
                    credentialId?: never;
                } | {
                    sourceSystem?: "pretix";
                    configuration?: {
                        sourceMode: "official-api";
                        sourceSystem: "pretix";
                    };
                    credentialId: unknown;
                } | {
                    sourceSystem?: "hi-events";
                    configuration?: {
                        sourceMode: "official-api";
                        sourceSystem: "hi-events";
                    };
                    credentialId: unknown;
                } | {
                    sourceSystem?: "eventbrite";
                    configuration?: {
                        sourceMode: "official-api";
                        sourceSystem: "eventbrite";
                    };
                    credentialId: unknown;
                } | {
                    sourceSystem?: "ticket-tailor";
                    configuration?: {
                        sourceMode: "official-api";
                        sourceSystem: "ticket-tailor";
                    };
                    credentialId: unknown;
                });
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["MigrationJob"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listMigrationMappings: {
        parameters: {
            query: {
                organizationId: string;
                sourceSystem?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["MigrationMapping"]>;
                    };
                };
            };
        };
    };
    createMigrationMapping: {
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    sourceSystem: string;
                    name: string;
                    entityType: string;
                    mapping: {
                        [key: string]: string | Array<string>;
                    };
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["MigrationMapping"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getMigrationJob: {
        parameters: {
            path: {
                jobId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MigrationJob"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listMigrationJobFiles: {
        parameters: {
            path: {
                jobId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["MigrationFile"]>;
                    };
                };
            };
        };
    };
    registerMigrationJobFile: {
        parameters: {
            path: {
                jobId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    uploadArtifactId: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["MigrationFile"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listMigrationJobRows: {
        parameters: {
            path: {
                jobId: string;
            };
            query?: {
                limit?: number;
                entityType?: string;
                status?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["MigrationRow"]>;
                    };
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listMigrationJobConflicts: {
        parameters: {
            path: {
                jobId: string;
            };
            query?: {
                limit?: number;
                offset?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["MigrationConflict"]>;
                    };
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    listMigrationJobEvents: {
        parameters: {
            path: {
                jobId: string;
            };
            query?: {
                afterSequence?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<components["schemas"]["MigrationEvent"]>;
                    };
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    runMigrationDryRun: {
        parameters: {
            path: {
                jobId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MigrationDryRunResult"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    prepareMigrationJob: {
        parameters: {
            path: {
                jobId: string;
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["MigrationStarted"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getMigrationReport: {
        parameters: {
            path: {
                jobId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MigrationReport"];
                };
            };
        };
    };
    downloadMigrationReport: {
        parameters: {
            path: {
                jobId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MigrationReport"];
                };
            };
        };
    };
    getPortableMigrationRebindings: {
        parameters: {
            path: {
                jobId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PortableImportRebindingStatus"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    bindPortableMigrationDestination: {
        parameters: {
            path: {
                jobId: string;
                portableId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    destinationReference: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PortableImportRebinding"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    approvePortableMigrationJob: {
        parameters: {
            path: {
                jobId: string;
            };
            header: {
                "Idempotency-Key": string;
                "x-tixkit-confirmation": string;
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["PortableImportApproval"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    revokePortableMigrationApproval: {
        parameters: {
            path: {
                jobId: string;
                approvalId: string;
            };
            header: {
                "x-tixkit-confirmation": string;
            };
        };
        requestBody?: {
            content: {
                "application/json": {
                    reason?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PortableImportApprovalRevocation"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    activatePortableMigrationJob: {
        parameters: {
            path: {
                jobId: string;
            };
            header: {
                "x-tixkit-confirmation": string;
            };
        };
        requestBody?: {
            content: {
                "application/json": Record<string, unknown>;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["PortableImportActivated"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    commitMigrationJob: {
        parameters: {
            path: {
                jobId: string;
            };
            header: {
                "x-tixkit-confirmation": string;
            };
        };
        requestBody?: {
            content: {
                "application/json": {
                    cutoverProof: components["schemas"]["PortableCutoverProof"];
                };
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["MigrationStarted"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    pauseMigrationJob: {
        parameters: {
            path: {
                jobId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["MigrationActionAccepted"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    resumeMigrationJob: {
        parameters: {
            path: {
                jobId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["MigrationActionAccepted"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    cancelMigrationJob: {
        parameters: {
            path: {
                jobId: string;
            };
            header: {
                "Idempotency-Key": string;
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["MigrationActionAccepted"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    assessMigrationRollback: {
        parameters: {
            path: {
                jobId: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["MigrationRollbackAssessment"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    rollbackMigrationJob: {
        parameters: {
            path: {
                jobId: string;
            };
            header: {
                "Idempotency-Key": string;
                "x-tixkit-confirmation": string;
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["MigrationActionAccepted"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getWebhookEndpoints: {
        parameters: {
            query?: {
                cursor?: string;
                limit?: number;
                organizationId?: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["WebhookEndpointPage"];
                };
            };
        };
    };
    postWebhookEndpoints: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    url: string;
                    events: Array<components["schemas"]["WebhookEventType"]>;
                    description?: string;
                };
            };
        };
        responses: {
            "201": {
                content: {
                    "application/json": components["schemas"]["WebhookEndpointCreated"];
                };
                headers: {
                    "Cache-Control": "private, no-store";
                    Pragma: "no-cache";
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    patchWebhookEndpointsByEndpointId: {
        parameters: {
            path: {
                endpointId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    url?: string;
                    events?: Array<components["schemas"]["WebhookEventType"]>;
                    status?: "active" | "disabled";
                    description?: string | null;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": components["schemas"]["WebhookEndpoint"];
                };
            };
        };
    };
    postWebhookEndpointsByEndpointIdTest: {
        parameters: {
            path: {
                endpointId: string;
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": {
                        queued: true;
                        test: true;
                        eventId: string;
                        endpointId: string;
                    };
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "429": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": {
                        queued: false;
                        test: true;
                        eventId: string;
                        endpointId: string;
                        error: {
                            code: "TEMPORAL_UNAVAILABLE";
                            message: string;
                        };
                    };
                };
            };
        };
    };
    getWebhookEndpointsByEndpointIdEvents: {
        parameters: {
            path: {
                endpointId: string;
            };
            query?: {
                cursor?: string;
                limit?: number;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        items: Array<{
                            id?: string;
                            eventId?: string;
                            deliveryId?: string;
                            endpointId?: string | null;
                            requestedEndpointId?: string;
                            deliveryKey?: string;
                            eventType?: string;
                            status?: string;
                            statusCode?: number;
                            attemptCount?: number;
                            deliveredAt?: string | null;
                            createdAt?: string;
                        }>;
                        nextCursor: string | null;
                        hasMore: boolean;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postWebhookEndpointsByEndpointIdEventsByEventIdReplay: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
            path: {
                endpointId: string;
                eventId: string;
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["WebhookEndpointReplayQueued"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["WebhookEndpointReplayUnavailable"];
                };
            };
        };
    };
    postWebhookEventsByEventIdReplay: {
        parameters: {
            header: {
                "Idempotency-Key": string;
            };
            path: {
                eventId: string;
            };
        };
        responses: {
            "202": {
                content: {
                    "application/json": components["schemas"]["WebhookReplayQueued"];
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "409": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["WebhookReplayUnavailable"];
                };
            };
        };
    };
    postWebhooksStripe: {
        responses: {
            "200": Record<string, never>;
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postWebhooksClerk: {
        responses: {
            "200": Record<string, never>;
        };
    };
    postWebhooksTelnyxSms: {
        responses: {
            "200": Record<string, never>;
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postWebhooksEmailByProvider: {
        parameters: {
            path: {
                provider: string;
            };
        };
        responses: {
            "200": Record<string, never>;
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "503": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getShortLinks: {
        responses: {
            "200": {
                content: {
                    "application/json": {
                        links: Array<{
                            id: string;
                            slug: string;
                            destinationUrl: string;
                            clicks: number;
                            createdAt?: string;
                        }>;
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postShortLinks: {
        requestBody: {
            content: {
                "application/json": {
                    destinationUrl: string;
                    slug?: string;
                    brandId?: string;
                    utmParams?: {
                        [key: string]: string;
                    };
                    expiresAt?: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        id: string;
                        slug: string;
                        destinationUrl: string;
                        utmParams?: {
                            [key: string]: string;
                        };
                        clicks: number;
                        createdAt?: string;
                    };
                };
            };
            "400": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    getShortLinksByIdClicks: {
        parameters: {
            path: {
                id: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        id: string;
                        totalClicks: number;
                        byDay: {
                            [key: string]: number;
                        };
                    };
                };
            };
            "401": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "403": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
    postProviderIncidentsByEvidenceIdReveal: {
        parameters: {
            path: {
                evidenceId: string;
            };
        };
        requestBody: {
            content: {
                "application/json": {
                    organizationId: string;
                    reason: string;
                };
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        requestId: string;
                    };
                };
                headers: {
                    "Cache-Control": "no-store";
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "404": Record<string, never>;
            "429": Record<string, never>;
            "503": Record<string, never>;
        };
    };
    getProviderIncidents: {
        parameters: {
            query: {
                organizationId: string;
                correlationSha256: string;
            };
        };
        responses: {
            "200": {
                content: {
                    "application/json": {
                        evidence: Array<{
                            evidenceId: string;
                            provider: string;
                            operation: string;
                            correlationSha256: string;
                            capturedAt: string;
                            expiresAt: string;
                        }>;
                    };
                };
                headers: {
                    "Cache-Control": "no-store";
                };
            };
            "400": Record<string, never>;
            "401": Record<string, never>;
            "403": Record<string, never>;
            "429": Record<string, never>;
            "503": Record<string, never>;
        };
    };
    getSBySlug: {
        parameters: {
            path: {
                slug: string;
            };
        };
        responses: {
            "302": Record<string, never>;
            "404": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
            "410": {
                content: {
                    "application/json": components["schemas"]["ApiError"];
                };
            };
        };
    };
};

export type webhooks = Record<string, never>;

export interface components {
    securitySchemes: {
        BearerAuth: unknown;
        ApiKey: unknown;
        ScannerDeviceAuth: unknown;
        AgentOAuth: unknown;
        StripeSignature: unknown;
        SvixSignature: unknown;
        TelnyxSignature: unknown;
        EmailProviderSignature: unknown;
    };
    parameters: {
        IdempotencyKey: string;
        RequiredIdempotencyKey: string;
        MessageCampaignIdempotencyKey: string;
        MigrationLifecycleIdempotencyKey: string;
        AgentControlIdempotencyKey: string;
        AgentActionIdempotencyKey: string;
        AgentPlanIdempotencyKey: string;
        AgentApprovalConfirmation: string;
        AgentApprovalIdempotencyKey: string;
        AgentApprovalRevocationConfirmation: string;
        AgentExecutionConfirmation: string;
        AgentExecutionIdempotencyKey: string;
        AgentMemoryIdempotencyKey: string;
        CheckoutSessionToken: string;
        OptionalCheckoutSessionToken: string;
        PaymentIntentClientSecret: string;
        ScannerDeviceSecret: string;
        OptionalScannerDeviceSecret: string;
        Cursor: string;
        Limit: number;
        AdminTableCursor: string;
        AdminTableDirection: "next" | "prev";
        AdminTableLimit: number;
        AdminTableSearch: string;
        AdminTableSort: string;
        AdminTableIncludeFacets: boolean;
        AdminTableIncludeTotal: boolean;
    };
    schemas: {
        AgentPlanProtocol_id: string;
        AgentPlanProtocol_sha256: string;
        AgentPlanProtocol_timestamp: string;
        AgentPlanProtocol_reasonCode: string;
        AgentPlanProtocol_assumption: {
            id: components["schemas"]["AgentPlanProtocol_id"];
            statement: string;
            provenanceType: "user" | "system" | "tool" | "inferred";
            sourceReference?: string;
            verification: "confirmed" | "unverified" | "rejected";
        };
        AgentPlanProtocol_projectedChange: {
            resourceType: components["schemas"]["AgentPlanProtocol_id"];
            resourceId: components["schemas"]["AgentPlanProtocol_id"];
            operation: "create" | "update" | "publish" | "send" | "refund" | "export" | "delete";
            beforeVersion?: number;
            projectedVersion?: number;
            previewSha256: components["schemas"]["AgentPlanProtocol_sha256"];
        };
        AgentPlanProtocol_cost: {
            amountMinor: number;
            currency: string;
            basis: string;
            quoteSha256: components["schemas"]["AgentPlanProtocol_sha256"];
            expiresAt: components["schemas"]["AgentPlanProtocol_timestamp"];
        };
        AgentPlanProtocol_readinessImpact: {
            beforeSnapshotSha256: components["schemas"]["AgentPlanProtocol_sha256"];
            projectedSnapshotSha256: components["schemas"]["AgentPlanProtocol_sha256"];
            introducedReasonCodes: Array<components["schemas"]["AgentPlanProtocol_reasonCode"]>;
            resolvedReasonCodes: Array<components["schemas"]["AgentPlanProtocol_reasonCode"]>;
        };
        AgentPlanProtocol_approvalRequirement: {
            mode: "none" | "fresh_action";
            riskClass: "read_only" | "low" | "high" | "critical";
        };
        AgentPlanProtocol_reversibility: ({
            mode: "none" | "reversible" | "compensatable";
            compensationActionKind?: "event.read" | "readiness.read" | "report.read" | "event.prepare" | "content.prepare" | "campaign.prepare" | "event.update" | "event.publish" | "inventory.change" | "campaign.send" | "refund.issue" | "permission.change" | "personal_data.export" | "credential.change" | "domain.change" | "provider.change" | "migration.execute" | "resource.delete";
            windowSeconds?: number;
        }) & (unknown);
        AgentPlanProtocol_planStep: {
            id: components["schemas"]["AgentPlanProtocol_id"];
            actionKind: "event.publish";
            actionProtocolVersion: "2026-07-22";
            actionDigest: components["schemas"]["AgentPlanProtocol_sha256"];
            dependsOnStepIds: Array<components["schemas"]["AgentPlanProtocol_id"]>;
            projectedChanges: Array<components["schemas"]["AgentPlanProtocol_projectedChange"]>;
            costs: Array<components["schemas"]["AgentPlanProtocol_cost"]>;
            readinessImpact: components["schemas"]["AgentPlanProtocol_readinessImpact"];
            approvalRequirement: components["schemas"]["AgentPlanProtocol_approvalRequirement"];
            reversibility: components["schemas"]["AgentPlanProtocol_reversibility"];
        };
        AgentPlanProtocol_agentPlanDefinition: {
            id: components["schemas"]["AgentPlanProtocol_id"];
            protocolVersion: "2026-07-27";
            tenantId: components["schemas"]["AgentPlanProtocol_id"];
            agentPrincipalId: components["schemas"]["AgentPlanProtocol_id"];
            sponsorPrincipalId: components["schemas"]["AgentPlanProtocol_id"];
            delegationGrantId: components["schemas"]["AgentPlanProtocol_id"];
            purpose: string;
            assumptions: Array<components["schemas"]["AgentPlanProtocol_assumption"]>;
            steps: Array<components["schemas"]["AgentPlanProtocol_planStep"]>;
            createdAt: components["schemas"]["AgentPlanProtocol_timestamp"];
            expiresAt: components["schemas"]["AgentPlanProtocol_timestamp"];
            planSha256: components["schemas"]["AgentPlanProtocol_sha256"];
        };
        AgentPlanProtocol_stepState: ({
            stepId: components["schemas"]["AgentPlanProtocol_id"];
            status: "pending" | "blocked" | "awaiting_approval" | "approved" | "executing" | "succeeded" | "failed" | "cancelled" | "compensated";
            approvalId?: components["schemas"]["AgentPlanProtocol_id"];
            executionId?: components["schemas"]["AgentPlanProtocol_id"];
            resultSha256?: components["schemas"]["AgentPlanProtocol_sha256"];
            failureCode?: string;
        }) & (unknown & unknown & unknown & unknown);
        AgentPlanProtocol_agentPlanState: {
            planId: components["schemas"]["AgentPlanProtocol_id"];
            planSha256: components["schemas"]["AgentPlanProtocol_sha256"];
            stateVersion: number;
            status: "prepared" | "awaiting_approval" | "executing" | "succeeded" | "failed" | "cancelled" | "expired" | "compensated";
            stepStates: Array<components["schemas"]["AgentPlanProtocol_stepState"]>;
            updatedAt: components["schemas"]["AgentPlanProtocol_timestamp"];
        };
        AgentPlanDefinition: components["schemas"]["AgentPlanProtocol_agentPlanDefinition"];
        AgentPlanState: components["schemas"]["AgentPlanProtocol_agentPlanState"];
        PersistedAgentPlan: {
            definition: components["schemas"]["AgentPlanDefinition"];
            state: components["schemas"]["AgentPlanState"];
            actionBindings: Array<{
                stepId: components["schemas"]["AgentPlanProtocol_id"];
                actionId: components["schemas"]["AgentPlanProtocol_id"];
            }>;
        };
        ApiError: {
            error: {
                code: string;
                message: string;
                details?: Record<string, unknown>;
                requestId: string;
            };
        };
        MigrationPreparationConfiguration: {
            sourceMode: "official-export";
            sourceSystem: "generic-csv" | "pretix" | "hi-events" | "eventbrite" | "ticket-tailor";
            artifactIds: Array<string>;
        } | {
            sourceMode: "official-api";
            sourceSystem: "pretix";
            organizerSlug: string;
            eventSlugs: Array<string>;
            baseUrl?: string;
        } | {
            sourceMode: "official-api";
            sourceSystem: "hi-events";
            accountId: string;
            eventIds: Array<string>;
            baseUrl?: string;
        } | {
            sourceMode: "official-api";
            sourceSystem: "eventbrite";
            organizationId: string;
            eventIds: Array<string>;
        } | {
            sourceMode: "official-api";
            sourceSystem: "ticket-tailor";
            accountId: string;
            eventIds: Array<string>;
        };
        MigrationJob: {
            id: string;
            tenant_id: string;
            organization_id: string;
            source_system: string;
            adapter_version: string;
            mode: "dry-run" | "commit";
            status: string;
            configurationHash: string;
            credentialConfigured: boolean;
            summary?: {
                [key: string]: unknown;
            } | null;
            created_at: string;
            updated_at: string;
        };
        MigrationFile: {
            id: string;
            import_job_id: string;
            original_name: string;
            media_type: string;
            byte_size: number;
            sha256: string;
            status: string;
            created_at: string;
            [key: string]: unknown;
        };
        MigrationMapping: {
            id: string;
            organization_id: string;
            source_system: string;
            name: string;
            entity_type: string;
            mapping: {
                [key: string]: string | Array<string>;
            };
            [key: string]: unknown;
        };
        MigrationReport: {
            job?: {
                [key: string]: unknown;
            };
            report?: {
                [key: string]: unknown;
            };
            conflicts?: Array<{
                [key: string]: unknown;
            }>;
            correctivePlans?: Array<{
                [key: string]: unknown;
            }>;
            portableDryRunReceipt?: components["schemas"]["PortableDryRunReceipt"];
            [key: string]: unknown;
        };
        PortableDryRunReceipt: {
            operationId: string;
            manifestSha256: string;
            destinationId: string;
            sourceChangeCursor: string;
            inputSha256: string;
            artifactSha256: string;
            checkedAt: string;
            compatible: true;
            requiredRebindings: Array<string>;
            sha256: string;
            attestationKeyId: string;
            signature: string;
        };
        PortableCutoverProof: {
            tenantId: string;
            deploymentId: string;
            sourceChangeCursor: string;
            observedAt: string;
            sourceFrozen: boolean;
            bundleId: string;
            manifestSha256: string;
            destinationId: string;
            operationId: string;
            issuedAt: string;
            expiresAt: string;
            nonce: string;
            receiptSha256: string;
            keyId: string;
            signature: string;
        };
        MigrationAdapterCatalogEntry: {
            id: "generic-csv" | "pretix" | "hi-events" | "eventbrite" | "ticket-tailor";
            displayName: string;
            supportedVersions: Array<string>;
            featureMapping: {
                [key: string]: unknown;
            };
            knownLosses: Array<string>;
            rateLimitPolicy: {
                [key: string]: unknown;
            };
            sourceModes: Array<"official-api" | "official-export">;
        };
        MigrationRow: {
            id: string;
            importJobId: string;
            fileId?: string | null;
            entityType: string;
            correlationId: string;
            rowNumber: number;
            status: string;
            severity?: string | null;
            tixkitId?: string | null;
            sourceHash: string;
            normalizedHash?: string | null;
        };
        MigrationConflict: {
            id: string;
            entity_type: string;
            correlationId: string;
            severity: string;
            code: string;
            message: unknown;
            details: unknown;
        };
        MigrationEvent: {
            id: string;
            sequence: number;
            type: string;
            severity: string;
            message: unknown;
            createdAt: string;
            data: unknown;
        };
        MigrationAccepted: {
            accepted: true;
        };
        MigrationStarted: {
            jobId: string;
            status: string;
        };
        PortableImportApproval: {
            approvalId: string;
            approvalDigest: string;
            expiresAt: string;
            commitConfirmation: string;
        };
        PortableImportRebinding: {
            portableId: string;
            kind: "custom_domain" | "provider_account" | "payment_provider_account" | "email_delivery_route" | "sms_delivery_route" | "marketing_integration" | "tax_registration" | "sending_identity" | "wallet_credential" | "oauth_redirect_origin" | "webhook_endpoint";
            destinationReference: string;
            boundBy?: string;
            provenanceSha256: string;
            updatedAt: string;
        };
        PortableImportRebindingStatus: {
            required: Array<{
                [key: string]: unknown;
            }>;
            completed: Array<components["schemas"]["PortableImportRebinding"]>;
            complete: boolean;
        };
        PortableImportApprovalRevocation: {
            approvalId: string;
            revoked: true;
            revokedAt: string;
        };
        PortableImportActivated: {
            jobId: string;
            status: "activated";
        };
        MigrationActionAccepted: {
            jobId: string;
            action: "pause" | "resume" | "cancel" | "rollback";
            accepted: true;
            commandId: string;
            lifecycleSequence: number;
        };
        MigrationDryRunResult: {
            status: "ready" | "failed";
            report: components["schemas"]["MigrationReport"];
            domainWrites: 0;
            portableDryRunReceipt?: components["schemas"]["PortableDryRunReceipt"];
            portableDryRunReceiptSha256?: string;
        };
        MigrationRollbackAssessment: {
            eligible: boolean;
            mode: string;
            blockers: Array<{
                [key: string]: unknown;
            }>;
            [key: string]: unknown;
        };
        ContentValidationIssue: {
            code: string;
            message: string;
            severity: "error" | "warning";
            field?: string;
        };
        ContentValidationResult: {
            valid: boolean;
            severity: "error" | "warning";
            issues: Array<components["schemas"]["ContentValidationIssue"]>;
        };
        ContentDocument: {
            id: string;
            tenantId: string;
            organizationId: string;
            brandId: string;
            eventId?: string;
            eventVersion?: number;
            channel: "event_page" | "email" | "sms" | "imessage" | "social_invite";
            key: string;
            name: string;
            status: "draft" | "published" | "archived";
            locale: string;
            currentDraftVersionId?: string;
            publishedVersionId?: string;
            createdAt: string;
            updatedAt: string;
        };
        ContentDocumentVersion: {
            id: string;
            documentId: string;
            versionNumber: number;
            status: "draft" | "published" | "superseded";
            schemaVersion: number;
            subject?: string;
            previewText?: string;
            contentJson: components["schemas"]["EventPageDocumentV2"] | components["schemas"]["EmailTemplateDocument"] | components["schemas"]["SmsTemplateDocument"] | {
                [key: string]: unknown;
            };
            renderedHtml?: string;
            renderedText?: string;
            variables: Array<{
                key: string;
                required: boolean;
                description?: string;
            }>;
            validation: components["schemas"]["ContentValidationResult"];
            createdBy: string;
            createdAt: string;
            publishedAt?: string;
        };
        PuckComponentData: {
            type: string;
            props: {
                [key: string]: unknown;
            };
        };
        PuckRootData: {
            props: {
                [key: string]: unknown;
            };
        };
        PuckData: {
            content: Array<components["schemas"]["PuckComponentData"]>;
            root: components["schemas"]["PuckRootData"];
            zones?: {
                [key: string]: Array<components["schemas"]["PuckComponentData"]>;
            };
        };
        EventPageDocumentV2: {
            schemaVersion: 2;
            editor: {
                provider: "@puckeditor/core";
                data: components["schemas"]["PuckData"];
            };
            settings?: {
                [key: string]: unknown;
            };
        };
        EmailTemplateDocument: {
            schemaVersion: 1;
            editor: {
                provider: "@react-email/editor";
                contentHtml: string;
                contentText?: string;
                contentJson?: {
                    [key: string]: unknown;
                };
            };
            settings: {
                templateKey: string;
                subject: string;
                previewText?: string;
                locale: string;
                category: "transactional" | "bulk" | "staff" | "system";
                sender: {
                    fromEmail?: string;
                    fromName?: string;
                    replyToEmail?: string;
                };
            };
            blocks: Array<{
                type: "event_hero";
                headline: string;
                body?: string;
                imageUrl?: string;
                imageAlt?: string;
                ctaLabel?: string;
                ctaUrl?: string;
            } | {
                type: "ticket_summary";
                title: string;
                body: string;
            } | {
                type: "order_summary";
                title: string;
                rows: Array<{
                    label: string;
                    value: string;
                }>;
            } | {
                type: "qr_code";
                title: string;
                imageUrl: string;
                imageAlt?: string;
            } | {
                type: "calendar_button";
                label: string;
                url: string;
            } | {
                type: "venue_block";
                title: string;
                address: string;
                mapUrl?: string;
            } | {
                type: "social_links";
                links: Array<{
                    label: string;
                    url: string;
                }>;
            } | {
                type: "unsubscribe_footer";
                body: string;
                unsubscribeUrl: string;
            } | {
                type: "raw_html";
                html: string;
                safe: boolean;
            }>;
        };
        SmsTemplateDocument: {
            schemaVersion: 1;
            editor: {
                provider: "@tixkit/content-message/sms-composer";
                body: string;
            };
            settings: {
                templateKey: string;
                locale: string;
                category: "transactional" | "bulk" | "staff" | "system";
                consentCategory: "transactional" | "marketing" | "staff" | "system";
                segmentLimit: number;
                estimatedCostPerSegmentCents: number;
                optOutText?: string;
            };
            shortLinks: Array<{
                originalUrl: string;
                reason: "long_url" | "unsafe_url";
                field: string;
            }>;
        };
        PublicContentPage: {
            document: {
                eventId: string;
                channel: "event_page";
                key: string;
                name: string;
                locale: string;
                updatedAt: string;
            };
            version: {
                versionNumber: number;
                subject?: string;
                previewText?: string;
                publishedAt?: string;
            };
            page: {
                provider: "@puckeditor/core";
                puckData: components["schemas"]["PuckData"];
                settings: {
                    [key: string]: unknown;
                };
                discovery: components["schemas"]["PublicEventDiscoveryCard"];
            };
        };
        DraftPreviewPage: {
            document: {
                eventId: string;
                channel: "event_page";
                key: string;
                name: string;
                locale: string;
                updatedAt: string;
            };
            version: {
                versionNumber: number;
                status: string;
                subject?: string;
                previewText?: string;
            };
            contentJson: components["schemas"]["EventPageDocumentV2"];
            context: {
                [key: string]: unknown;
            };
            validation: components["schemas"]["ContentValidationResult"];
        };
        PublicCheckoutBootstrap: {
            event: components["schemas"]["PublicEvent"];
            availability: Array<components["schemas"]["PublicAvailabilityItem"]>;
            questions: components["schemas"]["PublicQuestionsResponse"];
            resaleListing: components["schemas"]["PublicTicketListing"];
        };
        PublicEventPageBootstrap: {
            event: components["schemas"]["PublicEvent"];
            contentPage: components["schemas"]["PublicContentPage"];
            availability: Array<components["schemas"]["PublicAvailabilityItem"]>;
            resaleListings: components["schemas"]["PublicTicketListingPage"];
        };
        Ga4MarketingIntegrationConfig: {
            measurementId: string;
        };
        MetaPixelMarketingIntegrationConfig: {
            pixelId: string;
        };
        GenericTagMarketingIntegrationConfig: {
            pixelUrl: string;
        };
        PublicMarketingIntegration: ({
            provider: "ga4" | "meta_pixel" | "generic_tag";
            config: unknown;
            consentRequired: boolean;
            status: "active" | "disabled";
        }) & ({
            provider: "ga4";
            config: components["schemas"]["Ga4MarketingIntegrationConfig"];
        } | {
            provider: "meta_pixel";
            config: components["schemas"]["MetaPixelMarketingIntegrationConfig"];
        } | {
            provider: "generic_tag";
            config: components["schemas"]["GenericTagMarketingIntegrationConfig"];
        });
        PublicEventMediaRendition: {
            variant: "thumbnail" | "card" | "page" | "social";
            width: number;
            height: number;
            url: string;
        };
        PublicEventMediaAsset: {
            role: "poster" | "cover" | "social";
            altText: string;
            focalPoint: {
                x: number;
                y: number;
            };
            renditions: Array<components["schemas"]["PublicEventMediaRendition"]>;
        };
        PublicEvent: {
            id: string;
            slug: string;
            title: string;
            description: string | null;
            status: string;
            timezone: string;
            startsAt: string;
            endsAt: string | null;
            venue: {
                [key: string]: unknown;
            } | null;
            brandId: string;
            coverImageUrl?: string;
            mediaAssets?: Array<components["schemas"]["PublicEventMediaAsset"]>;
            minimumAge: number | null;
            marketingIntegrations: Array<components["schemas"]["PublicMarketingIntegration"]>;
        };
        PublicEventRevision: {
            revision: string | null;
        };
        PublicEventDiscoveryCard: {
            title: string;
            summary: string;
            category?: string;
            tags: Array<string>;
            imageUrl?: string;
            startsAt?: string;
            venueName?: string;
            publicPath?: string;
        };
        ContentDocumentPage: {
            items: Array<components["schemas"]["ContentDocument"]>;
        };
        ContentDocumentVersionPage: {
            items: Array<components["schemas"]["ContentDocumentVersion"]>;
        };
        ContentRenderOutput: {
            subject?: string;
            html?: string;
            text?: string;
            segments?: number;
        };
        ContentPreview: {
            channel: "event_page" | "email" | "sms" | "imessage" | "social_invite";
            output: components["schemas"]["ContentRenderOutput"];
            validation: components["schemas"]["ContentValidationResult"];
            renderArtifact?: components["schemas"]["ContentRenderArtifact"];
        };
        ContentRenderArtifact: {
            id: string;
            tenantId: string;
            documentId: string;
            versionId: string;
            channel: "event_page" | "email" | "sms" | "imessage" | "social_invite";
            outputType: "preview" | "test_send" | "send";
            artifactRef: string;
            checksum: string;
            createdAt: string;
        };
        ContentTestSend: {
            id: string;
            tenantId: string;
            documentId: string;
            versionId: string;
            channel: "event_page" | "email" | "sms" | "imessage" | "social_invite";
            recipient: string;
            status: "captured" | "failed";
            renderedSubject?: string;
            renderedHtml?: string;
            renderedText?: string;
            error?: string;
            createdAt: string;
        };
        EventThumbnail: {
            renditionId: string;
            role: "poster" | "cover" | "social";
            variant: "card" | "thumbnail";
            altText: string;
            width: number;
            height: number;
            checksumSha256: string;
            url: string;
        };
        Event: {
            id: string;
            tenantId: string;
            organizationId: string;
            brandId: string;
            title: string;
            slug: string;
            status: "draft" | "published" | "paused" | "ended" | "archived";
            currency: string;
            startsAt: string;
            endsAt?: string;
            timezone: string;
            visibility?: "public" | "unlisted" | "private";
            description?: string;
            capacity?: number;
            minimumAge: number | null;
            venue?: {
                [key: string]: unknown;
            } | null;
            seo?: Record<string, unknown>;
            coverImageUrl?: string;
            thumbnail?: components["schemas"]["EventThumbnail"] | null;
            externalUrl?: string;
            resalePolicy: components["schemas"]["ResalePolicy"];
            grossSalesCents: number;
            ticketsSold: number;
            checkIns: number;
            version: number;
            lastSetupSection?: string;
            coverImageAlt?: string;
            seoUseCoverImage: boolean;
            createdAt: string;
            updatedAt: string;
        };
        ReadinessStep: {
            id: "workspace_selection" | "brand_identity" | "payment_path" | "team_access" | "legal_configuration" | "sender_identity" | "basics_schedule" | "sellable_tickets" | "currency_coherence" | "fee_pricing" | "checkout_consent" | "public_content" | "confirmation_content" | "payment_readiness" | "preview_review" | "test_order" | "check_in_configuration" | "publishability" | "publication_status";
            status: "complete" | "incomplete" | "blocked" | "not_applicable";
            priority: "required" | "recommended";
            reasonCodes: Array<"workspace_selected" | "organization_inactive" | "brand_inactive" | "brand_identity_configured" | "brand_identity_incomplete" | "payment_capture_mode" | "payment_capture_mode_paid_unsupported" | "payment_path_ready" | "payment_path_missing" | "payment_account_inactive" | "payment_charges_disabled" | "payment_currency_mismatch" | "team_access_configured" | "team_access_single_member" | "legal_configuration_complete" | "legal_configuration_missing" | "sender_identity_verified" | "sender_identity_missing" | "event_basics_valid" | "event_title_missing" | "event_schedule_invalid" | "event_start_invalid" | "event_timezone_missing" | "sellable_ticket_available" | "sellable_ticket_missing" | "ticket_inventory_unavailable" | "inventory_invalid" | "sales_window_invalid" | "currency_coherent" | "ticket_currency_mismatch" | "product_currency_mismatch" | "pricing_valid" | "pricing_invalid" | "checkout_reviewed" | "checkout_review_required" | "public_content_published" | "public_content_missing" | "confirmation_content_valid" | "confirmation_content_missing" | "payment_not_required" | "payment_ready" | "preview_reviewed" | "preview_review_required" | "test_order_complete" | "test_order_recommended" | "test_order_not_applicable" | "check_in_configured" | "check_in_configuration_missing" | "required_steps_complete" | "required_steps_incomplete" | "event_published" | "event_unpublished" | "acknowledgement_stale" | "permission_required">;
            actionId: "select_workspace" | "configure_brand" | "configure_payments" | "manage_team" | "configure_legal" | "configure_sender" | "edit_event_basics" | "manage_tickets" | "manage_products" | "review_fees" | "review_checkout" | "edit_event_content" | "edit_confirmation_content" | "review_preview" | "run_test_order" | "configure_check_in" | "publish_event" | "view_event" | null;
            requiredPermission: "events.read" | "events.write" | "tickets.write" | "orders.read" | "orders.write" | "refunds.write" | "attendees.read" | "attendees.write" | "checkins.read" | "checkins.write" | "box_office.write" | "messages.write" | "reports.read" | "settings.write" | "developers.write" | "migrations.read" | "migrations.write" | "migrations.commit" | "migrations.rollback" | "billing.write" | null;
            updatedAt: string | null;
            acknowledgedAt: string | null;
            acknowledgementValid: boolean | null;
        };
        WorkspaceReadiness: {
            tenantId: string;
            organizationId: string;
            brandId: string;
            generatedAt: string;
            paymentMode: "capture" | "provider_test" | "provider";
            complete: boolean;
            steps: Array<components["schemas"]["ReadinessStep"]>;
            actionFeed?: Array<components["schemas"]["WorkspaceDashboardAction"]>;
        };
        WorkspaceDashboardAction: {
            id: string;
            stepId: "workspace_selection" | "brand_identity" | "payment_path" | "team_access" | "legal_configuration" | "sender_identity";
            severity: "critical" | "high" | "medium" | "low";
            owner: "organizer" | "finance" | "marketing" | "support" | "door_operations";
            deadlineAt: string | null;
            status: "incomplete" | "blocked";
            reasonCodes: Array<"organization_inactive" | "brand_inactive" | "brand_identity_incomplete" | "payment_path_missing" | "team_access_single_member" | "legal_configuration_missing" | "sender_identity_missing" | "permission_required">;
            actionId: "select_workspace" | "configure_brand" | "configure_payments" | "manage_team" | "configure_legal" | "configure_sender" | "edit_event_basics" | "manage_tickets" | "manage_products" | "review_fees" | "review_checkout" | "edit_event_content" | "edit_confirmation_content" | "review_preview" | "run_test_order" | "configure_check_in" | "publish_event" | "view_event" | null;
            requiredPermission: "events.read" | "events.write" | "tickets.write" | "orders.read" | "orders.write" | "refunds.write" | "attendees.read" | "attendees.write" | "checkins.read" | "checkins.write" | "box_office.write" | "messages.write" | "reports.read" | "settings.write" | "developers.write" | "migrations.read" | "migrations.write" | "migrations.commit" | "migrations.rollback" | "billing.write" | null;
            updatedAt: string | null;
        };
        DashboardAction: {
            id: string;
            sourceType: "event_launch" | "event_operations" | "delivery_operations";
            resource: {
                type: "event";
                organizationId: string;
                brandId: string;
                eventId: string;
                eventVersion: number;
                eventTitle: string;
            };
            severity: "critical" | "high" | "medium" | "low";
            owner: "organizer" | "finance" | "marketing" | "support" | "door_operations";
            deadlineAt: string | null;
            deadlinePolicy: "none" | "event_start";
            overdue: boolean;
            occurrenceCount: number;
            reasonCode: "event_unpublished" | "event_starting_soon" | "event_sales_paused" | "failed_exports";
            remediation: {
                id: "continue_event_setup" | "prepare_door_operations" | "review_paused_event" | "review_failed_exports";
                readinessActionId: "view_event" | "configure_check_in" | null;
                requiredPermission: "events.write" | "checkins.write" | "reports.read" | null;
                canRemediate: boolean;
                availability: "available" | "permission_required" | "unsupported";
            };
            staleness: {
                state: "current" | "expired";
                consistency: "repeatable_read";
                evaluatedAt: string;
                expiresAt: string;
                sourceUpdatedAt: string | null;
                sourceVersion: number | null;
                evidenceRevision: string;
            };
        };
        DashboardActionFeed: {
            tenantId: string;
            organizationId: string;
            brandId: string;
            evaluationVersion: 1;
            generatedAt: string;
            expiresAt: string;
            nextCursor: string | null;
            actions: Array<components["schemas"]["DashboardAction"]>;
        };
        EventLaunchReadiness: {
            tenantId: string;
            organizationId: string;
            brandId: string;
            eventId: string;
            eventVersion: number;
            generatedAt: string;
            paymentMode: "capture" | "provider_test" | "provider";
            launchable: boolean;
            published: boolean;
            requiredBlockers: Array<components["schemas"]["ReadinessStep"]>;
            recommendedWarnings: Array<components["schemas"]["ReadinessStep"]>;
            steps: Array<components["schemas"]["ReadinessStep"]>;
        };
        ReadinessAcknowledgement: {
            tenantId: string;
            organizationId: string;
            brandId: string;
            eventId: string;
            stepId: "checkout_consent" | "preview_review";
            stepVersion: number;
            subjectFingerprint: string;
            actorId: string;
            acknowledgedAt: string;
        };
        LaunchReadinessFailedError: {
            error: {
                code: "launch_readiness_failed";
                message: string;
                details: {
                    requiredBlockers: Array<components["schemas"]["ReadinessStep"]>;
                    recommendedWarnings: Array<components["schemas"]["ReadinessStep"]>;
                };
                requestId: string;
            };
        };
        StaleEventVersionError: {
            error: {
                code: "stale_event_version";
                message: string;
                details: {
                    expectedVersion: number;
                    currentVersion: number;
                };
                requestId: string;
            };
        };
        EventArchivedError: {
            error: {
                code: "event_archived";
                message: string;
                requestId: string;
            };
        };
        DuplicateEventRequest: {
            startsAt: string;
            title?: string;
            copy: {
                basicsVenue: boolean;
                ticketTypes: boolean;
                products: boolean;
                checkoutQuestions: boolean;
                feeResalePolicies: boolean;
                eventPageContent: boolean;
                lifecycleContent: boolean;
                marketingIntegrations: boolean;
            };
        };
        ResalePolicy: {
            enabled: boolean;
            maxMultiplier: number;
            maxAbsoluteCents?: number | null;
        };
        ResaleTermsAcceptance: {
            accepted: true;
            termsVersion: "2026-07-16";
            settlementModel: "organizer_managed";
            refundModel: "manual_coordinated_resolution";
        };
        FeeRule: {
            id?: string;
            eventId?: string;
            name: string;
            type: "percentage" | "fixed";
            value: number;
            appliedTo: "per_ticket" | "per_order";
            absorbIntoPrice: boolean;
            createdAt?: string;
            updatedAt?: string;
        };
        EventFeePolicy: {
            eventId: string;
            eventVersion: number;
            passFeesToBuyer: boolean;
            rules: Array<components["schemas"]["FeeRule"]>;
        };
        UpdateEventFeePolicyInput: {
            expectedVersion: number;
            passFeesToBuyer: boolean;
            rules: Array<{
                id?: string;
                name: string;
                type: "percentage" | "fixed";
                value: number;
                appliedTo: "per_ticket" | "per_order";
            }>;
        };
        AdminTableSortEntry: {
            field: string;
            direction: "asc" | "desc";
        };
        AdminTableFilterValue: {
            type: "text";
            value: string;
        } | {
            type: "select";
            values: Array<string>;
        } | {
            type: "boolean";
            value: boolean;
        } | {
            type: "date_range";
            from?: string;
            to?: string;
        } | {
            type: "number_range";
            min?: number;
            max?: number;
        };
        AdminTableFacetRow: {
            value: string | number | boolean;
            total: number;
        };
        AdminTableFacet: {
            rows?: Array<components["schemas"]["AdminTableFacetRow"]>;
            total?: number;
            min?: number;
            max?: number;
        };
        AdminTableAppliedQuery: {
            search?: string;
            sort: Array<components["schemas"]["AdminTableSortEntry"]>;
            filters: {
                [key: string]: components["schemas"]["AdminTableFilterValue"];
            };
            rejectedFilters?: Array<string>;
            rejectedSort?: Array<string>;
        };
        EventPage: {
            items: Array<components["schemas"]["Event"]>;
            nextCursor?: string | null;
            prevCursor?: string | null;
            total?: number;
            filterTotal?: number;
            facets?: {
                [key: string]: components["schemas"]["AdminTableFacet"];
            };
            applied?: components["schemas"]["AdminTableAppliedQuery"];
        };
        TicketType: {
            id: string;
            eventId?: string;
            eventOccurrenceId?: string;
            name: string;
            kind: "free" | "paid" | "donation" | "product";
            status?: "draft" | "active" | "paused" | "sold_out" | "ended";
            visibility?: "public" | "hidden" | "locked";
            currency: string;
            priceCents: number;
            minimumPriceCents?: number;
            minPerOrder?: number;
            maxPerOrder?: number;
            requiresAccessCode?: boolean;
            inventoryPoolId?: string;
        };
        EventOccurrence: {
            id: string;
            eventId: string;
            title: string;
            startsAt: string;
            endsAt: string;
            timezone: string;
            venue?: Record<string, unknown>;
            capacity?: number | null;
            sortOrder: number;
            status: "scheduled" | "cancelled" | "completed";
            createdAt?: string;
            updatedAt?: string;
        };
        EventOccurrencePage: {
            items: Array<components["schemas"]["EventOccurrence"]>;
            nextCursor?: string | null;
            hasMore?: boolean;
        };
        MarketingIntegration: ({
            id?: string;
            tenantId?: string;
            organizationId?: string;
            brandId?: string;
            eventId?: string;
            provider: "ga4" | "meta_pixel" | "generic_tag";
            config: unknown;
            consentRequired: boolean;
            status: "active" | "disabled";
            createdAt?: string;
            updatedAt?: string;
        }) & ({
            provider: "ga4";
            config: components["schemas"]["Ga4MarketingIntegrationConfig"];
        } | {
            provider: "meta_pixel";
            config: components["schemas"]["MetaPixelMarketingIntegrationConfig"];
        } | {
            provider: "generic_tag";
            config: components["schemas"]["GenericTagMarketingIntegrationConfig"];
        });
        MarketingIntegrationPage: {
            items: Array<components["schemas"]["MarketingIntegration"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        TicketTypePage: {
            items: Array<components["schemas"]["TicketType"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        WaitlistEntry: {
            id: string;
            eventId: string;
            ticketTypeId: string;
            email: string;
            firstName?: string;
            lastName?: string;
            phone?: string;
            quantity: number;
            status: "joined" | "offered" | "claimed" | "cancelled" | "expired";
            offerExpiresAt?: string;
            offeredAt?: string;
            claimedAt?: string;
            cancelledAt?: string;
            createdAt: string;
            updatedAt: string;
        };
        WaitlistEntryPage: {
            items: Array<components["schemas"]["WaitlistEntry"]>;
            settings: components["schemas"]["WaitlistSettings"];
        };
        WaitlistSettings: {
            autoOfferEnabled: boolean;
            offerTtlMinutes: number;
        };
        JoinWaitlistRequest: {
            ticketTypeId: string;
            email: string;
            firstName?: string;
            lastName?: string;
            phone?: string;
            quantity?: number;
        };
        WaitlistOffer: {
            entry: components["schemas"]["WaitlistEntry"];
            claimToken: string;
        };
        AccessRule: {
            id: string;
            ticketTypeId: string;
            type: "code" | "email_domain";
            value: string;
            maxUses?: number;
            usesCount: number;
            expiresAt?: string;
            createdAt?: string;
            updatedAt?: string;
        };
        AccessRulePage: {
            items: Array<components["schemas"]["AccessRule"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        TicketTypeBatchResult: {
            ticketType: components["schemas"]["TicketType"];
            accessRules: Array<components["schemas"]["AccessRule"]>;
        };
        CreateTicketTypeBatch: {
            ticketType: {
                name: string;
                description?: string;
                kind: "free" | "paid" | "donation";
                visibility?: "public" | "hidden" | "locked";
                currency: string;
                priceCents: number;
                minimumPriceCents?: number | null;
                salesStartAt?: string;
                salesEndAt?: string;
                minPerOrder?: number;
                maxPerOrder?: number;
                inventoryPoolId?: string;
                requiresAccessCode?: boolean;
                accessCodeHint?: string | null;
            };
            inventoryPool?: {
                name: string;
                totalCapacity: number;
                holdTtlSeconds?: number;
            };
            accessRules?: Array<components["schemas"]["AccessRuleCreate"]>;
        };
        UpdateTicketTypeBatch: {
            ticketType: {
                name?: string;
                description?: string;
                kind?: "free" | "paid" | "donation";
                status?: "draft" | "active" | "paused" | "sold_out" | "ended";
                visibility?: "public" | "hidden" | "locked";
                currency?: string;
                priceCents?: number;
                minimumPriceCents?: number | null;
                salesStartAt?: string | null;
                salesEndAt?: string | null;
                minPerOrder?: number;
                maxPerOrder?: number;
                inventoryPoolId?: string;
                requiresAccessCode?: boolean;
                accessCodeHint?: string | null;
                sortOrder?: number;
            };
            accessRules?: Array<components["schemas"]["AccessRuleCreate"]>;
        };
        AccessRuleCreate: {
            type: "code" | "email_domain";
            value: string;
            maxUses?: number | null;
            expiresAt?: string | null;
        };
        ProductCategory: {
            id: string;
            eventId: string;
            name: string;
            sortOrder: number;
            createdAt?: string;
            updatedAt?: string;
        };
        ProductCategoryPage: {
            items: Array<components["schemas"]["ProductCategory"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        Product: {
            id: string;
            eventId: string;
            name: string;
            description?: string;
            priceCents: number;
            currency: string;
            categoryId?: string;
            maxPerOrder: number;
            availableFrom?: string;
            availableUntil?: string;
            status: "active" | "inactive";
            sortOrder: number;
            createdAt?: string;
            updatedAt?: string;
        };
        ProductPage: {
            items: Array<components["schemas"]["Product"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        AvailabilityResult: {
            ticketTypeId: string;
            eventOccurrenceId?: string;
            available: number;
            total: number;
            reserved?: number;
            sold?: number;
            status: string;
        };
        AvailabilityPage: {
            items: Array<components["schemas"]["AvailabilityResult"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        PublicAvailabilityTicketItem: {
            ticketTypeId: string;
            eventOccurrenceId?: string;
            name: string;
            kind: "free" | "paid" | "donation";
            priceCents: number;
            currency: string;
            minimumPriceCents?: number;
            minPerOrder: number;
            maxPerOrder: number;
            available: number;
            status: string;
            requiresAccessCode: boolean;
            accessCodeHint?: string;
            description?: string;
            salesStartAt?: string;
            salesEndAt?: string;
        };
        PublicAvailabilityProductItem: {
            type: "product";
            productId: string;
            name: string;
            kind: "product";
            priceCents: number;
            currency: string;
            minPerOrder: number;
            maxPerOrder: number;
            available: number;
            status: string;
            requiresAccessCode: boolean;
            description?: string;
            salesStartAt?: string;
            salesEndAt?: string;
        };
        PublicAvailabilityItem: components["schemas"]["PublicAvailabilityTicketItem"] | components["schemas"]["PublicAvailabilityProductItem"];
        PublicQuestionsResponse: {
            buyerQuestions: Array<components["schemas"]["Question"]>;
            attendeeQuestions: Array<components["schemas"]["Question"]>;
        };
        PublicTicketListing: {
            id: string;
            eventId: string;
            ticketTypeId?: string;
            ticketTypeName?: string;
            status: "listed";
            priceCents: number;
            currency: string;
            faceValueCents: number;
            expiresAt?: string;
            createdAt: string;
            updatedAt: string;
        };
        PublicTicketListingPage: {
            items: Array<components["schemas"]["PublicTicketListing"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        CheckoutQuoteLineItem: {
            type?: "ticket" | "product" | "resale";
            ticketTypeId?: string;
            productId?: string;
            resaleListingId?: string;
            name?: string;
            description?: string;
            quantity: number;
            unitPriceCents?: number;
            unitAmountCents?: number;
            subtotalCents?: number;
            discountCents?: number;
            taxCents?: number;
            feeCents?: number;
            buyerFeeCents?: number;
            organizerAbsorbedFeeCents?: number;
            totalCents: number;
        };
        CheckoutSession: {
            id: string;
            eventId: string;
            brandId?: string;
            status: "open" | "pending_payment" | "completed" | "expired" | "cancelled";
            currency: string;
            clientToken?: string;
            quote: {
                totalCents: number;
                subtotalCents: number;
                discountCents: number;
                taxCents: number;
                feeCents: number;
                buyerFeeCents?: number;
                organizerAbsorbedFeeCents?: number;
                lineItems?: Array<components["schemas"]["CheckoutQuoteLineItem"]>;
            };
            paymentIntentId?: string;
            clientSecret?: string;
            successUrl?: string;
            cancelUrl?: string;
            orderId?: string;
            paymentCompensation?: components["schemas"]["PaymentCompensation"];
            expiresAt: string;
        };
        CheckoutSessionUpdateInput: {
            buyer?: {
                email?: string;
                firstName?: string;
                lastName?: string;
                phone?: string;
            };
            successUrl?: string;
            cancelUrl?: string;
        };
        CheckoutWalletPasses: {
            tickets: Array<{
                ticketId: string;
                ticketCode: string;
                faceValueCents: number;
                currency: string;
                resaleEnabled: boolean;
                resaleMaxPriceCents: number;
                activeResaleListing?: components["schemas"]["TicketListing"];
                appleUrl?: string;
                googleUrl?: string;
            }>;
        };
        CreateUploadArtifact: ({
            purpose: "checkout_answer" | "brand_logo" | "user_avatar" | "content_email_image" | "content_event_page_image" | "migration_import" | "event_poster" | "event_cover" | "event_social" | "event_seo_image";
            organizationId?: string;
            fileName: string;
            contentType: string;
            sizeBytes: number;
            brandId?: string;
            eventId?: string;
            metadata?: {
                [key: string]: unknown;
            };
        }) & ({
            purpose?: "migration_import";
            organizationId: string;
            sizeBytes?: number;
            brandId?: never;
            eventId?: never;
        } | {
            purpose?: "checkout_answer" | "brand_logo" | "user_avatar" | "content_email_image" | "content_event_page_image" | "event_poster" | "event_cover" | "event_social" | "event_seo_image";
            organizationId?: never;
        });
        PublicCreateUploadArtifact: {
            fileName: string;
            contentType: string;
            sizeBytes: number;
            questionId: string;
        };
        UploadArtifactTicket: {
            artifactId: string;
            uploadUrl: string;
            uploadHeaders: {
                [key: string]: string;
            };
            completeUrl: string;
            completeToken?: string;
            expiresAt: string;
        };
        PublicCompleteUploadArtifact: {
            token: string;
        };
        CompleteUploadArtifact: Record<string, unknown>;
        UploadArtifactCompleteResult: {
            artifactId: string;
            status: string;
            scanStatus: string;
        };
        UploadArtifactDownload: {
            downloadUrl: string;
            durable?: boolean;
        };
        EventMediaRendition: {
            id: string;
            variant: "thumbnail" | "card" | "page" | "social";
            width: number;
            height: number;
            format: "webp";
            checksumSha256: string;
            sizeBytes: number;
            url: string;
            organizerUrl?: string;
        };
        EventMediaAsset: {
            id: string;
            role: "poster" | "cover" | "social";
            original: {
                uploadArtifactId: string;
                width: number;
                height: number;
                format: "jpeg" | "png" | "webp";
                checksumSha256: string;
                sizeBytes: number;
            };
            focalPoint: {
                x: number;
                y: number;
            };
            altText: string;
            renditions: Array<components["schemas"]["EventMediaRendition"]>;
        };
        AttachEventMedia: {
            uploadArtifactId: string;
            altText: string;
            focalPoint: {
                x: number;
                y: number;
            };
        };
        CheckoutConfirmCompleted: {
            order: components["schemas"]["Order"];
            sessionId: string;
            status: "completed";
        };
        CheckoutConfirmPending: {
            sessionId: string;
            status: "pending_payment";
            paymentIntentId: string;
            clientSecret?: string;
            totalCents: number;
            currency: string;
        };
        CheckoutHostedHandoff: {
            url: string;
            expiresAt: string;
        };
        BoxOfficeOrderInput: {
            tenderType: "comp" | "cash" | "manual_card";
            amountCents: number;
            items: Array<{
                ticketTypeId: string;
                occurrenceId?: string;
                quantity: number;
                attendeeFields?: Array<Record<string, unknown>>;
            }>;
            buyer?: {
                email?: string;
                firstName?: string;
                lastName?: string;
                phone?: string;
            };
            buyerFields?: {
                [key: string]: unknown;
            };
            notes?: string;
        };
        BoxOfficeOrderResult: {
            order: components["schemas"]["Order"];
            sessionId: string;
            status: "completed";
        };
        Order: {
            id: string;
            orderNumber: string;
            status: "draft" | "pending_payment" | "paid" | "partially_refunded" | "refunded" | "cancelled" | "expired" | "disputed";
            currency: string;
            subtotalCents?: number;
            discountCents?: number;
            taxCents?: number;
            feeCents?: number;
            totalCents: number;
            refundedCents?: number;
            buyerEmail: string;
            buyerFirstName?: string;
            buyerLastName?: string;
            salesChannel?: "online" | "box_office";
            operatorId?: string;
            tenderType?: "comp" | "cash" | "manual_card";
            isTest?: boolean;
            paidAt?: string;
            refundedAt?: string;
            cancelledAt?: string;
        };
        OrderDetail: components["schemas"]["Order"] & {
            lineItems: Array<components["schemas"]["OrderLineItem"]>;
            attendees: Array<components["schemas"]["Attendee"]>;
            invoice?: components["schemas"]["Invoice"];
            taxSnapshots: Array<components["schemas"]["TaxSnapshot"]>;
            checkoutAnswers: {
                buyerFields: {
                    [key: string]: unknown;
                };
                attendeeFields: {
                    [key: string]: unknown;
                };
            };
            consentSnapshots: {
                [key: string]: unknown;
            };
            refunds: Array<components["schemas"]["Refund"]>;
            timeline: Array<components["schemas"]["OrderTimelineEvent"]>;
            deliveryStatus: {
                email: "pending" | "not_applicable";
                tickets: "issued" | "not_issued";
            };
        };
        OrderPage: {
            items: Array<components["schemas"]["Order"]>;
            nextCursor?: string | null;
            prevCursor?: string | null;
            total?: number;
            filterTotal?: number;
            facets?: {
                [key: string]: components["schemas"]["AdminTableFacet"];
            };
            applied?: components["schemas"]["AdminTableAppliedQuery"];
        };
        PaymentCompensation: {
            id: string;
            tenantId?: string;
            checkoutSessionId?: string;
            paymentIntentId?: string | null;
            provider: string;
            providerIntentId: string;
            amountCents?: number;
            currency?: string;
            action: string;
            status: "pending" | "succeeded" | "failed" | "manual_review" | "already_ordered";
            providerCompensationId?: string | null;
            attempts: number;
            reason: string;
            lastError?: string | null;
            metadata?: {
                [key: string]: unknown;
            };
            createdAt?: string;
            updatedAt: string;
        };
        PaymentCompensationPage: {
            items: Array<components["schemas"]["PaymentCompensation"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        OrderLineItem: {
            id: string;
            ticketTypeId?: string;
            eventOccurrenceId?: string;
            productId?: string;
            resaleListingId?: string;
            description: string;
            quantity: number;
            unitPriceCents: number;
            subtotalCents?: number;
            totalCents: number;
        };
        TaxSnapshot: {
            id: string;
            orderId: string;
            orderLineItemId: string;
            eventId: string;
            taxRuleId?: string;
            taxRuleName: string;
            rate: number;
            type: "inclusive" | "exclusive";
            appliedTo: "ticket" | "fee" | "all";
            taxableAmountCents: number;
            taxCents: number;
            currency: string;
            inclusive: boolean;
            provider: string;
            providerCalculationId?: string;
            createdAt: string;
        };
        Invoice: {
            id: string;
            orderId: string;
            invoiceNumber: string;
            status: "issued" | "void";
            currency: string;
            subtotalCents: number;
            discountCents: number;
            taxCents: number;
            feeCents: number;
            totalCents: number;
            refundedCents: number;
            buyerEmail: string;
            buyerName?: string;
            buyerTaxId?: string;
            sellerName: string;
            sellerTaxId?: string;
            reverseCharge: boolean;
            issuedAt: string;
        };
        InvoiceDocument: {
            invoice: components["schemas"]["Invoice"];
            order: components["schemas"]["Order"];
            lineItems: Array<components["schemas"]["OrderLineItem"]>;
            taxSnapshots: Array<components["schemas"]["TaxSnapshot"]>;
        };
        OrderTimelineEvent: {
            id: string;
            type: string;
            description: string;
            actorId?: string;
            createdAt: string;
        };
        Refund: {
            id: string;
            orderId: string;
            providerRefundId?: string;
            amountCents: number;
            currency: string;
            status: string;
            reason: string;
            createdAt?: string;
        };
        ApiKey: {
            id: string;
            tenantId: string;
            organizationId: string;
            name: string;
            keyPrefix: string;
            scopes: Array<string>;
            brandIds?: Array<string>;
            eventIds?: Array<string>;
            lastUsedAt?: string;
            expiresAt?: string;
            revokedAt?: string;
            createdAt: string;
            updatedAt: string;
        };
        ApiKeyPage: {
            items: Array<components["schemas"]["ApiKey"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        ApiKeyCreated: (Record<string, unknown>) & (components["schemas"]["ApiKey"] & {
            apiKey: string;
        });
        ScannerDevice: {
            id: string;
            tenantId: string;
            organizationId: string;
            name: string;
            deviceId: string;
            status: "active" | "revoked";
            eventIds: Array<string>;
            scopes: Array<"checkins.read" | "checkins.write">;
            lastSeenAt?: string;
            createdAt: string;
            updatedAt: string;
        };
        ScannerDevicePage: {
            items: Array<components["schemas"]["ScannerDevice"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        ScannerDeviceCreated: (Record<string, unknown>) & (components["schemas"]["ScannerDevice"] & {
            secret: string;
        });
        ScannerDeviceRevoked: {
            deviceId: string;
            status: "revoked";
        };
        Organization: {
            id: string;
            tenantId: string;
            name: string;
            slug: string;
            clerkOrganizationId?: string;
            boxOfficeSettings: components["schemas"]["BoxOfficeSettings"];
            eventDefaults?: components["schemas"]["EventDefaults"];
            status: string;
            createdAt?: string;
            updatedAt?: string;
        };
        EventDefaults: {
            timezone?: string;
            currency?: string;
            country?: string;
            defaultVenueId?: string | null;
            eventDescription?: string;
        };
        SavedVenue: {
            id: string;
            organizationId: string;
            name: string;
            address: Record<string, unknown>;
            timezone?: string;
            createdAt: string;
            updatedAt: string;
        };
        BoxOfficeSettings: {
            enabled: boolean;
            allowedTenderTypes: Array<"cash" | "manual_card" | "comp">;
            requireBuyerEmail: boolean;
            receiptMode: "print" | "email" | "both";
        };
        Brand: {
            id: string;
            tenantId: string;
            organizationId: string;
            name: string;
            slug: string;
            status: string;
            theme?: Record<string, unknown>;
            supportUrl?: string;
            legalUrls?: Record<string, unknown>;
            whiteLabel?: boolean;
            paymentAccountId?: string | null;
            createdAt?: string;
            updatedAt?: string;
        };
        BootstrapOrganization: {
            id: string;
            tenantId: string;
            name: string;
            slug: string;
            status: string;
            boxOfficeSettings?: components["schemas"]["BoxOfficeSettings"];
            eventDefaults?: components["schemas"]["EventDefaults"];
        };
        BootstrapBrand: {
            id: string;
            tenantId: string;
            organizationId: string;
            name: string;
            slug: string;
            status: string;
            theme: Record<string, unknown>;
            domains: Array<components["schemas"]["BrandDomain"]>;
            whiteLabel: boolean;
            paymentAccountId?: string | null;
        };
        BootstrapContext: {
            organizations: Array<components["schemas"]["BootstrapOrganization"]>;
            brands: Array<components["schemas"]["BootstrapBrand"]>;
        };
        BrandDomain: {
            id: string;
            brandId: string;
            domain: string;
            isPrimary: boolean;
            isVerified: boolean;
            verificationToken?: string;
            sslStatus: string;
            createdAt?: string;
            updatedAt?: string;
        };
        BrandSenderIdentity: {
            id: string;
            tenantId: string;
            brandId: string;
            email: string;
            name: string;
            replyToEmail?: string;
            verified: boolean;
            verifiedAt?: string;
            createdAt: string;
            updatedAt: string;
        };
        InventoryPool: {
            id: string;
            eventId: string;
            name: string;
            totalCapacity: number;
            reservedCount: number;
            soldCount: number;
            holdTtlSeconds?: number;
            createdAt?: string;
            updatedAt?: string;
        };
        Attendee: {
            id: string;
            tenantId: string;
            orderId: string;
            eventId: string;
            eventTitle?: string;
            ticketTypeId: string;
            ticketTypeName?: string;
            ticketId?: string;
            firstName?: string;
            lastName?: string;
            email: string;
            phone?: string;
            status: string;
            customAnswers?: Record<string, unknown>;
            checkedInAt?: string;
            checkInDeviceId?: string;
            createdAt?: string;
            updatedAt?: string;
        };
        AttendeeUpdateInput: {
            firstName?: string | null;
            lastName?: string | null;
            email?: string;
            phone?: string | null;
        };
        AttendeePage: {
            items: Array<components["schemas"]["Attendee"]>;
            nextCursor?: string | null;
            prevCursor?: string | null;
            total?: number;
            filterTotal?: number;
            facets?: {
                [key: string]: components["schemas"]["AdminTableFacet"];
            };
            applied?: components["schemas"]["AdminTableAppliedQuery"];
        };
        Ticket: {
            id: string;
            tenantId: string;
            orderId: string;
            attendeeId: string;
            eventId: string;
            ticketTypeId: string;
            status: string;
            code: string;
            qrPayload: string;
            qrHash: string;
            transferredToEmail?: string;
            transferredAt?: string;
            checkedInAt?: string;
            checkedInByDeviceId?: string;
            createdAt?: string;
            updatedAt?: string;
        };
        TicketListing: {
            id: string;
            tenantId: string;
            eventId: string;
            ticketId: string;
            sellerId: string;
            status: "listed" | "delisted" | "sold" | "expired";
            priceCents: number;
            currency: string;
            faceValueCents: number;
            soldToId?: string;
            expiresAt?: string;
            soldAt?: string;
            createdAt: string;
            updatedAt: string;
        };
        TicketListingPage: {
            items: Array<components["schemas"]["TicketListing"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        ResaleSettlementEntry: {
            id: string;
            kind: "payable_accrued" | "payout_recorded" | "payable_reversed" | "recovery_required";
            amountCents: number;
            currency: string;
            actorId: string;
            method: string;
            externalReferenceSha256: string | null;
            reason: string | null;
            createdAt: string;
        };
        ResaleSettlement: {
            id: string;
            listingId: string;
            tenantId: string;
            organizationId: string;
            brandId: string;
            eventId: string;
            sellerOrderId: string | null;
            buyerOrderId: string | null;
            sellerTicketId: string | null;
            buyerTicketId: string | null;
            currency: string;
            grossCents: number | null;
            feeCents: number | null;
            payableCents: number | null;
            paidCents: number | null;
            reversedCents: number | null;
            recoveryCents: number | null;
            state: "pending" | "paid" | "reversed" | "recovery_required" | "review_required";
            termsVersion: string | null;
            version: number;
            createdAt: string;
            updatedAt: string;
            entries: Array<components["schemas"]["ResaleSettlementEntry"]>;
        };
        CheckInList: {
            id: string;
            eventId: string;
            name: string;
            ticketTypeIds: Array<string>;
            status: string;
            createdAt?: string;
            updatedAt?: string;
        };
        CheckInListPage: {
            items: Array<components["schemas"]["CheckInList"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        OfflineManifestTicket: {
            ticketId: string;
            ticketTypeId: string;
            eventOccurrenceId?: string;
            attendeeName: string;
            qrHash: string;
            status: string;
        };
        OfflineManifestTicketV2: components["schemas"]["OfflineManifestTicket"] & {
            status: "valid" | "checked_in" | "void" | "refunded" | "transferred";
        };
        OfflineManifestV1: {
            eventId: string;
            checkInListId: string;
            generatedAt: string;
            expiresAt: string;
            keyId: string;
            signature: string;
            tickets: Array<components["schemas"]["OfflineManifestTicket"]>;
            version?: never;
        };
        OfflineManifestV2: {
            version: 2;
            algorithm: "ES256";
            issuer: string;
            tenantId: string;
            eventId: string;
            checkInListId: string;
            generatedAt: string;
            expiresAt: string;
            keyId: string;
            signature: string;
            tickets: Array<components["schemas"]["OfflineManifestTicketV2"]>;
        };
        OfflineManifest: components["schemas"]["OfflineManifestV1"] | components["schemas"]["OfflineManifestV2"];
        OfflineManifestVerificationKeySet: {
            version: 1;
            issuer: string;
            keys: Array<{
                keyId: string;
                algorithm: "ES256";
                publicKey: {
                    kty: "EC";
                    crv: "P-256";
                    x: string;
                    y: string;
                };
                notBefore: string;
                notAfter: string;
            }>;
        };
        ScanResult: {
            outcome: "accepted" | "duplicate" | "invalid" | "revoked" | "not_found" | "wrong_event" | "wrong_list";
            ticketId?: string;
            message: string;
        };
        SyncScanResult: {
            accepted: number;
            duplicates: number;
            invalid: number;
            results: Array<{
                qrHash?: string;
                outcome?: string;
            }>;
        };
        BulkSyncErrorSample: {
            sequence: number;
            scanIndex: number;
            outcome: string;
            metadata?: {
                [key: string]: unknown;
            };
        };
        BulkSyncJob: {
            id: string;
            tenantId: string;
            eventId: string;
            checkInListId: string;
            deviceId: string;
            totalChunks: number;
            totalScans: number | null;
            chunksReceived: number;
            chunksProcessed: number;
            status: "pending" | "receiving" | "processing" | "completed" | "failed";
            attemptCount: number;
            nextAttemptAt?: string | null;
            leasedUntil?: string | null;
            lastAttemptedAt?: string | null;
            processingStartedAt?: string | null;
            processingCompletedAt?: string | null;
            accepted: number;
            duplicates: number;
            invalid: number;
            processingMetrics: {
                processingDurationMs: number;
                transactionDurationMs: number;
                lockWaitMs: number;
                scanLogInsertDurationMs: number;
                ticketUpdateDurationMs: number;
                attendeeUpdateDurationMs: number;
                rowsProcessed: number;
                clockWarnings: number;
            };
            sampleErrors: Array<components["schemas"]["BulkSyncErrorSample"]>;
            failureMessage?: string | null;
            createdAt?: string;
            updatedAt?: string;
            completedAt?: string | null;
        };
        BulkSyncChunk: {
            id: string;
            jobId: string;
            sequence: number;
            scanCount: number;
            status: "uploaded" | "processing" | "processed" | "failed";
            accepted: number;
            duplicates: number;
            invalid: number;
            clockWarnings: number;
            sampleErrors: Array<components["schemas"]["BulkSyncErrorSample"]>;
            attemptCount: number;
            failureMessage?: string | null;
            createdAt?: string;
            updatedAt?: string;
            processedAt?: string | null;
        };
        BulkSyncChunkList: {
            items: Array<components["schemas"]["BulkSyncChunk"]>;
            total: number;
        };
        AuditLog: {
            id: string;
            tenantId: string;
            organizationId?: string | null;
            brandId?: string | null;
            actorType: string;
            actorId: string;
            action: string;
            resourceType: string;
            resourceId: string;
            diffSummary?: Record<string, unknown> | null;
            requestId?: string | null;
            ip?: string | null;
            userAgent?: string | null;
            createdAt: string;
        };
        WebhookEndpoint: {
            id: string;
            tenantId: string;
            organizationId: string;
            url: string;
            description?: string;
            events: Array<components["schemas"]["WebhookEventType"]>;
            status: "active" | "disabled";
            createdAt: string;
            updatedAt: string;
        };
        WebhookEventType: "order.created" | "order.paid" | "order.refunded" | "order.disputed" | "ticket.issued" | "ticket.checked_in" | "attendee.updated" | "event.published" | "event.cancelled";
        WebhookEndpointCreated: (Record<string, unknown>) & (components["schemas"]["WebhookEndpoint"] & {
            secret: string;
        });
        WebhookEndpointPage: {
            items: Array<components["schemas"]["WebhookEndpoint"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        SalesReport: {
            eventId: string;
            currency: string;
            grossSalesCents: number;
            grossSalesByChannelCents: {
                online: number;
                boxOffice: number;
            };
            netRevenueCents: number;
            refundsCents: number;
            feesCents: number;
            taxCents: number;
            ticketsSold: number;
            checkIns: number;
            ordersCount: number;
            paidOrdersCount: number;
            range: {
                from: string;
                to: string;
            };
        };
        TaxReport: {
            eventId: string;
            currency: string;
            totalTaxCollectedCents: number;
            breakdown: Array<{
                taxRuleName: string;
                rate: number | null;
                taxableAmountCents: number;
                taxCollectedCents: number;
            }>;
        };
        AttendanceReport: {
            eventId: string;
            totalAttendees: number;
            checkedIn: number;
            notCheckedIn: number;
            checkInRate: number;
            breakdownByTicketType: Array<{
                ticketTypeId: string;
                ticketTypeName: string;
                total: number;
                checkedIn: number;
            }>;
        };
        PromoReport: {
            eventId: string;
            discountCodes: Array<{
                code: string;
                usesCount: number;
                discountAmountCents: number;
                revenueAttributedCents: number;
            }>;
        };
        AffiliateReport: {
            organizationId: string;
            affiliates: Array<{
                affiliateId: string;
                code: string;
                name: string;
                referralsCount: number;
                revenueAttributedCents: number;
                commissionCents: number;
            }>;
        };
        ExportJobQueued: {
            exportId: string;
            status: "pending";
        };
        ExportJob: {
            exportId: string;
            eventId?: string;
            type: string;
            format: string;
            status: "pending" | "processing" | "completed" | "failed";
            fileUrl?: string | null;
            downloadUrl?: string | null;
            createdAt: string;
            completedAt?: string | null;
        };
        AuditLogPage: {
            items: Array<components["schemas"]["AuditLog"]>;
            nextCursor?: string | null;
            prevCursor?: string | null;
            total?: number;
            filterTotal?: number;
            facets?: {
                [key: string]: components["schemas"]["AdminTableFacet"];
            };
            applied?: components["schemas"]["AdminTableAppliedQuery"];
        };
        PrivacyRequestInput: ({
            organizationId: string;
            brandId?: string;
            subjectType: "buyer" | "attendee";
            subjectId?: string;
            subjectEmail?: string;
        }) & ({
            subjectId: unknown;
        } | {
            subjectEmail: unknown;
        });
        PrivacyRequest: {
            id: string;
            tenantId: string;
            organizationId: string;
            brandId?: string | null;
            requestType: "export" | "erasure";
            subjectType: "buyer" | "attendee";
            subjectId?: string | null;
            subjectEmail?: string | null;
            status: "pending" | "processing" | "completed" | "failed";
            requestedBy: string;
            result?: Record<string, unknown> | null;
            error?: string | null;
            createdAt: string;
            completedAt?: string | null;
        };
        PrivacyRequestPage: {
            items: Array<components["schemas"]["PrivacyRequest"]>;
            nextCursor?: string | null;
            prevCursor?: string | null;
            total?: number;
            filterTotal?: number;
            facets?: {
                [key: string]: components["schemas"]["AdminTableFacet"];
            };
            applied?: components["schemas"]["AdminTableAppliedQuery"];
        };
        MessageQueued: {
            campaignId: string;
            eventId: string;
            emailTemplateKey?: string;
            smsTemplateKey?: string;
            channel: "email" | "sms" | "both";
            status: "queued" | "failed" | "suppressed";
            audienceCount: number;
            queuedEmailJobs: number;
            queuedSmsJobs: number;
            startFailedEmailJobs: number;
            startFailedSmsJobs: number;
            suppressedRecipients: number;
            consentExclusions: number;
            skippedRecipients: number;
            scheduledAt?: string;
            emailJobIds: Array<string>;
            smsJobIds: Array<string>;
        };
        MessageJob: {
            id: string;
            tenant_id?: string;
            brand_id?: string;
            template_key?: string;
            template_version_id?: string;
            provider_route_id?: string;
            status: string;
            priority?: string;
            scheduled_at?: string | null;
            workflow_id?: string | null;
            recipient?: string;
            created_at?: string;
            updated_at?: string;
        };
        MessageJobEnvelope: {
            channel: "email" | "sms";
            campaignId: string;
            eventId: string;
            job: components["schemas"]["MessageJob"];
        };
        MessageDeliveryLogEnvelope: {
            channel: "email" | "sms";
            campaignId: string;
            eventId: string;
            delivery: {
                [key: string]: unknown;
            };
        };
        MessageProviderEvent: {
            id: string;
            tenant_id?: string | null;
            provider: string;
            provider_event_id: string;
            event_type: string;
            provider_message_id?: string | null;
            processed_at?: string | null;
            created_at: string;
        };
        MessageProviderEventEnvelope: {
            channel: "email" | "sms";
            campaignId: string;
            eventId: string;
            event: components["schemas"]["MessageProviderEvent"];
        };
        WebhookReplayQueued: {
            queued: boolean;
            eventId: string;
            endpoints: number;
        };
        WebhookEndpointReplayQueued: {
            queued: boolean;
            eventId: string;
            endpointId: string;
        };
        WebhookReplayRetryError: {
            code: "REPLAY_DISPATCH_INCOMPLETE" | "REPLAY_FINALIZATION_UNAVAILABLE";
            message: string;
        };
        WebhookReplayUnavailable: {
            queued: false;
            eventId: string;
            error: components["schemas"]["WebhookReplayRetryError"];
        };
        WebhookEndpointReplayUnavailable: {
            queued: false;
            eventId: string;
            endpointId: string;
            error: components["schemas"]["WebhookReplayRetryError"];
        };
        PaymentAccount: {
            id: string;
            tenantId?: string;
            organizationId: string;
            provider: "stripe" | "stripe_connect";
            providerAccountId: string;
            status: "pending" | "active" | "restricted" | "disabled";
            defaultCurrency: string;
            detailsSubmitted: boolean;
            chargesEnabled: boolean;
            payoutsEnabled: boolean;
            requirements: {
                [key: string]: unknown;
            };
            disabledReason: string | null;
            onboardingUrl?: string;
            createdAt?: string;
            updatedAt?: string;
        };
        Question: {
            id: string;
            eventId: string;
            ticketTypeId?: string;
            type: "text" | "textarea" | "email" | "phone" | "select" | "multiselect" | "checkbox" | "date" | "file" | "waiver";
            label: string;
            description?: string;
            required: boolean;
            appliesTo: "buyer" | "attendee" | "both";
            options?: Array<string>;
            placeholder?: string;
            validationPattern?: string;
            conditionalVisibility?: Record<string, unknown>;
            sortOrder: number;
            isConsentField: boolean;
            consentText?: string;
            consentVersion?: string;
            createdAt?: string;
            updatedAt?: string;
        };
        QuestionPage: {
            items: Array<components["schemas"]["Question"]>;
            nextCursor: string | null;
            hasMore: boolean;
        };
        ReorderQuestionsRequest: {
            questions: Array<{
                id: string;
                sortOrder: number;
            }>;
        };
        RefundQueued: {
            orderId: string;
            refundAmount: number;
            status: "pending";
            message: string;
        };
        AgentPrincipal: {
            id: string;
            tenantId: string;
            kind: "third_party" | "self_hosted";
            sponsorPrincipalId: string;
            capabilities: Array<"events.read" | "events.prepare" | "events.execute" | "readiness.read">;
            maximumAutonomy: "read" | "recommend" | "prepare" | "execute_with_approval";
            protocolVersion: string;
            state: "active" | "suspended" | "revoked";
            registeredAt: string;
            updatedAt?: string;
        };
        AgentPrincipal20260802: {
            id: string;
            tenantId: string;
            kind: "third_party" | "self_hosted";
            sponsorPrincipalId: string;
            capabilities: Array<"events.read" | "events.prepare" | "events.execute" | "readiness.read" | "content.prepare">;
            maximumAutonomy: "read" | "recommend" | "prepare" | "execute_with_approval";
            protocolVersion: string;
            state: "active" | "suspended" | "revoked";
            registeredAt: string;
            updatedAt?: string;
        };
        AgentPrincipal20260803: {
            id: string;
            tenantId: string;
            kind: "third_party" | "self_hosted";
            sponsorPrincipalId: string;
            capabilities: Array<"events.read" | "events.prepare" | "events.execute" | "readiness.read" | "content.prepare" | "campaigns.prepare">;
            maximumAutonomy: "read" | "recommend" | "prepare" | "execute_with_approval";
            protocolVersion: string;
            state: "active" | "suspended" | "revoked";
            registeredAt: string;
            updatedAt?: string;
        };
        AgentPrincipalResponse: components["schemas"]["AgentPrincipal"] | components["schemas"]["AgentPrincipal20260802"] | components["schemas"]["AgentPrincipal20260803"];
        AgentOAuthClient: {
            id: string;
            tenantId: string;
            organizationId: string;
            agentPrincipalId: string;
            name: string;
            clientId: string;
            clientSecret?: string;
            scope: "agent.invoke";
            status: "active" | "revoked";
            createdAt: string;
            updatedAt: string;
        };
        AgentOAuthClientCreated: {
            id: string;
            tenantId: string;
            organizationId: string;
            agentPrincipalId: string;
            name: string;
            clientId: string;
            clientSecret: string;
            scope: "agent.invoke";
            status: "active" | "revoked";
            createdAt: string;
            updatedAt: string;
        };
        AgentSession: {
            principal: components["schemas"]["AgentPrincipal"] & {
                updatedAt: string;
            };
            authentication: {
                grantType: "client_credentials";
                scope: "agent.invoke";
                productPermissions: Array<string>;
            };
            delegationRequired: true;
            supportedProtocolVersion: string;
        };
        AgentSession20260802: {
            principal: components["schemas"]["AgentPrincipal20260802"] & {
                updatedAt: string;
            };
            authentication: {
                grantType: "client_credentials";
                scope: "agent.invoke";
                productPermissions: Array<string>;
            };
            delegationRequired: true;
            supportedProtocolVersion: string;
        };
        AgentSession20260803: {
            principal: components["schemas"]["AgentPrincipal20260803"] & {
                updatedAt: string;
            };
            authentication: {
                grantType: "client_credentials";
                scope: "agent.invoke";
                productPermissions: Array<string>;
            };
            delegationRequired: true;
            supportedProtocolVersion: string;
        };
        AgentSessionResponse: components["schemas"]["AgentSession"] | components["schemas"]["AgentSession20260802"] | components["schemas"]["AgentSession20260803"];
        AgentAction: {
            id: string;
            protocolVersion: "2026-07-22";
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            kind: "event.publish";
            autonomy: "execute_with_approval";
            target: {
                tenantId: string;
                resourceType: "event";
                resourceId: string;
                resourceVersion: number;
                apiOperation: "events.publish";
            };
            payload: {
                readinessSnapshotSha256: string;
            };
            idempotencyKey: string;
            expectedPolicyVersion: number;
            preparedAt: string;
        };
        AgentReadinessReadAction: {
            id: string;
            protocolVersion: "2026-07-22";
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            kind: "readiness.read";
            autonomy: "read";
            target: {
                tenantId: string;
                resourceType: "event";
                resourceId: string;
                resourceVersion: number;
                apiOperation: "events.readiness.get";
            };
            payload: {
                readinessSnapshotSha256: string;
            };
            idempotencyKey: string;
            expectedPolicyVersion: number;
            preparedAt: string;
        };
        AgentReadinessReadResult: {
            resourceId: string;
            resourceVersion: number;
            status: "ready" | "blocked";
            readinessSnapshotSha256: string;
            generatedAt: string;
            published: boolean;
            blockerReasonCodes: Array<string>;
            warningReasonCodes: Array<string>;
        };
        AgentEventReadAction: {
            id: string;
            protocolVersion: "2026-07-22";
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            kind: "event.read";
            autonomy: "read";
            target: {
                tenantId: string;
                resourceType: "event";
                resourceId: string;
                resourceVersion: number;
                apiOperation: "events.get";
            };
            payload: {
                eventSnapshotSha256: string;
            };
            idempotencyKey: string;
            expectedPolicyVersion: number;
            preparedAt: string;
        };
        AgentEventReadResult: {
            resourceId: string;
            resourceVersion: number;
            eventSnapshotSha256: string;
            observedAt: string;
            event: {
                title: string;
                description: string | null;
                status: "draft" | "published" | "paused" | "ended" | "archived";
                currency: string;
                timezone: string;
                startsAt: string;
                endsAt: string | null;
                visibility: "public" | "unlisted" | "private";
                capacity: number | null;
                minimumAge: number | null;
            };
            untrustedContentPaths: Array<"event.title" | "event.description">;
        };
        AgentReportReadAction: {
            id: string;
            protocolVersion: "2026-07-22";
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            kind: "report.read";
            autonomy: "read";
            target: {
                tenantId: string;
                resourceType: "event";
                resourceId: string;
                resourceVersion: number;
                apiOperation: "reports.get";
            };
            payload: {
                reportType: "event_sales";
                from: string;
                to: string;
                reportSnapshotSha256: string;
            };
            idempotencyKey: string;
            expectedPolicyVersion: number;
            preparedAt: string;
        };
        AgentReportReadResult: {
            resourceId: string;
            resourceVersion: number;
            reportType: "event_sales";
            from: string;
            to: string;
            reportSnapshotSha256: string;
            observedAt: string;
            report: {
                currency: string;
                grossSalesCents: number;
                grossSalesByChannelCents: {
                    online: number;
                    boxOffice: number;
                };
                netRevenueCents: number;
                refundsCents: number;
                feesCents: number;
                taxCents: number;
                ticketsSold: number;
                checkIns: number;
                ordersCount: number;
                paidOrdersCount: number;
            };
            untrustedContentPaths: Array<never>;
        };
        AgentEventPrepareChanges: {
            title?: string;
            slug?: string;
            description?: string;
            currency?: string;
            timezone?: string;
            startsAt?: string;
            endsAt?: string | null;
            venue?: {
                [key: string]: unknown;
            } | null;
            venueId?: string | null;
            visibility?: "public" | "unlisted" | "private";
            seo?: {
                title?: string;
                description?: string;
                imageUrl?: string;
            };
            capacity?: number | null;
            minimumAge?: number | null;
            coverImageUrl?: string | null;
            externalUrl?: string | null;
            coverImageAlt?: string | null;
            seoUseCoverImage?: boolean;
            lastSetupSection?: string | null;
        };
        AgentEventPrepareProjection: {
            title?: string;
            slug?: string;
            description?: string | null;
            currency?: string;
            timezone?: string;
            startsAt?: string;
            endsAt?: string | null;
            venue?: {
                [key: string]: unknown;
            } | null;
            venueId?: string | null;
            visibility?: "public" | "unlisted" | "private";
            seo?: {
                title?: string;
                description?: string;
                imageUrl?: string;
            };
            capacity?: number | null;
            minimumAge?: number | null;
            coverImageUrl?: string | null;
            externalUrl?: string | null;
            coverImageAlt?: string | null;
            seoUseCoverImage?: boolean;
            lastSetupSection?: string | null;
        };
        AgentEventPrepareResolvedChanges: components["schemas"]["AgentEventPrepareProjection"] & {
            description?: string;
            coverImageUrl?: string | null;
            seo?: {
                title?: string;
                description?: string;
                imageUrl?: string;
            };
        };
        AgentEventPrepareAction: {
            id: string;
            protocolVersion: "2026-07-22";
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            kind: "event.prepare";
            autonomy: "prepare";
            target: {
                tenantId: string;
                resourceType: "event";
                resourceId: string;
                resourceVersion: number;
                apiOperation: "events.prepare";
            };
            payload: {
                changePreviewSha256: string;
                changes: components["schemas"]["AgentEventPrepareResolvedChanges"];
            };
            idempotencyKey: string;
            expectedPolicyVersion: number;
            preparedAt: string;
        };
        AgentEventPrepareResult: {
            resourceId: string;
            resourceVersion: number;
            changePreviewSha256: string;
            observedAt: string;
            changedFields: Array<"capacity" | "coverImageAlt" | "coverImageUrl" | "currency" | "description" | "endsAt" | "externalUrl" | "lastSetupSection" | "minimumAge" | "seo" | "seoUseCoverImage" | "slug" | "startsAt" | "timezone" | "title" | "venue" | "venueId" | "visibility">;
            before: components["schemas"]["AgentEventPrepareProjection"];
            after: components["schemas"]["AgentEventPrepareResolvedChanges"];
            untrustedContentPaths: Array<string>;
        };
        AgentSafeEventPageContent: {
            schemaVersion: 2;
            editor: {
                provider: "@puckeditor/core";
                data: {
                    root: {
                        props: {
                            [key: string]: string;
                        };
                    };
                    content: Array<({
                        type: "EventHeader" | "EventDescription" | "Divider" | "Tickets" | "ResaleTickets" | "CheckoutCta" | "BrandFooter";
                        props: {
                            id: string;
                            brandLabel?: string;
                            title?: string;
                            description?: string;
                            startsAtLabel?: string;
                            timezone?: string;
                            venueName?: string;
                            imageUrl?: string;
                            imageAlt?: string;
                            imageFit?: string;
                            imagePosition?: string;
                            overlayContentPosition?: string;
                            overlayContentHorizontalPosition?: string;
                            overlayMinHeight?: string;
                            overlayPadding?: string;
                            contentPadding?: string;
                            contentGap?: string;
                            imageOpacity?: string;
                            backgroundOverlayColor?: string;
                            backgroundOverlayOpacity?: string;
                            logoPosition?: string;
                            logoSize?: string;
                            logoMaxHeight?: string;
                            logoMaxWidth?: string;
                            eyebrow?: string;
                            body?: string;
                            alignment?: string;
                            titleAlignment?: string;
                            bodyAlignment?: string;
                            imageAlignment?: string;
                            spacing?: string;
                            backgroundColor?: string;
                            imageLayout?: string;
                            imagePositionX?: string;
                            imagePositionY?: string;
                            imageRadius?: string;
                            eyebrowFontSize?: string;
                            titleFontSize?: string;
                            bodyFontSize?: string;
                            eyebrowColor?: string;
                            titleColor?: string;
                            bodyColor?: string;
                            contentBackgroundColor?: string;
                            contentRadius?: string;
                            emptyTitle?: string;
                            emptyDescription?: string;
                            badgeLabel?: string;
                            label?: string;
                            supportingText?: string;
                            showDate?: boolean;
                            showTimezone?: boolean;
                            showVenue?: boolean;
                            showBrandBadge?: boolean;
                            logos?: Array<unknown>;
                            imageOverlay?: Array<unknown>;
                            imagePlacement?: {
                                x?: string;
                                y?: string;
                                scale?: string;
                            };
                        };
                    }) & (unknown & unknown & unknown & unknown & unknown & unknown & unknown)>;
                };
            };
            settings: {
                locale: string;
                publicPath: string;
                discovery: {
                    summary: string;
                    category?: string;
                    tags: Array<string>;
                    coverImageUrl?: string;
                    socialImageUrl?: string;
                    seoTitle?: string;
                    seoDescription?: string;
                };
            };
        };
        AgentContentPrepareValidation: ({
            valid: boolean;
            severity: "error" | "warning";
            issueCodes: Array<string>;
        }) & (unknown & unknown);
        AgentContentPreparePreview: {
            provider: "@puckeditor/core";
            discovery: {
                title: string;
                summary: string;
                category?: string;
                tags: Array<string>;
                imageUrl?: string;
                startsAt?: string;
                venueName?: string;
                publicPath?: string;
            };
        };
        AgentContentPreparePayload: {
            channel: "event_page";
            content: components["schemas"]["AgentSafeEventPageContent"];
            preview: components["schemas"]["AgentContentPreparePreview"];
            validation: components["schemas"]["AgentContentPrepareValidation"];
            contentPreviewSha256: string;
        };
        AgentContentPrepareAction: {
            id: string;
            protocolVersion: "2026-07-22";
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            kind: "content.prepare";
            autonomy: "prepare";
            target: {
                tenantId: string;
                resourceType: "event";
                resourceId: string;
                resourceVersion: number;
                apiOperation: "content.prepare";
            };
            payload: components["schemas"]["AgentContentPreparePayload"];
            idempotencyKey: string;
            expectedPolicyVersion: number;
            preparedAt: string;
        };
        AgentContentPrepareResult: {
            resourceId: string;
            resourceVersion: number;
            channel: "event_page";
            content: components["schemas"]["AgentSafeEventPageContent"];
            preview: components["schemas"]["AgentContentPreparePreview"];
            validation: components["schemas"]["AgentContentPrepareValidation"];
            contentPreviewSha256: string;
            observedAt: string;
            untrustedContentPaths: Array<never>;
        };
        AgentCampaignTemplateVersion: {
            channel: "email" | "sms";
            templateKey: string;
            versionId: string;
            contentSha256: string;
        };
        AgentCampaignPreparePayload: {
            audience: "all" | "checked_in" | "not_checked_in" | "specific";
            channel: "email" | "sms" | "both";
            requestedAttendeeIds: Array<string>;
            templateVersions: Array<components["schemas"]["AgentCampaignTemplateVersion"]>;
            contentVersionSha256: string;
            audienceSnapshotSha256: string;
            exclusionSnapshotSha256: string;
            complianceResultSha256: string;
            audienceCount: number;
            eligibleRecipientCount: number;
            eligibleDeliveryCount: number;
            suppressedDeliveryCount: number;
            consentExclusionCount: number;
            missingContactCount: number;
        };
        AgentCampaignPrepareAction: {
            id: string;
            protocolVersion: "2026-07-22";
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            kind: "campaign.prepare";
            autonomy: "prepare";
            target: {
                tenantId: string;
                resourceType: "event";
                resourceId: string;
                resourceVersion: number;
                apiOperation: "campaigns.prepare";
            };
            payload: components["schemas"]["AgentCampaignPreparePayload"];
            idempotencyKey: string;
            expectedPolicyVersion: number;
            preparedAt: string;
        };
        AgentCampaignPrepareResult: {
            audience: "all" | "checked_in" | "not_checked_in" | "specific";
            channel: "email" | "sms" | "both";
            requestedAttendeeIds: Array<string>;
            templateVersions: Array<components["schemas"]["AgentCampaignTemplateVersion"]>;
            contentVersionSha256: string;
            audienceSnapshotSha256: string;
            exclusionSnapshotSha256: string;
            complianceResultSha256: string;
            audienceCount: number;
            eligibleRecipientCount: number;
            eligibleDeliveryCount: number;
            suppressedDeliveryCount: number;
            consentExclusionCount: number;
            missingContactCount: number;
            resourceId: string;
            resourceVersion: number;
            observedAt: string;
            untrustedContentPaths: Array<never>;
        };
        AgentEventUpdateAction: {
            id: string;
            protocolVersion: "2026-07-22";
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            kind: "event.update";
            autonomy: "execute_with_approval";
            target: {
                tenantId: string;
                resourceType: "event";
                resourceId: string;
                resourceVersion: number;
                apiOperation: "events.update";
            };
            payload: {
                changePreviewSha256: string;
                changes: components["schemas"]["AgentEventPrepareResolvedChanges"];
            };
            idempotencyKey: string;
            expectedPolicyVersion: number;
            preparedAt: string;
        };
        AgentEventUpdatePreview: components["schemas"]["AgentEventPrepareResult"];
        PreparedAgentAction: {
            action: components["schemas"]["AgentAction"];
            actionDigest: string;
            expiresAt: string;
            authorization: {
                eligibleForApproval: boolean;
                reasons: Array<string>;
                snapshotSha256: string;
                checkedAt: string;
            };
            dryRun: {
                launchable: boolean;
                readinessSnapshotSha256: string;
                blockingReasonCodes: Array<string>;
            };
        };
        PreparedAgentReadinessReadAction: {
            action: components["schemas"]["AgentReadinessReadAction"];
            actionDigest: string;
            expiresAt: string;
            authorization: {
                allowed: true;
                eligibleForApproval: false;
                reasons: Array<string>;
                snapshotSha256: string;
                checkedAt: string;
            };
            dryRun: {
                launchable: boolean;
                readinessSnapshotSha256: string;
                blockingReasonCodes: Array<string>;
            };
            result: components["schemas"]["AgentReadinessReadResult"];
            resultSha256: string;
        };
        PreparedAgentEventReadAction: {
            action: components["schemas"]["AgentEventReadAction"];
            actionDigest: string;
            expiresAt: string;
            authorization: {
                allowed: true;
                eligibleForApproval: false;
                reasons: Array<string>;
                snapshotSha256: string;
                checkedAt: string;
            };
            result: components["schemas"]["AgentEventReadResult"];
            resultSha256: string;
        };
        PreparedAgentReportReadAction: {
            action: components["schemas"]["AgentReportReadAction"];
            actionDigest: string;
            expiresAt: string;
            authorization: {
                allowed: true;
                eligibleForApproval: false;
                reasons: Array<string>;
                snapshotSha256: string;
                checkedAt: string;
            };
            result: components["schemas"]["AgentReportReadResult"];
            resultSha256: string;
        };
        PreparedAgentEventPrepareAction: {
            action: components["schemas"]["AgentEventPrepareAction"];
            actionDigest: string;
            expiresAt: string;
            authorization: {
                allowed: true;
                eligibleForApproval: false;
                reasons: Array<string>;
                snapshotSha256: string;
                checkedAt: string;
            };
            result: components["schemas"]["AgentEventPrepareResult"];
            resultSha256: string;
        };
        PreparedAgentContentPrepareAction: {
            action: components["schemas"]["AgentContentPrepareAction"];
            actionDigest: string;
            expiresAt: string;
            authorization: {
                allowed: true;
                eligibleForApproval: false;
                reasons: Array<string>;
                snapshotSha256: string;
                checkedAt: string;
            };
            result: components["schemas"]["AgentContentPrepareResult"];
            resultSha256: string;
        };
        PreparedAgentCampaignPrepareAction: {
            action: components["schemas"]["AgentCampaignPrepareAction"];
            actionDigest: string;
            expiresAt: string;
            authorization: {
                allowed: true;
                eligibleForApproval: false;
                reasons: Array<string>;
                snapshotSha256: string;
                checkedAt: string;
            };
            result: components["schemas"]["AgentCampaignPrepareResult"];
            resultSha256: string;
        };
        PreparedAgentEventUpdateAction: {
            action: components["schemas"]["AgentEventUpdateAction"];
            actionDigest: string;
            expiresAt: string;
            authorization: {
                eligibleForApproval: boolean;
                reasons: Array<string>;
                snapshotSha256: string;
                checkedAt: string;
            };
            preview: components["schemas"]["AgentEventUpdatePreview"];
            previewSha256: string;
        };
        AgentApproval: {
            id: string;
            tenantId: string;
            actionDigest: string;
            planSha256?: string;
            approverPrincipalId: string;
            approverPermissionSnapshot: Array<"events:publish">;
            policyVersion: number;
            approvedAt: string;
            expiresAt: string;
            revokedAt?: string;
            consumedAt?: string;
        };
        AgentEventUpdateApproval: {
            id: string;
            tenantId: string;
            actionDigest: string;
            approverPrincipalId: string;
            approverPermissionSnapshot: Array<"events:write">;
            policyVersion: number;
            approvedAt: string;
            expiresAt: string;
            revokedAt?: string;
            consumedAt?: string;
        };
        AgentExecution: {
            id: string;
            tenantId: string;
            actionId: string;
            actionDigest: string;
            planSha256?: string;
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            approvalId: string;
            idempotencyKey: string;
            requestFingerprint: string;
            state: "reserved" | "running" | "succeeded" | "failed" | "compensated";
            resourceVersion: number;
            policyVersion: number;
            fenceToken: number;
            leaseOwner?: string;
            leaseExpiresAt?: string;
            result?: {
                resourceId: string;
                resourceVersion: number;
                status: "published";
            };
            failureCode?: string;
            createdAt: string;
            updatedAt: string;
        };
        AgentEventUpdateExecution: {
            id: string;
            tenantId: string;
            actionId: string;
            actionDigest: string;
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            approvalId: string;
            idempotencyKey: string;
            requestFingerprint: string;
            state: "reserved" | "running" | "succeeded" | "failed";
            resourceVersion: number;
            policyVersion: number;
            fenceToken: number;
            leaseOwner?: string;
            leaseExpiresAt?: string;
            result?: {
                resourceId: string;
                resourceVersion: number;
                status: "updated";
            };
            failureCode?: string;
            createdAt: string;
            updatedAt: string;
        };
        AgentExecutionAuditRecord: {
            id: string;
            tenantId: string;
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            delegationGrantId: string;
            actionId: string;
            actionDigest: string;
            planSha256?: string;
            approvalId: string;
            phase: "prepared" | "authorized" | "denied" | "started" | "succeeded" | "failed" | "compensated";
            idempotencyKey: string;
            resourceVersion: number;
            occurredAt: string;
            reasonCodes: Array<string>;
        };
        AgentExecutionEvidence: {
            execution: components["schemas"]["AgentExecution"];
            audit: Array<components["schemas"]["AgentExecutionAuditRecord"]>;
        };
        AgentEventUpdateExecutionEvidence: {
            execution: components["schemas"]["AgentEventUpdateExecution"];
            audit: Array<components["schemas"]["AgentExecutionAuditRecord"]>;
        };
        AgentDelegation: {
            id: string;
            tenantId: string;
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            capabilities: Array<"events.read" | "events.prepare" | "events.execute" | "readiness.read">;
            resourceScopes: Array<string>;
            permissionSnapshot: Array<string>;
            issuedAt: string;
            expiresAt: string;
            revokedAt?: string;
        };
        AgentDelegation20260802: {
            id: string;
            tenantId: string;
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            capabilities: Array<"events.read" | "events.prepare" | "events.execute" | "readiness.read" | "content.prepare">;
            resourceScopes: Array<string>;
            permissionSnapshot: Array<string>;
            issuedAt: string;
            expiresAt: string;
            revokedAt?: string;
        };
        AgentDelegation20260803: {
            id: string;
            tenantId: string;
            agentPrincipalId: string;
            sponsorPrincipalId: string;
            capabilities: Array<"events.read" | "events.prepare" | "events.execute" | "readiness.read" | "content.prepare" | "campaigns.prepare">;
            resourceScopes: Array<string>;
            permissionSnapshot: Array<string>;
            issuedAt: string;
            expiresAt: string;
            revokedAt?: string;
        };
        AgentDelegationResponse: components["schemas"]["AgentDelegation"] | components["schemas"]["AgentDelegation20260802"] | components["schemas"]["AgentDelegation20260803"];
        AgentMemoryNamespaceRequest: {
            scopeType: "workspace";
            purpose: "organizer_preferences" | "project_context";
        } | {
            scopeType: "event";
            scopeId: string;
            purpose: "organizer_preferences" | "project_context";
        };
        AgentMemoryNamespace: {
            tenantId: string;
            sponsorPrincipalId: string;
            scopeType: "workspace" | "event";
            scopeId?: string;
            purpose: "organizer_preferences" | "project_context";
        };
        AgentMemoryOrganizerPreferences: {
            kind: "organizer_preferences";
            summary: string;
            tone?: "concise" | "warm" | "formal" | "direct";
            verbosity?: "brief" | "standard" | "detailed";
            locale?: string;
            timezone?: string;
            currency?: string;
        };
        AgentMemoryProjectContext: {
            kind: "project_context";
            summary: string;
            facts?: Array<{
                kind: "objective" | "constraint" | "decision";
                text: string;
            }>;
        };
        AgentMemoryContent: components["schemas"]["AgentMemoryOrganizerPreferences"] | components["schemas"]["AgentMemoryProjectContext"];
        AgentMemoryProvenance: {
            type: "organizer" | "agent_observation" | "import";
            actorPrincipalId: string;
            agentPrincipalId?: string;
            sourceReference?: string;
            observedAt: string;
        };
        AgentMemoryCreateRequest: {
            namespace: components["schemas"]["AgentMemoryNamespaceRequest"] & {
                purpose: "organizer_preferences";
            };
            key: string;
            content: components["schemas"]["AgentMemoryOrganizerPreferences"];
            retentionExpiresAt: string;
        } | {
            namespace: components["schemas"]["AgentMemoryNamespaceRequest"] & {
                purpose: "project_context";
            };
            key: string;
            content: components["schemas"]["AgentMemoryProjectContext"];
            retentionExpiresAt: string;
        };
        AgentMemoryNamespaceRequestBody: {
            namespace: components["schemas"]["AgentMemoryNamespaceRequest"];
        };
        AgentMemoryCorrectRequest: {
            expectedVersion: number;
            content: components["schemas"]["AgentMemoryContent"];
            retentionExpiresAt: string;
        };
        AgentMemoryDeleteRequest: {
            namespace: components["schemas"]["AgentMemoryNamespaceRequest"];
            expectedVersion: number;
        };
        AgentMemoryEntry: {
            id: string;
            namespace: components["schemas"]["AgentMemoryNamespace"];
            key: string;
            content: components["schemas"]["AgentMemoryContent"];
            contentSha256: string;
            provenance: components["schemas"]["AgentMemoryProvenance"];
            version: number;
            retentionExpiresAt: string;
            createdAt: string;
            updatedAt: string;
        };
        AgentMemoryExportBundle: {
            schemaVersion: 1;
            exportedAt: string;
            namespace: components["schemas"]["AgentMemoryNamespace"];
            entries: Array<components["schemas"]["AgentMemoryEntry"]>;
            sha256: string;
        };
        OAuthApplication: {
            id: string;
            tenantId?: string;
            organizationId: string;
            name: string;
            clientId: string;
            redirectUris: Array<string>;
            scopes: Array<string>;
            status: "active" | "disabled" | "revoked";
            createdAt?: string;
            updatedAt?: string;
        };
        OAuthApplicationCreated: (Record<string, unknown>) & (components["schemas"]["OAuthApplication"] & {
            clientSecret: string;
        });
        OAuthTokenResponse: {
            access_token: string;
            token_type: "Bearer";
            expires_in: number;
            scope: string;
            refresh_token?: string;
        };
    };
}

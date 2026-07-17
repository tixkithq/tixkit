export type AuthorizationBoundary =
  | 'brand'
  | 'event'
  | 'organization'
  | 'owner'
  | 'permission'
  | 'principal-type'
  | 'tenant';

export type AuthorizationSideEffectKind = 'persistence' | 'workflow';

export type AuthorizationPolicyCondition =
  | Readonly<{ discriminator: 'principal-scope'; value: 'organization-wide' }>
  | Readonly<{ discriminator: 'purpose'; value: 'user_avatar' }>;

export type RouteAuthorizationDenialContract = Readonly<{
  authorizedControl: Readonly<{
    required: true;
    status: 200 | 201 | 202 | 204;
  }>;
  denialResponse: Readonly<{
    code: 'NOT_FOUND';
    status: 404;
  }>;
  deniedBoundaries: readonly AuthorizationBoundary[];
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST';
  operationId: string;
  path: string;
  permissionDenialResponse?: Readonly<{
    code: 'FORBIDDEN';
    status: 403;
  }>;
  policyDenialResponse?: Readonly<{
    code: 'FORBIDDEN';
    status: 403;
  }>;
  policyCondition?: AuthorizationPolicyCondition;
  policyDeniedBoundaries?: readonly AuthorizationBoundary[];
  persistenceSource?: string;
  resourceParameters: readonly string[];
  sideEffectAssertions: readonly AuthorizationSideEffectKind[];
  source: string;
}>;

function denialContract(
  contract: RouteAuthorizationDenialContract,
): RouteAuthorizationDenialContract {
  return Object.freeze({
    ...contract,
    authorizedControl: Object.freeze({ ...contract.authorizedControl }),
    denialResponse: Object.freeze({ ...contract.denialResponse }),
    deniedBoundaries: Object.freeze([...contract.deniedBoundaries]),
    ...(contract.permissionDenialResponse
      ? { permissionDenialResponse: Object.freeze({ ...contract.permissionDenialResponse }) }
      : {}),
    ...(contract.policyDenialResponse
      ? { policyDenialResponse: Object.freeze({ ...contract.policyDenialResponse }) }
      : {}),
    ...(contract.policyCondition
      ? { policyCondition: Object.freeze({ ...contract.policyCondition }) }
      : {}),
    ...(contract.policyDeniedBoundaries
      ? { policyDeniedBoundaries: Object.freeze([...contract.policyDeniedBoundaries]) }
      : {}),
    resourceParameters: Object.freeze([...contract.resourceParameters]),
    sideEffectAssertions: Object.freeze([...contract.sideEffectAssertions]),
  });
}

const eventReadPaths = [
  ['/events/{eventId}', 'getEventsByEventId'],
  ['/events/{eventId}/attendees', 'getEventsByEventIdAttendees'],
  ['/events/{eventId}/availability', 'getEventsByEventIdAvailability'],
  ['/events/{eventId}/check-in-lists', 'getEventsByEventIdCheckInLists'],
  ['/events/{eventId}/launch-readiness', 'getEventsByEventIdLaunchReadiness'],
  ['/events/{eventId}/media', 'getEventsByEventIdMedia'],
  ['/events/{eventId}/messages', 'getEventsByEventIdMessages'],
  ['/events/{eventId}/questions', 'getEventsByEventIdQuestions'],
  ['/events/{eventId}/reports/sales', 'getEventsByEventIdReportsSales'],
  ['/events/{eventId}/waitlist', 'getEventsByEventIdWaitlist'],
] as const;

export const EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  ...eventReadPaths.map(([path, operationId]) =>
    denialContract({
      authorizedControl: { required: true, status: 200 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'event'],
      method: 'GET',
      operationId,
      path,
      resourceParameters: ['eventId'],
      sideEffectAssertions: [],
      source: 'event-route-authorization-db.integration.test.ts',
    }),
  ),
  ...(
    [
      ['/events/{eventId}/check-in-lists', 'postEventsByEventIdCheckInLists'],
      ['/events/{eventId}/product-categories', 'postEventsByEventIdProductCategories'],
      ['/events/{eventId}/questions', 'postEventsByEventIdQuestions'],
    ] as const
  ).map(([path, operationId]) =>
    denialContract({
      authorizedControl: { required: true, status: 201 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'event'],
      method: 'POST',
      operationId,
      path,
      persistenceSource: 'event-route-authorization-db.integration.test.ts',
      resourceParameters: ['eventId'],
      sideEffectAssertions: ['persistence'],
      source: 'event-route-authorization-db.integration.test.ts',
    }),
  ),
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postEventsByEventIdReadinessAcknowledgementsByStepId',
    path: '/events/{eventId}/readiness-acknowledgements/{stepId}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId', 'stepId'],
    sideEffectAssertions: ['persistence'],
    source: 'event-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 204 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'DELETE',
    operationId: 'deleteEventsByEventIdReadinessAcknowledgementsByStepId',
    path: '/events/{eventId}/readiness-acknowledgements/{stepId}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId', 'stepId'],
    sideEffectAssertions: ['persistence'],
    source: 'event-route-authorization-db.integration.test.ts',
  }),
]);

export const ORDER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  ...(
    [
      ['/orders/{orderId}', 'getOrdersByOrderId'],
      ['/orders/{orderId}/invoice', 'getOrdersByOrderIdInvoice'],
      ['/orders/{orderId}/invoice/download', 'getOrdersByOrderIdInvoiceDownload'],
    ] as const
  ).map(([path, operationId]) =>
    denialContract({
      authorizedControl: { required: true, status: 200 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      method: 'GET',
      operationId,
      path,
      resourceParameters: ['orderId'],
      sideEffectAssertions: [],
      source: 'order-route-authorization-db.integration.test.ts',
    }),
  ),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postOrdersByOrderIdCancel',
    path: '/orders/{orderId}/cancel',
    persistenceSource: 'order-route-authorization-db.integration.test.ts',
    resourceParameters: ['orderId'],
    sideEffectAssertions: ['persistence'],
    source: 'order-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 202 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postOrdersByOrderIdRefunds',
    path: '/orders/{orderId}/refunds',
    persistenceSource: 'order-route-authorization-db.integration.test.ts',
    resourceParameters: ['orderId'],
    sideEffectAssertions: ['persistence', 'workflow'],
    source: 'order-route-authorization-db.integration.test.ts',
  }),
]);

export const PROVIDER_INCIDENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'GET',
    operationId: 'getProviderIncidents',
    path: '/provider-incidents',
    resourceParameters: [],
    sideEffectAssertions: [],
    source: 'provider-incident-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'postProviderIncidentsByEvidenceIdReveal',
    path: '/provider-incidents/{evidenceId}/reveal',
    persistenceSource: 'provider-incident-route-authorization-db.integration.test.ts',
    resourceParameters: ['evidenceId'],
    sideEffectAssertions: ['persistence'],
    source: 'provider-incident-route-authorization-db.integration.test.ts',
  }),
]);

export const MIGRATION_CREDENTIAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['organization'],
    method: 'POST',
    operationId: 'createMigrationCredential',
    path: '/migration-credentials',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'import-platform.integration.test.ts',
    resourceParameters: [],
    sideEffectAssertions: ['persistence'],
    source: 'migration-credential-route-authorization.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 204 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'DELETE',
    operationId: 'revokeMigrationCredential',
    path: '/migration-credentials/{credentialId}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'import-platform.integration.test.ts',
    resourceParameters: ['credentialId'],
    sideEffectAssertions: ['persistence'],
    source: 'migration-credential-route-authorization.test.ts',
  }),
]);

export const API_KEY_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postApiKeys',
    path: '/api-keys',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'api-key-route-authorization-db.integration.test.ts',
    resourceParameters: [],
    sideEffectAssertions: ['persistence'],
    source: 'api-key-route-authorization.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 204 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'DELETE',
    operationId: 'deleteApiKeysByKeyId',
    path: '/api-keys/{keyId}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'api-key-route-authorization-db.integration.test.ts',
    resourceParameters: ['keyId'],
    sideEffectAssertions: ['persistence'],
    source: 'api-key-route-authorization.test.ts',
  }),
]);

export const SCANNER_DEVICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postScannerDevices',
    path: '/scanner-devices',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'scanner-device-route-authorization-db.integration.test.ts',
    resourceParameters: [],
    sideEffectAssertions: ['persistence'],
    source: 'scanner-device-route-authorization.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postScannerDevicesByDeviceIdRevoke',
    path: '/scanner-devices/{deviceId}/revoke',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'scanner-device-route-authorization-db.integration.test.ts',
    resourceParameters: ['deviceId'],
    sideEffectAssertions: ['persistence'],
    source: 'scanner-device-route-authorization.test.ts',
  }),
]);

export const ATTENDEE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'PATCH',
    operationId: 'patchAttendeesByAttendeeId',
    path: '/attendees/{attendeeId}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'attendee-route-authorization-db.integration.test.ts',
    resourceParameters: ['attendeeId'],
    sideEffectAssertions: ['persistence'],
    source: 'attendee-route-authorization-db.integration.test.ts',
  }),
]);

export const CHECK_IN_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postCheckInsScan',
    path: '/check-ins/scan',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'checkin-scan-route-authorization-db.integration.test.ts',
    resourceParameters: [],
    sideEffectAssertions: ['persistence'],
    source: 'checkin-scan-route-authorization-db.integration.test.ts',
  }),
]);

export const BOX_OFFICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postEventsByEventIdBoxOfficeOrders',
    path: '/events/{eventId}/box-office/orders',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'box-office-orders-db.integration.test.ts',
    resourceParameters: ['eventId'],
    sideEffectAssertions: ['persistence', 'workflow'],
    source: 'box-office-routes.test.ts',
  }),
]);

export const PAYMENT_ACCOUNT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'postOrganizationsByOrganizationIdPaymentAccountsStripeConnect',
    path: '/organizations/{organizationId}/payment-accounts/stripe-connect',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'payment-account-route-authorization-db.integration.test.ts',
    resourceParameters: ['organizationId'],
    sideEffectAssertions: ['persistence'],
    source: 'payment-account-route-authorization-db.integration.test.ts',
  }),
]);

export const UPLOAD_ARTIFACT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: [],
    method: 'POST',
    operationId: 'postUploadArtifacts',
    path: '/upload-artifacts',
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'purpose', value: 'user_avatar' },
    policyDeniedBoundaries: ['principal-type'],
    persistenceSource: 'upload-artifact-route-authorization-db.integration.test.ts',
    resourceParameters: [],
    sideEffectAssertions: ['persistence'],
    source: 'upload-artifact-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'owner'],
    method: 'POST',
    operationId: 'postUploadArtifactsByArtifactIdComplete',
    path: '/upload-artifacts/{artifactId}/complete',
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'purpose', value: 'user_avatar' },
    policyDeniedBoundaries: ['principal-type'],
    persistenceSource: 'upload-artifact-route-authorization-db.integration.test.ts',
    resourceParameters: ['artifactId'],
    sideEffectAssertions: ['persistence'],
    source: 'upload-artifact-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'owner'],
    method: 'GET',
    operationId: 'getUploadArtifactsByArtifactIdDownload',
    path: '/upload-artifacts/{artifactId}/download',
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'purpose', value: 'user_avatar' },
    policyDeniedBoundaries: ['principal-type'],
    resourceParameters: ['artifactId'],
    sideEffectAssertions: [],
    source: 'upload-artifact-route-authorization-db.integration.test.ts',
  }),
]);

export const RESALE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postTicketsByTicketIdResaleListings',
    path: '/tickets/{ticketId}/resale-listings',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'resale-routes-db.integration.test.ts',
    resourceParameters: ['ticketId'],
    sideEffectAssertions: ['persistence'],
    source: 'resale-routes-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postTicketListingsByListingIdDelist',
    path: '/ticket-listings/{listingId}/delist',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'resale-routes-db.integration.test.ts',
    resourceParameters: ['listingId'],
    sideEffectAssertions: ['persistence'],
    source: 'resale-routes-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postTicketsByTicketIdTransfer',
    path: '/tickets/{ticketId}/transfer',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'resale-routes-db.integration.test.ts',
    resourceParameters: ['ticketId'],
    sideEffectAssertions: ['persistence'],
    source: 'resale-routes-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'GET',
    operationId: 'getTicketListingsByListingIdSettlement',
    path: '/ticket-listings/{listingId}/settlement',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    resourceParameters: ['listingId'],
    sideEffectAssertions: [],
    source: 'resale-settlement-routes.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postTicketListingsByListingIdSettlementPayouts',
    path: '/ticket-listings/{listingId}/settlement/payouts',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'resale-settlement-concurrency-db.integration.test.ts',
    resourceParameters: ['listingId'],
    sideEffectAssertions: ['persistence'],
    source: 'resale-settlement-routes.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postTicketListingsByListingIdSettlementReversals',
    path: '/ticket-listings/{listingId}/settlement/reversals',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'resale-settlement-concurrency-db.integration.test.ts',
    resourceParameters: ['listingId'],
    sideEffectAssertions: ['persistence'],
    source: 'resale-settlement-routes.test.ts',
  }),
]);

export const WEBHOOK_REPLAY_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze(
  (
    [
      [
        '/webhook-endpoints/{endpointId}/events/{eventId}/replay',
        'postWebhookEndpointsByEndpointIdEventsByEventIdReplay',
        ['endpointId', 'eventId'],
      ],
      ['/webhook-events/{eventId}/replay', 'postWebhookEventsByEventIdReplay', ['eventId']],
    ] as const
  ).map(([path, operationId, resourceParameters]) =>
    denialContract({
      authorizedControl: { required: true, status: 202 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'organization'],
      method: 'POST',
      operationId,
      path,
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
      policyDeniedBoundaries: ['brand', 'event'],
      persistenceSource: 'webhook-replay-route-authorization-db.integration.test.ts',
      resourceParameters,
      sideEffectAssertions: ['persistence', 'workflow'],
      source: 'webhook-replay-route-authorization-db.integration.test.ts',
    }),
  ),
);

export const WEBHOOK_TEST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 202 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'postWebhookEndpointsByEndpointIdTest',
    path: '/webhook-endpoints/{endpointId}/test',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'webhook-replay-route-authorization-db.integration.test.ts',
    resourceParameters: ['endpointId'],
    sideEffectAssertions: ['persistence', 'workflow'],
    source: 'webhook-replay-route-authorization-db.integration.test.ts',
  }),
]);

export const ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  ...EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...ORDER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...PROVIDER_INCIDENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_CREDENTIAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...API_KEY_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...SCANNER_DEVICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...ATTENDEE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...CHECK_IN_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...BOX_OFFICE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...PAYMENT_ACCOUNT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...UPLOAD_ARTIFACT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...RESALE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...WEBHOOK_REPLAY_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...WEBHOOK_TEST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
]);

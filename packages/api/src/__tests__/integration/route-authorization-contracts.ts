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
  | Readonly<{
      discriminator: 'principal-scope';
      value: 'no-event-scope' | 'organization-wide';
    }>
  | Readonly<{ discriminator: 'purpose'; value: 'user_avatar' }>;

export type RouteAuthorizationDenialContract = Readonly<{
  authorizedControl: Readonly<{
    required: true;
    status: 200 | 201 | 202 | 204 | 410;
  }>;
  denialResponse: Readonly<{
    code: 'NOT_FOUND';
    status: 404;
  }>;
  deniedBoundaries: readonly AuthorizationBoundary[];
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
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
  ...(
    [
      ['/events/{eventId}/product-categories', 'postEventsByEventIdProductCategories'],
      ['/events/{eventId}/products', 'postEventsByEventIdProducts'],
    ] as const
  ).map(([path, operationId]) =>
    denialContract({
      authorizedControl: { required: true, status: 201 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      method: 'POST',
      operationId,
      path,
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      persistenceSource: 'product-catalog-route-authorization-db.integration.test.ts',
      resourceParameters: ['eventId'],
      sideEffectAssertions: ['persistence'],
      source: 'product-catalog-route-authorization-db.integration.test.ts',
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
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'GET',
    operationId: 'getEventsByEventIdOperationalHealth',
    path: '/events/{eventId}/operational-health',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    resourceParameters: ['eventId'],
    sideEffectAssertions: [],
    source: 'event-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postEventsByEventIdDuplicate',
    path: '/events/{eventId}/duplicate',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-duplication-db.integration.test.ts',
    resourceParameters: ['eventId'],
    sideEffectAssertions: ['persistence'],
    source: 'event-duplication-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postEventsByEventIdOccurrences',
    path: '/events/{eventId}/occurrences',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-occurrence-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId'],
    sideEffectAssertions: ['persistence'],
    source: 'event-occurrence-route-authorization-db.integration.test.ts',
  }),
  ...(
    [
      ['/events/{eventId}/inventory-pools', 'postEventsByEventIdInventoryPools'],
      ['/events/{eventId}/ticket-types', 'postEventsByEventIdTicketTypes'],
      ['/events/{eventId}/ticket-types/batch', 'postEventsByEventIdTicketTypesBatch'],
    ] as const
  ).map(([path, operationId]) =>
    denialContract({
      authorizedControl: { required: true, status: 201 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      method: 'POST',
      operationId,
      path,
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      persistenceSource: 'ticket-configuration-route-authorization-db.integration.test.ts',
      resourceParameters: ['eventId'],
      sideEffectAssertions: ['persistence'],
      source: 'ticket-configuration-route-authorization-db.integration.test.ts',
    }),
  ),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'PATCH',
    operationId: 'patchEventsByEventIdOccurrencesByOccurrenceId',
    path: '/events/{eventId}/occurrences/{occurrenceId}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-occurrence-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId', 'occurrenceId'],
    sideEffectAssertions: ['persistence'],
    source: 'event-occurrence-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'PATCH',
    operationId: 'patchEventsByEventId',
    path: '/events/{eventId}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId'],
    sideEffectAssertions: ['persistence'],
    source: 'event-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'PUT',
    operationId: 'putEventsByEventIdCodeFormat',
    path: '/events/{eventId}/code-format',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId'],
    sideEffectAssertions: ['persistence'],
    source: 'event-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'PUT',
    operationId: 'putEventsByEventIdFeePolicy',
    path: '/events/{eventId}/fee-policy',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId'],
    sideEffectAssertions: ['persistence'],
    source: 'event-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'PUT',
    operationId: 'putEventsByEventIdResalePolicy',
    path: '/events/{eventId}/resale-policy',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'resale-policy-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId'],
    sideEffectAssertions: ['persistence'],
    source: 'resale-policy-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'PUT',
    operationId: 'putEventsByEventIdMarketingIntegrationsByProvider',
    path: '/events/{eventId}/marketing-integrations/{provider}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'marketing-integration-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId', 'provider'],
    sideEffectAssertions: ['persistence'],
    source: 'marketing-integration-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postEventsByEventIdQuestionsReorder',
    path: '/events/{eventId}/questions/reorder',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'question-reorder-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId'],
    sideEffectAssertions: ['persistence'],
    source: 'question-reorder-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postEventsByEventIdWaitlistByEntryIdOffer',
    path: '/events/{eventId}/waitlist/{entryId}/offer',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'waitlist-offer-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId', 'entryId'],
    sideEffectAssertions: ['persistence'],
    source: 'waitlist-offer-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'PATCH',
    operationId: 'patchEventsByEventIdWaitlistSettings',
    path: '/events/{eventId}/waitlist/settings',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'waitlist-settings-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId'],
    sideEffectAssertions: ['persistence'],
    source: 'waitlist-settings-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'PUT',
    operationId: 'putEventsByEventIdSetupSection',
    path: '/events/{eventId}/setup-section',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId'],
    sideEffectAssertions: ['persistence'],
    source: 'event-route-authorization-db.integration.test.ts',
  }),
  ...(
    [
      ['/events/{eventId}/pause', 'postEventsByEventIdPause'],
      ['/events/{eventId}/archive', 'postEventsByEventIdArchive'],
      ['/events/{eventId}/publish', 'postEventsByEventIdPublish'],
    ] as const
  ).map(([path, operationId]) =>
    denialContract({
      authorizedControl: { required: true, status: 200 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
      method: 'POST',
      operationId,
      path,
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      persistenceSource: 'event-route-authorization-db.integration.test.ts',
      resourceParameters: ['eventId'],
      sideEffectAssertions: ['persistence'],
      source: 'event-route-authorization-db.integration.test.ts',
    }),
  ),
]);

export const EVENT_MEDIA_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'PUT',
    operationId: 'putEventsByEventIdMediaByRole',
    path: '/events/{eventId}/media/{role}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-media-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId', 'role'],
    sideEffectAssertions: ['persistence'],
    source: 'event-media-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 204 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'DELETE',
    operationId: 'deleteEventsByEventIdMediaByRole',
    path: '/events/{eventId}/media/{role}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'event-media-route-authorization-db.integration.test.ts',
    resourceParameters: ['eventId', 'role'],
    sideEffectAssertions: ['persistence'],
    source: 'event-media-route-authorization-db.integration.test.ts',
  }),
]);

export const ORGANIZATION_READINESS_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze(
  (
    [
      ['/organizations/{organizationId}/readiness', 'getOrganizationsByOrganizationIdReadiness'],
      [
        '/organizations/{organizationId}/dashboard-actions',
        'getOrganizationsByOrganizationIdDashboardActions',
      ],
    ] as const
  ).map(([path, operationId]) =>
    denialContract({
      authorizedControl: { required: true, status: 200 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'organization', 'brand'],
      method: 'GET',
      operationId,
      path,
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      resourceParameters: ['organizationId'],
      sideEffectAssertions: [],
      source: 'event-route-authorization-db.integration.test.ts',
    }),
  ),
);

export const TENANT_LIST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: [],
    method: 'GET',
    operationId: 'getOrganizations',
    path: '/organizations',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    resourceParameters: [],
    sideEffectAssertions: [],
    source: 'tenant-list-route-authorization-db.integration.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: [],
    method: 'GET',
    operationId: 'getBrands',
    path: '/brands',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'no-event-scope' },
    policyDeniedBoundaries: ['event'],
    resourceParameters: [],
    sideEffectAssertions: [],
    source: 'tenant-list-route-authorization-db.integration.test.ts',
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

export const MIGRATION_ADAPTER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: [],
    method: 'GET',
    operationId: 'listMigrationAdapters',
    path: '/migration-adapters',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    resourceParameters: [],
    sideEffectAssertions: [],
    source: 'migration-credential-route-authorization.test.ts',
  }),
]);

export const MIGRATION_JOB_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze(
  (
    [
      ['/migration-jobs/{jobId}', 'getMigrationJob'],
      ['/migration-jobs/{jobId}/files', 'listMigrationJobFiles'],
      ['/migration-jobs/{jobId}/rows', 'listMigrationJobRows'],
      ['/migration-jobs/{jobId}/conflicts', 'listMigrationJobConflicts'],
      ['/migration-jobs/{jobId}/events', 'listMigrationJobEvents'],
      ['/migration-jobs/{jobId}/rollback-assessment', 'assessMigrationRollback'],
      ['/migration-jobs/{jobId}/report', 'getMigrationReport'],
      ['/migration-jobs/{jobId}/report/download', 'downloadMigrationReport'],
    ] as const
  ).map(([path, operationId]) =>
    denialContract({
      authorizedControl: { required: true, status: 200 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'organization'],
      method: 'GET',
      operationId,
      path,
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
      policyDeniedBoundaries: ['brand', 'event'],
      resourceParameters: ['jobId'],
      sideEffectAssertions: [],
      source: 'migration-job-read-route-authorization-db.integration.test.ts',
    }),
  ),
);

export const MIGRATION_LIST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze(
  (
    [
      ['/migration-jobs', 'listMigrationJobs'],
      ['/migration-mappings', 'listMigrationMappings'],
    ] as const
  ).map(([path, operationId]) =>
    denialContract({
      authorizedControl: { required: true, status: 200 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['organization'],
      method: 'GET',
      operationId,
      path,
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
      policyDeniedBoundaries: ['brand', 'event'],
      resourceParameters: [],
      sideEffectAssertions: [],
      source: 'migration-job-read-route-authorization-db.integration.test.ts',
    }),
  ),
);

export const PORTABLE_REBINDING_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'GET',
    operationId: 'getPortableMigrationRebindings',
    path: '/migration-jobs/{jobId}/portable-rebindings',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    resourceParameters: ['jobId'],
    sideEffectAssertions: [],
    source: 'migration-job-read-route-authorization-db.integration.test.ts',
  }),
]);

export const MIGRATION_MAPPING_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'createMigrationMapping',
    path: '/migration-mappings',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'migration-mapping-route-authorization-db.integration.test.ts',
    resourceParameters: [],
    sideEffectAssertions: ['persistence'],
    source: 'migration-mapping-route-authorization-db.integration.test.ts',
  }),
]);

export const MIGRATION_JOB_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'createMigrationJob',
    path: '/migration-jobs',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'migration-job-write-route-authorization-db.integration.test.ts',
    resourceParameters: [],
    sideEffectAssertions: ['persistence'],
    source: 'migration-job-write-route-authorization-db.integration.test.ts',
  }),
]);

export const PORTABLE_MIGRATION_JOB_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'createPortableMigrationJob',
    path: '/portable-migration-jobs',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'migration-job-write-route-authorization-db.integration.test.ts',
    resourceParameters: [],
    sideEffectAssertions: ['persistence'],
    source: 'migration-job-write-route-authorization-db.integration.test.ts',
  }),
]);

export const MIGRATION_FILE_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'registerMigrationJobFile',
    path: '/migration-jobs/{jobId}/files',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'migration-file-route-authorization-db.integration.test.ts',
    resourceParameters: ['jobId'],
    sideEffectAssertions: ['persistence'],
    source: 'migration-file-route-authorization-db.integration.test.ts',
  }),
]);

export const MIGRATION_PREPARE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 202 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'prepareMigrationJob',
    path: '/migration-jobs/{jobId}/prepare',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'migration-prepare-route-authorization-db.integration.test.ts',
    resourceParameters: ['jobId'],
    sideEffectAssertions: ['persistence', 'workflow'],
    source: 'migration-prepare-route-authorization-db.integration.test.ts',
  }),
]);

export const MIGRATION_COMMIT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 202 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'commitMigrationJob',
    path: '/migration-jobs/{jobId}/commit',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'migration-commit-route-authorization-db.integration.test.ts',
    resourceParameters: ['jobId'],
    sideEffectAssertions: ['persistence', 'workflow'],
    source: 'migration-commit-route-authorization-db.integration.test.ts',
  }),
]);

export const MIGRATION_LIFECYCLE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze(
  (
    [
      ['pause', 'pauseMigrationJob'],
      ['resume', 'resumeMigrationJob'],
      ['cancel', 'cancelMigrationJob'],
      ['rollback', 'rollbackMigrationJob'],
    ] as const
  ).map(([action, operationId]) =>
    denialContract({
      authorizedControl: { required: true, status: 202 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'organization'],
      method: 'POST',
      operationId,
      path: `/migration-jobs/{jobId}/${action}`,
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
      policyDeniedBoundaries: ['brand', 'event'],
      persistenceSource: 'migration-lifecycle-route-authorization-db.integration.test.ts',
      resourceParameters: ['jobId'],
      sideEffectAssertions: ['persistence', 'workflow'],
      source: 'migration-lifecycle-route-authorization-db.integration.test.ts',
    }),
  ),
);

export const MIGRATION_DRY_RUN_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'runMigrationDryRun',
    path: '/migration-jobs/{jobId}/dry-run',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'migration-dry-run-route-authorization-db.integration.test.ts',
    resourceParameters: ['jobId'],
    sideEffectAssertions: ['persistence'],
    source: 'migration-dry-run-route-authorization-db.integration.test.ts',
  }),
]);

export const PORTABLE_MIGRATION_APPROVAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'approvePortableMigrationJob',
    path: '/migration-jobs/{jobId}/portable-approval',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'portable-import-control.integration.test.ts',
    resourceParameters: ['jobId'],
    sideEffectAssertions: ['persistence'],
    source: 'portable-import-control.integration.test.ts',
  }),
]);

export const PORTABLE_MIGRATION_APPROVAL_REVOCATION_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS =
  Object.freeze([
    denialContract({
      authorizedControl: { required: true, status: 200 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'organization'],
      method: 'POST',
      operationId: 'revokePortableMigrationApproval',
      path: '/migration-jobs/{jobId}/portable-approvals/{approvalId}/revoke',
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
      policyDeniedBoundaries: ['brand', 'event'],
      persistenceSource: 'portable-import-control.integration.test.ts',
      resourceParameters: ['jobId', 'approvalId'],
      sideEffectAssertions: ['persistence'],
      source: 'portable-import-control.integration.test.ts',
    }),
  ]);

export const PORTABLE_MIGRATION_REBINDING_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS =
  Object.freeze([
    denialContract({
      authorizedControl: { required: true, status: 200 },
      denialResponse: { code: 'NOT_FOUND', status: 404 },
      deniedBoundaries: ['tenant', 'organization'],
      method: 'PUT',
      operationId: 'bindPortableMigrationDestination',
      path: '/migration-jobs/{jobId}/portable-rebindings/{portableId}',
      permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
      policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
      policyDeniedBoundaries: ['brand', 'event'],
      persistenceSource: 'portable-import-control.integration.test.ts',
      resourceParameters: ['jobId', 'portableId'],
      sideEffectAssertions: ['persistence'],
      source: 'portable-import-control.integration.test.ts',
    }),
  ]);

export const PORTABLE_MIGRATION_ACTIVATION_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId: 'activatePortableMigrationJob',
    path: '/migration-jobs/{jobId}/activate',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'portable-import-control.integration.test.ts',
    resourceParameters: ['jobId'],
    sideEffectAssertions: ['persistence'],
    source: 'portable-import-control.integration.test.ts',
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
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['organization'],
    method: 'GET',
    operationId: 'getApiKeys',
    path: '/api-keys',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    resourceParameters: [],
    sideEffectAssertions: [],
    source: 'api-key-route-authorization-db.integration.test.ts',
  }),
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

export const OAUTH_APPLICATION_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  denialContract({
    authorizedControl: { required: true, status: 201 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['organization'],
    method: 'POST',
    operationId: 'postOauthApplications',
    path: '/oauth-applications',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'oauth-application-route-authorization-db.integration.test.ts',
    resourceParameters: [],
    sideEffectAssertions: ['persistence'],
    source: 'oauth-application-route-authorization.test.ts',
  }),
  denialContract({
    authorizedControl: { required: true, status: 204 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'DELETE',
    operationId: 'deleteOauthApplicationsByAppId',
    path: '/oauth-applications/{appId}',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyDenialResponse: { code: 'FORBIDDEN', status: 403 },
    policyCondition: { discriminator: 'principal-scope', value: 'organization-wide' },
    policyDeniedBoundaries: ['brand', 'event'],
    persistenceSource: 'oauth-application-route-authorization-db.integration.test.ts',
    resourceParameters: ['appId'],
    sideEffectAssertions: ['persistence'],
    source: 'oauth-application-route-authorization.test.ts',
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
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'GET',
    operationId: 'getOrganizationsByOrganizationIdPaymentAccounts',
    path: '/organizations/{organizationId}/payment-accounts',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    resourceParameters: ['organizationId'],
    sideEffectAssertions: [],
    source: 'payment-account-route-authorization-db.integration.test.ts',
  }),
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
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization'],
    method: 'POST',
    operationId:
      'postOrganizationsByOrganizationIdPaymentAccountsByPaymentAccountIdStripeConnectRefresh',
    path: '/organizations/{organizationId}/payment-accounts/{paymentAccountId}/stripe-connect/refresh',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'payment-account-route-authorization-db.integration.test.ts',
    resourceParameters: ['organizationId', 'paymentAccountId'],
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
    authorizedControl: { required: true, status: 410 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: [],
    method: 'POST',
    operationId: 'postTicketListingsByListingIdComplete',
    path: '/ticket-listings/{listingId}/complete',
    permissionDenialResponse: { code: 'FORBIDDEN', status: 403 },
    persistenceSource: 'resale-routes-db.integration.test.ts',
    resourceParameters: ['listingId'],
    sideEffectAssertions: ['persistence'],
    source: 'resale-routes-db.integration.test.ts',
  }),
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
  ...EVENT_MEDIA_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...ORGANIZATION_READINESS_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...TENANT_LIST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...ORDER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...PROVIDER_INCIDENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_ADAPTER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_JOB_READ_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_LIST_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...PORTABLE_REBINDING_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_MAPPING_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_JOB_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...PORTABLE_MIGRATION_JOB_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_FILE_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_PREPARE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_COMMIT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_LIFECYCLE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_DRY_RUN_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...PORTABLE_MIGRATION_APPROVAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...PORTABLE_MIGRATION_APPROVAL_REVOCATION_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...PORTABLE_MIGRATION_REBINDING_WRITE_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...PORTABLE_MIGRATION_ACTIVATION_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...MIGRATION_CREDENTIAL_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...API_KEY_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...OAUTH_APPLICATION_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
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

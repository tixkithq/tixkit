export type AuthorizationBoundary = 'brand' | 'event' | 'organization' | 'tenant';

export type AuthorizationSideEffectKind = 'persistence' | 'workflow';

export type RouteAuthorizationDenialContract = Readonly<{
  authorizedControl: Readonly<{
    required: true;
    status: 200 | 201 | 202;
  }>;
  denialResponse: Readonly<{
    code: 'NOT_FOUND';
    status: 404;
  }>;
  deniedBoundaries: readonly AuthorizationBoundary[];
  method: 'GET' | 'POST';
  operationId: string;
  path: string;
  resourceParameters: readonly string[];
  sideEffectAssertions: readonly AuthorizationSideEffectKind[];
}>;

function denialContract(
  contract: RouteAuthorizationDenialContract,
): RouteAuthorizationDenialContract {
  return Object.freeze({
    ...contract,
    authorizedControl: Object.freeze({ ...contract.authorizedControl }),
    denialResponse: Object.freeze({ ...contract.denialResponse }),
    deniedBoundaries: Object.freeze([...contract.deniedBoundaries]),
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
      resourceParameters: ['eventId'],
      sideEffectAssertions: ['persistence'],
    }),
  ),
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
    }),
  ),
  denialContract({
    authorizedControl: { required: true, status: 200 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postOrdersByOrderIdCancel',
    path: '/orders/{orderId}/cancel',
    resourceParameters: ['orderId'],
    sideEffectAssertions: ['persistence'],
  }),
  denialContract({
    authorizedControl: { required: true, status: 202 },
    denialResponse: { code: 'NOT_FOUND', status: 404 },
    deniedBoundaries: ['tenant', 'organization', 'brand', 'event'],
    method: 'POST',
    operationId: 'postOrdersByOrderIdRefunds',
    path: '/orders/{orderId}/refunds',
    resourceParameters: ['orderId'],
    sideEffectAssertions: ['persistence', 'workflow'],
  }),
]);

export const ROUTE_AUTHORIZATION_DENIAL_CONTRACTS = Object.freeze([
  ...EVENT_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
  ...ORDER_ROUTE_AUTHORIZATION_DENIAL_CONTRACTS,
]);

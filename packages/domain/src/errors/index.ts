export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
};

export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYMENT_REQUIRED'
  | 'PAYMENT_FAILED'
  | 'INVENTORY_EXHAUSTED'
  | 'HOLD_EXPIRED'
  | 'CHECKOUT_EXPIRED'
  | 'DISCOUNT_INVALID'
  | 'DISCOUNT_EXHAUSTED'
  | 'ACCESS_CODE_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TENANT_MISMATCH'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} not found: ${id}`, 404, { resource, id });
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string = 'You do not have permission to perform this action') {
    super('FORBIDDEN', message, 403);
    this.name = 'ForbiddenError';
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message: string = 'Authentication required') {
    super('UNAUTHORIZED', message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, 400, details);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, 409, details);
    this.name = 'ConflictError';
  }
}

export class InventoryExhaustedError extends DomainError {
  constructor(ticketTypeId: string, requested: number, available: number) {
    super(
      'INVENTORY_EXHAUSTED',
      `Insufficient inventory for ticket type ${ticketTypeId}: requested ${requested}, available ${available}`,
      409,
      { ticketTypeId, requested, available },
    );
    this.name = 'InventoryExhaustedError';
  }
}

export class HoldExpiredError extends DomainError {
  constructor(holdId: string) {
    super('HOLD_EXPIRED', `Checkout hold ${holdId} has expired`, 409, { holdId });
    this.name = 'HoldExpiredError';
  }
}

export class CheckoutExpiredError extends DomainError {
  constructor(sessionId: string) {
    super('CHECKOUT_EXPIRED', `Checkout session ${sessionId} has expired`, 409, { sessionId });
    this.name = 'CheckoutExpiredError';
  }
}

export class DiscountInvalidError extends DomainError {
  constructor(code: string, reason: string) {
    super('DISCOUNT_INVALID', `Discount code "${code}" is invalid: ${reason}`, 400, { code, reason });
    this.name = 'DiscountInvalidError';
  }
}

export class AccessCodeRequiredError extends DomainError {
  constructor(ticketTypeId: string) {
    super('ACCESS_CODE_REQUIRED', `Ticket type ${ticketTypeId} requires an access code`, 403, {
      ticketTypeId,
    });
    this.name = 'AccessCodeRequiredError';
  }
}

export class PaymentFailedError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('PAYMENT_FAILED', message, 402, details);
    this.name = 'PaymentFailedError';
  }
}

export class RateLimitedError extends DomainError {
  constructor(message: string = 'Rate limit exceeded') {
    super('RATE_LIMITED', message, 429);
    this.name = 'RateLimitedError';
  }
}

export class TenantMismatchError extends DomainError {
  constructor(message: string = 'Resource does not belong to the requested tenant') {
    super('TENANT_MISMATCH', message, 403);
    this.name = 'TenantMismatchError';
  }
}

export class WebhookSignatureError extends DomainError {
  constructor(message: string = 'Webhook signature verification failed') {
    super('WEBHOOK_SIGNATURE_INVALID', message, 401);
    this.name = 'WebhookSignatureError';
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(key: string) {
    super('IDEMPOTENCY_CONFLICT', `Idempotency key ${key} was used with a different request body`, 409, {
      key,
    });
    this.name = 'IdempotencyConflictError';
  }
}

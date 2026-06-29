/**
 * Box-office / card-present POS sales mode (C-072).
 *
 * Domain logic for authenticated in-person order creation, reusing the
 * existing inventory/hold/finalize/issuance workflow with an explicit
 * sales channel and operator attribution. Supports comp, cash, and manual
 * (card-not-present) tender. Pure validation/state; persistence + the actual
 * inventory calls live in the API route and workflow activities.
 */

export type SalesChannel = 'online' | 'box_office';

export type BoxOfficeTenderType = 'comp' | 'cash' | 'manual_card';

export type BoxOfficeOrderInput = {
  eventId: string;
  tenantId: string;
  operatorId: string;
  tenderType: BoxOfficeTenderType;
  items: { ticketTypeId: string; quantity: number }[];
  buyerEmail?: string;
  amountCents?: number;
  currency: string;
  notes?: string;
};

export type BoxOfficeOrder = {
  salesChannel: SalesChannel;
  operatorId: string;
  tenderType: BoxOfficeTenderType;
  amountCents: number;
  currency: string;
  items: { ticketTypeId: string; quantity: number }[];
  buyerEmail?: string;
  notes?: string;
};

export class BoxOfficeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoxOfficeError';
  }
}

const VALID_TENDERS = new Set<BoxOfficeTenderType>(['comp', 'cash', 'manual_card']);

export function validateBoxOfficeOrder(input: BoxOfficeOrderInput): BoxOfficeOrder {
  if (!input.operatorId) {
    throw new BoxOfficeError('Operator attribution (operatorId) is required for box-office sales');
  }
  if (!VALID_TENDERS.has(input.tenderType)) {
    throw new BoxOfficeError(`Invalid tender type: ${input.tenderType}`);
  }
  if (!input.items || input.items.length === 0) {
    throw new BoxOfficeError('At least one line item is required');
  }
  for (const item of input.items) {
    if (item.quantity < 1 || !Number.isInteger(item.quantity)) {
      throw new BoxOfficeError(`Invalid quantity for ticket type ${item.ticketTypeId}`);
    }
  }
  if (input.tenderType === 'comp' && input.amountCents && input.amountCents > 0) {
    throw new BoxOfficeError('Comp orders must have a zero amount');
  }
  if (input.tenderType !== 'comp' && (input.amountCents === undefined || input.amountCents < 0)) {
    throw new BoxOfficeError(`${input.tenderType} tender requires a non-negative amount`);
  }
  if (input.tenderType === 'cash' && input.amountCents === 0) {
    throw new BoxOfficeError('Cash tender must have a positive amount');
  }
  return {
    salesChannel: 'box_office',
    operatorId: input.operatorId,
    tenderType: input.tenderType,
    amountCents: input.amountCents ?? 0,
    currency: input.currency,
    items: input.items,
    buyerEmail: input.buyerEmail,
    notes: input.notes,
  };
}

/** Group revenue by sales channel for reporting. */
export function groupRevenueByChannel(
  orders: { salesChannel: SalesChannel; amountCents: number }[],
): Record<SalesChannel, number> {
  const totals: Record<SalesChannel, number> = { online: 0, box_office: 0 };
  for (const order of orders) {
    totals[order.salesChannel] += order.amountCents;
  }
  return totals;
}

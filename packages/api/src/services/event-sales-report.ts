import type { Database } from '@tixkit/db';
import { groupRevenueByChannel, type SalesChannel } from '@tixkit/domain';

export interface EventSalesReportInput {
  tenantId: string;
  eventId: string;
  organizationId?: string;
  brandId?: string;
  eventCurrency?: string | null;
  from?: Date;
  to?: Date;
  observedAt: Date;
}

export interface EventSalesReport {
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
}

export async function resolveEventSalesReport(
  db: Database,
  input: EventSalesReportInput,
): Promise<EventSalesReport> {
  let totalsQuery = db
    .selectFrom('orders')
    .select(({ fn }) => [
      fn.countAll<number>().as('paid_orders_count'),
      fn.sum<number>('total_cents').as('gross_sales_cents'),
      fn.sum<number>('fee_cents').as('fees_cents'),
      fn.sum<number>('tax_cents').as('tax_cents'),
    ])
    .where('event_id', '=', input.eventId)
    .where('tenant_id', '=', input.tenantId)
    .where('is_test', '=', false)
    .where('status', 'in', ['paid', 'partially_refunded', 'refunded']);
  if (input.organizationId)
    totalsQuery = totalsQuery.where('organization_id', '=', input.organizationId);
  if (input.brandId) totalsQuery = totalsQuery.where('brand_id', '=', input.brandId);
  if (input.from) totalsQuery = totalsQuery.where('created_at', '>=', input.from);
  if (input.to) totalsQuery = totalsQuery.where('created_at', '<=', input.to);
  const totalsRow = await totalsQuery.executeTakeFirst();

  let channelQuery = db
    .selectFrom('orders')
    .select(({ fn }) => ['sales_channel', fn.sum<number>('total_cents').as('gross_sales_cents')])
    .where('event_id', '=', input.eventId)
    .where('tenant_id', '=', input.tenantId)
    .where('is_test', '=', false)
    .where('status', 'in', ['paid', 'partially_refunded', 'refunded'])
    .groupBy('sales_channel');
  if (input.organizationId)
    channelQuery = channelQuery.where('organization_id', '=', input.organizationId);
  if (input.brandId) channelQuery = channelQuery.where('brand_id', '=', input.brandId);
  if (input.from) channelQuery = channelQuery.where('created_at', '>=', input.from);
  if (input.to) channelQuery = channelQuery.where('created_at', '<=', input.to);
  const channelRows = await channelQuery.execute();

  let firstOrderQuery = db
    .selectFrom('orders')
    .select(['currency', 'created_at'])
    .where('event_id', '=', input.eventId)
    .where('tenant_id', '=', input.tenantId)
    .where('is_test', '=', false)
    .where('status', 'in', ['paid', 'partially_refunded', 'refunded'])
    .orderBy('created_at', 'asc')
    .limit(1);
  if (input.organizationId)
    firstOrderQuery = firstOrderQuery.where('organization_id', '=', input.organizationId);
  if (input.brandId) firstOrderQuery = firstOrderQuery.where('brand_id', '=', input.brandId);
  if (input.from) firstOrderQuery = firstOrderQuery.where('created_at', '>=', input.from);
  if (input.to) firstOrderQuery = firstOrderQuery.where('created_at', '<=', input.to);

  let lastOrderQuery = db
    .selectFrom('orders')
    .select(['created_at'])
    .where('event_id', '=', input.eventId)
    .where('tenant_id', '=', input.tenantId)
    .where('is_test', '=', false)
    .where('status', 'in', ['paid', 'partially_refunded', 'refunded'])
    .orderBy('created_at', 'desc')
    .limit(1);
  if (input.organizationId)
    lastOrderQuery = lastOrderQuery.where('organization_id', '=', input.organizationId);
  if (input.brandId) lastOrderQuery = lastOrderQuery.where('brand_id', '=', input.brandId);
  if (input.from) lastOrderQuery = lastOrderQuery.where('created_at', '>=', input.from);
  if (input.to) lastOrderQuery = lastOrderQuery.where('created_at', '<=', input.to);

  const [firstOrder, lastOrder] = await Promise.all([
    firstOrderQuery.executeTakeFirst(),
    lastOrderQuery.executeTakeFirst(),
  ]);

  let refundQuery = db
    .selectFrom('refunds')
    .innerJoin('orders', 'refunds.order_id', 'orders.id')
    .select(['refunds.amount_cents'])
    .where('refunds.tenant_id', '=', input.tenantId)
    .where('orders.event_id', '=', input.eventId)
    .where('orders.tenant_id', '=', input.tenantId)
    .where('orders.is_test', '=', false)
    .where('orders.status', 'in', ['paid', 'partially_refunded', 'refunded'])
    .where('refunds.status', '=', 'succeeded');
  if (input.organizationId)
    refundQuery = refundQuery.where('orders.organization_id', '=', input.organizationId);
  if (input.brandId) refundQuery = refundQuery.where('orders.brand_id', '=', input.brandId);
  if (input.from) refundQuery = refundQuery.where('refunds.created_at', '>=', input.from);
  if (input.to) refundQuery = refundQuery.where('refunds.created_at', '<=', input.to);
  const refundRows = await refundQuery.execute();

  const grossSales = Number(totalsRow?.gross_sales_cents ?? 0);
  const grossSalesByChannel = groupRevenueByChannel(
    channelRows.map((order) => {
      const salesChannel: SalesChannel =
        order.sales_channel === 'box_office' ? 'box_office' : 'online';
      return {
        salesChannel,
        amountCents: Number(order.gross_sales_cents ?? 0),
      };
    }),
  );
  const refunds = refundRows.reduce((sum, refund) => sum + Number(refund.amount_cents), 0);

  let activeTicketsQuery = db
    .selectFrom('tickets')
    .innerJoin('orders', 'tickets.order_id', 'orders.id')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('tickets.tenant_id', '=', input.tenantId)
    .where('tickets.event_id', '=', input.eventId)
    .where('tickets.status', 'in', ['valid', 'checked_in'])
    .where('orders.tenant_id', '=', input.tenantId)
    .where('orders.event_id', '=', input.eventId)
    .where('orders.is_test', '=', false)
    .where('orders.status', 'in', ['paid', 'partially_refunded', 'refunded']);
  if (input.organizationId)
    activeTicketsQuery = activeTicketsQuery.where(
      'orders.organization_id',
      '=',
      input.organizationId,
    );
  if (input.brandId)
    activeTicketsQuery = activeTicketsQuery.where('orders.brand_id', '=', input.brandId);
  if (input.from)
    activeTicketsQuery = activeTicketsQuery.where('orders.created_at', '>=', input.from);
  if (input.to) activeTicketsQuery = activeTicketsQuery.where('orders.created_at', '<=', input.to);
  const activeTicketsRow = await activeTicketsQuery.executeTakeFirst();
  const activeTicketsSold = Number(activeTicketsRow?.count ?? 0);
  let lineItemsQuantityRow: { quantity: number | string | null } | undefined;
  if (activeTicketsSold === 0 && Number(totalsRow?.paid_orders_count ?? 0) > 0) {
    let lineItemsQuery = db
      .selectFrom('order_line_items')
      .innerJoin('orders', 'order_line_items.order_id', 'orders.id')
      .select(({ fn }) => fn.sum<number>('order_line_items.quantity').as('quantity'))
      .where('order_line_items.ticket_type_id', 'is not', null)
      .where('orders.tenant_id', '=', input.tenantId)
      .where('orders.event_id', '=', input.eventId)
      .where('orders.is_test', '=', false)
      .where('orders.status', 'in', ['paid', 'partially_refunded', 'refunded']);
    if (input.organizationId)
      lineItemsQuery = lineItemsQuery.where('orders.organization_id', '=', input.organizationId);
    if (input.brandId) lineItemsQuery = lineItemsQuery.where('orders.brand_id', '=', input.brandId);
    if (input.from) lineItemsQuery = lineItemsQuery.where('orders.created_at', '>=', input.from);
    if (input.to) lineItemsQuery = lineItemsQuery.where('orders.created_at', '<=', input.to);
    lineItemsQuantityRow = await lineItemsQuery.executeTakeFirst();
  }
  const ticketsSold =
    activeTicketsSold > 0 ? activeTicketsSold : Number(lineItemsQuantityRow?.quantity ?? 0);

  let allOrdersQuery = db
    .selectFrom('orders')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('event_id', '=', input.eventId)
    .where('tenant_id', '=', input.tenantId)
    .where('is_test', '=', false);
  if (input.organizationId)
    allOrdersQuery = allOrdersQuery.where('organization_id', '=', input.organizationId);
  if (input.brandId) allOrdersQuery = allOrdersQuery.where('brand_id', '=', input.brandId);
  if (input.from) allOrdersQuery = allOrdersQuery.where('created_at', '>=', input.from);
  if (input.to) allOrdersQuery = allOrdersQuery.where('created_at', '<=', input.to);
  const totalOrdersCountRow = await allOrdersQuery.executeTakeFirst();

  let checkInsQuery = db
    .selectFrom('tickets')
    .innerJoin('orders', 'tickets.order_id', 'orders.id')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('tickets.tenant_id', '=', input.tenantId)
    .where('tickets.event_id', '=', input.eventId)
    .where('tickets.status', '=', 'checked_in')
    .where('orders.tenant_id', '=', input.tenantId)
    .where('orders.event_id', '=', input.eventId)
    .where('orders.is_test', '=', false)
    .where('orders.status', 'in', ['paid', 'partially_refunded', 'refunded']);
  if (input.organizationId)
    checkInsQuery = checkInsQuery.where('orders.organization_id', '=', input.organizationId);
  if (input.brandId) checkInsQuery = checkInsQuery.where('orders.brand_id', '=', input.brandId);
  if (input.from) checkInsQuery = checkInsQuery.where('orders.created_at', '>=', input.from);
  if (input.to) checkInsQuery = checkInsQuery.where('orders.created_at', '<=', input.to);
  const checkInsRow = await checkInsQuery.executeTakeFirst();

  return {
    eventId: input.eventId,
    currency: firstOrder?.currency ?? input.eventCurrency ?? 'USD',
    grossSalesCents: grossSales,
    grossSalesByChannelCents: {
      online: grossSalesByChannel.online,
      boxOffice: grossSalesByChannel.box_office,
    },
    netRevenueCents: grossSales - refunds,
    refundsCents: refunds,
    feesCents: Number(totalsRow?.fees_cents ?? 0),
    taxCents: Number(totalsRow?.tax_cents ?? 0),
    ticketsSold,
    checkIns: Number(checkInsRow?.count ?? 0),
    ordersCount: Number(totalOrdersCountRow?.count ?? 0),
    paidOrdersCount: Number(totalsRow?.paid_orders_count ?? 0),
    range: {
      from:
        input.from?.toISOString() ??
        firstOrder?.created_at?.toISOString() ??
        input.observedAt.toISOString(),
      to:
        input.to?.toISOString() ??
        lastOrder?.created_at?.toISOString() ??
        input.observedAt.toISOString(),
    },
  };
}

import type { CurrencyCode, ISO8601Date, Ulid } from '../shared/index.js';
import { z } from 'zod';

export const exportTypeSchema = z.enum([
  'attendees',
  'orders',
  'scan_logs',
  'sales',
  'tax',
  'tickets',
]);
export type ExportType = z.infer<typeof exportTypeSchema>;

export const exportFormatSchema = z.enum(['csv', 'xlsx', 'json']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export function parseExportFilterDateBoundary(value: string, boundary: 'start' | 'end'): Date {
  let date: Date;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    date = new Date(boundary === 'start' ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)) {
      return date;
    }
  } else {
    date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  throw new Error(`${boundary === 'start' ? 'from' : 'to'} must be a valid date`);
}

const exportFilterDateSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => {
      try {
        parseExportFilterDateBoundary(value, 'start');
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid date' },
  );

const exportStatusFilterSchema = z.string().trim().min(1).max(128);
const exportTicketTypeFilterSchema = z.string().trim().min(1).max(128);

const exportDateFiltersShape = {
  from: exportFilterDateSchema.optional(),
  to: exportFilterDateSchema.optional(),
};

const attendeeExportFiltersSchema = z
  .object({
    ...exportDateFiltersShape,
    status: exportStatusFilterSchema.optional(),
    ticketTypeId: exportTicketTypeFilterSchema.optional(),
    checkInStatus: z.enum(['checked_in', 'not_checked_in']).optional(),
  })
  .strict();

const orderExportFiltersSchema = z
  .object({
    ...exportDateFiltersShape,
    status: exportStatusFilterSchema.optional(),
  })
  .strict();

const ticketExportFiltersSchema = z
  .object({
    ...exportDateFiltersShape,
    status: exportStatusFilterSchema.optional(),
    ticketTypeId: exportTicketTypeFilterSchema.optional(),
  })
  .strict();

const scanLogExportFiltersSchema = z
  .object({
    ...exportDateFiltersShape,
    status: exportStatusFilterSchema.optional(),
  })
  .strict();

const taxExportFiltersSchema = z.object(exportDateFiltersShape).strict();

export const exportFiltersByTypeSchema = {
  attendees: attendeeExportFiltersSchema,
  orders: orderExportFiltersSchema,
  scan_logs: scanLogExportFiltersSchema,
  sales: orderExportFiltersSchema,
  tax: taxExportFiltersSchema,
  tickets: ticketExportFiltersSchema,
} satisfies Record<ExportType, z.ZodType<Record<string, unknown>>>;

export type ExportFilters = z.infer<typeof attendeeExportFiltersSchema> &
  z.infer<typeof orderExportFiltersSchema> &
  z.infer<typeof ticketExportFiltersSchema> &
  z.infer<typeof scanLogExportFiltersSchema> &
  z.infer<typeof taxExportFiltersSchema>;

export function parseExportFilters(type: string, filters: unknown): ExportFilters {
  const exportType = exportTypeSchema.parse(type);
  return exportFiltersByTypeSchema[exportType].parse(filters ?? {}) as ExportFilters;
}

const exportRequestBaseSchema = {
  eventId: z.string().min(1).optional(),
  format: exportFormatSchema,
};

export const createExportRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...exportRequestBaseSchema,
      type: z.literal('attendees'),
      filters: attendeeExportFiltersSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...exportRequestBaseSchema,
      type: z.literal('orders'),
      filters: orderExportFiltersSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...exportRequestBaseSchema,
      type: z.literal('scan_logs'),
      filters: scanLogExportFiltersSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...exportRequestBaseSchema,
      type: z.literal('sales'),
      filters: orderExportFiltersSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...exportRequestBaseSchema,
      type: z.literal('tax'),
      filters: taxExportFiltersSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...exportRequestBaseSchema,
      type: z.literal('tickets'),
      filters: ticketExportFiltersSchema.optional(),
    })
    .strict(),
]);

export type SalesReport = {
  eventId: Ulid;
  currency: CurrencyCode;
  grossSalesCents: number;
  netRevenueCents: number;
  refundsCents: number;
  feesCollectedCents: number;
  taxCollectedCents: number;
  ticketsSold: number;
  ticketsRefunded: number;
  ordersCount: number;
  paidOrdersCount: number;
  freeOrdersCount: number;
  averageOrderValueCents: number;
  period: {
    from: ISO8601Date;
    to: ISO8601Date;
  };
  breakdown: {
    ticketTypeId: Ulid;
    ticketTypeName: string;
    quantitySold: number;
    revenueCents: number;
    refundedCents: number;
  }[];
};

export type TaxReport = {
  eventId: Ulid;
  currency: CurrencyCode;
  totalTaxCollectedCents: number;
  breakdown: {
    taxRuleName: string;
    rate: number;
    taxableAmountCents: number;
    taxCollectedCents: number;
  }[];
};

export type PromoReport = {
  eventId: Ulid;
  discountCodes: {
    code: string;
    usesCount: number;
    discountAmountCents: number;
    revenueAttributedCents: number;
  }[];
};

export type AffiliateReport = {
  organizationId: Ulid;
  affiliates: {
    affiliateId: Ulid;
    code: string;
    name: string;
    referralsCount: number;
    revenueAttributedCents: number;
    commissionCents: number;
  }[];
};

export type AttendanceReport = {
  eventId: Ulid;
  totalAttendees: number;
  checkedIn: number;
  notCheckedIn: number;
  checkInRate: number;
  breakdownByTicketType: {
    ticketTypeId: Ulid;
    ticketTypeName: string;
    total: number;
    checkedIn: number;
  }[];
};

export type ConversionFunnel = {
  eventId: Ulid;
  widgetViews: number;
  checkoutStarted: number;
  checkoutCompleted: number;
  conversionRate: number;
};

export type DashboardMetrics = {
  grossSalesCents: number;
  netRevenueCents: number;
  ticketsSold: number;
  checkIns: number;
  refundsCents: number;
  ordersCount: number;
  period: {
    from: ISO8601Date;
    to: ISO8601Date;
  };
};

export type ExportRequest = {
  id: Ulid;
  tenantId: Ulid;
  eventId?: Ulid;
  type: ExportType;
  format: ExportFormat;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  fileUrl?: string;
  requestedBy: Ulid;
  createdAt: ISO8601Date;
  completedAt?: ISO8601Date;
  filters?: ExportFilters;
};

import type { CurrencyCode, ISO8601Date, Ulid } from '../shared/index.js';

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
  type: 'attendees' | 'orders' | 'scan_logs' | 'sales' | 'tax';
  format: 'csv' | 'xlsx';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  fileUrl?: string;
  requestedBy: Ulid;
  createdAt: ISO8601Date;
  completedAt?: ISO8601Date;
  filters?: Record<string, unknown>;
};

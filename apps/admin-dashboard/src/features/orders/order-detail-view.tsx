'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, Ban, RotateCcw, Mail, User, ClipboardList, Truck } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { routes } from '@/lib/routes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { RefundDialog } from './refund-dialog';
import { useAdminData } from '@/hooks/use-admin-data';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { OrderStatusBadge } from '@/features/events/event-status-badge';
import { toast } from 'sonner';

export function attendeeDisplayName(attendee: {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  id: string;
}) {
  const explicitName = attendee.name?.trim();
  if (explicitName) return explicitName;
  const fullName = [attendee.firstName, attendee.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ');
  if (fullName) return fullName;
  return attendee.email?.trim() || attendee.id;
}

export function OrderDetailView({ orderId }: { orderId: string }) {
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [refundOpen, setRefundOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const {
    data: order,
    loading,
    error,
    refetch,
  } = useAdminData(() => adminApi.getOrder(orderId), [orderId]);
  const attendees = order?.attendees ?? [];

  const handleCancel = async () => {
    setPending(true);
    const result = await adminApi.cancelOrder(orderId);
    setPending(false);
    if (result.ok) {
      toast.success('Order cancelled');
      setCancelOpen(false);
      refetch();
    } else {
      toast.error(result.error.message);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-10 w-full max-w-xs" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" asChild>
          <Link href={routes.orders} prefetch={false}>
            <ArrowLeft className="size-4" />
            Back to orders
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">Order not found</h1>
        <p className="text-muted-foreground">
          {error?.message ?? 'The order you are looking for does not exist.'}
        </p>
      </div>
    );
  }

  const canCancel = order.status === 'pending' || order.status === 'paid';
  const canRefund = order.status === 'paid' || order.status === 'partially_refunded';
  const buyerAnswers = Object.entries(order.checkoutAnswers?.buyerFields ?? {});
  const attendeeAnswers = Object.entries(order.checkoutAnswers?.attendeeFields ?? {});
  const consentSnapshots = Object.entries(order.consentSnapshots ?? {});

  return (
    <div className="space-y-6">
      <Button variant="ghost" asChild>
        <Link href={routes.orders} prefetch={false}>
          <ArrowLeft className="size-4" />
          Back to orders
        </Link>
      </Button>

      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="break-all font-mono text-2xl font-bold tracking-tight">{order.id}</h1>
            <div className="shrink-0">
              <OrderStatusBadge status={order.status} />
            </div>
          </div>
          <p className="break-words text-sm text-muted-foreground">
            {order.eventTitle} · {formatDate(order.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {canCancel && (
            <Button variant="outline" onClick={() => setCancelOpen(true)}>
              <Ban className="size-4" />
              Cancel
            </Button>
          )}
          {canRefund && (
            <Button variant="destructive" onClick={() => setRefundOpen(true)}>
              <RotateCcw className="size-4" />
              Refund
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Buyer Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3">
              <User className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="break-words font-medium">{order.buyerName ?? 'Unknown'}</p>
                <p className="break-all text-sm text-muted-foreground">{order.buyerEmail}</p>
              </div>
            </div>
            <div className="border-t pt-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total</span>
                <span className="font-medium">
                  {formatCurrency(order.totalCents, order.currency)}
                </span>
              </div>
              {order.refundedCents > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Refunded</span>
                  <span className="font-medium text-red-600 dark:text-red-400">
                    -{formatCurrency(order.refundedCents, order.currency)}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Attendees</span>
                <span className="font-medium">{attendees.length || order.attendeeCount}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Payment</span>
                <Badge variant="outline" className="shrink-0">
                  {order.paymentProvider ?? '—'}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Attendees</CardTitle>
          </CardHeader>
          <CardContent>
            {attendees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No attendee details available.</p>
            ) : (
              <div className="space-y-2">
                {attendees.map((attendee) => (
                  <div
                    key={attendee.id}
                    className="flex items-start justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium">
                          {attendeeDisplayName(attendee)}
                        </p>
                        <p className="break-words text-xs text-muted-foreground">
                          {attendee.ticketTypeName ?? attendee.ticketTypeId ?? 'Ticket'}
                          {attendee.email && ` · ${attendee.email}`}
                        </p>
                      </div>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      {attendee.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Line Items</CardTitle>
        </CardHeader>
        <CardContent>
          {order.lineItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No line items available.</p>
          ) : (
            <div className="space-y-2">
              {order.lineItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-3 rounded-lg border p-3 text-sm"
                >
                  <div className="min-w-0">
                    <p className="break-words font-medium">{item.description}</p>
                    <p className="break-words text-muted-foreground">
                      Qty {item.quantity} · Unit{' '}
                      {formatCurrency(item.unitPriceCents, item.currency)}
                    </p>
                    {(item.discountCents > 0 || item.taxCents > 0 || item.feeCents > 0) && (
                      <p className="break-words text-xs text-muted-foreground">
                        Discount {formatCurrency(item.discountCents, item.currency)} · Tax{' '}
                        {formatCurrency(item.taxCents, item.currency)} · Fees{' '}
                        {formatCurrency(item.feeCents, item.currency)}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 font-medium">
                    {formatCurrency(item.totalCents, item.currency)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Checkout Answers</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <AnswerList title="Buyer" entries={buyerAnswers} />
            <AnswerList title="Attendees" entries={attendeeAnswers} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Consent Snapshots</CardTitle>
          </CardHeader>
          <CardContent>
            {consentSnapshots.length === 0 ? (
              <p className="text-sm text-muted-foreground">No consent snapshots captured.</p>
            ) : (
              <div className="space-y-2">
                {consentSnapshots.map(([key, value]) => (
                  <div key={key} className="rounded-lg border p-3 text-sm">
                    <p className="font-medium">{key}</p>
                    <p className="mt-1 break-words text-muted-foreground">{formatUnknown(value)}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Refund Ledger</CardTitle>
          </CardHeader>
          <CardContent>
            {order.refunds.length === 0 ? (
              <p className="text-sm text-muted-foreground">No refunds recorded.</p>
            ) : (
              <div className="space-y-2">
                {order.refunds.map((refund) => (
                  <div
                    key={refund.id}
                    className="flex items-start justify-between gap-3 rounded-lg border p-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="break-words font-medium">{refund.reason || refund.id}</p>
                      <p className="break-words text-xs text-muted-foreground">
                        {formatDateTime(refund.createdAt)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-medium">
                        -{formatCurrency(refund.amountCents, refund.currency)}
                      </p>
                      <Badge variant="outline">{refund.status}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Delivery Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <DeliveryRow icon={Mail} label="Email" value={order.deliveryStatus.email} />
            <DeliveryRow icon={Truck} label="Tickets" value={order.deliveryStatus.tickets} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {order.timeline.length > 0 ? (
              order.timeline.map((item) => (
                <TimelineItem
                  key={item.id}
                  label={item.description}
                  date={item.createdAt}
                  icon={User}
                />
              ))
            ) : (
              <TimelineItem label="Order Created" date={order.createdAt} icon={User} />
            )}
            {order.status === 'paid' && (
              <TimelineItem
                label="Payment Confirmed"
                date={order.paidAt ?? order.createdAt}
                icon={User}
              />
            )}
            {(order.status === 'refunded' || order.status === 'partially_refunded') && (
              <TimelineItem
                label="Refund Processed"
                date={order.refundedAt ?? order.createdAt}
                icon={RotateCcw}
              />
            )}
            {order.status === 'cancelled' && (
              <TimelineItem
                label="Order Cancelled"
                date={order.cancelledAt ?? order.createdAt}
                icon={Ban}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel order"
        description={`Are you sure you want to cancel order ${order.id}? This cannot be undone.`}
        confirmText="Cancel order"
        variant="destructive"
        pending={pending}
        onConfirm={handleCancel}
      />
      {canRefund && (
        <RefundDialog
          order={order}
          open={refundOpen}
          onOpenChange={setRefundOpen}
          onSuccess={refetch}
        />
      )}
    </div>
  );
}

function TimelineItem({
  label,
  date,
  icon: Icon,
}: {
  label: string;
  date: string;
  icon: React.ElementType;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{formatDateTime(date)}</p>
      </div>
    </div>
  );
}

function AnswerList({ title, entries }: { title: string; entries: Array<[string, unknown]> }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ClipboardList className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-words">{title}</span>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No answers captured.</p>
      ) : (
        <div className="space-y-2">
          {entries.map(([key, value]) => (
            <div key={key} className="rounded-lg border p-3 text-sm">
              <p className="break-words font-medium">{key}</p>
              <p className="mt-1 break-words text-muted-foreground">{formatUnknown(value)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DeliveryRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 break-words">{label}</span>
      </div>
      <Badge variant="outline" className="shrink-0">
        {value.replace(/_/g, ' ')}
      </Badge>
    </div>
  );
}

function formatUnknown(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

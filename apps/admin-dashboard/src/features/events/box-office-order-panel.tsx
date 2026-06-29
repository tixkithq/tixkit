'use client';

import * as React from 'react';
import Link from 'next/link';
import { Banknote, CreditCard, Gift, Printer, ReceiptText, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  type AdminBoxOfficeOrderResult,
  type AdminEventOccurrence,
  type AdminTicketType,
  adminApi,
} from '@/lib/api';
import { routes } from '@/lib/routes';
import { formatCurrency } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

type TenderType = 'comp' | 'cash' | 'manual_card';

type AttendeeDraft = {
  firstName: string;
  lastName: string;
  email: string;
};

const TENDER_OPTIONS: Array<{
  value: TenderType;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    value: 'cash',
    label: 'Cash',
    description: 'Cash tender collected at the door.',
    icon: Banknote,
  },
  {
    value: 'manual_card',
    label: 'Manual card',
    description: 'Card-not-present tender recorded by an operator.',
    icon: CreditCard,
  },
  {
    value: 'comp',
    label: 'Comp',
    description: 'Zero-value ticket issued by the box office.',
    icon: Gift,
  },
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseAmountCents(value: string): number | null {
  const normalized = value.replaceAll(',', '').replace(/^\$/, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [dollars, cents = ''] = normalized.split('.');
  const parsed = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function amountInputValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

function availableFor(ticket: AdminTicketType): number | null {
  if (ticket.quantityTotal === null || ticket.quantityTotal === undefined) return null;
  return Math.max(0, ticket.quantityTotal - ticket.quantitySold);
}

function buildIdempotencyKey(eventId: string): string {
  const random =
    globalThis.crypto?.randomUUID?.().replaceAll('-', '') ??
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `box_office_${eventId}_${random}`;
}

function tenderLabel(tenderType: TenderType): string {
  return TENDER_OPTIONS.find((option) => option.value === tenderType)?.label ?? tenderType;
}

function optionalString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function BoxOfficeOrderPanel({
  eventId,
  ticketTypes,
  occurrences,
  onOrderCreated,
}: {
  eventId: string;
  ticketTypes: AdminTicketType[];
  occurrences: AdminEventOccurrence[];
  onOrderCreated?: () => void;
}) {
  const sellableTickets = React.useMemo(
    () => ticketTypes.filter((ticket) => ticket.status === 'active'),
    [ticketTypes],
  );
  const [ticketTypeId, setTicketTypeId] = React.useState(sellableTickets[0]?.id ?? '');
  const [quantity, setQuantity] = React.useState(1);
  const [tenderType, setTenderType] = React.useState<TenderType>('cash');
  const [amount, setAmount] = React.useState('0.00');
  const [buyerFirstName, setBuyerFirstName] = React.useState('');
  const [buyerLastName, setBuyerLastName] = React.useState('');
  const [buyerEmail, setBuyerEmail] = React.useState('');
  const [buyerPhone, setBuyerPhone] = React.useState('');
  const [attendees, setAttendees] = React.useState<AttendeeDraft[]>([
    { firstName: '', lastName: '', email: '' },
  ]);
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<AdminBoxOfficeOrderResult | null>(null);

  const selectedTicket = sellableTickets.find((ticket) => ticket.id === ticketTypeId);
  const selectedOccurrence = selectedTicket?.eventOccurrenceId
    ? occurrences.find((occurrence) => occurrence.id === selectedTicket.eventOccurrenceId)
    : undefined;
  const expectedTotalCents = selectedTicket ? selectedTicket.priceCents * quantity : 0;
  const amountCents = tenderType === 'comp' ? 0 : parseAmountCents(amount);
  const available = selectedTicket ? availableFor(selectedTicket) : null;

  React.useEffect(() => {
    if (!sellableTickets.some((ticket) => ticket.id === ticketTypeId)) {
      setTicketTypeId(sellableTickets[0]?.id ?? '');
    }
  }, [sellableTickets, ticketTypeId]);

  React.useEffect(() => {
    setAmount(amountInputValue(tenderType === 'comp' ? 0 : expectedTotalCents));
  }, [expectedTotalCents, tenderType]);

  React.useEffect(() => {
    setAttendees((current) =>
      Array.from(
        { length: quantity },
        (_, index) =>
          current[index] ?? {
            firstName: '',
            lastName: '',
            email: '',
          },
      ),
    );
  }, [quantity]);

  const updateAttendee = (index: number, field: keyof AttendeeDraft, value: string) => {
    setAttendees((current) =>
      current.map((attendee, attendeeIndex) =>
        attendeeIndex === index ? { ...attendee, [field]: value } : attendee,
      ),
    );
  };

  const copyBuyerToAttendees = () => {
    setAttendees((current) =>
      current.map((attendee) => ({
        firstName: attendee.firstName || buyerFirstName,
        lastName: attendee.lastName || buyerLastName,
        email: attendee.email || buyerEmail,
      })),
    );
  };

  const validate = (): string | null => {
    if (!selectedTicket) return 'Choose an active ticket type.';
    if (!Number.isInteger(quantity) || quantity < 1) return 'Quantity must be at least 1.';
    const minPerOrder = selectedTicket.minPerOrder ?? 1;
    const maxPerOrder = selectedTicket.maxPerOrder ?? Number.MAX_SAFE_INTEGER;
    if (quantity < minPerOrder) {
      return `Quantity must be at least ${minPerOrder} for ${selectedTicket.name}.`;
    }
    if (quantity > maxPerOrder) {
      return `Quantity cannot exceed ${maxPerOrder} for ${selectedTicket.name}.`;
    }
    if (available !== null && quantity > available) {
      return `${selectedTicket.name} only has ${available} remaining.`;
    }
    if (!buyerFirstName.trim() || !buyerLastName.trim())
      return 'Buyer first and last name are required.';
    if (!EMAIL_PATTERN.test(buyerEmail.trim())) return 'Enter a valid buyer email.';
    for (const [index, attendee] of attendees.entries()) {
      const label = `Attendee ${index + 1}`;
      if (!attendee.firstName.trim() || !attendee.lastName.trim()) {
        return `${label} first and last name are required.`;
      }
      if (!EMAIL_PATTERN.test(attendee.email.trim())) return `Enter a valid email for ${label}.`;
    }
    if (tenderType === 'comp' && amountCents !== 0) return 'Comp orders must be zero dollars.';
    if (tenderType !== 'comp' && expectedTotalCents <= 0) {
      return 'Use comp tender for zero-dollar door orders.';
    }
    if (tenderType !== 'comp' && amountCents === null) return 'Enter a valid tender amount.';
    if (tenderType !== 'comp' && amountCents !== expectedTotalCents) {
      return `Tender amount must match ${formatCurrency(expectedTotalCents, selectedTicket.currency)}.`;
    }
    return null;
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      setResult(null);
      return;
    }
    if (!selectedTicket || amountCents === null) return;

    setSubmitting(true);
    setError(null);
    const response = await adminApi.createBoxOfficeOrder(eventId, {
      idempotencyKey: buildIdempotencyKey(eventId),
      tenderType,
      amountCents,
      items: [
        {
          ticketTypeId: selectedTicket.id,
          occurrenceId: optionalString(selectedTicket.eventOccurrenceId),
          quantity,
          attendeeFields: attendees.map((attendee) => ({
            firstName: attendee.firstName.trim(),
            lastName: attendee.lastName.trim(),
            email: attendee.email.trim(),
          })),
        },
      ],
      buyer: {
        firstName: buyerFirstName.trim(),
        lastName: buyerLastName.trim(),
        email: buyerEmail.trim(),
        phone: buyerPhone.trim() || undefined,
      },
      notes: notes.trim() || undefined,
    });
    setSubmitting(false);

    if (!response.ok) {
      setError(response.error.message);
      setResult(null);
      toast.error(response.error.message);
      return;
    }

    setResult(response.data);
    onOrderCreated?.();
  };

  if (sellableTickets.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <ReceiptText className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Sell at door</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            Activate at least one ticket type before issuing box-office orders.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ReceiptText className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Sell at door</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              Issue comp, cash, or manual card-not-present orders from the box office.
            </p>
          </div>
          <div className="rounded-md border px-3 py-2 text-sm">
            <span className="text-muted-foreground">Expected total </span>
            <span className="font-semibold">
              {formatCurrency(
                tenderType === 'comp' ? 0 : expectedTotalCents,
                selectedTicket?.currency ?? 'USD',
              )}
            </span>
          </div>
        </div>

        <form className="space-y-5" onSubmit={submit}>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_120px_180px_180px]">
            <div className="space-y-2">
              <Label htmlFor="box-office-ticket">Ticket</Label>
              <select
                id="box-office-ticket"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={ticketTypeId}
                onChange={(event) => setTicketTypeId(event.target.value)}
              >
                {sellableTickets.map((ticket) => {
                  const remaining = availableFor(ticket);
                  return (
                    <option key={ticket.id} value={ticket.id}>
                      {ticket.name} - {formatCurrency(ticket.priceCents, ticket.currency)}
                      {remaining === null ? '' : ` - ${remaining} left`}
                    </option>
                  );
                })}
              </select>
              {selectedOccurrence ? (
                <p className="text-xs text-muted-foreground">
                  Occurrence: {selectedOccurrence.title}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="box-office-quantity">Qty</Label>
              <Input
                id="box-office-quantity"
                type="number"
                min={1}
                max={selectedTicket?.maxPerOrder ?? undefined}
                value={quantity}
                onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="box-office-tender">Tender</Label>
              <select
                id="box-office-tender"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={tenderType}
                onChange={(event) => setTenderType(event.target.value as TenderType)}
              >
                {TENDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="box-office-amount">Tender amount</Label>
              <Input
                id="box-office-amount"
                inputMode="decimal"
                value={amount}
                disabled={tenderType === 'comp'}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="box-office-buyer-first">Buyer first name</Label>
              <Input
                id="box-office-buyer-first"
                value={buyerFirstName}
                onChange={(event) => setBuyerFirstName(event.target.value)}
                autoComplete="given-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="box-office-buyer-last">Buyer last name</Label>
              <Input
                id="box-office-buyer-last"
                value={buyerLastName}
                onChange={(event) => setBuyerLastName(event.target.value)}
                autoComplete="family-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="box-office-buyer-email">Buyer email</Label>
              <Input
                id="box-office-buyer-email"
                type="email"
                value={buyerEmail}
                onChange={(event) => setBuyerEmail(event.target.value)}
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="box-office-buyer-phone">Buyer phone</Label>
              <Input
                id="box-office-buyer-phone"
                value={buyerPhone}
                onChange={(event) => setBuyerPhone(event.target.value)}
                autoComplete="tel"
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-sm font-semibold">Attendees</h3>
              <Button type="button" variant="outline" size="sm" onClick={copyBuyerToAttendees}>
                <ShieldCheck className="size-4" />
                Use buyer details
              </Button>
            </div>
            <div className="space-y-3">
              {attendees.map((attendee, index) => (
                <div key={index} className="grid gap-3 rounded-md border p-3 lg:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor={`box-office-attendee-${index}-first`}>
                      Attendee {index + 1} first name
                    </Label>
                    <Input
                      id={`box-office-attendee-${index}-first`}
                      value={attendee.firstName}
                      onChange={(event) => updateAttendee(index, 'firstName', event.target.value)}
                      autoComplete="given-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`box-office-attendee-${index}-last`}>
                      Attendee {index + 1} last name
                    </Label>
                    <Input
                      id={`box-office-attendee-${index}-last`}
                      value={attendee.lastName}
                      onChange={(event) => updateAttendee(index, 'lastName', event.target.value)}
                      autoComplete="family-name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`box-office-attendee-${index}-email`}>
                      Attendee {index + 1} email
                    </Label>
                    <Input
                      id={`box-office-attendee-${index}-email`}
                      type="email"
                      value={attendee.email}
                      onChange={(event) => updateAttendee(index, 'email', event.target.value)}
                      autoComplete="email"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="box-office-notes">Operator notes</Label>
            <Textarea
              id="box-office-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Cash drawer, comp reason, or manual card reference"
            />
          </div>

          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Order not issued</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {result ? (
            <Alert>
              <ShieldCheck className="size-4" />
              <AlertTitle>Order issued</AlertTitle>
              <AlertDescription>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <span>Order: {result.order.id}</span>
                  <span>Session: {result.sessionId}</span>
                  <span>Status: {result.status}</span>
                  <span>Tender: {tenderLabel(tenderType)}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <Link href={routes.orderDetail(result.order.id)}>Open order</Link>
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => window.print()}>
                    <Printer className="size-4" />
                    Print receipt
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="flex justify-end">
            <Button
              type="submit"
              disabled={submitting}
              className="disabled:bg-slate-950 disabled:text-white disabled:opacity-100 dark:disabled:bg-white dark:disabled:text-slate-950"
            >
              <ReceiptText className="size-4" />
              {submitting ? 'Issuing...' : 'Issue door order'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

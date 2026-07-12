'use client';

import * as React from 'react';
import Link from 'next/link';
import { adminApi, type AdminCheckoutQuestion } from '@/lib/api';
import { routes } from '@/lib/routes';
import { useAdminQuery } from '@/hooks/use-admin-table-data';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency, formatDate } from '@/lib/format';
import { EventPagePersistedEditorView } from '@/features/content-editor/event-page-persisted-editor-view';

function hasPreviewAnswer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'boolean') return value;
  return String(value ?? '').trim().length > 0;
}

function PreviewQuestion({
  question,
  value,
  onChange,
}: {
  question: AdminCheckoutQuestion;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const id = `preview-question-${question.id}`;
  const label = (
    <label htmlFor={id} className="text-sm font-medium">
      {question.label}
      {question.required ? ' *' : ''}
    </label>
  );
  if (question.type === 'checkbox' || question.type === 'waiver')
    return (
      <div className="flex items-start gap-2">
        <input
          id={id}
          type="checkbox"
          required={question.required}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </div>
    );
  if (question.type === 'select')
    return (
      <div className="grid gap-1">
        {label}
        <select
          id={id}
          required={question.required}
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value)}
          className="rounded-md border bg-background px-3 py-2"
        >
          <option value="">Select…</option>
          {question.options?.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </div>
    );
  if (question.type === 'multiselect') {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return (
      <fieldset className="grid gap-1">
        <legend className="text-sm font-medium">
          {question.label}
          {question.required ? ' *' : ''}
        </legend>
        {question.options?.map((option) => (
          <label key={option} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={() =>
                onChange(
                  selected.includes(option)
                    ? selected.filter((item) => item !== option)
                    : [...selected, option],
                )
              }
            />
            {option}
          </label>
        ))}
      </fieldset>
    );
  }
  if (question.type === 'file')
    return (
      <div className="grid gap-1">
        {label}
        <input
          id={id}
          type="file"
          required={question.required}
          onChange={(event) => onChange(event.target.files?.[0]?.name ?? '')}
        />
      </div>
    );
  const common = {
    id,
    required: question.required,
    placeholder: question.placeholder,
    pattern: question.validationPattern,
    value: String(value ?? ''),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(event.target.value),
    className: 'w-full rounded-md border bg-background px-3 py-2',
  };
  return (
    <div className="grid gap-1">
      {label}
      {question.type === 'textarea' ? (
        <textarea {...common} />
      ) : (
        <input {...common} type={question.type === 'phone' ? 'tel' : question.type} />
      )}
      {question.description ? (
        <p className="text-xs text-muted-foreground">{question.description}</p>
      ) : null}
    </div>
  );
}

export function EventPreviewView({ eventId }: { eventId: string }) {
  const [viewport, setViewport] = React.useState<'desktop' | 'mobile'>('desktop');
  const [message, setMessage] = React.useState<string>();
  const [acknowledging, setAcknowledging] = React.useState(false);
  const [testingCheckout, setTestingCheckout] = React.useState(false);
  const [selectedTicketId, setSelectedTicketId] = React.useState('');
  const [quantity, setQuantity] = React.useState(1);
  const [donationAmountCents, setDonationAmountCents] = React.useState<number>();
  const [selectedProducts, setSelectedProducts] = React.useState<string[]>([]);
  const [authoritativeQuote, setAuthoritativeQuote] = React.useState<{
    currency: string;
    taxCents: number;
    feeCents: number;
    totalCents: number;
  }>();
  const [answers, setAnswers] = React.useState<Record<string, unknown>>({});
  const [rendererReady, setRendererReady] = React.useState(false);
  const [rendererError, setRendererError] = React.useState<string>();
  React.useEffect(() => {
    setAuthoritativeQuote(undefined);
  }, [selectedTicketId, quantity, selectedProducts, donationAmountCents, answers]);
  const markRendererReady = React.useCallback(() => {
    setRendererReady(true);
    setRendererError(undefined);
  }, []);
  const markRendererError = React.useCallback((value: string) => {
    setRendererReady(false);
    setRendererError(value);
  }, []);
  const {
    data: event,
    loading,
    error,
  } = useAdminQuery(['getEvent', eventId], () => adminApi.getEvent(eventId));
  const {
    data: tickets,
    loading: ticketsLoading,
    error: ticketsError,
  } = useAdminQuery(['listTicketTypes', eventId], () => adminApi.listTicketTypes(eventId));
  const {
    data: products,
    loading: productsLoading,
    error: productsError,
  } = useAdminQuery(['listProducts', eventId], () => adminApi.listProducts(eventId));
  const {
    data: questions,
    loading: questionsLoading,
    error: questionsError,
  } = useAdminQuery(['listCheckoutQuestions', eventId], () =>
    adminApi.listCheckoutQuestions(eventId),
  );
  const {
    data: readiness,
    loading: readinessLoading,
    error: readinessError,
  } = useAdminQuery(['getEventLaunchReadiness', eventId], () =>
    adminApi.getEventLaunchReadiness(eventId),
  );
  if (loading) return <Skeleton className="h-[36rem] w-full" />;
  if (error || !event)
    return (
      <div role="alert" className="rounded-lg border p-6">
        {error?.message ?? 'Event preview unavailable.'}
      </div>
    );
  const acknowledge = async () => {
    setAcknowledging(true);
    setMessage(undefined);
    try {
      const result = await adminApi.acknowledgeReadinessStep(eventId, 'preview_review');
      setMessage(result.ok ? 'Preview marked reviewed.' : result.error.message);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Unable to mark preview reviewed.');
    } finally {
      setAcknowledging(false);
    }
  };
  const previewLoading = ticketsLoading || productsLoading || questionsLoading;
  const previewError = ticketsError ?? productsError ?? questionsError;
  const testTicket = tickets?.find((ticket) => ticket.status === 'active');
  const selectedTicket = tickets?.find((ticket) => ticket.id === selectedTicketId) ?? testTicket;
  const canTestCheckout =
    readiness?.paymentMode === 'capture' || readiness?.paymentMode === 'provider_test';
  const runTestCheckout = async () => {
    if (!selectedTicket) return;
    setTestingCheckout(true);
    setMessage(undefined);
    try {
      const result = await adminApi.runTestCheckout(eventId, {
        ticketTypeId: selectedTicket.id,
        quantity,
        donationAmountCents,
        productIds: selectedProducts,
        buyerFields: answers,
      });
      if (result.ok) setAuthoritativeQuote(result.data.quote);
      setMessage(
        result.ok
          ? `Test checkout completed (${result.data.orderId}). It is excluded from production reporting.`
          : result.error.message,
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Test checkout failed.');
    } finally {
      setTestingCheckout(false);
    }
  };
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold uppercase tracking-wider text-amber-700">
            Preview — no real charge will be created
          </p>
          <h1 className="text-2xl font-bold">Unified event and checkout preview</h1>
        </div>
        <div className="flex gap-2">
          <Button
            variant={viewport === 'desktop' ? 'default' : 'outline'}
            onClick={() => setViewport('desktop')}
            aria-pressed={viewport === 'desktop'}
          >
            Desktop
          </Button>
          <Button
            variant={viewport === 'mobile' ? 'default' : 'outline'}
            onClick={() => setViewport('mobile')}
            aria-pressed={viewport === 'mobile'}
          >
            Mobile
          </Button>
        </div>
      </header>
      <div
        className={`mx-auto transition-[max-width] ${viewport === 'mobile' ? 'max-w-sm' : 'max-w-5xl'}`}
      >
        <Card>
          <CardHeader>
            <CardTitle>{event.title}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {formatDate(event.startsAt)} · {event.timezone}
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="whitespace-pre-line">
              {event.description || 'No public description yet.'}
            </p>
            <section>
              <h2 className="font-semibold">Available tickets</h2>
              <ul className="mt-2 space-y-2">
                {(tickets ?? []).map((ticket) => (
                  <li key={ticket.id} className="flex justify-between rounded border p-3">
                    <span>{ticket.name}</span>
                    <span>
                      {ticket.kind === 'donation'
                        ? 'Donation'
                        : formatCurrency(ticket.priceCents, ticket.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h2 className="font-semibold">Products</h2>
              <p className="text-sm text-muted-foreground">
                {products?.length ?? 0} configured add-on
                {products?.length === 1 ? '' : 's'}.
              </p>
            </section>
            <section>
              <h2 className="font-semibold">Checkout questions</h2>
              <div className="mt-2 space-y-3">
                {(questions ?? []).map((question) => (
                  <PreviewQuestion
                    key={question.id}
                    question={question}
                    value={answers[question.id]}
                    onChange={(value) =>
                      setAnswers((current) => ({ ...current, [question.id]: value }))
                    }
                  />
                ))}
              </div>
            </section>
            <section
              className="space-y-3 rounded-md border border-dashed p-4"
              aria-label="Interactive checkout preview"
            >
              <h2 className="font-semibold">Interactive checkout preview</h2>
              <label className="block text-sm">
                Ticket
                <select
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                  value={selectedTicket?.id ?? ''}
                  onChange={(event) => setSelectedTicketId(event.target.value)}
                >
                  {(tickets ?? [])
                    .filter((ticket) => ticket.status === 'active')
                    .map((ticket) => (
                      <option key={ticket.id} value={ticket.id}>
                        {ticket.name} — {formatCurrency(ticket.priceCents, ticket.currency)}
                      </option>
                    ))}
                </select>
              </label>
              {selectedTicket?.kind === 'donation' ? (
                <label className="block text-sm">
                  Donation amount ({event.currency})
                  <input
                    type="number"
                    min={(selectedTicket.minimumPriceCents ?? 0) / 100}
                    step="0.01"
                    value={donationAmountCents === undefined ? '' : donationAmountCents / 100}
                    onChange={(event) =>
                      setDonationAmountCents(Math.round((Number(event.target.value) || 0) * 100))
                    }
                    className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                  />
                </label>
              ) : null}
              <label className="block text-sm">
                Quantity
                <input
                  type="number"
                  min={selectedTicket?.minPerOrder ?? 1}
                  max={selectedTicket?.maxPerOrder ?? 10}
                  value={quantity}
                  onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                />
              </label>
              {(products ?? [])
                .filter((product) => product.status === 'active')
                .map((product) => (
                  <label key={product.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedProducts.includes(product.id)}
                      onChange={(event) =>
                        setSelectedProducts((current) =>
                          event.target.checked
                            ? [...current, product.id]
                            : current.filter((id) => id !== product.id),
                        )
                      }
                    />
                    {product.name} — {formatCurrency(product.priceCents, product.currency)}
                  </label>
                ))}
              <p className="text-sm font-medium">
                {authoritativeQuote ? 'Authoritative test quote' : 'Estimated total'}:{' '}
                {formatCurrency(
                  authoritativeQuote?.totalCents ??
                    (selectedTicket?.kind === 'donation'
                      ? (donationAmountCents ?? selectedTicket.minimumPriceCents ?? 0) * quantity
                      : (selectedTicket?.priceCents ?? 0) * quantity) +
                      (products ?? [])
                        .filter((product) => selectedProducts.includes(product.id))
                        .reduce((sum, product) => sum + product.priceCents, 0),
                  authoritativeQuote?.currency ?? event.currency,
                )}
              </p>
              {authoritativeQuote ? (
                <p className="text-xs text-muted-foreground">
                  Server pricing includes{' '}
                  {formatCurrency(authoritativeQuote.feeCents, authoritativeQuote.currency)} fees
                  and {formatCurrency(authoritativeQuote.taxCents, authoritativeQuote.currency)}{' '}
                  tax.
                </p>
              ) : null}
            </section>
            <div className="flex flex-wrap gap-3">
              <Button asChild variant="outline">
                <Link href={`${routes.eventContentEventPage(eventId)}?preview=1`}>
                  Open rendered event-page preview
                </Link>
              </Button>
              {canTestCheckout ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !selectedTicket ||
                    testingCheckout ||
                    previewLoading ||
                    (questions ?? []).some(
                      (question) => question.required && !hasPreviewAnswer(answers[question.id]),
                    )
                  }
                  onClick={() => void runTestCheckout()}
                >
                  {testingCheckout ? 'Running test checkout…' : 'Run safe test checkout'}
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
        <section className="mt-5" aria-label="Authenticated event-page renderer preview">
          <EventPagePersistedEditorView
            eventId={eventId}
            previewOnly
            onPreviewReady={markRendererReady}
            onPreviewError={markRendererError}
          />
        </section>
      </div>
      {previewLoading ? <output>Loading ticket, product, and checkout behavior…</output> : null}
      {previewError ? (
        <p role="alert" className="text-sm text-destructive">
          Preview behavior could not be loaded: {previewError.message}
        </p>
      ) : null}
      {!rendererReady && !rendererError ? (
        <output>Loading the authenticated event-page renderer…</output>
      ) : null}
      {rendererError ? (
        <p role="alert" className="text-sm text-destructive">
          Rendered event-page preview failed: {rendererError}
        </p>
      ) : null}
      {readinessLoading ? <output>Checking whether safe test checkout is available…</output> : null}
      {readinessError ? (
        <p role="alert" className="text-sm text-destructive">
          Test checkout availability could not be loaded: {readinessError.message}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span aria-live="polite" className="text-sm text-muted-foreground">
          {message}
        </span>
        <Button
          onClick={() => void acknowledge()}
          disabled={
            previewLoading ||
            Boolean(previewError) ||
            !rendererReady ||
            Boolean(rendererError) ||
            acknowledging
          }
        >
          {acknowledging ? 'Marking reviewed…' : 'Mark preview reviewed'}
        </Button>
        <Button variant="outline" asChild>
          <Link href={routes.eventDetail(eventId)}>Back to launch center</Link>
        </Button>
      </div>
    </div>
  );
}

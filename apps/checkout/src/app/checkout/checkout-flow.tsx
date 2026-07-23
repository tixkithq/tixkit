'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CalendarIcon,
  MapPinIcon,
  TicketIcon,
  AlertCircleIcon,
  LoaderCircleIcon,
  CheckCircle2Icon,
  ArrowLeftIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/empty-state';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { TicketSelection } from '@/components/checkout/ticket-selection';
import { PromoInput } from '@/components/checkout/promo-input';
import { AttendeeForm, type AttendeeAnswers } from '@/components/checkout/attendee-form';
import { OrderSummary } from '@/components/checkout/order-summary';
import { PaymentHandoff } from '@/components/checkout/payment-handoff';
import { BrandFooter } from '@/components/checkout/brand-footer';
import {
  publicApi,
  checkoutApi,
  CheckoutApiError,
  CURRENT_RESALE_TERMS_ACCEPTANCE,
  isRetryable,
  newCheckoutIdempotencyKey,
  newConfirmIdempotencyKey,
  userFacingMessage,
  type PublicEvent,
  type AvailabilityItem,
  type CheckoutSession,
  type CheckoutPublicResaleListing,
  type Buyer,
  type CartItem,
  type ConfirmResult,
  type CreateCheckoutSessionInput,
  type QuestionsResponse,
} from '@/lib/api';
import type { ResolvedBrand } from '@/lib/brand';
import { BrandThemeSurface } from '@/components/brand-theme-surface';
import { useResolvedBrand } from '@/lib/use-brand';
import { storeSessionToken, getSessionToken, clearSessionToken } from '@/lib/session-token';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { parseItemsParam, parseProductFilterParam } from '@/lib/checkout-query';
import {
  isRequiredCheckoutAnswerMissing,
  normalizeCheckoutAnswers,
  questionPatternValidationMessage,
  questionTypeValidationMessage,
  visibleCheckoutQuestions,
} from '@/lib/checkout-questions';
import { trackMarketingEvent, type MarketingEventItem } from '@/lib/marketing';
import { RefreshNotifier } from '@/components/refresh-notifier';
import {
  evaluateDateOfBirthEligibility,
  maximumEligibleDateOfBirth,
  requiresDateOfBirthVerification,
} from '@tixkit/domain/eligibility';
import type { PublicEventOccurrence } from '@/lib/api';
import { emitEmbedLifecycle, initializeEmbedHandshake } from '@/lib/embed-contract';
import {
  isInventoryConflictCode,
  planFromInventoryErrorDetails,
  planInventoryRecovery,
  type InventoryApiDetails,
  type InventoryRecoveryPlan,
} from '@/lib/inventory-recovery';
import {
  isTransportFailure,
  readConnectivityStatus,
  RequestGeneration,
  transportFailureMessage,
  type ConnectivityStatus,
} from '@/lib/network-recovery';
import { checkoutCopy } from '@/lib/checkout-copy';

type Props = {
  initialEventId: string;
  initialSessionId: string;
  initialSessionToken: string;
  waitlistClaimToken?: string;
  brandId?: string;
  supportUrl?: string;
  termsUrl?: string;
  privacyUrl?: string;
  refundUrl?: string;
  presetDiscountCode?: string;
  trackingId?: string;
  affiliateCode?: string;
  prefilledItemsParam?: string;
  productFilterParam?: string;
  resaleListingId?: string;
};

/** Browser clock may only trigger revalidation; server status is authoritative. */
export type SessionHoldStatus = 'ok' | 'checking' | 'expired' | 'terminal' | 'revalidation_failed';

/** setTimeout delays above 32-bit signed max overflow and can fire immediately. */
export const MAX_EXPIRY_TIMER_MS = 2_147_483_647;

export function parseSessionExpiresAtMs(expiresAt: string | undefined | null): number | null {
  if (typeof expiresAt !== 'string' || expiresAt.trim() === '') return null;
  const ms = Date.parse(expiresAt);
  return Number.isFinite(ms) ? ms : null;
}

export function isServerSessionExpired(session: Pick<CheckoutSession, 'status'>): boolean {
  return session.status === 'expired' || session.status === 'cancelled';
}

type ServerSessionTransition = 'confirm' | 'payment' | 'completed' | 'terminal';

/**
 * Session status is server-authoritative. Keep this table deliberately small:
 * a payment handoff is valid only for a pending payment with no completed order;
 * every unknown state fails closed instead of reopening checkout.
 */
function serverSessionTransition(session: CheckoutSession): ServerSessionTransition {
  if (session.orderId || session.status === 'completed' || session.status === 'succeeded') {
    return 'completed';
  }
  if (
    session.status === 'expired' ||
    session.status === 'cancelled' ||
    session.status === 'failed'
  ) {
    return 'terminal';
  }
  if (session.status === 'pending_payment') return 'payment';
  if (session.status === 'open' || session.status === 'pending') return 'confirm';
  return 'terminal';
}

function terminalSessionMessage(session: Pick<CheckoutSession, 'status'>): string {
  if (session.status === 'expired') {
    return 'Your checkout session expired. Start a new order to reserve tickets again.';
  }
  if (session.status === 'cancelled') {
    return 'This checkout session was cancelled. Start a new order to reserve tickets again.';
  }
  if (session.status === 'failed') {
    return 'This checkout session can no longer accept payment. Start a new order to try again.';
  }
  return 'This checkout session is not payable. Start a new order to try again.';
}

function isCheckoutExpiredError(error: unknown): boolean {
  return (
    error instanceof CheckoutApiError && (error.code === 'CHECKOUT_EXPIRED' || error.status === 410)
  );
}

function availabilityItemId(item: AvailabilityItem): string {
  if (item.resaleListingId) return `resale:${item.resaleListingId}`;
  if (item.ticketTypeId) return `ticket:${item.ticketTypeId}:${item.eventOccurrenceId ?? 'event'}`;
  if (item.productId) return `product:${item.productId}`;
  return item.name;
}

function cartItemId(item: CartItem): string {
  if (item.resaleListingId) return `resale:${item.resaleListingId}`;
  if (item.ticketTypeId) return `ticket:${item.ticketTypeId}:${item.occurrenceId ?? 'event'}`;
  if (item.productId) return `product:${item.productId}`;
  return '';
}

function productFilterMatches(item: AvailabilityItem, productFilter: Set<string>): boolean {
  if (productFilter.has(availabilityItemId(item))) return true;
  if (item.ticketTypeId && productFilter.has(item.ticketTypeId)) return true;
  return !!item.productId && productFilter.has(item.productId);
}

async function findPublicResaleListing(
  eventId: string,
  resaleListingId: string,
  signal: AbortSignal,
): Promise<CheckoutPublicResaleListing | undefined> {
  let cursor: string | null | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop -- cursor pages must be fetched sequentially.
    const page = await publicApi.getResaleListings(
      eventId,
      signal,
      cursor ? { cursor } : undefined,
    );
    const listing = page.items.find((item) => item.id === resaleListingId);
    if (listing) return listing;
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}

type Phase = 'select' | 'confirm' | 'payment' | 'completed';

function emitCheckoutEvent(
  event: 'checkout_started' | 'checkout_session_created' | 'order_completed',
  detail: Record<string, unknown>,
) {
  emitEmbedLifecycle(
    event === 'checkout_started'
      ? 'checkout-started'
      : event === 'checkout_session_created'
        ? 'checkout-session-created'
        : 'order-completed',
    detail,
  );
}

export default function CheckoutFlow({
  initialEventId,
  initialSessionId,
  initialSessionToken,
  waitlistClaimToken,
  brandId,
  supportUrl,
  termsUrl,
  privacyUrl,
  refundUrl,
  presetDiscountCode,
  trackingId,
  affiliateCode,
  prefilledItemsParam,
  productFilterParam,
  resaleListingId,
}: Props) {
  const { push } = useRouter();
  useEffect(() => initializeEmbedHandshake(), []);
  const [eventId, setEventId] = useState(initialEventId);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [sessionToken, setSessionToken] = useState(initialSessionToken);
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [availability, setAvailability] = useState<AvailabilityItem[]>([]);
  const [occurrences, setOccurrences] = useState<PublicEventOccurrence[]>([]);
  const [resaleListing, setResaleListing] = useState<CheckoutPublicResaleListing | null>(null);
  const [resaleTermsAccepted, setResaleTermsAccepted] = useState(false);
  const [questions, setQuestions] = useState<QuestionsResponse | null>(null);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [questionsError, setQuestionsError] = useState<string | null>(null);
  const [questionsRetryKey, setQuestionsRetryKey] = useState(0);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [donationAmounts, setDonationAmounts] = useState<Record<string, number>>({});
  const [buyer, setBuyer] = useState<Buyer>({
    email: '',
    firstName: '',
    lastName: '',
    phone: '',
    dateOfBirth: '',
  });
  const [buyerAnswers, setBuyerAnswers] = useState<AttendeeAnswers>({});
  const [attendeeAnswers, setAttendeeAnswers] = useState<AttendeeAnswers>({});
  const [attendeeDateOfBirths, setAttendeeDateOfBirths] = useState<Record<string, string>>({});
  const [discountCode, setDiscountCode] = useState<string | undefined>(presetDiscountCode);
  // Initialize accessCode with presetDiscountCode so locked-ticket direct links
  // (e.g. ?discount=VIP&products=locked_tt) prefill the access code field.
  const [accessCode, setAccessCode] = useState<string>(presetDiscountCode ?? '');
  const [unlockedTicketTypeIds, setUnlockedTicketTypeIds] = useState<Set<string>>(() => new Set());
  const [promoApplied, setPromoApplied] = useState(Boolean(presetDiscountCode));
  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [phase, setPhase] = useState<Phase>('select');
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | undefined>();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [buyerQuestionErrors, setBuyerQuestionErrors] = useState<Record<string, string>>({});
  const [attendeeQuestionErrors, setAttendeeQuestionErrors] = useState<Record<string, string>>({});
  const [buyerDateOfBirthError, setBuyerDateOfBirthError] = useState<string>();
  const [attendeeDateOfBirthErrors, setAttendeeDateOfBirthErrors] = useState<
    Record<string, string>
  >({});
  const [waitlistMessage, setWaitlistMessage] = useState<string | null>(null);
  const [waitlistTicketTypeIds, setWaitlistTicketTypeIds] = useState<Set<string>>(() => new Set());
  const [claimTicketTypeId, setClaimTicketTypeId] = useState<string | null>(null);
  const [claimQuantity, setClaimQuantity] = useState(1);
  const didApplyPrefilledItemsRef = useRef(false);
  const didApplyWaitlistClaimRef = useRef(false);
  const createSessionAttemptRef = useRef<
    { fingerprint: string; idempotencyKey: string } | undefined
  >(undefined);
  const confirmSessionAttemptRef = useRef<
    { sessionId: string; idempotencyKey: string } | undefined
  >(undefined);
  const createSessionInFlightRef = useRef(false);
  const confirmSessionInFlightRef = useRef(false);
  const [sessionHoldStatus, setSessionHoldStatus] = useState<SessionHoldStatus>('ok');
  const [sessionHoldMessage, setSessionHoldMessage] = useState<string | null>(null);
  const sessionHoldStatusRef = useRef<SessionHoldStatus>('ok');
  const sessionRef = useRef<CheckoutSession | null>(null);
  const sessionTokenRef = useRef(sessionToken);
  const phaseRef = useRef<Phase>(phase);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revalidateAbortRef = useRef<AbortController | null>(null);
  const revalidateInFlightRef = useRef(false);
  const confirmationNavigationRef = useRef<string | null>(null);
  const resumeRequestGenerationRef = useRef(0);
  /** After server confirms a still-valid hold, do not auto-loop when browser clock already passed expiresAt. */
  const serverConfirmedHoldRef = useRef<{ sessionId: string; expiresAt: string } | null>(null);
  const expiryRestartButtonRef = useRef<HTMLButtonElement | null>(null);
  const expiryRetryButtonRef = useRef<HTMLButtonElement | null>(null);
  const inventoryAlertRef = useRef<HTMLDivElement | null>(null);
  const [inventoryRecovery, setInventoryRecovery] = useState<InventoryRecoveryPlan | null>(null);
  const [inventoryAcknowledged, setInventoryAcknowledged] = useState(false);
  const [connectivity, setConnectivity] = useState<ConnectivityStatus>(() =>
    readConnectivityStatus(),
  );
  const [networkMessage, setNetworkMessage] = useState<string | null>(null);
  const mutationGenerationRef = useRef(new RequestGeneration());
  const quantitiesRef = useRef(quantities);
  const availabilityRef = useRef(availability);

  sessionRef.current = session;
  sessionTokenRef.current = sessionToken;
  phaseRef.current = phase;
  quantitiesRef.current = quantities;
  availabilityRef.current = availability;

  const setHoldStatus = useCallback((status: SessionHoldStatus, message: string | null = null) => {
    sessionHoldStatusRef.current = status;
    setSessionHoldStatus(status);
    setSessionHoldMessage(message);
  }, []);

  const clearExpiryTimer = useCallback(() => {
    if (expiryTimerRef.current !== null) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
  }, []);

  const clearHeldSessionLocally = useCallback(() => {
    const held = sessionRef.current;
    if (held?.id) clearSessionToken(held.id);
    setSession(null);
    setSessionId('');
    setSessionToken('');
    setConfirmResult(null);
    setPhase('select');
    createSessionAttemptRef.current = undefined;
    confirmSessionAttemptRef.current = undefined;
    createSessionInFlightRef.current = false;
    confirmSessionInFlightRef.current = false;
  }, []);

  const navigateToConfirmation = useCallback(
    (nextSessionId: string, orderId?: string | null) => {
      if (!nextSessionId) return;
      const params = new URLSearchParams({ sessionId: nextSessionId });
      if (orderId) params.set('orderId', orderId);
      const destination = `/checkout/confirmation?${params.toString()}`;
      if (confirmationNavigationRef.current === destination) return;
      confirmationNavigationRef.current = destination;
      push(destination);
    },
    [push],
  );

  const applyServerSessionState = useCallback(
    (loaded: CheckoutSession): ServerSessionTransition => {
      const transition = serverSessionTransition(loaded);
      sessionRef.current = loaded;
      setSession(loaded);
      if (loaded.clientToken) {
        setSessionToken(loaded.clientToken);
        storeSessionToken(loaded.id, loaded.clientToken);
      }

      if (transition === 'completed') {
        clearExpiryTimer();
        setConfirmResult(null);
        setPhase('completed');
        setHoldStatus('ok', null);
        navigateToConfirmation(loaded.id, loaded.orderId);
        return transition;
      }

      if (transition === 'terminal') {
        clearExpiryTimer();
        serverConfirmedHoldRef.current = null;
        setConfirmResult(null);
        createSessionAttemptRef.current = undefined;
        confirmSessionAttemptRef.current = undefined;
        createSessionInFlightRef.current = false;
        confirmSessionInFlightRef.current = false;
        setPhase('confirm');
        setHoldStatus(
          isServerSessionExpired(loaded) ? 'expired' : 'terminal',
          terminalSessionMessage(loaded),
        );
        return transition;
      }

      // A resumed pending_payment session does not include a capability for
      // the payment provider. Re-confirming with the existing session is
      // idempotent server-side and is the only authority that may restore a
      // client secret; never synthesize one in the browser.
      if (transition === 'payment' && !confirmResult) {
        setPhase('confirm');
        setValidationError('Resume payment to securely restore your checkout session.');
      } else {
        setPhase(transition);
      }
      setHoldStatus('ok', null);
      return transition;
    },
    [clearExpiryTimer, confirmResult, navigateToConfirmation, setHoldStatus],
  );
  const applyServerSessionStateRef = useRef(applyServerSessionState);
  applyServerSessionStateRef.current = applyServerSessionState;

  const restartCheckoutAfterExpiry = useCallback(() => {
    clearExpiryTimer();
    revalidateAbortRef.current?.abort();
    revalidateAbortRef.current = null;
    revalidateInFlightRef.current = false;
    serverConfirmedHoldRef.current = null;
    clearHeldSessionLocally();
    setHoldStatus('ok', null);
    setError(null);
    setValidationError(null);
    setLoading(false);
  }, [clearExpiryTimer, clearHeldSessionLocally, setHoldStatus]);

  useEffect(() => {
    const generation = mutationGenerationRef.current;
    function handleOnline() {
      setConnectivity('online');
      setNetworkMessage(null);
    }
    function handleOffline() {
      setConnectivity('offline');
      setNetworkMessage(transportFailureMessage('offline'));
    }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      generation.invalidate();
    };
  }, []);

  const applyInventoryRecoveryPlan = useCallback(
    (plan: InventoryRecoveryPlan, options?: { refreshAvailability?: AvailabilityItem[] }) => {
      if (options?.refreshAvailability) {
        setAvailability(options.refreshAvailability);
        availabilityRef.current = options.refreshAvailability;
      }
      setInventoryRecovery(plan);
      setInventoryAcknowledged(false);
      setValidationError(plan.summary || null);
      setError(null);
      if (sessionRef.current) {
        clearExpiryTimer();
        revalidateAbortRef.current?.abort();
        revalidateAbortRef.current = null;
        revalidateInFlightRef.current = false;
        serverConfirmedHoldRef.current = null;
        clearHeldSessionLocally();
        setHoldStatus('ok', null);
      }
      createSessionAttemptRef.current = undefined;
      confirmSessionAttemptRef.current = undefined;
      setPhase('select');
      setConfirmResult(null);
      queueMicrotask(() => inventoryAlertRef.current?.focus());
    },
    [clearExpiryTimer, clearHeldSessionLocally, setHoldStatus],
  );

  const acknowledgeInventoryRecovery = useCallback(() => {
    if (!inventoryRecovery) return;
    setQuantities(inventoryRecovery.proposedQuantities);
    quantitiesRef.current = inventoryRecovery.proposedQuantities;
    setInventoryAcknowledged(true);
    setInventoryRecovery(null);
    setValidationError(null);
    setError(null);
  }, [inventoryRecovery]);

  const handleSelectionConflict = useCallback(
    async (err: unknown) => {
      const code = err instanceof CheckoutApiError ? err.code : undefined;
      if (
        !isInventoryConflictCode(code) &&
        !(err instanceof CheckoutApiError && err.status === 409)
      ) {
        return false;
      }

      let refreshed = availabilityRef.current;
      try {
        if (eventId) {
          refreshed = await publicApi.getAvailability(eventId);
          setAvailability(refreshed);
          availabilityRef.current = refreshed;
        }
      } catch {
        // Keep last known availability when refresh fails; still surface the conflict.
      }

      const details =
        err instanceof CheckoutApiError
          ? (err.details as InventoryApiDetails | undefined)
          : undefined;
      const fromDetails = planFromInventoryErrorDetails(details, quantitiesRef.current, refreshed);
      const plan =
        fromDetails ??
        planInventoryRecovery({
          quantities: quantitiesRef.current,
          availability: refreshed,
          currency: refreshed[0]?.currency,
          previousQuote: sessionRef.current?.quote ?? null,
          nextQuote: null,
        });

      if (!plan.requiresAcknowledgement) {
        const fallback: InventoryRecoveryPlan = {
          changes: [
            {
              kind: 'unavailable',
              itemId: details?.ticketTypeId
                ? `ticket:${details.ticketTypeId}:${details.occurrenceId ?? details.eventOccurrenceId ?? 'event'}`
                : 'selection',
              name: 'Selected tickets',
              message: userFacingMessage(err),
            },
          ],
          proposedQuantities: quantitiesRef.current,
          requiresAcknowledgement: true,
          summary: userFacingMessage(err),
          focusItemId: null,
        };
        applyInventoryRecoveryPlan(fallback, { refreshAvailability: refreshed });
        return true;
      }

      applyInventoryRecoveryPlan(plan, { refreshAvailability: refreshed });
      return true;
    },
    [applyInventoryRecoveryPlan, eventId],
  );

  const brand: ResolvedBrand = useResolvedBrand(
    useMemo(
      () => ({
        brandId: brandId ?? event?.brandId,
        supportUrl,
        termsUrl,
        privacyUrl,
        refundUrl,
      }),
      [brandId, event, supportUrl, termsUrl, privacyUrl, refundUrl],
    ),
  );

  const productFilter = useMemo(
    () => parseProductFilterParam(productFilterParam),
    [productFilterParam],
  );

  const visibleAvailability = useMemo(() => {
    if (resaleListing) {
      return [
        {
          type: 'resale' as const,
          resaleListingId: resaleListing.id,
          name: resaleListing.ticketTypeName
            ? `Resale ticket - ${resaleListing.ticketTypeName}`
            : 'Resale ticket',
          description: 'Verified resale ticket from another attendee.',
          kind: 'resale' as const,
          priceCents: resaleListing.priceCents,
          currency: resaleListing.currency,
          minPerOrder: 1,
          maxPerOrder: 1,
          available: 1,
          status: 'active',
        },
      ];
    }
    return productFilter
      ? availability.filter((item) => productFilterMatches(item, productFilter))
      : availability;
  }, [availability, productFilter, resaleListing]);
  const prefilledItems = useMemo(() => parseItemsParam(prefilledItemsParam), [prefilledItemsParam]);

  // Determine if the cart contains any ticket that requires an access code.
  const cartHasLockedTicket = useMemo(
    () =>
      visibleAvailability.some(
        (item) =>
          item.requiresAccessCode &&
          item.ticketTypeId &&
          (quantities[availabilityItemId(item)] ?? 0) > 0,
      ),
    [visibleAvailability, quantities],
  );
  const hasVisibleLockedTicket = useMemo(
    () => visibleAvailability.some((item) => item.requiresAccessCode),
    [visibleAvailability],
  );
  const accessCodeApplied = unlockedTicketTypeIds.size > 0;

  const selectedItems = useMemo<CartItem[]>(() => {
    if (resaleListing) return [{ resaleListingId: resaleListing.id, quantity: 1 }];

    const baseItems: CartItem[] = [];
    for (const item of visibleAvailability) {
      const itemId = availabilityItemId(item);
      const qty = quantities[itemId] ?? 0;
      if (qty === 0) continue;
      const unitAmountCents =
        item.kind === 'donation'
          ? (donationAmounts[itemId] ?? Math.max(item.minimumPriceCents ?? 0, item.priceCents))
          : item.priceCents;
      const cartItem: CartItem = {
        quantity: qty,
      };
      if (item.ticketTypeId) cartItem.ticketTypeId = item.ticketTypeId;
      if (item.eventOccurrenceId) cartItem.occurrenceId = item.eventOccurrenceId;
      if (item.productId) cartItem.productId = item.productId;
      if (item.kind === 'donation') {
        cartItem.unitAmountCents = unitAmountCents;
      }
      baseItems.push(cartItem);
    }

    // Build attendeeFields for each item based on attendee question answers.
    return baseItems.map((item) => {
      if (!item.ticketTypeId) return item;
      const lineId = cartItemId(item);
      const ticketQuestions =
        questions?.attendeeQuestions.filter(
          (q) => !q.ticketTypeId || q.ticketTypeId === item.ticketTypeId,
        ) ?? [];
      const attendeeFields: Record<string, unknown>[] = [];
      for (let i = 0; i < item.quantity; i++) {
        const answersForAttendee = Object.fromEntries(
          ticketQuestions.map((q) => [q.id, attendeeAnswers[`${lineId}:${i}:${q.id}`]]),
        );
        const fields: Record<string, unknown> = {};
        const dateOfBirth = attendeeDateOfBirths[`${lineId}:${i}`];
        if (requiresDateOfBirthVerification(event?.minimumAge) && dateOfBirth) {
          fields.dateOfBirth = dateOfBirth;
        }
        for (const q of visibleCheckoutQuestions(ticketQuestions, answersForAttendee)) {
          const key = `${lineId}:${i}:${q.id}`;
          const answer = attendeeAnswers[key];
          if (answer !== undefined) {
            fields[q.id] = answer;
          }
        }
        attendeeFields.push(fields);
      }
      return Object.assign({}, item, { attendeeFields });
    });
  }, [
    visibleAvailability,
    quantities,
    donationAmounts,
    questions,
    attendeeAnswers,
    attendeeDateOfBirths,
    event?.minimumAge,
    resaleListing,
  ]);

  const previewTotal = useMemo(
    () =>
      selectedItems.reduce((total, item) => {
        const itemId = cartItemId(item);
        const ticket = visibleAvailability.find((c) => availabilityItemId(c) === itemId);
        const unit =
          item.unitAmountCents ??
          (ticket?.kind === 'donation'
            ? Math.max(ticket?.minimumPriceCents ?? 0, ticket?.priceCents ?? 0)
            : (ticket?.priceCents ?? 0));
        return total + item.quantity * unit;
      }, 0),
    [visibleAvailability, selectedItems],
  );

  const displayCurrency =
    visibleAvailability[0]?.currency ?? availability[0]?.currency ?? session?.currency ?? 'USD';
  const selectedMarketingItems = useMemo<MarketingEventItem[]>(
    () =>
      selectedItems.map((item) => {
        const availabilityItem = visibleAvailability.find(
          (candidate) => availabilityItemId(candidate) === cartItemId(item),
        );
        return {
          id: item.resaleListingId ?? item.ticketTypeId ?? item.productId,
          name: availabilityItem?.name,
          quantity: item.quantity,
          priceCents: item.unitAmountCents ?? availabilityItem?.priceCents,
        };
      }),
    [selectedItems, visibleAvailability],
  );

  const emailValid = buyer.email.includes('@') && buyer.email.includes('.');
  const paymentBillingDetails = useMemo(() => {
    const name = [buyer.firstName, buyer.lastName].filter(Boolean).join(' ');
    return {
      name: name || undefined,
      email: buyer.email || undefined,
      phone: buyer.phone || undefined,
    };
  }, [buyer.email, buyer.firstName, buyer.lastName, buyer.phone]);

  // Validate donation amounts and attendee questions before creating session.
  function validateCart(): string | null {
    setBuyerQuestionErrors({});
    setAttendeeQuestionErrors({});
    setBuyerDateOfBirthError(undefined);
    setAttendeeDateOfBirthErrors({});

    if (!questions) {
      return questionsError ?? 'Required checkout fields are still loading. Please try again.';
    }

    const defaultTarget = {
      participationAt: event?.startsAt ?? '',
      timezone: event?.timezone ?? 'UTC',
    };
    const targetForItem = (item: CartItem) => {
      const occurrenceId =
        item.occurrenceId ?? (item.resaleListingId ? resaleListing?.eventOccurrenceId : undefined);
      const occurrence = occurrenceId
        ? occurrences.find((candidate) => candidate.id === occurrenceId)
        : undefined;
      return occurrence
        ? { participationAt: occurrence.startsAt, timezone: occurrence.timezone }
        : defaultTarget;
    };
    if (requiresDateOfBirthVerification(event?.minimumAge)) {
      const buyerTargets =
        selectedItems.length > 0 ? selectedItems.map(targetForItem) : [defaultTarget];
      for (const target of buyerTargets) {
        const result = evaluateDateOfBirthEligibility({
          dateOfBirth: buyer.dateOfBirth,
          minimumAge: event?.minimumAge,
          ...target,
        });
        if (!result.eligible) {
          setBuyerDateOfBirthError(result.message);
          return result.message;
        }
      }
    }

    for (const item of selectedItems) {
      if (!item.ticketTypeId) continue;
      const lineId = cartItemId(item);
      const target = targetForItem(item);
      const ticket = visibleAvailability.find((t) => availabilityItemId(t) === lineId);
      if (!ticket) continue;
      if (item.quantity > 0 && item.quantity < ticket.minPerOrder) {
        return `${ticket.name} requires at least ${ticket.minPerOrder} per order.`;
      }
      if (ticket.kind === 'donation') {
        const amount = donationAmounts[lineId] ?? item.unitAmountCents ?? 0;
        if (amount < (ticket.minimumPriceCents ?? 0)) {
          return `Donation for ${ticket.name} must be at least ${formatCurrency(ticket.minimumPriceCents ?? 0, ticket.currency)}.`;
        }
      }
      if (requiresDateOfBirthVerification(event?.minimumAge)) {
        for (let index = 0; index < item.quantity; index++) {
          const key = `${lineId}:${index}`;
          const result = evaluateDateOfBirthEligibility({
            dateOfBirth: attendeeDateOfBirths[key],
            minimumAge: event?.minimumAge,
            ...target,
          });
          if (!result.eligible) {
            const message = `${ticket.name} attendee ${index + 1}: ${result.message}`;
            setAttendeeDateOfBirthErrors({ [key]: message });
            return message;
          }
        }
      }
    }

    // Validate required attendee questions.
    if (questions) {
      for (const item of selectedItems) {
        if (!item.ticketTypeId) continue;
        const lineId = cartItemId(item);
        const ticketType = visibleAvailability.find((t) => availabilityItemId(t) === lineId);
        const ticketQuestions = questions.attendeeQuestions.filter(
          (q) => !q.ticketTypeId || q.ticketTypeId === item.ticketTypeId,
        );
        for (let i = 0; i < item.quantity; i++) {
          const answersForAttendee = Object.fromEntries(
            ticketQuestions.map((q) => [q.id, attendeeAnswers[`${lineId}:${i}:${q.id}`]]),
          );
          for (const q of visibleCheckoutQuestions(ticketQuestions, answersForAttendee)) {
            const key = `${lineId}:${i}:${q.id}`;
            const answer = attendeeAnswers[key];
            if (q.required && isRequiredCheckoutAnswerMissing(q, answer)) {
              const message =
                q.type === 'checkbox'
                  ? `Please check ${q.label} for ${ticketType?.name ?? 'this ticket'} attendee ${i + 1}.`
                  : q.type === 'multiselect'
                    ? `Choose at least one option for ${q.label} for ${ticketType?.name ?? 'this ticket'} attendee ${i + 1}.`
                    : `Please complete ${q.label} for ${ticketType?.name ?? 'this ticket'} attendee ${i + 1}.`;
              setAttendeeQuestionErrors({ [key]: message });
              return message;
            }
            const typeError = questionTypeValidationMessage(q, answer);
            if (typeError) {
              const message = `${typeError} for ${ticketType?.name ?? 'this ticket'} attendee ${i + 1}.`;
              setAttendeeQuestionErrors({ [key]: message });
              return message;
            }
            const patternError = questionPatternValidationMessage(q, answer);
            if (patternError) {
              const message = `${patternError} for ${ticketType?.name ?? 'this ticket'} attendee ${i + 1}.`;
              setAttendeeQuestionErrors({ [key]: message });
              return message;
            }
          }
        }
      }

      // Validate required buyer questions.
      for (const q of visibleCheckoutQuestions(questions.buyerQuestions, buyerAnswers)) {
        const answer = buyerAnswers[q.id];
        if (q.required && isRequiredCheckoutAnswerMissing(q, answer)) {
          const message =
            q.type === 'checkbox'
              ? `Please check ${q.label}.`
              : q.type === 'multiselect'
                ? `Choose at least one option for ${q.label}.`
                : `Please complete ${q.label}.`;
          setBuyerQuestionErrors({ [q.id]: message });
          return message;
        }
        const typeError = questionTypeValidationMessage(q, answer);
        if (typeError) {
          const message = `${typeError}.`;
          setBuyerQuestionErrors({ [q.id]: message });
          return message;
        }
        const patternError = questionPatternValidationMessage(q, answer);
        if (patternError) {
          const message = `${patternError}.`;
          setBuyerQuestionErrors({ [q.id]: message });
          return message;
        }
      }
    }

    // Validate access code when cart has locked tickets.
    if (cartHasLockedTicket) {
      const lockedTicket = selectedItems.find((item) => {
        if (!item.ticketTypeId) return false;
        const lineId = cartItemId(item);
        const ticket = visibleAvailability.find(
          (candidate) => availabilityItemId(candidate) === lineId,
        );
        return ticket?.requiresAccessCode && !unlockedTicketTypeIds.has(item.ticketTypeId);
      });
      if (lockedTicket) return 'An access code is required to purchase locked tickets.';
    }

    return null;
  }

  const canCreateSession = Boolean(
    eventId &&
    selectedItems.length > 0 &&
    !loading &&
    !questionsLoading &&
    !questionsError &&
    questions &&
    (!resaleListing || resaleTermsAccepted) &&
    !(inventoryRecovery && !inventoryAcknowledged) &&
    connectivity !== 'offline',
  );

  // Resolve an existing session once on mount when resuming via sessionId +
  // token. This must NOT re-run when we create a new session mid-flow (that
  // would reset the phase back to "select"), so it reads the initial values
  // and only fires on mount.
  useEffect(() => {
    const requestGeneration = ++resumeRequestGenerationRef.current;
    const controller = new AbortController();
    let active = true;
    const isCurrentRequest = () =>
      active && requestGeneration === resumeRequestGenerationRef.current;
    async function loadSession() {
      if (!initialSessionId) {
        if (isCurrentRequest()) setInitialLoading(false);
        return;
      }
      // Prefer the token from sessionStorage (resume mechanism), then from
      // initial props. Never read the token from URL params here.
      let token = getSessionToken(initialSessionId) || initialSessionToken;
      const fragment = typeof window === 'undefined' ? '' : window.location.hash.slice(1);
      const fragmentHandoff = new URLSearchParams(fragment).get('handoff') || '';
      if (fragmentHandoff && typeof window !== 'undefined') {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.hash = '';
        window.history.replaceState(null, '', cleanUrl.toString());
      }
      const handoff = token ? '' : fragmentHandoff;
      if (!token && !handoff) {
        if (isCurrentRequest()) setInitialLoading(false);
        return;
      }
      setLoading(true);
      try {
        const loaded = handoff
          ? await checkoutApi.exchangeHandoff(initialSessionId, handoff)
          : await checkoutApi.getSession(
              initialSessionId,
              token || undefined,
              undefined,
              controller.signal,
            );
        if (!isCurrentRequest()) return;
        token = token || loaded.clientToken || '';
        if (!token) throw new Error('Checkout handoff did not return a session credential.');
        storeSessionToken(initialSessionId, token);
        setSessionId(loaded.id);
        setSessionToken(token);
        setEventId(loaded.eventId);
        applyServerSessionStateRef.current(loaded);
      } catch (err) {
        if (isCurrentRequest() && !controller.signal.aborted) setError(userFacingMessage(err));
      } finally {
        if (isCurrentRequest()) {
          setLoading(false);
          setInitialLoading(false);
        }
      }
    }
    void loadSession();
    return () => {
      active = false;
      controller.abort();
    };
  }, [initialSessionId, initialSessionToken]);

  // Load event + availability + questions whenever eventId changes.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadEvent() {
      if (!eventId) {
        setInitialLoading(false);
        setQuestions(null);
        setQuestionsError(null);
        setQuestionsLoading(false);
        return;
      }
      setInitialLoading(true);
      setError(null);
      setQuestions(null);
      setQuestionsError(null);
      setQuestionsLoading(false);
      try {
        let loadedEvent: Awaited<ReturnType<typeof publicApi.getEvent>>;
        let loadedAvailability: Awaited<ReturnType<typeof publicApi.getAvailability>>;
        let selectedResaleListing:
          | Awaited<ReturnType<typeof findPublicResaleListing>>
          | undefined
          | null;
        let loadedQuestions: Awaited<ReturnType<typeof publicApi.getQuestions>> | null = null;
        let loadedOccurrences: PublicEventOccurrence[] = [];

        try {
          const bootstrap = await publicApi.getCheckoutBootstrap(eventId, controller.signal, {
            products: productFilterParam,
            resaleListingId,
          });
          loadedEvent = bootstrap.event;
          loadedAvailability = bootstrap.availability;
          selectedResaleListing = bootstrap.resaleListing ?? undefined;
          loadedQuestions = bootstrap.questions;
          loadedOccurrences = bootstrap.occurrences ?? [];
        } catch (bootstrapError) {
          if (controller.signal.aborted) throw bootstrapError;
          [loadedEvent, loadedAvailability, selectedResaleListing, loadedOccurrences] =
            await Promise.all([
              publicApi.getEvent(eventId, controller.signal),
              publicApi.getAvailability(eventId, controller.signal, productFilterParam),
              resaleListingId
                ? findPublicResaleListing(eventId, resaleListingId, controller.signal)
                : Promise.resolve(undefined),
              typeof publicApi.getOccurrences === 'function'
                ? publicApi.getOccurrences(eventId, controller.signal)
                : Promise.resolve([]),
            ]);
        }

        if (cancelled) return;
        if (resaleListingId && !selectedResaleListing) {
          throw new CheckoutApiError(
            'RESALE_LISTING_UNAVAILABLE',
            'This resale ticket is no longer available.',
            404,
          );
        }
        setEvent(loadedEvent);
        setAvailability(loadedAvailability);
        setOccurrences(loadedOccurrences);
        setResaleListing(selectedResaleListing ?? null);
        setQuantities((current) => {
          const initialPrefilledItems = didApplyPrefilledItemsRef.current ? [] : prefilledItems;
          const next: Record<string, number> = {};
          for (const item of loadedAvailability) {
            const itemId = availabilityItemId(item);
            const prefilledItem = initialPrefilledItems.find(
              (preset) => preset.ticketTypeId === item.ticketTypeId,
            );
            const prefilledQuantity = prefilledItem
              ? Math.min(
                  prefilledItem.quantity,
                  item.maxPerOrder ?? prefilledItem.quantity,
                  item.available,
                )
              : 0;
            next[itemId] = current[itemId] ?? prefilledQuantity;
          }
          didApplyPrefilledItemsRef.current = true;
          return next;
        });
        // Initialize donation amounts with minimum price.
        setDonationAmounts((current) => {
          const next = { ...current };
          for (const item of loadedAvailability) {
            if (item.kind === 'donation') {
              const itemId = availabilityItemId(item);
              next[itemId] =
                current[itemId] ?? Math.max(item.minimumPriceCents ?? 0, item.priceCents);
            }
          }
          return next;
        });

        // Required checkout fields are server-authoritative. If the question
        // metadata cannot load, keep checkout blocked until a retry succeeds.
        if (loadedQuestions) {
          setQuestions(loadedQuestions);
          setQuestionsError(null);
        } else {
          if (!cancelled) setInitialLoading(false);
          setQuestionsLoading(true);
          try {
            loadedQuestions = await publicApi.getQuestions(eventId, controller.signal);
            if (!cancelled) {
              setQuestions(loadedQuestions);
              setQuestionsError(null);
            }
          } catch (err) {
            if (!cancelled && !controller.signal.aborted) {
              setQuestions(null);
              setQuestionsError(userFacingMessage(err));
            }
          } finally {
            if (!cancelled) setQuestionsLoading(false);
          }
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setError(userFacingMessage(err));
      } finally {
        if (!cancelled) setInitialLoading(false);
      }
    }

    void loadEvent();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [eventId, prefilledItems, productFilterParam, resaleListingId, questionsRetryKey]);

  useEffect(() => {
    if (!waitlistClaimToken) return;
    const claimToken = waitlistClaimToken;
    let cancelled = false;
    const controller = new AbortController();

    async function loadWaitlistClaim() {
      setLoading(true);
      setError(null);
      try {
        const claim = await publicApi.getWaitlistClaim(claimToken, controller.signal);
        if (cancelled) return;
        if (claim.eventId && claim.eventId !== eventId) {
          setEventId(claim.eventId);
        }
        setClaimTicketTypeId(claim.ticketTypeId);
        setClaimQuantity(Math.max(1, claim.quantity));
        setBuyer((current) => ({
          ...current,
          email: current.email || claim.email,
          firstName: current.firstName || claim.firstName || '',
          lastName: current.lastName || claim.lastName || '',
          phone: current.phone || claim.phone || '',
        }));
        setWaitlistMessage('Waitlist offer applied.');
      } catch (err) {
        if (!cancelled && !controller.signal.aborted) {
          setError(userFacingMessage(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadWaitlistClaim();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [eventId, waitlistClaimToken]);

  useEffect(() => {
    if (!claimTicketTypeId || didApplyWaitlistClaimRef.current) return;
    const claimTicket = visibleAvailability.find(
      (ticket) => ticket.ticketTypeId === claimTicketTypeId,
    );
    if (!claimTicket) return;
    didApplyWaitlistClaimRef.current = true;
    const quantity = Math.min(claimQuantity, claimTicket.maxPerOrder);
    setQuantities((current) => ({
      ...current,
      [availabilityItemId(claimTicket)]: quantity,
    }));
  }, [claimQuantity, claimTicketTypeId, visibleAvailability]);

  const revalidateSessionHold = useCallback(
    async (options?: { manual?: boolean }) => {
      const held = sessionRef.current;
      const token = sessionTokenRef.current;
      const activePhase = phaseRef.current;
      if (!held || !token) return;
      if (activePhase === 'completed' || activePhase === 'select') return;

      // A manual retry or a newer expiry check supersedes the previous request.
      // Its finally block may not clear the shared state after this controller
      // becomes stale.
      revalidateAbortRef.current?.abort();
      revalidateInFlightRef.current = true;
      const controller = new AbortController();
      revalidateAbortRef.current = controller;
      clearExpiryTimer();
      setHoldStatus('checking', 'Checking whether your ticket reservation is still valid…');

      try {
        const loaded = await checkoutApi.getSession(held.id, token, undefined, controller.signal);
        if (controller.signal.aborted || revalidateAbortRef.current !== controller) return;
        if (loaded.id !== sessionRef.current?.id) return;

        const transition = serverSessionTransition(loaded);
        if (transition === 'completed' || transition === 'terminal') {
          applyServerSessionState(loaded);
          return;
        }

        // Server is authoritative: a still-open/pending session keeps checkout open
        // even if the browser clock already passed expiresAt.
        serverConfirmedHoldRef.current = {
          sessionId: loaded.id,
          expiresAt: loaded.expiresAt,
        };
        applyServerSessionState(loaded);
        if (options?.manual) setError(null);
      } catch (err) {
        if (controller.signal.aborted || revalidateAbortRef.current !== controller) return;
        if (sessionRef.current?.id !== held.id) return;

        if (isCheckoutExpiredError(err)) {
          serverConfirmedHoldRef.current = null;
          setConfirmResult(null);
          createSessionAttemptRef.current = undefined;
          confirmSessionAttemptRef.current = undefined;
          createSessionInFlightRef.current = false;
          confirmSessionInFlightRef.current = false;
          setHoldStatus(
            'expired',
            userFacingMessage(err) ||
              'Your checkout session expired. Start a new order to reserve tickets again.',
          );
          return;
        }

        setHoldStatus(
          'revalidation_failed',
          'We could not confirm your ticket reservation. Payment is paused until the reservation is revalidated.',
        );
      } finally {
        if (revalidateAbortRef.current === controller) {
          revalidateAbortRef.current = null;
          revalidateInFlightRef.current = false;
        }
      }
    },
    [applyServerSessionState, clearExpiryTimer, setHoldStatus],
  );

  useEffect(() => {
    clearExpiryTimer();
    revalidateAbortRef.current?.abort();
    revalidateAbortRef.current = null;
    revalidateInFlightRef.current = false;

    if (!session || !sessionToken) {
      if (sessionHoldStatusRef.current !== 'ok') setHoldStatus('ok', null);
      return;
    }

    if (phase === 'completed' || phase === 'select') {
      if (sessionHoldStatusRef.current !== 'ok' && phase === 'completed') {
        setHoldStatus('ok', null);
      }
      return;
    }

    if (serverSessionTransition(session) === 'terminal') {
      setConfirmResult(null);
      serverConfirmedHoldRef.current = null;
      setHoldStatus(
        isServerSessionExpired(session) ? 'expired' : 'terminal',
        terminalSessionMessage(session),
      );
      return;
    }

    if (sessionHoldStatusRef.current === 'expired' || sessionHoldStatusRef.current === 'terminal') {
      return;
    }
    if (sessionHoldStatusRef.current === 'revalidation_failed') {
      return;
    }
    if (sessionHoldStatusRef.current === 'checking') {
      return;
    }

    // Malformed expiresAt: fail closed and force server revalidation before pay.
    const expiresAtMs = parseSessionExpiresAtMs(session.expiresAt);
    if (expiresAtMs === null) {
      void revalidateSessionHold();
      return;
    }

    const delay = expiresAtMs - Date.now();
    if (delay <= 0) {
      const confirmed = serverConfirmedHoldRef.current;
      // Server already confirmed this exact hold after local expiry; avoid a
      // revalidation loop driven only by clock skew. Submit still re-checks.
      if (
        confirmed &&
        confirmed.sessionId === session.id &&
        confirmed.expiresAt === session.expiresAt
      ) {
        setHoldStatus('ok', null);
        return;
      }
      void revalidateSessionHold();
      return;
    }

    serverConfirmedHoldRef.current = null;
    setHoldStatus('ok', null);

    // Chain capped timers so far-future expiresAt values never overflow setTimeout.
    const scheduleExpiryCheck = (targetMs: number) => {
      clearExpiryTimer();
      const remaining = targetMs - Date.now();
      if (remaining <= 0) {
        void revalidateSessionHold();
        return;
      }
      expiryTimerRef.current = setTimeout(
        () => {
          const stillRemaining = targetMs - Date.now();
          if (stillRemaining <= 0) {
            void revalidateSessionHold();
            return;
          }
          scheduleExpiryCheck(targetMs);
        },
        Math.min(remaining, MAX_EXPIRY_TIMER_MS),
      );
    };
    scheduleExpiryCheck(expiresAtMs);

    return () => {
      clearExpiryTimer();
      revalidateAbortRef.current?.abort();
      revalidateAbortRef.current = null;
    };
  }, [
    clearExpiryTimer,
    phase,
    revalidateSessionHold,
    session,
    session?.expiresAt,
    session?.id,
    session?.status,
    sessionToken,
    setHoldStatus,
  ]);

  useEffect(() => {
    if (sessionHoldStatus === 'expired' || sessionHoldStatus === 'terminal') {
      expiryRestartButtonRef.current?.focus();
      return;
    }
    if (sessionHoldStatus === 'revalidation_failed') {
      expiryRetryButtonRef.current?.focus();
    }
  }, [sessionHoldStatus]);

  const submissionBlockedByHold =
    sessionHoldStatus === 'checking' ||
    sessionHoldStatus === 'expired' ||
    sessionHoldStatus === 'terminal' ||
    sessionHoldStatus === 'revalidation_failed' ||
    Boolean(inventoryRecovery && !inventoryAcknowledged) ||
    connectivity === 'offline';

  const handlePaymentError = useCallback((message: string) => {
    setError(message);
  }, []);

  function increase(itemId: string) {
    if (inventoryRecovery && !inventoryAcknowledged) return;
    const ticket = visibleAvailability.find((t) => availabilityItemId(t) === itemId);
    if (
      ticket?.ticketTypeId &&
      ticket.requiresAccessCode &&
      !unlockedTicketTypeIds.has(ticket.ticketTypeId)
    )
      return;
    setQuantities((current) => {
      const quantity = current[itemId] ?? 0;
      const maximum = Math.min(
        ticket?.maxPerOrder ?? Number.POSITIVE_INFINITY,
        ticket?.available ?? Number.POSITIVE_INFINITY,
      );
      const minimum = ticket?.minPerOrder ?? 1;
      const nextQuantity = quantity === 0 ? minimum : quantity + 1;
      return {
        ...current,
        [itemId]: Math.min(nextQuantity, maximum),
      };
    });
  }
  function decrease(itemId: string) {
    if (inventoryRecovery && !inventoryAcknowledged) return;
    const ticket = visibleAvailability.find((t) => availabilityItemId(t) === itemId);
    setQuantities((current) => {
      const quantity = current[itemId] ?? 0;
      const minimum = ticket?.minPerOrder ?? 1;
      return {
        ...current,
        [itemId]: quantity <= minimum ? 0 : quantity - 1,
      };
    });
  }

  function handleDonationAmountChange(itemId: string, amountCents: number) {
    setDonationAmounts((current) => ({
      ...current,
      [itemId]: amountCents,
    }));
  }

  async function applyAccessCode(code: string) {
    const lockedTicketTypeIds = visibleAvailability
      .filter((ticket): ticket is AvailabilityItem & { ticketTypeId: string } =>
        Boolean(ticket.ticketTypeId && ticket.requiresAccessCode),
      )
      .map((ticket) => ticket.ticketTypeId);
    if (lockedTicketTypeIds.length === 0) return;

    setAccessCode(code);
    setUnlockedTicketTypeIds(new Set());
    setValidationError(null);
    setLoading(true);
    try {
      const result = await publicApi.validateAccessCode(eventId, {
        ticketTypeIds: lockedTicketTypeIds,
        accessCode: code,
        buyerEmail: buyer.email || undefined,
      });
      if (result.ticketTypeIds.length === 0) {
        setValidationError('Access code did not unlock any tickets.');
        return;
      }
      setUnlockedTicketTypeIds(new Set(result.ticketTypeIds));
      if (promoApplied && discountCode === code) {
        setDiscountCode(undefined);
        setPromoApplied(false);
      }
    } catch (err) {
      setValidationError(userFacingMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function removeAccessCode() {
    setAccessCode('');
    setUnlockedTicketTypeIds(new Set());
  }

  function applyDiscount(code: string) {
    setDiscountCode(code);
    setPromoApplied(true);
  }

  function removeDiscount() {
    setDiscountCode(undefined);
    setPromoApplied(false);
  }

  async function joinWaitlist(ticket: AvailabilityItem) {
    if (!ticket.ticketTypeId) return;
    if (!validateEmail()) return;
    setLoading(true);
    setError(null);
    setValidationError(null);
    setWaitlistMessage(null);
    try {
      const entry = await publicApi.joinWaitlist(eventId, {
        ticketTypeId: ticket.ticketTypeId,
        email: buyer.email,
        firstName: buyer.firstName || undefined,
        lastName: buyer.lastName || undefined,
        phone: buyer.phone || undefined,
        quantity: Math.max(1, quantities[availabilityItemId(ticket)] ?? 1),
      });
      setWaitlistTicketTypeIds((current) => {
        const next = new Set(current);
        next.add(entry.ticketTypeId);
        return next;
      });
      setWaitlistMessage(`You're on the waitlist for ${ticket.name}.`);
    } catch (err) {
      setError(userFacingMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function validateEmail() {
    if (!buyer.email) {
      setEmailError('Email is required to continue.');
      return false;
    }
    if (!emailValid) {
      setEmailError('Enter a valid email address.');
      return false;
    }
    setEmailError(undefined);
    return true;
  }

  async function createSession() {
    if (!canCreateSession) return;
    if (sessionHoldStatusRef.current === 'expired' || sessionHoldStatusRef.current === 'terminal')
      return;
    if (inventoryRecovery && !inventoryAcknowledged) return;
    if (resaleListing && !resaleTermsAccepted) {
      setValidationError('Accept the resale settlement and refund terms to continue.');
      return;
    }
    if (!validateEmail()) return;

    const cartError = validateCart();
    if (cartError) {
      setValidationError(cartError);
      return;
    }
    if (createSessionInFlightRef.current) return;

    const connectivityNow = readConnectivityStatus();
    setConnectivity(connectivityNow);
    if (connectivityNow === 'offline') {
      setNetworkMessage(transportFailureMessage('offline'));
      setError(transportFailureMessage('offline'));
      return;
    }

    createSessionInFlightRef.current = true;
    const generation = mutationGenerationRef.current.next();
    setValidationError(null);
    setNetworkMessage(null);

    setLoading(true);
    setError(null);
    setConfirmResult(null);
    try {
      // Build successUrl without any token. The confirmation page resolves
      // the session via sessionId using the token from sessionStorage.
      const successUrl = `${window.location.origin}/checkout/confirmation?sessionId={sessionId}&orderId={orderId}`;
      const createInput: CreateCheckoutSessionInput = {
        eventId,
        items: selectedItems,
        buyer: {
          email: buyer.email,
          ...(buyer.firstName ? { firstName: buyer.firstName } : {}),
          ...(buyer.lastName ? { lastName: buyer.lastName } : {}),
          ...(buyer.phone ? { phone: buyer.phone } : {}),
          ...(buyer.dateOfBirth ? { dateOfBirth: buyer.dateOfBirth } : {}),
        },
        buyerFields: Object.fromEntries(
          Object.entries(normalizeCheckoutAnswers(buyerAnswers)).filter(([questionId]) =>
            visibleCheckoutQuestions(questions?.buyerQuestions ?? [], buyerAnswers).some(
              (question) => question.id === questionId,
            ),
          ),
        ),
        // Pass both discountCode and accessCode when both are set, so buyers
        // can use a promo code alongside an access code for locked tickets.
        discountCode: resaleListing ? undefined : discountCode || undefined,
        accessCode: resaleListing ? undefined : accessCodeApplied ? accessCode : undefined,
        waitlistClaimToken: resaleListing ? undefined : waitlistClaimToken || undefined,
        trackingId,
        affiliateCode,
        resaleTermsAcceptance:
          resaleListing && resaleTermsAccepted ? CURRENT_RESALE_TERMS_ACCEPTANCE : undefined,
        successUrl,
        cancelUrl: window.location.href,
      };
      const fingerprint = JSON.stringify(createInput);
      const currentAttempt = createSessionAttemptRef.current;
      const attempt =
        currentAttempt?.fingerprint === fingerprint
          ? currentAttempt
          : { fingerprint, idempotencyKey: newCheckoutIdempotencyKey() };
      createSessionAttemptRef.current = attempt;
      const created = await checkoutApi.createSession(createInput, attempt.idempotencyKey);
      if (!mutationGenerationRef.current.isCurrent(generation)) return;
      if (!created.clientToken) {
        throw new CheckoutApiError(
          'SESSION_TOKEN_MISSING',
          'Checkout session token was not returned.',
          200,
        );
      }

      // Surface material quote total changes vs the buyer's local preview.
      const localQuoteLines = selectedItems.map((item) => {
        const itemId = cartItemId(item);
        const availabilityItem = availabilityRef.current.find(
          (candidate) => availabilityItemId(candidate) === itemId,
        );
        const unitPriceCents = item.unitAmountCents ?? availabilityItem?.priceCents ?? 0;
        return {
          ticketTypeId: item.ticketTypeId,
          eventOccurrenceId: item.occurrenceId,
          productId: item.productId,
          resaleListingId: item.resaleListingId,
          description: availabilityItem?.name ?? 'Selected item',
          quantity: item.quantity,
          unitPriceCents,
          totalCents: unitPriceCents * item.quantity,
        };
      });
      const quotePlan = planInventoryRecovery({
        quantities: quantitiesRef.current,
        availability: availabilityRef.current,
        currency: created.currency ?? displayCurrency,
        previousQuote: {
          subtotalCents: previewTotal,
          discountCents: 0,
          taxCents: 0,
          feeCents: 0,
          totalCents: previewTotal,
          lineItems: localQuoteLines,
        },
        nextQuote: created.quote,
      });
      if (quotePlan.requiresAcknowledgement) {
        // Keep the server session (authoritative quote), but never infer consent
        // from a matching total. Component reallocations and item price changes
        // require the buyer's explicit acknowledgement before confirmation.
        setInventoryRecovery(quotePlan);
        setInventoryAcknowledged(false);
        setValidationError(quotePlan.summary);
      } else {
        setInventoryRecovery(null);
        setInventoryAcknowledged(true);
      }

      createSessionAttemptRef.current = undefined;
      serverConfirmedHoldRef.current = null;
      setSessionId(created.id);
      setSessionToken(created.clientToken);
      applyServerSessionState(created);
      // Store the token in sessionStorage for resume after redirect.
      // Do NOT write the token to the URL or browser history.
      storeSessionToken(created.id, created.clientToken);
      trackMarketingEvent(event?.marketingIntegrations, 'begin_checkout', {
        eventId,
        sessionId: created.id,
        currency: created.currency ?? displayCurrency,
        valueCents: created.quote.totalCents,
        items: selectedMarketingItems,
      });
      emitCheckoutEvent('checkout_session_created', {
        sessionId: created.id,
        eventId,
      });
      emitCheckoutEvent('checkout_started', {
        sessionId: created.id,
        eventId,
      });
    } catch (err) {
      if (!mutationGenerationRef.current.isCurrent(generation)) return;
      if (await handleSelectionConflict(err)) {
        createSessionAttemptRef.current = undefined;
        return;
      }
      if (isTransportFailure(err)) {
        const status = readConnectivityStatus();
        setConnectivity(status);
        // Keep the original transport message (supports idempotent retry UX).
        // Only swap in the offline banner copy when the browser is offline.
        const message =
          status === 'offline' ? transportFailureMessage('offline') : userFacingMessage(err);
        setNetworkMessage(message);
        setError(message);
        return;
      }
      if (!isRetryable(err)) createSessionAttemptRef.current = undefined;
      setError(userFacingMessage(err));
    } finally {
      if (mutationGenerationRef.current.isCurrent(generation)) {
        createSessionInFlightRef.current = false;
        setLoading(false);
      } else {
        createSessionInFlightRef.current = false;
      }
    }
  }

  async function confirmSession() {
    if (!session || !sessionToken || confirmSessionInFlightRef.current) return;
    if (submissionBlockedByHold || sessionHoldStatusRef.current !== 'ok') return;
    if (inventoryRecovery && !inventoryAcknowledged) return;

    const connectivityNow = readConnectivityStatus();
    setConnectivity(connectivityNow);
    if (connectivityNow === 'offline') {
      setNetworkMessage(transportFailureMessage('offline'));
      setError(transportFailureMessage('offline'));
      return;
    }

    const expiresAtMs = parseSessionExpiresAtMs(session.expiresAt);
    const confirmed = serverConfirmedHoldRef.current;
    const serverAlreadyConfirmed =
      confirmed && confirmed.sessionId === session.id && confirmed.expiresAt === session.expiresAt;
    // Always revalidate before pay when expiresAt is missing/invalid, or when
    // the browser clock says the hold lapsed and the server has not confirmed it.
    if (expiresAtMs === null || (expiresAtMs <= Date.now() && !serverAlreadyConfirmed)) {
      void revalidateSessionHold();
      return;
    }

    confirmSessionInFlightRef.current = true;
    const generation = mutationGenerationRef.current.next();
    setLoading(true);
    setError(null);
    setNetworkMessage(null);
    try {
      const currentAttempt = confirmSessionAttemptRef.current;
      const attempt =
        currentAttempt?.sessionId === session.id
          ? currentAttempt
          : { sessionId: session.id, idempotencyKey: newConfirmIdempotencyKey() };
      confirmSessionAttemptRef.current = attempt;
      const result = await checkoutApi.confirmSession(
        session.id,
        sessionToken,
        attempt.idempotencyKey,
      );
      if (!mutationGenerationRef.current.isCurrent(generation)) return;
      // Hold may flip while confirm is in flight; never advance payment after expiry.
      const holdAfterConfirm = sessionHoldStatusRef.current;
      if (holdAfterConfirm !== 'ok') {
        confirmSessionAttemptRef.current = undefined;
        return;
      }
      confirmSessionAttemptRef.current = undefined;
      if ('order' in result) {
        setConfirmResult(result);
        setPhase('completed');
        setHoldStatus('ok', null);
        const order = result.order;
        trackMarketingEvent(event?.marketingIntegrations, 'purchase', {
          eventId,
          sessionId: session.id,
          orderId: order.id,
          currency: order.currency ?? session.currency ?? displayCurrency,
          valueCents: order.totalCents,
          items: selectedMarketingItems,
        });
        emitCheckoutEvent('order_completed', {
          sessionId: session.id,
          orderId: order.id,
          eventId,
        });
        // Redirect to confirmation with only sessionId/orderId, no token.
        navigateToConfirmation(session.id, order.id);
      } else {
        // Payment UI is only valid while the server session remains payable.
        const payableSession: CheckoutSession = {
          ...session,
          status: result.status,
          orderId: null,
        };
        if (serverSessionTransition(payableSession) !== 'payment') {
          setConfirmResult(null);
          setHoldStatus('terminal', terminalSessionMessage(payableSession));
          setPhase('confirm');
          return;
        }
        sessionRef.current = payableSession;
        setSession(payableSession);
        setConfirmResult(result);
        setValidationError(null);
        setPhase('payment');
      }
    } catch (err) {
      if (!mutationGenerationRef.current.isCurrent(generation)) return;
      if (isCheckoutExpiredError(err)) {
        confirmSessionAttemptRef.current = undefined;
        setConfirmResult(null);
        setHoldStatus(
          'expired',
          userFacingMessage(err) ||
            'Your checkout session expired. Start a new order to reserve tickets again.',
        );
        return;
      }
      if (await handleSelectionConflict(err)) {
        confirmSessionAttemptRef.current = undefined;
        return;
      }
      if (isTransportFailure(err)) {
        const status = readConnectivityStatus();
        setConnectivity(status);
        const message =
          status === 'offline' ? transportFailureMessage('offline') : userFacingMessage(err);
        setNetworkMessage(message);
        setError(message);
        return;
      }
      if (!isRetryable(err)) confirmSessionAttemptRef.current = undefined;
      setError(userFacingMessage(err));
    } finally {
      confirmSessionInFlightRef.current = false;
      setLoading(false);
    }
  }

  function editOrder() {
    if (sessionHoldStatusRef.current === 'expired' || sessionHoldStatusRef.current === 'terminal') {
      restartCheckoutAfterExpiry();
      return;
    }
    setPhase('select');
    setError(null);
    setValidationError(null);
  }

  const startsAt = event ? formatDateTime(event.startsAt, event.timezone) : null;
  const venueName = event?.venue?.name;
  const isFreeOrder = session?.quote.totalCents === 0;

  const buyerParticipationTarget = useMemo(() => {
    const targets = selectedItems.map((item) => {
      const occurrenceId =
        item.occurrenceId ?? (item.resaleListingId ? resaleListing?.eventOccurrenceId : undefined);
      const occurrence = occurrenceId
        ? occurrences.find((candidate) => candidate.id === occurrenceId)
        : undefined;
      return occurrence
        ? { participationAt: occurrence.startsAt, timezone: occurrence.timezone }
        : { participationAt: event?.startsAt ?? '', timezone: event?.timezone ?? 'UTC' };
    });
    const fallback = {
      participationAt: event?.startsAt ?? '',
      timezone: event?.timezone ?? 'UTC',
    };
    return (targets.length > 0 ? targets : [fallback]).reduce((strictest, candidate) => {
      const candidateMax = maximumEligibleDateOfBirth({
        participationAt: candidate.participationAt,
        timezone: candidate.timezone,
        minimumAge: event?.minimumAge,
      });
      const strictestMax = maximumEligibleDateOfBirth({
        participationAt: strictest.participationAt,
        timezone: strictest.timezone,
        minimumAge: event?.minimumAge,
      });
      return candidateMax && (!strictestMax || candidateMax < strictestMax) ? candidate : strictest;
    });
  }, [event, occurrences, resaleListing, selectedItems]);

  // Build attendee question groups for the AttendeeForm.
  const attendeeQuestionGroups = useMemo(() => {
    if (!questions) return [];
    return selectedItems
      .filter((item): item is CartItem & { ticketTypeId: string } => Boolean(item.ticketTypeId))
      .map((item) => {
        const ticket = visibleAvailability.find((t) => availabilityItemId(t) === cartItemId(item));
        const itemQuestions = questions.attendeeQuestions.filter(
          (q) => !q.ticketTypeId || q.ticketTypeId === item.ticketTypeId,
        );
        const occurrence = item.occurrenceId
          ? occurrences.find((candidate) => candidate.id === item.occurrenceId)
          : undefined;
        return {
          lineId: cartItemId(item),
          ticketTypeId: item.ticketTypeId,
          ticketName: ticket?.name ?? 'Ticket',
          quantity: item.quantity,
          questions: itemQuestions,
          participationAt: occurrence?.startsAt ?? event?.startsAt ?? '',
          timezone: occurrence?.timezone ?? event?.timezone ?? 'UTC',
        };
      })
      .filter((group) => group.quantity > 0);
  }, [event, occurrences, questions, selectedItems, visibleAvailability]);

  if (initialLoading) {
    return (
      <Surface brand={brand}>
        <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6">
          <Skeleton className="h-8 w-48" />
          <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
            <div className="space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
            <Skeleton className="h-80 w-full" />
          </div>
        </div>
      </Surface>
    );
  }

  // Hard load failure with no event and no session.
  if (error && !event && !session) {
    const notFound = error === 'Event not found' || (error.length > 0 && /not found/i.test(error));
    return (
      <Surface brand={brand}>
        <div className="mx-auto w-full max-w-2xl px-4 py-16 sm:px-6">
          <EmptyState
            icon={AlertCircleIcon}
            title={notFound ? 'Event not found' : 'Checkout unavailable'}
            description={error}
            action={
              <Button variant="outline" onClick={() => window.location.reload()}>
                Try again
              </Button>
            }
          />
        </div>
      </Surface>
    );
  }

  return (
    <Surface brand={brand}>
      <RefreshNotifier eventId={eventId} />
      <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <Badge variant="secondary" className="gap-1.5">
                <TicketIcon className="size-3.5" />
                {brand.name}
              </Badge>
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                {event?.title ?? 'Checkout'}
              </h1>
            </div>
            {phase === 'select' && eventId ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => push(`/e/${eventId}`)}
                className="gap-1.5"
              >
                <ArrowLeftIcon className="size-4" />
                Back to event
              </Button>
            ) : phase === 'confirm' || phase === 'payment' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={editOrder}
                disabled={loading}
                className="gap-1.5"
              >
                <ArrowLeftIcon className="size-4" />
                Edit order
              </Button>
            ) : null}
          </div>
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {startsAt ? (
              <div className="flex items-center gap-2">
                <CalendarIcon className="size-4" />
                <dd>{startsAt}</dd>
              </div>
            ) : null}
            {venueName ? (
              <div className="flex items-center gap-2">
                <MapPinIcon className="size-4" />
                <dd>{venueName}</dd>
              </div>
            ) : null}
          </dl>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-6">
            {phase === 'select' ? (
              <Card>
                <CardHeader>
                  <CardTitle>Select tickets</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  {resaleListing ? (
                    <div className="space-y-4 rounded-lg border bg-card p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="font-medium">
                            {resaleListing.ticketTypeName
                              ? `Resale ticket - ${resaleListing.ticketTypeName}`
                              : 'Resale ticket'}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            Verified resale ticket. Quantity is fixed at 1.
                          </p>
                        </div>
                        <p className="font-semibold tabular-nums">
                          {formatCurrency(resaleListing.priceCents, resaleListing.currency)}
                        </p>
                      </div>
                      <div className="flex items-start gap-3 border-t pt-4">
                        <input
                          id="resale-terms-acceptance"
                          type="checkbox"
                          checked={resaleTermsAccepted}
                          onChange={(checkboxEvent) =>
                            setResaleTermsAccepted(checkboxEvent.target.checked)
                          }
                          className="mt-0.5 size-4 rounded border-input"
                        />
                        <Label htmlFor="resale-terms-acceptance" className="space-y-1 font-normal">
                          <span className="block font-medium">Accept resale purchase terms</span>
                          <span className="block text-xs leading-relaxed text-muted-foreground">
                            The organizer manages seller payment and coordinates any buyer refund
                            manually. Tixkit does not hold seller funds or promise an automatic
                            resale refund.
                          </span>
                        </Label>
                      </div>
                    </div>
                  ) : visibleAvailability.length === 0 ? (
                    <EmptyState
                      icon={TicketIcon}
                      title="No tickets available"
                      description="Ticket sales have not opened for this event yet."
                    />
                  ) : (
                    <TicketSelection
                      tickets={visibleAvailability}
                      quantities={quantities}
                      loading={loading}
                      onDecrease={decrease}
                      onIncrease={increase}
                      donationAmounts={donationAmounts}
                      onDonationAmountChange={handleDonationAmountChange}
                      unlockedTicketTypeIds={unlockedTicketTypeIds}
                      waitlistTicketTypeIds={waitlistTicketTypeIds}
                      onJoinWaitlist={joinWaitlist}
                    />
                  )}

                  <Separator />

                  {!resaleListing && hasVisibleLockedTicket ? (
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Access code</p>
                        <PromoInput
                          initialCode={accessCode}
                          disabled={loading}
                          applied={accessCodeApplied}
                          onApply={applyAccessCode}
                          onRemove={removeAccessCode}
                          accessMode
                        />
                      </div>
                    </div>
                  ) : null}

                  {!resaleListing ? (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">Have a promo code?</p>
                      <PromoInput
                        initialCode={discountCode}
                        disabled={loading}
                        applied={promoApplied}
                        onApply={applyDiscount}
                        onRemove={removeDiscount}
                      />
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            {(phase === 'select' || phase === 'confirm') && event ? (
              <Card>
                <CardHeader>
                  <CardTitle>Your details</CardTitle>
                </CardHeader>
                <CardContent>
                  {questionsLoading ? (
                    <Alert>
                      <LoaderCircleIcon className="animate-spin" />
                      <AlertTitle>Loading checkout fields</AlertTitle>
                      <AlertDescription>
                        Required buyer and attendee fields are loading before checkout can continue.
                      </AlertDescription>
                    </Alert>
                  ) : questionsError ? (
                    <Alert variant="destructive">
                      <AlertCircleIcon />
                      <AlertTitle>Checkout fields unavailable</AlertTitle>
                      <AlertDescription className="space-y-3">
                        <span>{questionsError}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-fit"
                          onClick={() => setQuestionsRetryKey((current) => current + 1)}
                        >
                          Retry checkout fields
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : questions ? (
                    <AttendeeForm
                      buyer={buyer}
                      onChange={setBuyer}
                      disabled={loading && phase === 'confirm'}
                      emailError={emailError}
                      buyerDateOfBirthError={buyerDateOfBirthError}
                      minimumAge={event?.minimumAge}
                      participationAt={buyerParticipationTarget.participationAt}
                      timezone={buyerParticipationTarget.timezone}
                      eventId={eventId}
                      buyerQuestions={questions.buyerQuestions}
                      buyerAnswers={buyerAnswers}
                      buyerQuestionErrors={buyerQuestionErrors}
                      onBuyerAnswersChange={(answers) => {
                        setBuyerAnswers(answers);
                        setBuyerQuestionErrors({});
                      }}
                      attendeeQuestionGroups={attendeeQuestionGroups}
                      attendeeAnswers={attendeeAnswers}
                      attendeeQuestionErrors={attendeeQuestionErrors}
                      attendeeDateOfBirths={attendeeDateOfBirths}
                      attendeeDateOfBirthErrors={attendeeDateOfBirthErrors}
                      onAttendeeDateOfBirthsChange={(values) => {
                        setAttendeeDateOfBirths(values);
                        setAttendeeDateOfBirthErrors({});
                      }}
                      onAttendeeAnswersChange={(answers) => {
                        setAttendeeAnswers(answers);
                        setAttendeeQuestionErrors({});
                      }}
                    />
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            {phase === 'payment' && confirmResult && !('order' in confirmResult) ? (
              <Card>
                <CardHeader>
                  <CardTitle>Payment</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {sessionHoldStatus === 'checking' ? (
                    <output
                      className="flex w-full items-start gap-3 rounded-lg border bg-card px-4 py-3 text-sm text-card-foreground"
                      aria-live="polite"
                    >
                      <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin" />
                      <span className="space-y-1">
                        <span className="block font-medium tracking-tight">
                          Checking reservation
                        </span>
                        <span className="block text-muted-foreground">
                          {sessionHoldMessage ??
                            'Checking whether your ticket reservation is still valid…'}
                        </span>
                      </span>
                    </output>
                  ) : null}
                  {sessionHoldStatus === 'expired' || sessionHoldStatus === 'terminal' ? (
                    <Alert variant="destructive">
                      <AlertCircleIcon />
                      <AlertTitle>
                        {sessionHoldStatus === 'expired'
                          ? 'Checkout expired'
                          : 'Checkout unavailable'}
                      </AlertTitle>
                      <AlertDescription className="space-y-3">
                        <p>
                          {sessionHoldMessage ??
                            'Your checkout session expired. Start a new order to reserve tickets again.'}
                        </p>
                        <Button
                          ref={expiryRestartButtonRef}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-fit"
                          onClick={restartCheckoutAfterExpiry}
                        >
                          Start new order
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {sessionHoldStatus === 'revalidation_failed' ? (
                    <Alert variant="destructive">
                      <AlertCircleIcon />
                      <AlertTitle>Reservation could not be verified</AlertTitle>
                      <AlertDescription className="space-y-3">
                        <p>
                          {sessionHoldMessage ??
                            'We could not confirm your ticket reservation. Payment is paused until the reservation is revalidated.'}
                        </p>
                        <Button
                          ref={expiryRetryButtonRef}
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-fit"
                          onClick={() => void revalidateSessionHold({ manual: true })}
                        >
                          Retry reservation check
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {sessionHoldStatus === 'ok' ? (
                    <PaymentHandoff
                      clientSecret={confirmResult.clientSecret ?? ''}
                      currency={confirmResult.currency}
                      totalCents={confirmResult.totalCents}
                      billingDetails={paymentBillingDetails}
                      // Return URL contains only sessionId, no token.
                      // The confirmation page resolves the session via
                      // sessionId using the token from sessionStorage.
                      returnUrl={`${window.location.origin}/checkout/confirmation?sessionId=${encodeURIComponent(sessionId)}`}
                      onError={handlePaymentError}
                    />
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            {phase === 'completed' ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
                  <CheckCircle2Icon className="size-10 text-emerald-600" />
                  <h2 className="text-lg font-semibold">Order complete</h2>
                  <p className="text-sm text-muted-foreground">Redirecting to your confirmation…</p>
                  <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
                </CardContent>
              </Card>
            ) : null}
          </div>

          <aside className="lg:sticky lg:top-6 lg:self-start">
            <Card>
              <CardHeader>
                <CardTitle>Order summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <OrderSummary
                  items={selectedItems}
                  tickets={visibleAvailability}
                  currency={displayCurrency}
                  quote={session?.quote}
                  presetTotalCents={previewTotal}
                />

                {inventoryRecovery ? (
                  <Alert
                    ref={inventoryAlertRef}
                    variant="destructive"
                    tabIndex={-1}
                    aria-live="assertive"
                    className="outline-none"
                  >
                    <AlertCircleIcon />
                    <AlertTitle>{checkoutCopy.inventoryChangedTitle}</AlertTitle>
                    <AlertDescription className="space-y-3">
                      <p>{inventoryRecovery.summary}</p>
                      <ul className="list-disc space-y-1 pl-4 text-sm">
                        {inventoryRecovery.changes.map((change) => (
                          <li key={`${change.kind}:${change.itemId}`}>{change.message}</li>
                        ))}
                      </ul>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-fit"
                          onClick={acknowledgeInventoryRecovery}
                        >
                          {checkoutCopy.inventoryChangedAcknowledge}
                        </Button>
                        {inventoryRecovery.focusItemId ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="w-fit"
                            onClick={() => {
                              setPhase('select');
                              const el = document.getElementById(
                                `ticket-${inventoryRecovery.focusItemId}`,
                              );
                              el?.focus();
                              el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                            }}
                          >
                            {checkoutCopy.inventoryReviewSelection}
                          </Button>
                        ) : null}
                      </div>
                    </AlertDescription>
                  </Alert>
                ) : null}

                {validationError && !inventoryRecovery ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertTitle>{checkoutCopy.pleaseFixTitle}</AlertTitle>
                    <AlertDescription>{validationError}</AlertDescription>
                  </Alert>
                ) : null}

                {waitlistMessage ? (
                  <Alert>
                    <CheckCircle2Icon />
                    <AlertTitle>Waitlist</AlertTitle>
                    <AlertDescription>{waitlistMessage}</AlertDescription>
                  </Alert>
                ) : null}

                {connectivity === 'offline' ? (
                  <Alert variant="destructive" aria-live="assertive">
                    <AlertCircleIcon />
                    <AlertTitle>{checkoutCopy.networkOfflineTitle}</AlertTitle>
                    <AlertDescription className="space-y-3">
                      <p>{networkMessage ?? transportFailureMessage('offline')}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-fit"
                        onClick={() => {
                          const status = readConnectivityStatus();
                          setConnectivity(status);
                          if (status === 'offline') {
                            setNetworkMessage(transportFailureMessage('offline'));
                            return;
                          }
                          setNetworkMessage(null);
                          setError(null);
                          if (phase === 'confirm' && session) {
                            void confirmSession();
                          } else if (phase === 'select') {
                            void createSession();
                          } else if (sessionHoldStatus === 'revalidation_failed' && session) {
                            void revalidateSessionHold({ manual: true });
                          }
                        }}
                      >
                        {checkoutCopy.networkRetry}
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}

                {error && connectivity !== 'offline' ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertTitle>
                      {isTransportFailure({ code: 'NETWORK_ERROR', status: 0 }) &&
                      (error.toLowerCase().includes('reach') ||
                        error.toLowerCase().includes('network') ||
                        error.toLowerCase().includes('offline'))
                        ? checkoutCopy.networkUnreachableTitle
                        : error.toLowerCase().includes('inventory') ||
                            error.toLowerCase().includes('sold out')
                          ? checkoutCopy.inventoryChangedTitle
                          : checkoutCopy.checkoutErrorTitle}
                    </AlertTitle>
                    <AlertDescription className="space-y-3">
                      <p>{error}</p>
                      {networkMessage ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-fit"
                          onClick={() => {
                            setNetworkMessage(null);
                            setError(null);
                            if (phase === 'confirm' && session) {
                              void confirmSession();
                            } else if (phase === 'select') {
                              void createSession();
                            }
                          }}
                        >
                          {checkoutCopy.networkRetry}
                        </Button>
                      ) : null}
                    </AlertDescription>
                  </Alert>
                ) : null}

                {session && (phase === 'confirm' || phase === 'payment') ? (
                  <div className="space-y-2" aria-live="polite">
                    {sessionHoldStatus === 'ok' && parseSessionExpiresAtMs(session.expiresAt) ? (
                      <p className="text-xs text-muted-foreground">
                        Session reserved until{' '}
                        {new Date(session.expiresAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                        . Your tickets are held while you complete checkout. We re-check the
                        reservation with the server when that time is reached.
                      </p>
                    ) : null}
                    {sessionHoldStatus === 'checking' ? (
                      <output
                        className="flex w-full items-start gap-3 rounded-lg border bg-card px-4 py-3 text-sm text-card-foreground"
                        aria-live="polite"
                      >
                        <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin" />
                        <span className="space-y-1">
                          <span className="block font-medium tracking-tight">
                            Checking reservation
                          </span>
                          <span className="block text-muted-foreground">
                            {sessionHoldMessage ??
                              'Checking whether your ticket reservation is still valid…'}
                          </span>
                        </span>
                      </output>
                    ) : null}
                    {sessionHoldStatus === 'expired' || sessionHoldStatus === 'terminal' ? (
                      <Alert variant="destructive">
                        <AlertCircleIcon />
                        <AlertTitle>
                          {sessionHoldStatus === 'expired'
                            ? 'Checkout expired'
                            : 'Checkout unavailable'}
                        </AlertTitle>
                        <AlertDescription className="space-y-3">
                          <p>
                            {sessionHoldMessage ??
                              'Your checkout session expired. Start a new order to reserve tickets again.'}
                          </p>
                          <Button
                            ref={phase === 'confirm' ? expiryRestartButtonRef : undefined}
                            type="button"
                            variant="outline"
                            size="sm"
                            className="w-fit"
                            onClick={restartCheckoutAfterExpiry}
                          >
                            Start new order
                          </Button>
                        </AlertDescription>
                      </Alert>
                    ) : null}
                    {sessionHoldStatus === 'revalidation_failed' ? (
                      <Alert variant="destructive">
                        <AlertCircleIcon />
                        <AlertTitle>Reservation could not be verified</AlertTitle>
                        <AlertDescription className="space-y-3">
                          <p>
                            {sessionHoldMessage ??
                              'We could not confirm your ticket reservation. Payment is paused until the reservation is revalidated.'}
                          </p>
                          <Button
                            ref={phase === 'confirm' ? expiryRetryButtonRef : undefined}
                            type="button"
                            variant="outline"
                            size="sm"
                            className="w-fit"
                            onClick={() => void revalidateSessionHold({ manual: true })}
                          >
                            Retry reservation check
                          </Button>
                        </AlertDescription>
                      </Alert>
                    ) : null}
                  </div>
                ) : null}

                {phase === 'select' ? (
                  <Button
                    type="button"
                    size="lg"
                    className="w-full gap-2"
                    disabled={
                      !canCreateSession ||
                      sessionHoldStatus === 'expired' ||
                      sessionHoldStatus === 'terminal'
                    }
                    onClick={createSession}
                  >
                    {loading ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
                    Continue
                  </Button>
                ) : phase === 'confirm' ? (
                  <Button
                    type="button"
                    size="lg"
                    className="w-full gap-2"
                    disabled={loading || !session || submissionBlockedByHold}
                    onClick={confirmSession}
                  >
                    {loading || sessionHoldStatus === 'checking' ? (
                      <LoaderCircleIcon className="size-4 animate-spin" />
                    ) : null}
                    {sessionHoldStatus === 'checking'
                      ? 'Checking reservation…'
                      : isFreeOrder
                        ? 'Place free order'
                        : `Pay ${formatCurrency(session?.quote.totalCents ?? previewTotal, session?.currency ?? displayCurrency)}`}
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          </aside>
        </div>

        <BrandFooter brand={brand} />
      </div>
    </Surface>
  );
}

function Surface({ brand, children }: { brand: ResolvedBrand; children: React.ReactNode }) {
  return (
    <BrandThemeSurface as="main" className="min-h-svh bg-background text-foreground" brand={brand}>
      {children}
    </BrandThemeSurface>
  );
}

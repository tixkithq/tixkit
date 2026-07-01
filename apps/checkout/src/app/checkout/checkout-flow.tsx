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
  userFacingMessage,
  type PublicEvent,
  type AvailabilityItem,
  type CheckoutSession,
  type CheckoutPublicResaleListing,
  type Buyer,
  type CartItem,
  type ConfirmResult,
  type QuestionsResponse,
} from '@/lib/api';
import { brandThemeStyle, type ResolvedBrand } from '@/lib/brand';
import { useResolvedBrand } from '@/lib/use-brand';
import { storeSessionToken, getSessionToken } from '@/lib/session-token';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { parseItemsParam, parseProductFilterParam } from '@/lib/checkout-query';
import {
  isAnswerEmpty,
  normalizeCheckoutAnswers,
  visibleCheckoutQuestions,
} from '@/lib/checkout-questions';
import { trackMarketingEvent, type MarketingEventItem } from '@/lib/marketing';

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
  event: 'checkout_started' | 'order_completed',
  detail: Record<string, unknown>,
) {
  if (typeof window === 'undefined') return;
  const message = {
    source: 'tixkit-checkout',
    event,
    type: event,
    ...detail,
  };
  window.parent?.postMessage(message, '*');
  window.opener?.postMessage(message, '*');
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
  const router = useRouter();
  const [eventId, setEventId] = useState(initialEventId);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [sessionToken, setSessionToken] = useState(initialSessionToken);
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [availability, setAvailability] = useState<AvailabilityItem[]>([]);
  const [resaleListing, setResaleListing] = useState<CheckoutPublicResaleListing | null>(null);
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
  });
  const [buyerAnswers, setBuyerAnswers] = useState<AttendeeAnswers>({});
  const [attendeeAnswers, setAttendeeAnswers] = useState<AttendeeAnswers>({});
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
  const [waitlistMessage, setWaitlistMessage] = useState<string | null>(null);
  const [waitlistTicketTypeIds, setWaitlistTicketTypeIds] = useState<Set<string>>(() => new Set());
  const [claimTicketTypeId, setClaimTicketTypeId] = useState<string | null>(null);
  const [claimQuantity, setClaimQuantity] = useState(1);
  const didApplyPrefilledItemsRef = useRef(false);
  const didApplyWaitlistClaimRef = useRef(false);

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
      if (ticketQuestions.length === 0) return item;

      const attendeeFields: Record<string, unknown>[] = [];
      for (let i = 0; i < item.quantity; i++) {
        const answersForAttendee = Object.fromEntries(
          ticketQuestions.map((q) => [q.id, attendeeAnswers[`${lineId}:${i}:${q.id}`]]),
        );
        const fields: Record<string, unknown> = {};
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
  }, [visibleAvailability, quantities, donationAmounts, questions, attendeeAnswers, resaleListing]);

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
    if (!questions) {
      return questionsError ?? 'Required checkout fields are still loading. Please try again.';
    }

    for (const item of selectedItems) {
      if (!item.ticketTypeId) continue;
      const lineId = cartItemId(item);
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
            if (!q.required) continue;
            const key = `${lineId}:${i}:${q.id}`;
            const answer = attendeeAnswers[key];
            if (isAnswerEmpty(answer)) {
              if (q.type === 'checkbox') {
                return `Please check ${q.label} for ${ticketType?.name ?? 'this ticket'} attendee ${i + 1}.`;
              }
              return `Please complete ${q.label} for ${ticketType?.name ?? 'this ticket'} attendee ${i + 1}.`;
            }
          }
        }
      }

      // Validate required buyer questions.
      for (const q of visibleCheckoutQuestions(questions.buyerQuestions, buyerAnswers)) {
        if (!q.required) continue;
        const answer = buyerAnswers[q.id];
        if (isAnswerEmpty(answer)) {
          if (q.type === 'checkbox') {
            return `Please check ${q.label}.`;
          }
          return `Please complete ${q.label}.`;
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
    questions,
  );

  // Resolve an existing session once on mount when resuming via sessionId +
  // token. This must NOT re-run when we create a new session mid-flow (that
  // would reset the phase back to "select"), so it reads the initial values
  // and only fires on mount.
  const didResumeRef = useRef(false);
  useEffect(() => {
    if (didResumeRef.current) return;
    didResumeRef.current = true;
    let cancelled = false;
    async function loadSession() {
      if (!initialSessionId) {
        setInitialLoading(false);
        return;
      }
      // Prefer the token from sessionStorage (resume mechanism), then from
      // initial props. Never read the token from URL params here.
      const token = getSessionToken(initialSessionId) || initialSessionToken;
      if (!token) {
        setInitialLoading(false);
        return;
      }
      setLoading(true);
      try {
        const loaded = await checkoutApi.getSession(initialSessionId, token);
        if (cancelled) return;
        setSession(loaded);
        setSessionId(loaded.id);
        setSessionToken(token);
        setEventId(loaded.eventId);
        setPhase(loaded.status === 'open' ? 'select' : 'confirm');
      } catch (err) {
        if (!cancelled) setError(userFacingMessage(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setInitialLoading(false);
        }
      }
    }
    void loadSession();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        const [loadedEvent, loadedAvailability, selectedResaleListing] = await Promise.all([
          publicApi.getEvent(eventId, controller.signal),
          publicApi.getAvailability(eventId, controller.signal, productFilterParam),
          resaleListingId
            ? findPublicResaleListing(eventId, resaleListingId, controller.signal)
            : Promise.resolve(undefined),
        ]);
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

        if (!cancelled) setInitialLoading(false);

        // Required checkout fields are server-authoritative. If the question
        // metadata cannot load, keep checkout blocked until a retry succeeds.
        setQuestionsLoading(true);
        try {
          const loadedQuestions = await publicApi.getQuestions(eventId, controller.signal);
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

  const handlePaymentError = useCallback((message: string) => {
    setError(message);
  }, []);

  function increase(itemId: string) {
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
    if (!validateEmail()) return;

    const cartError = validateCart();
    if (cartError) {
      setValidationError(cartError);
      return;
    }
    setValidationError(null);

    setLoading(true);
    setError(null);
    setConfirmResult(null);
    try {
      // Build successUrl without any token. The confirmation page resolves
      // the session via sessionId using the token from sessionStorage.
      const successUrl = `${window.location.origin}/checkout/confirmation?sessionId={sessionId}&orderId={orderId}`;
      const created = await checkoutApi.createSession({
        eventId,
        items: selectedItems,
        buyer,
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
        successUrl,
        cancelUrl: window.location.href,
      });
      if (!created.clientToken) {
        throw new CheckoutApiError(
          'SESSION_TOKEN_MISSING',
          'Checkout session token was not returned.',
          500,
        );
      }
      setSession(created);
      setSessionId(created.id);
      setSessionToken(created.clientToken);
      setPhase('confirm');
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
      emitCheckoutEvent('checkout_started', {
        sessionId: created.id,
        eventId,
      });
    } catch (err) {
      setError(userFacingMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function confirmSession() {
    if (!session || !sessionToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await checkoutApi.confirmSession(session.id, sessionToken);
      setConfirmResult(result);
      if ('order' in result) {
        setPhase('completed');
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
        const params = new URLSearchParams({
          sessionId: session.id,
          orderId: order.id,
        });
        if (order.orderNumber) params.set('orderNumber', order.orderNumber);
        router.push(`/checkout/confirmation?${params.toString()}`);
      } else {
        // Paid order: backend returned a payment intent client secret.
        setPhase('payment');
      }
    } catch (err) {
      setError(userFacingMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function editOrder() {
    setPhase('select');
    setError(null);
    setValidationError(null);
  }

  const startsAt = event ? formatDateTime(event.startsAt, event.timezone) : null;
  const venueName = event?.venue?.name;
  const isFreeOrder = session?.quote.totalCents === 0;

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
        return {
          lineId: cartItemId(item),
          ticketTypeId: item.ticketTypeId,
          ticketName: ticket?.name ?? 'Ticket',
          quantity: item.quantity,
          questions: itemQuestions,
        };
      })
      .filter((g) => g.questions.length > 0);
  }, [questions, selectedItems, visibleAvailability]);

  if (initialLoading) {
    return (
      <Surface brand={brand}>
        <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6">
          <Skeleton className="h-8 w-48" />
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
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
            {phase === 'confirm' || phase === 'payment' ? (
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

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6">
            {phase === 'select' ? (
              <Card>
                <CardHeader>
                  <CardTitle>Select tickets</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  {resaleListing ? (
                    <div className="rounded-lg border bg-card p-4">
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
                      eventId={eventId}
                      buyerQuestions={questions.buyerQuestions}
                      buyerAnswers={buyerAnswers}
                      onBuyerAnswersChange={setBuyerAnswers}
                      attendeeQuestionGroups={attendeeQuestionGroups}
                      attendeeAnswers={attendeeAnswers}
                      onAttendeeAnswersChange={setAttendeeAnswers}
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
                <CardContent>
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

                {validationError ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertTitle>Please fix the following</AlertTitle>
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

                {error ? (
                  <Alert variant="destructive">
                    <AlertCircleIcon />
                    <AlertTitle>Checkout error</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}

                {phase === 'select' ? (
                  <Button
                    type="button"
                    size="lg"
                    className="w-full gap-2"
                    disabled={!canCreateSession}
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
                    disabled={loading || !session}
                    onClick={confirmSession}
                  >
                    {loading ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
                    {isFreeOrder
                      ? 'Place free order'
                      : `Pay ${formatCurrency(session?.quote.totalCents ?? previewTotal, session?.currency ?? displayCurrency)}`}
                  </Button>
                ) : null}

                {session ? (
                  <p className="text-xs text-muted-foreground">
                    Session reserved until{' '}
                    {new Date(session.expiresAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                    . Your tickets are held while you complete checkout.
                  </p>
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
    <main className="min-h-svh bg-background text-foreground" style={brandThemeStyle(brand)}>
      {children}
    </main>
  );
}

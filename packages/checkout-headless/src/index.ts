import { issueCheckoutHeadlessRequestUrl } from './request-target.js';

export { issueCheckoutHeadlessRequestUrl } from './request-target.js';

export const CHECKOUT_HEADLESS_VERSION = '1.0.0' as const;

export type CheckoutPhase =
  | 'idle'
  | 'loading'
  | 'selecting'
  | 'collecting-details'
  | 'creating-session'
  | 'awaiting-payment'
  | 'confirming'
  | 'completed'
  | 'expired'
  | 'recoverable-error'
  | 'fatal-error';

export type AvailabilityItem = {
  type?: 'ticket' | 'product' | 'resale';
  ticketTypeId?: string;
  eventOccurrenceId?: string;
  productId?: string;
  resaleListingId?: string;
  name: string;
  kind: 'free' | 'paid' | 'donation' | 'product' | 'resale';
  priceCents: number;
  minimumPriceCents?: number;
  currency: string;
  minPerOrder: number;
  maxPerOrder: number;
  available: number;
  status: string;
  requiresAccessCode?: boolean;
};

export type CheckoutQuestion = {
  id: string;
  label: string;
  type:
    | 'text'
    | 'textarea'
    | 'email'
    | 'phone'
    | 'select'
    | 'multiselect'
    | 'checkbox'
    | 'date'
    | 'waiver'
    | 'file';
  required: boolean;
  appliesTo: 'buyer' | 'attendee' | 'both';
  ticketTypeId?: string;
  options?: string[];
};

export type CheckoutBuyer = {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  dateOfBirth?: string;
};

export type CheckoutTicketCartItem = {
  type: 'ticket';
  ticketTypeId: string;
  occurrenceId?: string;
  quantity: number;
  attendeeFields?: Record<string, unknown>[];
  donationAmountCents?: number;
};
export type CheckoutProductCartItem = { type: 'product'; productId: string; quantity: number };
export type CheckoutResaleCartItem = { type: 'resale'; resaleListingId: string; quantity: 1 };
export type CheckoutCartItem =
  | CheckoutTicketCartItem
  | CheckoutProductCartItem
  | CheckoutResaleCartItem;

export type CheckoutQuote = {
  totalCents: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  feeCents: number;
};
export type CheckoutSession = {
  id: string;
  eventId: string;
  status: string;
  currency: string;
  quote: CheckoutQuote;
  expiresAt: string;
  orderId?: string | null;
};
type TransportCheckoutSession = CheckoutSession & { clientToken?: string };
export type PaymentHandoff = {
  paymentIntentId: string;
  totalCents: number;
  currency: string;
  mode: 'hosted';
  url: string;
  expiresAt: string;
};
export type CheckoutConfirmation = { orderId: string; sessionId: string; status: string };
export type CheckoutConfirmOutcome =
  | { type: 'completed'; confirmation: CheckoutConfirmation }
  | { type: 'hosted-payment'; handoff: PaymentHandoff };
export type CheckoutError = { code: string; message: string; retryable: boolean };
export type CheckoutValidationIssue = { path: string; message: string };
export type CheckoutBootstrap = {
  event: Record<string, unknown> & { id: string };
  availability: AvailabilityItem[];
  questions: { buyerQuestions: CheckoutQuestion[]; attendeeQuestions: CheckoutQuestion[] };
};
type ApiCartItem = {
  ticketTypeId?: string;
  occurrenceId?: string;
  productId?: string;
  resaleListingId?: string;
  quantity: number;
  unitAmountCents?: number;
  attendeeFields?: Record<string, unknown>[];
};
export type CreateSessionInput = {
  eventId: string;
  buyer: CheckoutBuyer;
  items: ApiCartItem[];
  buyerFields?: Record<string, unknown>;
  discountCode?: string;
  accessCode?: string;
  waitlistClaimToken?: string;
  successUrl?: string;
  cancelUrl?: string;
};
type TransportConfirmResult =
  | { order: { id: string }; sessionId: string; status: string }
  | {
      sessionId: string;
      status: string;
      paymentIntentId: string;
      clientSecret?: string;
      totalCents: number;
      currency: string;
    };
export type CheckoutResumeReference = { sessionId: string; clientToken: string };

export interface CheckoutTransport {
  bootstrap(
    eventId: string,
    input: { products?: readonly string[]; signal?: AbortSignal },
  ): Promise<CheckoutBootstrap>;
  availability(
    eventId: string,
    input: { products?: readonly string[]; signal?: AbortSignal },
  ): Promise<AvailabilityItem[]>;
  validateAccessCode(
    eventId: string,
    input: { ticketTypeIds: readonly string[]; accessCode?: string; buyerEmail?: string },
    signal?: AbortSignal,
  ): Promise<{ valid: true; ticketTypeIds: string[] }>;
  joinWaitlist(
    eventId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  createSession(
    input: CreateSessionInput,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<TransportCheckoutSession>;
  getSession(
    sessionId: string,
    clientToken: string,
    signal?: AbortSignal,
  ): Promise<TransportCheckoutSession>;
  confirmSession(
    sessionId: string,
    clientToken: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<TransportConfirmResult>;
  createHostedHandoff(
    sessionId: string,
    clientToken: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; expiresAt: string }>;
}

export interface CheckoutStorage {
  get(key: string): string | null | Promise<string | null>;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void | Promise<void>;
}

async function readCheckoutStorage(
  storage: CheckoutStorage | undefined,
  key: string,
): Promise<string | null | undefined> {
  return storage?.get(key);
}

export type CheckoutSnapshot = {
  phase: CheckoutPhase;
  eventId: string;
  bootstrap?: CheckoutBootstrap;
  availability: AvailabilityItem[];
  cart: CheckoutCartItem[];
  buyer?: CheckoutBuyer;
  answers: Record<string, unknown>;
  accessCode?: string;
  revealedTicketTypeIds: readonly string[];
  discountCode?: string;
  waitlistClaimToken?: string;
  session?: CheckoutSession;
  paymentHandoff?: PaymentHandoff;
  confirmation?: CheckoutConfirmation;
  remainingHoldMs?: number;
  error?: CheckoutError;
  validationIssues: readonly CheckoutValidationIssue[];
};

export type CheckoutControllerOptions = {
  eventId: string;
  transport: CheckoutTransport;
  storage?: CheckoutStorage;
  storageKey?: string;
  now?: () => number;
  pollIntervalMs?: number;
};
export type CheckoutListener = (snapshot: Readonly<CheckoutSnapshot>) => void;
type Credential = { sessionId: string; clientToken: string };
type Operation = { id: number; signal: AbortSignal };
type StoredCheckoutState = {
  credential?: Credential;
  createIdempotencyKey?: string;
  confirmIdempotencyKey?: string;
};

export class CheckoutController {
  private snapshot: CheckoutSnapshot;
  private readonly listeners = new Set<CheckoutListener>();
  private operation?: AbortController;
  private operationId = 0;
  private holdTimer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private credential?: Credential;
  private createIdempotencyKey?: string;
  private confirmIdempotencyKey?: string;
  private storageHydrated = false;

  constructor(private readonly options: CheckoutControllerOptions) {
    this.now = options.now ?? Date.now;
    this.snapshot = {
      phase: 'idle',
      eventId: options.eventId,
      availability: [],
      cart: [],
      answers: {},
      revealedTicketTypeIds: [],
      validationIssues: [],
    };
  }

  getState(): Readonly<CheckoutSnapshot> {
    return this.snapshot;
  }
  subscribe(listener: CheckoutListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
  private emit(patch: Partial<CheckoutSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private begin(external?: AbortSignal): Operation {
    this.operation?.abort();
    const controller = new AbortController();
    this.operation = controller;
    const id = ++this.operationId;
    const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal;
    return { id, signal };
  }
  private current(operation: Operation): boolean {
    return operation.id === this.operationId && !operation.signal.aborted;
  }
  private fail(error: unknown, fatal = false, operation?: Operation): void {
    if (isAbort(error) || (operation && !this.current(operation))) return;
    this.emit({
      phase: fatal ? 'fatal-error' : 'recoverable-error',
      error: normalizeError(error, !fatal),
    });
  }

  async bootstrap(signal?: AbortSignal): Promise<void> {
    const operation = this.begin(signal);
    this.emit({ phase: 'loading', error: undefined });
    try {
      const loaded = await this.options.transport.bootstrap(this.options.eventId, {
        products: this.snapshot.revealedTicketTypeIds,
        signal: operation.signal,
      });
      if (!this.current(operation)) return;
      this.emit({ phase: 'selecting', bootstrap: loaded, availability: loaded.availability });
    } catch (error) {
      this.fail(error, true, operation);
    }
  }

  async refreshAvailability(signal?: AbortSignal): Promise<void> {
    const operation = this.begin(signal);
    try {
      const availability = await this.options.transport.availability(this.options.eventId, {
        products: this.snapshot.revealedTicketTypeIds,
        signal: operation.signal,
      });
      if (!this.current(operation)) return;
      this.emit({ availability, error: undefined });
    } catch (error) {
      this.fail(error, false, operation);
    }
  }

  setCartItem(item: CheckoutCartItem): void {
    assertCartItem(item, false);
    if (item.type === 'ticket' && item.donationAmountCents !== undefined) {
      throw new Error('Donation amounts may only be set with setDonation().');
    }
    const key = cartKey(item);
    const cart = this.snapshot.cart.filter((candidate) => cartKey(candidate) !== key);
    if (item.quantity > 0) cart.push(structuredCloneSafe(item));
    this.emit({
      cart,
      phase: cart.length ? 'collecting-details' : 'selecting',
      error: undefined,
      validationIssues: [],
    });
  }

  setDonation(
    item: Omit<CheckoutTicketCartItem, 'type' | 'donationAmountCents'>,
    amountCents: number,
  ): void {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new Error('Donation amount must be a positive integer.');
    }
    const availability = this.snapshot.availability.find(
      (candidate) =>
        candidate.ticketTypeId === item.ticketTypeId &&
        (!item.occurrenceId || candidate.eventOccurrenceId === item.occurrenceId),
    );
    if (availability?.kind !== 'donation') {
      throw new Error('Client-supplied amounts are accepted only for donation ticket types.');
    }
    const donation: CheckoutTicketCartItem = {
      type: 'ticket',
      ...structuredCloneSafe(item),
      donationAmountCents: amountCents,
    };
    assertCartItem(donation, true);
    const key = cartKey(donation);
    const cart = this.snapshot.cart.filter((candidate) => cartKey(candidate) !== key);
    cart.push(donation);
    this.emit({ cart, phase: 'collecting-details', error: undefined, validationIssues: [] });
  }

  setBuyer(buyer: CheckoutBuyer): void {
    this.emit({
      buyer: structuredCloneSafe(buyer),
      phase: 'collecting-details',
      error: undefined,
      validationIssues: [],
    });
  }
  setAnswers(answers: Record<string, unknown>): void {
    this.emit({
      answers: structuredCloneSafe(answers),
      phase: 'collecting-details',
      validationIssues: [],
    });
  }
  setDiscountCode(code?: string): void {
    this.emit({ discountCode: cleanCode(code), error: undefined });
  }
  setWaitlistClaimToken(token?: string): void {
    this.emit({ waitlistClaimToken: token?.trim() || undefined });
  }

  validateDetails(): readonly CheckoutValidationIssue[] {
    const issues: CheckoutValidationIssue[] = [];
    if (!this.snapshot.cart.length) issues.push({ path: 'cart', message: 'Select an item.' });
    if (!validBuyer(this.snapshot.buyer)) {
      issues.push({ path: 'buyer', message: 'Valid buyer details are required.' });
    }
    for (const question of this.snapshot.bootstrap?.questions.buyerQuestions ?? []) {
      const answer = this.snapshot.answers[question.id];
      if ((question.required || answerPresent(answer)) && !validAnswer(question, answer)) {
        issues.push({
          path: `answers.${question.id}`,
          message: 'The buyer answer is missing or invalid.',
        });
      }
    }
    for (const [itemIndex, item] of this.snapshot.cart.entries()) {
      if (item.type !== 'ticket') continue;
      const applicable = (this.snapshot.bootstrap?.questions.attendeeQuestions ?? []).filter(
        (question) => !question.ticketTypeId || question.ticketTypeId === item.ticketTypeId,
      );
      for (let attendeeIndex = 0; attendeeIndex < item.quantity; attendeeIndex += 1) {
        for (const question of applicable) {
          const answer = item.attendeeFields?.[attendeeIndex]?.[question.id];
          if ((question.required || answerPresent(answer)) && !validAnswer(question, answer)) {
            issues.push({
              path: `cart.${itemIndex}.attendeeFields.${attendeeIndex}.${question.id}`,
              message: 'A required attendee answer is missing or invalid.',
            });
          }
        }
      }
    }
    return issues;
  }

  async applyAccessCode(
    accessCode: string,
    ticketTypeIds: readonly string[],
    buyerEmail?: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const code = cleanCode(accessCode);
    if (!code) throw new Error('Access code is required.');
    if (!ticketTypeIds.length || ticketTypeIds.some((id) => !validId(id))) {
      throw new Error('At least one valid ticket type ID is required.');
    }
    const operation = this.begin(signal);
    try {
      const result = await this.options.transport.validateAccessCode(
        this.options.eventId,
        { ticketTypeIds: [...ticketTypeIds], accessCode: code, buyerEmail },
        operation.signal,
      );
      if (!this.current(operation)) return [];
      const revealedTicketTypeIds = unique([
        ...this.snapshot.revealedTicketTypeIds,
        ...result.ticketTypeIds,
      ]);
      const availability = await this.options.transport.availability(this.options.eventId, {
        products: revealedTicketTypeIds,
        signal: operation.signal,
      });
      if (!this.current(operation)) return [];
      this.emit({ accessCode: code, revealedTicketTypeIds, availability, error: undefined });
      return result.ticketTypeIds;
    } catch (error) {
      this.fail(error, false, operation);
      throw error;
    }
  }

  async joinWaitlist(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const operation = this.begin(signal);
    try {
      const result = await this.options.transport.joinWaitlist(
        this.options.eventId,
        structuredCloneSafe(input),
        operation.signal,
      );
      return this.current(operation) ? result : undefined;
    } catch (error) {
      this.fail(error, false, operation);
      return undefined;
    }
  }

  async createSession(
    input: { successUrl?: string; cancelUrl?: string; signal?: AbortSignal } = {},
  ): Promise<CheckoutSession | undefined> {
    const validationIssues = this.validateDetails();
    if (validationIssues.length) {
      this.emit({
        phase: 'recoverable-error',
        validationIssues,
        error: {
          code: 'invalid_details',
          message: 'Checkout details are incomplete.',
          retryable: true,
        },
      });
      return undefined;
    }
    if (!safeRedirectUrl(input.successUrl) || !safeRedirectUrl(input.cancelUrl)) {
      this.emit({
        phase: 'recoverable-error',
        error: {
          code: 'invalid_redirect',
          message: 'A checkout redirect URL is invalid.',
          retryable: true,
        },
      });
      return undefined;
    }
    const operation = this.begin(input.signal);
    this.emit({ phase: 'creating-session', error: undefined, validationIssues: [] });
    await this.hydrateStorage();
    if (!this.current(operation)) return undefined;
    const key = (this.createIdempotencyKey ??= randomKey());
    await this.persistState();
    try {
      const raw = await this.options.transport.createSession(
        {
          eventId: this.options.eventId,
          buyer: this.snapshot.buyer!,
          items: this.snapshot.cart.map(toApiCartItem),
          buyerFields: this.snapshot.answers,
          discountCode: this.snapshot.discountCode,
          accessCode: this.snapshot.accessCode,
          waitlistClaimToken: this.snapshot.waitlistClaimToken,
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
        },
        key,
        operation.signal,
      );
      if (!this.current(operation)) return undefined;
      const credential = credentialFrom(raw);
      if (!credential)
        throw new CheckoutHeadlessError('invalid_session', 'Checkout failed.', false);
      this.credential = credential;
      this.createIdempotencyKey = undefined;
      const session = publicSession(raw);
      this.emit({ session, phase: 'confirming' });
      await this.persistState();
      this.startHoldClock();
      return session;
    } catch (error) {
      if (!retryableError(error)) this.createIdempotencyKey = undefined;
      await this.persistState();
      this.fail(error, false, operation);
      return undefined;
    }
  }

  async resume(
    reference?: CheckoutResumeReference,
    signal?: AbortSignal,
  ): Promise<CheckoutSession | undefined> {
    const operation = this.begin(signal);
    try {
      await this.hydrateStorage();
      const credential = reference ?? this.credential;
      if (!credential || !this.current(operation)) return undefined;
      this.emit({ phase: 'loading', error: undefined });
      const raw = await this.options.transport.getSession(
        credential.sessionId,
        credential.clientToken,
        operation.signal,
      );
      if (!this.current(operation)) return undefined;
      this.credential = credential;
      const session = publicSession(raw);
      if (new Date(session.expiresAt).getTime() <= this.now()) {
        this.emit({ session, phase: 'expired', remainingHoldMs: 0 });
        return session;
      }
      const confirmation = session.orderId
        ? { orderId: session.orderId, sessionId: session.id, status: session.status }
        : undefined;
      this.emit({
        session,
        phase: confirmation
          ? 'completed'
          : session.status === 'pending_payment'
            ? 'awaiting-payment'
            : 'collecting-details',
        confirmation,
      });
      this.startHoldClock();
      return session;
    } catch (error) {
      this.fail(error, false, operation);
      return undefined;
    }
  }

  async confirm(signal?: AbortSignal): Promise<CheckoutConfirmOutcome | undefined> {
    const credential = this.credential;
    if (!this.snapshot.session || !credential) {
      this.emit({
        phase: 'recoverable-error',
        error: {
          code: 'missing_session',
          message: 'A checkout session is required.',
          retryable: true,
        },
      });
      return undefined;
    }
    const operation = this.begin(signal);
    this.emit({ phase: 'confirming', error: undefined });
    await this.hydrateStorage();
    if (!this.current(operation)) return undefined;
    const key = (this.confirmIdempotencyKey ??= randomKey());
    await this.persistState();
    try {
      const raw = await this.options.transport.confirmSession(
        credential.sessionId,
        credential.clientToken,
        key,
        operation.signal,
      );
      if (!this.current(operation)) return undefined;
      this.confirmIdempotencyKey = undefined;
      if ('order' in raw) {
        const confirmation = {
          orderId: raw.order.id,
          sessionId: raw.sessionId,
          status: raw.status,
        };
        const outcome: CheckoutConfirmOutcome = { type: 'completed', confirmation };
        this.emit({ phase: 'completed', confirmation, paymentHandoff: undefined });
        await this.clearReference();
        this.credential = undefined;
        this.stopHoldClock();
        return outcome;
      }
      const hosted = await this.options.transport.createHostedHandoff(
        credential.sessionId,
        credential.clientToken,
        operation.signal,
      );
      if (!this.current(operation)) return undefined;
      if (!safeHostedUrl(hosted.url) || !validFutureTimestamp(hosted.expiresAt, this.now())) {
        throw new CheckoutHeadlessError(
          'hosted_payment_unavailable',
          'Payment is unavailable.',
          false,
        );
      }
      const handoff: PaymentHandoff = {
        paymentIntentId: raw.paymentIntentId,
        totalCents: raw.totalCents,
        currency: raw.currency,
        mode: 'hosted',
        url: hosted.url,
        expiresAt: hosted.expiresAt,
      };
      const outcome: CheckoutConfirmOutcome = { type: 'hosted-payment', handoff };
      this.emit({ phase: 'awaiting-payment', paymentHandoff: handoff });
      await this.persistState();
      return outcome;
    } catch (error) {
      if (!retryableError(error)) this.confirmIdempotencyKey = undefined;
      await this.persistState();
      this.fail(error, false, operation);
      return undefined;
    }
  }

  async pollConfirmation(
    input: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<CheckoutConfirmation | undefined> {
    const started = this.now();
    const timeout = input.timeoutMs ?? 60_000;
    while (this.now() - started < timeout) {
      if (input.signal?.aborted) throw abortError();
      // eslint-disable-next-line no-await-in-loop -- confirmation polling is intentionally sequential.
      const session = await this.resume(undefined, input.signal);
      if (session?.orderId) return this.snapshot.confirmation;
      // eslint-disable-next-line no-await-in-loop -- polling delay must finish before another request.
      await delay(this.options.pollIntervalMs ?? 1_000, input.signal);
    }
    this.emit({
      phase: 'recoverable-error',
      error: {
        code: 'confirmation_pending',
        message: 'Confirmation is still pending.',
        retryable: true,
      },
    });
    return undefined;
  }

  cancel(): void {
    this.operationId += 1;
    this.operation?.abort();
    this.operation = undefined;
    if (!['completed', 'expired'].includes(this.snapshot.phase)) {
      this.emit({ phase: this.snapshot.cart.length ? 'collecting-details' : 'selecting' });
    }
  }
  async resetAttempt(): Promise<void> {
    this.cancel();
    this.createIdempotencyKey = undefined;
    this.confirmIdempotencyKey = undefined;
    await this.persistState();
  }
  destroy(): void {
    this.cancel();
    this.stopHoldClock();
    this.listeners.clear();
  }
  private startHoldClock(): void {
    this.stopHoldClock();
    const tick = () => {
      const expiresAt = this.snapshot.session
        ? new Date(this.snapshot.session.expiresAt).getTime()
        : 0;
      const remainingHoldMs = Math.max(0, expiresAt - this.now());
      if (remainingHoldMs === 0) {
        this.emit({ phase: 'expired', remainingHoldMs: 0 });
        this.stopHoldClock();
      } else this.emit({ remainingHoldMs });
    };
    tick();
    this.holdTimer = setInterval(tick, 1_000);
  }
  private stopHoldClock(): void {
    if (this.holdTimer) clearInterval(this.holdTimer);
    this.holdTimer = undefined;
  }
  private storageKey(): string {
    return this.options.storageKey ?? `tixkit:checkout:${this.options.eventId}`;
  }
  private async hydrateStorage(): Promise<void> {
    if (this.storageHydrated) return;
    this.storageHydrated = true;
    const value = await readCheckoutStorage(this.options.storage, this.storageKey());
    if (!value) return;
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const credential = parsed.credential;
      if (credential && typeof credential === 'object') {
        const candidate = credential as Record<string, unknown>;
        if (typeof candidate.sessionId === 'string' && typeof candidate.clientToken === 'string') {
          this.credential = {
            sessionId: candidate.sessionId,
            clientToken: candidate.clientToken,
          };
        }
      }
      this.createIdempotencyKey =
        typeof parsed.createIdempotencyKey === 'string' ? parsed.createIdempotencyKey : undefined;
      this.confirmIdempotencyKey =
        typeof parsed.confirmIdempotencyKey === 'string' ? parsed.confirmIdempotencyKey : undefined;
    } catch {
      await this.options.storage?.remove(this.storageKey());
    }
  }
  private async persistState(): Promise<void> {
    if (!this.options.storage) return;
    const state: StoredCheckoutState = {
      credential: this.credential,
      createIdempotencyKey: this.createIdempotencyKey,
      confirmIdempotencyKey: this.confirmIdempotencyKey,
    };
    await this.options.storage.set(this.storageKey(), JSON.stringify(state));
  }
  private async clearReference(): Promise<void> {
    this.credential = undefined;
    this.createIdempotencyKey = undefined;
    this.confirmIdempotencyKey = undefined;
    await this.options.storage?.remove(this.storageKey());
  }
}

export function createCheckoutController(options: CheckoutControllerOptions): CheckoutController {
  return new CheckoutController(options);
}
export function createMemoryCheckoutStorage(): CheckoutStorage {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

export function createFetchCheckoutTransport(options: {
  apiBaseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}): CheckoutTransport {
  const request = options.fetch ?? globalThis.fetch;
  if (!request) throw new Error('A fetch implementation is required.');
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const requestUrl = issueCheckoutHeadlessRequestUrl(options.apiBaseUrl, path);
    const response = await request(requestUrl, {
      ...init,
      headers: { accept: 'application/json', ...options.headers, ...init.headers },
    });
    const body = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) throw apiError(response.status, body);
    return body as T;
  };
  const productsQuery = (products?: readonly string[]) => {
    const value = products?.length ? unique(products).join(',') : '';
    return value ? `?products=${encodeURIComponent(value)}` : '';
  };
  return {
    bootstrap: (eventId, input) =>
      call(
        `/public/events/${encodeURIComponent(eventId)}/bootstrap${productsQuery(input.products)}`,
        {
          signal: input.signal,
        },
      ),
    availability: (eventId, input) =>
      call(
        `/public/events/${encodeURIComponent(eventId)}/availability${productsQuery(input.products)}`,
        { signal: input.signal },
      ),
    validateAccessCode: (eventId, input, signal) =>
      call(
        `/public/events/${encodeURIComponent(eventId)}/access-code`,
        jsonInit('POST', input, signal),
      ),
    joinWaitlist: (eventId, input, signal) =>
      call(
        `/public/events/${encodeURIComponent(eventId)}/waitlist`,
        jsonInit('POST', input, signal),
      ),
    createSession: (input, key, signal) =>
      call('/checkout/sessions', {
        ...jsonInit('POST', input, signal),
        headers: { 'Idempotency-Key': key },
      }),
    getSession: (id, token, signal) =>
      call(`/checkout/sessions/${encodeURIComponent(id)}`, {
        signal,
        headers: { 'X-Checkout-Session-Token': token },
      }),
    confirmSession: (id, token, key, signal) =>
      call(`/checkout/sessions/${encodeURIComponent(id)}/confirm`, {
        ...jsonInit('POST', {}, signal),
        headers: { 'X-Checkout-Session-Token': token, 'Idempotency-Key': key },
      }),
    createHostedHandoff: (id, token, signal) =>
      call(`/checkout/sessions/${encodeURIComponent(id)}/handoff`, {
        ...jsonInit('POST', {}, signal),
        headers: { 'X-Checkout-Session-Token': token },
      }),
  };
}

function jsonInit(method: string, body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
function assertCartItem(item: CheckoutCartItem, donation: boolean): void {
  if (!Number.isInteger(item.quantity) || item.quantity < (item.type === 'resale' ? 1 : 0)) {
    throw new Error('Cart quantity is invalid.');
  }
  if (item.type === 'resale' && item.quantity !== 1)
    throw new Error('Resale quantity must be one.');
  const id =
    item.type === 'ticket'
      ? item.ticketTypeId
      : item.type === 'product'
        ? item.productId
        : item.resaleListingId;
  if (!validId(id)) throw new Error('Cart item identifier is invalid.');
  if (!donation && item.type === 'ticket' && item.donationAmountCents !== undefined) {
    throw new Error('Donation amounts require setDonation().');
  }
}
function cartKey(item: CheckoutCartItem): string {
  if (item.type === 'ticket') return `ticket:${item.ticketTypeId}:${item.occurrenceId ?? ''}`;
  if (item.type === 'product') return `product:${item.productId}`;
  return `resale:${item.resaleListingId}`;
}
function toApiCartItem(item: CheckoutCartItem): ApiCartItem {
  if (item.type === 'ticket') {
    return {
      ticketTypeId: item.ticketTypeId,
      occurrenceId: item.occurrenceId,
      quantity: item.quantity,
      attendeeFields: item.attendeeFields,
      ...(item.donationAmountCents === undefined
        ? {}
        : { unitAmountCents: item.donationAmountCents }),
    };
  }
  if (item.type === 'product') return { productId: item.productId, quantity: item.quantity };
  return { resaleListingId: item.resaleListingId, quantity: 1 };
}
function validAnswer(question: CheckoutQuestion, value: unknown): boolean {
  if (question.type === 'checkbox' || question.type === 'waiver') return value === true;
  if (question.type === 'multiselect') {
    return (
      Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string')
    );
  }
  if (question.type === 'file') return typeof value === 'string' && validId(value);
  if (typeof value !== 'string' || !value.trim()) return false;
  if (question.type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (question.type === 'select' && question.options) return question.options.includes(value);
  return true;
}
function answerPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  return !Array.isArray(value) || value.length > 0;
}
function cleanCode(value?: string): string | undefined {
  return value?.trim().toUpperCase() || undefined;
}
function validBuyer(buyer?: CheckoutBuyer): boolean {
  return Boolean(
    buyer?.firstName.trim() &&
    buyer.lastName.trim() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(buyer.email),
  );
}
function safeRedirectUrl(value?: string): boolean {
  if (!value) return true;
  return safeUrl(value, false);
}
function safeHostedUrl(value: string): boolean {
  return safeUrl(value, true);
}
function validFutureTimestamp(value: string, now: number): boolean {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > now;
}
function safeUrl(value: string, hosted: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || containsControlCharacter(value)) return false;
    if (
      hosted &&
      [...url.searchParams.keys()].some((key) => /(?:client|session)?(?:token|secret)/iu.test(key))
    ) {
      return false;
    }
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && true
    );
  } catch {
    return false;
  }
}
function credentialFrom(session: TransportCheckoutSession): Credential | undefined {
  return session.clientToken
    ? { sessionId: session.id, clientToken: session.clientToken }
    : undefined;
}
function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}
function publicSession(session: TransportCheckoutSession): CheckoutSession {
  return {
    id: session.id,
    eventId: session.eventId,
    status: session.status,
    currency: session.currency,
    quote: structuredCloneSafe(session.quote),
    expiresAt: session.expiresAt,
    orderId: session.orderId,
  };
}
function randomKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function structuredCloneSafe<T>(value: T): T {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);
}
const SAFE_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  CHECKOUT_EXPIRED: 'The checkout session expired.',
  CHECKOUT_CANCELLED: 'The checkout session was cancelled.',
  EVENT_NOT_AVAILABLE: 'The event is not available for checkout.',
  INVENTORY_UNAVAILABLE: 'The selected inventory is no longer available.',
  RATE_LIMITED: 'Too many checkout requests. Try again shortly.',
  hosted_payment_unavailable: 'Payment is unavailable.',
  invalid_session: 'Checkout failed.',
});
function normalizeError(error: unknown, retryable: boolean): CheckoutError {
  if (error instanceof CheckoutHeadlessError) {
    const message = SAFE_ERRORS[error.code] ?? 'Checkout could not continue.';
    return { code: safeErrorCode(error.code), message, retryable: error.retryable };
  }
  return { code: 'checkout_error', message: 'Checkout could not continue.', retryable };
}
function safeErrorCode(code: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(code) ? code : 'checkout_error';
}
function retryableError(error: unknown): boolean {
  return error instanceof CheckoutHeadlessError ? error.retryable : true;
}
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
function abortError(): DOMException {
  return new DOMException('Operation aborted.', 'AbortError');
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}
function apiError(status: number, body: unknown): CheckoutHeadlessError {
  const data = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const nested =
    data.error && typeof data.error === 'object' ? (data.error as Record<string, unknown>) : data;
  const code = typeof nested.code === 'string' ? safeErrorCode(nested.code) : `http_${status}`;
  return new CheckoutHeadlessError(
    code,
    SAFE_ERRORS[code] ?? 'Checkout request failed.',
    status >= 500 || status === 429,
    status,
  );
}
function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export class CheckoutHeadlessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CheckoutHeadlessError';
  }
}

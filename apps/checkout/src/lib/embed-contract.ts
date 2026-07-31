import {
  EMBED_CONTRACT_VERSION,
  createCheckoutCloseRequestedMessage,
  createCheckoutLifecycleMessage,
  createCheckoutReadyMessage,
  parseHostHelloMessage,
} from '@tixkit/embed-core';

type EmbedContext = {
  widgetId: string;
  eventId: string;
  nonce: string;
  hostOrigin: string;
};

const STORAGE_KEY_PREFIX = 'tixkit.embed.v1.context.';
const WINDOW_NAME_PREFIX = 'tixkit-embed:';
let activeCleanup: (() => void) | null = null;
let activeContext: EmbedContext | null = null;

function isExactHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

function targetWindow(): Window | null {
  if (window.parent && window.parent !== window) return window.parent;
  return window.opener;
}

function contextFromSearch(): EmbedContext | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get('embedContractVersion') !== EMBED_CONTRACT_VERSION) return null;
  const widgetId = params.get('embedWidgetId');
  const eventId = params.get('eventId');
  const nonce = params.get('embedNonce');
  const hostOrigin = params.get('embedHostOrigin');
  if (!widgetId || !eventId || !nonce || !hostOrigin || !isExactHttpOrigin(hostOrigin)) return null;
  return { widgetId, eventId, nonce, hostOrigin };
}

function browsingPeerWidgetId(): string | null {
  const searchContext = contextFromSearch();
  if (searchContext) return searchContext.widgetId;
  return window.name.startsWith(WINDOW_NAME_PREFIX)
    ? window.name.slice(WINDOW_NAME_PREFIX.length) || null
    : null;
}

function storageKey(widgetId: string): string {
  return `${STORAGE_KEY_PREFIX}${widgetId}`;
}

function storedContext(): EmbedContext | null {
  try {
    const widgetId = browsingPeerWidgetId();
    if (!widgetId) return null;
    const value = window.sessionStorage.getItem(storageKey(widgetId));
    if (!value) return null;
    const parsed = JSON.parse(value) as Partial<EmbedContext>;
    if (
      parsed.widgetId !== widgetId ||
      typeof parsed.eventId !== 'string' ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.hostOrigin !== 'string' ||
      !isExactHttpOrigin(parsed.hostOrigin)
    ) {
      return null;
    }
    return parsed as EmbedContext;
  } catch {
    return null;
  }
}

function persistContext(context: EmbedContext): void {
  try {
    window.name = `${WINDOW_NAME_PREFIX}${context.widgetId}`;
    window.sessionStorage.setItem(storageKey(context.widgetId), JSON.stringify(context));
  } catch {
    // Storage is optional. The active in-memory handshake remains authoritative.
  }
}

export function initializeEmbedHandshake(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (activeCleanup) return activeCleanup;
  activeContext = contextFromSearch() ? null : storedContext();

  const handler = (event: MessageEvent) => {
    const hello = parseHostHelloMessage(event.data);
    if (!hello) return;
    const expected = contextFromSearch();
    const target = targetWindow();
    if (
      !expected ||
      !target ||
      event.source !== target ||
      event.origin !== expected.hostOrigin ||
      hello.hostOrigin !== expected.hostOrigin ||
      hello.widgetId !== expected.widgetId ||
      hello.eventId !== expected.eventId ||
      hello.nonce !== expected.nonce
    ) {
      return;
    }
    activeContext = expected;
    persistContext(expected);
    target.postMessage(
      createCheckoutReadyMessage({
        widgetId: expected.widgetId,
        eventId: expected.eventId,
        nonce: expected.nonce,
      }),
      expected.hostOrigin,
    );
  };

  const keydownHandler = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !activeContext) return;
    const target = targetWindow();
    if (!target) return;
    target.postMessage(
      createCheckoutCloseRequestedMessage({
        widgetId: activeContext.widgetId,
        eventId: activeContext.eventId,
        nonce: activeContext.nonce,
      }),
      activeContext.hostOrigin,
    );
  };

  window.addEventListener('message', handler);
  window.addEventListener('keydown', keydownHandler);
  const cleanup = () => {
    window.removeEventListener('message', handler);
    window.removeEventListener('keydown', keydownHandler);
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;
  return cleanup;
}

export function emitEmbedLifecycle(
  lifecycle: 'checkout-started' | 'checkout-session-created' | 'order-completed',
  detail: Record<string, unknown>,
): void {
  if (typeof window === 'undefined') return;
  initializeEmbedHandshake();
  const target = targetWindow();
  if (!target) return;
  const context = activeContext ?? (contextFromSearch() ? null : storedContext());
  const eventId = typeof detail.eventId === 'string' ? detail.eventId : context?.eventId;
  const sessionId = typeof detail.sessionId === 'string' ? detail.sessionId : undefined;
  const orderId = typeof detail.orderId === 'string' ? detail.orderId : undefined;

  if (context && eventId === context.eventId) {
    const binding = {
      widgetId: context.widgetId,
      eventId: context.eventId,
      nonce: context.nonce,
    };
    const message =
      lifecycle === 'checkout-session-created'
        ? sessionId
          ? createCheckoutLifecycleMessage({ ...binding, lifecycle, sessionId })
          : null
        : lifecycle === 'order-completed'
          ? orderId
            ? createCheckoutLifecycleMessage({
                ...binding,
                lifecycle,
                orderId,
                ...(sessionId ? { sessionId } : {}),
              })
            : null
          : createCheckoutLifecycleMessage({
              ...binding,
              lifecycle,
              ...(sessionId ? { sessionId } : {}),
            });
    if (!message) return;
    target.postMessage(message, context.hostOrigin);
  }
}

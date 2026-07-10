export const EMBED_CONTRACT_VERSION = '1.0' as const;
export const EMBED_CONTRACT_MAJOR = 1 as const;
export const EMBED_SOURCE_HOST = 'tixkit-embed-host' as const;
export const EMBED_SOURCE_CHECKOUT = 'tixkit-checkout' as const;

export const EMBED_MODES = ['inline', 'modal', 'button', 'redirect'] as const;
export const EMBED_PLATFORMS = ['html', 'react', 'vue', 'svelte', 'webflow', 'framer'] as const;
export const EMBED_THEMES = ['auto', 'light', 'dark', 'high-contrast'] as const;
export const EMBED_DENSITIES = ['compact', 'comfortable'] as const;
export const EMBED_BUTTON_SIZES = ['sm', 'md', 'lg'] as const;
export const EMBED_BUTTON_VARIANTS = ['solid', 'outline'] as const;

export type EmbedMode = (typeof EMBED_MODES)[number];
export type EmbedPlatform = (typeof EMBED_PLATFORMS)[number];
export type EmbedTheme = (typeof EMBED_THEMES)[number];
export type EmbedDensity = (typeof EMBED_DENSITIES)[number];
export type EmbedButtonSize = (typeof EMBED_BUTTON_SIZES)[number];
export type EmbedButtonVariant = (typeof EMBED_BUTTON_VARIANTS)[number];

export const EMBED_LIFECYCLE_NAMES = [
  'loading',
  'ready',
  'opened',
  'closed',
  'checkout-started',
  'checkout-session-created',
  'order-completed',
  'recoverable-error',
  'fatal-error',
] as const;

export type EmbedLifecycleName = (typeof EMBED_LIFECYCLE_NAMES)[number];
export type VersionedEmbedLifecycleEventName = `tixkit:v1:${EmbedLifecycleName}`;

export const EMBED_LEGACY_EVENT_ALIASES: Readonly<
  Partial<Record<EmbedLifecycleName, readonly string[]>>
> = Object.freeze({
  ready: ['loaded'],
  'checkout-started': ['checkout_started'],
  'order-completed': ['order_completed'],
  'recoverable-error': ['error'],
  'fatal-error': ['error'],
});

export function versionedLifecycleEventName(
  name: EmbedLifecycleName,
): VersionedEmbedLifecycleEventName {
  return `tixkit:v1:${name}`;
}

export const EMBED_ERROR_CODES = [
  'invalid-config',
  'invalid-origin',
  'invalid-message',
  'unsupported-contract-version',
  'handshake-timeout',
  'checkout-unreachable',
  'checkout-offline',
  'unsupported-browser',
  'session-expired',
  'checkout-rejected',
  'internal-error',
] as const;

export type EmbedErrorCode = (typeof EMBED_ERROR_CODES)[number];

export interface EmbedThemeTokens {
  colorPrimary?: string;
  colorSurface?: string;
  colorText?: string;
  colorMuted?: string;
  colorBorder?: string;
  radius?: number;
  density?: EmbedDensity;
  fontFamily?: string;
  buttonSize?: EmbedButtonSize;
  buttonVariant?: EmbedButtonVariant;
}

export interface EmbedElementConfig {
  brandId: string;
  eventId: string;
  mode: EmbedMode;
  locale?: string;
  theme?: EmbedTheme;
  themeTokens?: EmbedThemeTokens;
  products?: string;
  items?: string;
  discountCode?: string;
  accessCode?: string;
  trackingId?: string;
  affiliateCode?: string;
  checkoutBaseUrl?: string;
  reportingApiUrl?: string;
  hostOrigin?: string;
}

export interface TixkitWidgetElement extends HTMLElement {
  configuration: EmbedElementConfig;
  openCheckout(): void;
  closeCheckout(): void;
}

export interface TixkitButtonElement extends HTMLElement {
  configuration: EmbedElementConfig;
  openCheckout(): void;
  closeCheckout(): void;
}

export interface EmbedGeneratorOptions extends EmbedElementConfig {
  platform: EmbedPlatform;
  widgetScriptUrl?: string;
  widgetIntegrity?: string;
  includeLifecycle?: boolean;
  lifecycleCallbackName?: string;
  buttonLabel?: string;
  nonce?: string;
  marketing?: boolean;
}

export interface EmbedGeneratorResult {
  ok: true;
  snippet: string;
  csp: EmbedCspProfile;
  instructions: string;
  config: EmbedElementConfig;
}

export interface EmbedGeneratorFailure {
  ok: false;
  errors: readonly EmbedValidationIssue[];
}

export interface EmbedValidationIssue {
  path: string;
  code: EmbedErrorCode;
  message: string;
}

export interface EmbedLifecycleBaseDetail {
  contractVersion: typeof EMBED_CONTRACT_VERSION;
  widgetId: string;
  eventId: string;
  mode: EmbedMode;
  timestamp: string;
}

export interface EmbedLifecycleLoadingDetail extends EmbedLifecycleBaseDetail {
  name: 'loading';
}

export interface EmbedLifecycleReadyDetail extends EmbedLifecycleBaseDetail {
  name: 'ready';
}

export interface EmbedLifecycleOpenedDetail extends EmbedLifecycleBaseDetail {
  name: 'opened';
}

export interface EmbedLifecycleClosedDetail extends EmbedLifecycleBaseDetail {
  name: 'closed';
  reason: 'host' | 'buyer' | 'navigation' | 'disconnected' | 'unknown';
}

export interface EmbedLifecycleCheckoutStartedDetail extends EmbedLifecycleBaseDetail {
  name: 'checkout-started';
}

export interface EmbedLifecycleSessionCreatedDetail extends EmbedLifecycleBaseDetail {
  name: 'checkout-session-created';
  sessionId: string;
}

export interface EmbedLifecycleOrderCompletedDetail extends EmbedLifecycleBaseDetail {
  name: 'order-completed';
  orderId: string;
  sessionId?: string;
}

export interface EmbedLifecycleErrorDetail extends EmbedLifecycleBaseDetail {
  name: 'recoverable-error' | 'fatal-error';
  errorCode: EmbedErrorCode;
  message: string;
  retryable: boolean;
}

export type EmbedLifecycleDetail =
  | EmbedLifecycleLoadingDetail
  | EmbedLifecycleReadyDetail
  | EmbedLifecycleOpenedDetail
  | EmbedLifecycleClosedDetail
  | EmbedLifecycleCheckoutStartedDetail
  | EmbedLifecycleSessionCreatedDetail
  | EmbedLifecycleOrderCompletedDetail
  | EmbedLifecycleErrorDetail;

interface EmbedMessageBase {
  contractVersion: typeof EMBED_CONTRACT_VERSION;
  widgetId: string;
  eventId: string;
  nonce: string;
}

export interface EmbedHostHelloMessage extends EmbedMessageBase {
  source: typeof EMBED_SOURCE_HOST;
  type: 'host:hello';
  hostOrigin: string;
}

export interface EmbedCheckoutReadyMessage extends EmbedMessageBase {
  source: typeof EMBED_SOURCE_CHECKOUT;
  type: 'checkout:ready';
}

export interface EmbedCheckoutCloseRequestedMessage extends EmbedMessageBase {
  source: typeof EMBED_SOURCE_CHECKOUT;
  type: 'checkout:close-requested';
}

interface EmbedCheckoutLifecycleMessageBase extends EmbedMessageBase {
  source: typeof EMBED_SOURCE_CHECKOUT;
  type: 'checkout:lifecycle';
}

export interface EmbedCheckoutStartedMessage extends EmbedCheckoutLifecycleMessageBase {
  lifecycle: 'checkout-started';
  sessionId?: string;
}

export interface EmbedCheckoutSessionCreatedMessage extends EmbedCheckoutLifecycleMessageBase {
  lifecycle: 'checkout-session-created';
  sessionId: string;
}

export interface EmbedCheckoutOrderCompletedMessage extends EmbedCheckoutLifecycleMessageBase {
  lifecycle: 'order-completed';
  orderId: string;
  sessionId?: string;
}

export interface EmbedCheckoutErrorMessage extends EmbedCheckoutLifecycleMessageBase {
  lifecycle: 'recoverable-error' | 'fatal-error';
  errorCode: EmbedErrorCode;
  message: string;
  retryable: boolean;
}

export type EmbedCheckoutLifecycleMessage =
  | EmbedCheckoutStartedMessage
  | EmbedCheckoutSessionCreatedMessage
  | EmbedCheckoutOrderCompletedMessage
  | EmbedCheckoutErrorMessage;

export type EmbedHostMessage = EmbedHostHelloMessage;
export type EmbedCheckoutMessage =
  | EmbedCheckoutReadyMessage
  | EmbedCheckoutCloseRequestedMessage
  | EmbedCheckoutLifecycleMessage;

export interface EmbedMessageExpectation {
  origin: string;
  source: MessageEventSource | null;
  widgetId: string;
  eventId: string;
  nonce: string;
}

export type EmbedMessageValidationResult =
  | { ok: true; message: EmbedCheckoutMessage }
  | { ok: false; code: EmbedErrorCode; reason: string };

export interface EmbedCspFeatures {
  checkoutBaseUrl?: string;
  widgetScriptUrl?: string;
  reportingApiUrl?: string;
  marketing?: boolean;
  nonce?: string;
}

export interface EmbedCspProfile {
  directives: Readonly<Record<string, readonly string[]>>;
  header: string;
  metaTag: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const CALLBACK_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const SAFE_FONT_PATTERN = /^[A-Za-z0-9 ,.'"-]{1,160}$/;
const DEFAULT_CHECKOUT_BASE_URL = 'https://checkout.tixkit.com';
const DEFAULT_WIDGET_SCRIPT_URL = 'http://localhost:3000/tixkit-widget.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function isOneOf<const T extends readonly string[]>(value: unknown, values: T): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function httpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function exactOrigin(value: string): string | null {
  const url = httpUrl(value);
  if (!url || url.origin !== value || url.pathname !== '/' || url.search || url.hash) return null;
  return url.origin;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined;
}

export function validateEmbedThemeTokens(
  tokens: EmbedThemeTokens | undefined,
): EmbedValidationIssue[] {
  if (!tokens) return [];
  const issues: EmbedValidationIssue[] = [];
  const colorKeys: Array<keyof EmbedThemeTokens> = [
    'colorPrimary',
    'colorSurface',
    'colorText',
    'colorMuted',
    'colorBorder',
  ];
  for (const key of colorKeys) {
    const value = tokens[key];
    if (value !== undefined && (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value))) {
      issues.push({
        path: `themeTokens.${key}`,
        code: 'invalid-config',
        message: 'Use a six-digit hexadecimal color.',
      });
    }
  }
  if (
    tokens.radius !== undefined &&
    (!Number.isFinite(tokens.radius) || tokens.radius < 0 || tokens.radius > 32)
  ) {
    issues.push({
      path: 'themeTokens.radius',
      code: 'invalid-config',
      message: 'Radius must be between 0 and 32 pixels.',
    });
  }
  if (tokens.density !== undefined && !EMBED_DENSITIES.includes(tokens.density)) {
    issues.push({
      path: 'themeTokens.density',
      code: 'invalid-config',
      message: `Density must be ${EMBED_DENSITIES.join(' or ')}.`,
    });
  }
  if (tokens.buttonSize !== undefined && !EMBED_BUTTON_SIZES.includes(tokens.buttonSize)) {
    issues.push({
      path: 'themeTokens.buttonSize',
      code: 'invalid-config',
      message: `Button size must be ${EMBED_BUTTON_SIZES.join(', ')}.`,
    });
  }
  if (tokens.buttonVariant !== undefined && !EMBED_BUTTON_VARIANTS.includes(tokens.buttonVariant)) {
    issues.push({
      path: 'themeTokens.buttonVariant',
      code: 'invalid-config',
      message: `Button variant must be ${EMBED_BUTTON_VARIANTS.join(' or ')}.`,
    });
  }
  if (tokens.fontFamily !== undefined && !SAFE_FONT_PATTERN.test(tokens.fontFamily)) {
    issues.push({
      path: 'themeTokens.fontFamily',
      code: 'invalid-config',
      message: 'Font family contains unsupported characters.',
    });
  }
  return issues;
}

export function validateEmbedOptions(options: EmbedGeneratorOptions): EmbedValidationIssue[] {
  const issues: EmbedValidationIssue[] = [];
  if (!ID_PATTERN.test(options.eventId))
    issues.push({
      path: 'eventId',
      code: 'invalid-config',
      message: 'Event ID must contain 1-128 letters, digits, underscores, or hyphens.',
    });
  if (!ID_PATTERN.test(options.brandId))
    issues.push({
      path: 'brandId',
      code: 'invalid-config',
      message: 'Brand ID must contain 1-128 letters, digits, underscores, or hyphens.',
    });
  if (!EMBED_MODES.includes(options.mode))
    issues.push({
      path: 'mode',
      code: 'invalid-config',
      message: `Mode must be ${EMBED_MODES.join(', ')}.`,
    });
  if (!EMBED_PLATFORMS.includes(options.platform))
    issues.push({
      path: 'platform',
      code: 'invalid-config',
      message: `Platform must be ${EMBED_PLATFORMS.join(', ')}.`,
    });
  if (options.theme !== undefined && !EMBED_THEMES.includes(options.theme))
    issues.push({
      path: 'theme',
      code: 'invalid-config',
      message: `Theme must be ${EMBED_THEMES.join(', ')}.`,
    });
  if (options.locale !== undefined && !LOCALE_PATTERN.test(options.locale))
    issues.push({
      path: 'locale',
      code: 'invalid-config',
      message: 'Locale must be a BCP 47 language tag.',
    });
  if (
    options.lifecycleCallbackName !== undefined &&
    !CALLBACK_PATTERN.test(options.lifecycleCallbackName)
  )
    issues.push({
      path: 'lifecycleCallbackName',
      code: 'invalid-config',
      message: 'Lifecycle callback must be a JavaScript identifier.',
    });
  for (const [path, value, originOnly] of [
    ['checkoutBaseUrl', options.checkoutBaseUrl, false],
    ['widgetScriptUrl', options.widgetScriptUrl, false],
    ['reportingApiUrl', options.reportingApiUrl, false],
    ['hostOrigin', options.hostOrigin, true],
  ] as const) {
    if (value !== undefined && (originOnly ? !exactOrigin(value) : !httpUrl(value))) {
      issues.push({
        path,
        code: path === 'hostOrigin' ? 'invalid-origin' : 'invalid-config',
        message: originOnly
          ? 'Host origin must be an exact http(s) origin without a path.'
          : 'Value must be an http(s) URL.',
      });
    }
  }
  if (
    options.buttonLabel !== undefined &&
    (options.buttonLabel.trim().length === 0 || options.buttonLabel.length > 120)
  )
    issues.push({
      path: 'buttonLabel',
      code: 'invalid-config',
      message: 'Button label must contain 1-120 characters.',
    });
  if (
    options.widgetIntegrity !== undefined &&
    !/^sha384-[A-Za-z0-9+/]{64}$/.test(options.widgetIntegrity)
  )
    issues.push({
      path: 'widgetIntegrity',
      code: 'invalid-config',
      message: 'Widget integrity must be a SHA-384 SRI value from the release manifest.',
    });
  if (
    httpUrl(options.widgetScriptUrl ?? '')?.hostname === 'cdn.tixkit.com' &&
    options.widgetIntegrity === undefined
  )
    issues.push({
      path: 'widgetIntegrity',
      code: 'invalid-config',
      message: 'Production CDN snippets require the matching SHA-384 release integrity.',
    });
  return [...issues, ...validateEmbedThemeTokens(options.themeTokens)];
}

export function parseEmbedThemeTokens(value: string | null | undefined): EmbedThemeTokens | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) return null;
    const tokens = parsed as EmbedThemeTokens;
    return validateEmbedThemeTokens(tokens).length === 0 ? tokens : null;
  } catch {
    return null;
  }
}

export function createEmbedNonce(randomValues?: Uint8Array): string {
  const bytes =
    randomValues ??
    (() => {
      const result = new Uint8Array(18);
      if (!globalThis.crypto?.getRandomValues)
        throw new Error('Secure random number generation is unavailable.');
      return globalThis.crypto.getRandomValues(result);
    })();
  if (bytes.length < 16) throw new Error('Embed nonces require at least 128 bits of entropy.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (typeof globalThis.btoa === 'function')
    return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let output = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += alphabet[(accumulator >> bits) & 63];
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (6 - bits)) & 63];
  return output;
}

export function createWidgetId(randomValues?: Uint8Array): string {
  return `tkw_${createEmbedNonce(randomValues)}`;
}

export function validateCheckoutMessageEvent(
  event: Pick<MessageEvent, 'data' | 'origin' | 'source'>,
  expected: EmbedMessageExpectation,
): EmbedMessageValidationResult {
  if (event.origin !== expected.origin)
    return {
      ok: false,
      code: 'invalid-origin',
      reason: 'Message origin does not match checkout origin.',
    };
  if (event.source !== expected.source)
    return {
      ok: false,
      code: 'invalid-message',
      reason: 'Message source is not the active checkout frame.',
    };
  if (!isRecord(event.data))
    return { ok: false, code: 'invalid-message', reason: 'Message payload must be an object.' };
  const data = event.data;
  if (data.contractVersion !== EMBED_CONTRACT_VERSION)
    return {
      ok: false,
      code: 'unsupported-contract-version',
      reason: 'Message contract version is not supported.',
    };
  if (data.source !== EMBED_SOURCE_CHECKOUT)
    return { ok: false, code: 'invalid-message', reason: 'Message source marker is invalid.' };
  if (
    data.widgetId !== expected.widgetId ||
    data.eventId !== expected.eventId ||
    data.nonce !== expected.nonce ||
    typeof data.nonce !== 'string' ||
    data.nonce.length < 22 ||
    data.nonce.length > 128
  )
    return {
      ok: false,
      code: 'invalid-message',
      reason: 'Message widget, event, or nonce binding is invalid.',
    };
  if (data.type === 'checkout:ready')
    return hasOnlyKeys(data, ['contractVersion', 'source', 'type', 'widgetId', 'eventId', 'nonce'])
      ? { ok: true, message: data as unknown as EmbedCheckoutReadyMessage }
      : { ok: false, code: 'invalid-message', reason: 'Ready message has extra fields.' };
  if (data.type === 'checkout:close-requested')
    return hasOnlyKeys(data, ['contractVersion', 'source', 'type', 'widgetId', 'eventId', 'nonce'])
      ? { ok: true, message: data as unknown as EmbedCheckoutCloseRequestedMessage }
      : { ok: false, code: 'invalid-message', reason: 'Close request has extra fields.' };
  if (data.type !== 'checkout:lifecycle' || !isOneOf(data.lifecycle, EMBED_LIFECYCLE_NAMES))
    return { ok: false, code: 'invalid-message', reason: 'Message type or lifecycle is invalid.' };
  if (
    data.lifecycle === 'loading' ||
    data.lifecycle === 'ready' ||
    data.lifecycle === 'opened' ||
    data.lifecycle === 'closed'
  )
    return {
      ok: false,
      code: 'invalid-message',
      reason: 'Checkout cannot emit a host-owned lifecycle state.',
    };
  const lifecycleKeys = [
    'contractVersion',
    'source',
    'type',
    'widgetId',
    'eventId',
    'nonce',
    'lifecycle',
    ...(data.lifecycle === 'checkout-started' ? ['sessionId'] : []),
    ...(data.lifecycle === 'checkout-session-created' ? ['sessionId'] : []),
    ...(data.lifecycle === 'order-completed' ? ['sessionId', 'orderId'] : []),
    ...(data.lifecycle === 'recoverable-error' || data.lifecycle === 'fatal-error'
      ? ['errorCode', 'message', 'retryable']
      : []),
  ];
  if (!hasOnlyKeys(data, lifecycleKeys))
    return { ok: false, code: 'invalid-message', reason: 'Lifecycle message has extra fields.' };
  if ('sessionId' in data && typeof data.sessionId !== 'string')
    return { ok: false, code: 'invalid-message', reason: 'Session ID must be a string.' };
  if (data.lifecycle === 'checkout-session-created' && typeof data.sessionId !== 'string')
    return {
      ok: false,
      code: 'invalid-message',
      reason: 'Session-created messages require a session ID.',
    };
  if (data.lifecycle === 'order-completed' && typeof data.orderId !== 'string')
    return {
      ok: false,
      code: 'invalid-message',
      reason: 'Order-completed messages require an order ID.',
    };
  if (
    (data.lifecycle === 'recoverable-error' || data.lifecycle === 'fatal-error') &&
    (!isOneOf(data.errorCode, EMBED_ERROR_CODES) ||
      typeof data.message !== 'string' ||
      data.message.length > 240 ||
      typeof data.retryable !== 'boolean')
  )
    return {
      ok: false,
      code: 'invalid-message',
      reason: 'Error messages require a public error code, message, and retryable flag.',
    };
  return { ok: true, message: data as unknown as EmbedCheckoutLifecycleMessage };
}

export function createHostHelloMessage(
  input: Omit<EmbedHostHelloMessage, 'contractVersion' | 'source' | 'type'>,
): EmbedHostHelloMessage {
  if (!exactOrigin(input.hostOrigin))
    throw new Error('Host origin must be an exact http(s) origin.');
  return {
    contractVersion: EMBED_CONTRACT_VERSION,
    source: EMBED_SOURCE_HOST,
    type: 'host:hello',
    ...input,
  };
}

export function parseHostHelloMessage(value: unknown): EmbedHostHelloMessage | null {
  if (!isRecord(value)) return null;
  if (
    !hasOnlyKeys(value, [
      'contractVersion',
      'source',
      'type',
      'widgetId',
      'eventId',
      'nonce',
      'hostOrigin',
    ])
  )
    return null;
  if (
    value.contractVersion !== EMBED_CONTRACT_VERSION ||
    value.source !== EMBED_SOURCE_HOST ||
    value.type !== 'host:hello'
  )
    return null;
  const widgetId = optionalString(value, 'widgetId');
  const eventId = optionalString(value, 'eventId');
  const nonce = optionalString(value, 'nonce');
  const hostOrigin = optionalString(value, 'hostOrigin');
  if (
    !widgetId ||
    widgetId.length > 160 ||
    !eventId ||
    !nonce ||
    nonce.length < 22 ||
    nonce.length > 128 ||
    !hostOrigin ||
    !exactOrigin(hostOrigin)
  )
    return null;
  return {
    contractVersion: EMBED_CONTRACT_VERSION,
    source: EMBED_SOURCE_HOST,
    type: 'host:hello',
    widgetId,
    eventId,
    nonce,
    hostOrigin,
  };
}

export function createCheckoutReadyMessage(
  input: Omit<EmbedCheckoutReadyMessage, 'contractVersion' | 'source' | 'type'>,
): EmbedCheckoutReadyMessage {
  return {
    contractVersion: EMBED_CONTRACT_VERSION,
    source: EMBED_SOURCE_CHECKOUT,
    type: 'checkout:ready',
    ...input,
  };
}

export function createCheckoutCloseRequestedMessage(
  input: Omit<EmbedCheckoutCloseRequestedMessage, 'contractVersion' | 'source' | 'type'>,
): EmbedCheckoutCloseRequestedMessage {
  return {
    contractVersion: EMBED_CONTRACT_VERSION,
    source: EMBED_SOURCE_CHECKOUT,
    type: 'checkout:close-requested',
    ...input,
  };
}

type CheckoutLifecycleMessageInput<T> = T extends EmbedCheckoutLifecycleMessage
  ? Omit<T, 'contractVersion' | 'source' | 'type'>
  : never;

export function createCheckoutLifecycleMessage(
  input: CheckoutLifecycleMessageInput<EmbedCheckoutLifecycleMessage>,
): EmbedCheckoutLifecycleMessage {
  return {
    contractVersion: EMBED_CONTRACT_VERSION,
    source: EMBED_SOURCE_CHECKOUT,
    type: 'checkout:lifecycle',
    ...input,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function scriptNonceAttribute(nonce: string | undefined): string {
  return nonce ? ` nonce="${escapeHtml(nonce)}"` : '';
}

function elementAttributes(options: EmbedGeneratorOptions): string {
  const attributes: Array<[string, string | undefined]> = [
    ['brand', options.brandId],
    ['event', options.eventId],
    ['checkout-mode', options.mode === 'button' ? 'modal' : options.mode],
    ['locale', options.locale],
    ['theme', options.theme && options.theme !== 'auto' ? options.theme : undefined],
    ['theme-tokens', options.themeTokens ? JSON.stringify(options.themeTokens) : undefined],
    ['products', options.products],
    ['items', options.items],
    ['discount-code', options.discountCode],
    ['access-code', options.accessCode],
    ['tracking-id', options.trackingId],
    ['affiliate-code', options.affiliateCode],
    ['api-base-url', options.checkoutBaseUrl ?? DEFAULT_CHECKOUT_BASE_URL],
    ['reporting-api-url', options.reportingApiUrl],
    ['host-origin', options.hostOrigin],
  ];
  return attributes
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`)
    .join('\n  ');
}

function lifecycleScript(
  elementId: string,
  callbackName: string,
  nonce: string | undefined,
): string {
  const names = EMBED_LIFECYCLE_NAMES.map((name) => versionedLifecycleEventName(name));
  return `<script type="module"${scriptNonceAttribute(nonce)}>\n  const element = document.getElementById('${escapeHtml(elementId)}');\n  function ${callbackName}(name, detail) {\n    console.log('Tixkit:', name, detail);\n  }\n  for (const name of ${JSON.stringify(names)}) {\n    element.addEventListener(name, (event) => ${callbackName}(name, event.detail));\n  }\n</script>`;
}

function htmlSnippet(options: EmbedGeneratorOptions): string {
  const scriptUrl = options.widgetScriptUrl ?? DEFAULT_WIDGET_SCRIPT_URL;
  const elementId = `tixkit-${options.mode}-${options.eventId}`;
  const tagName = options.mode === 'button' ? 'tixkit-button' : 'tixkit-widget';
  const checkoutUrl = new URL('/checkout', options.checkoutBaseUrl ?? DEFAULT_CHECKOUT_BASE_URL);
  checkoutUrl.searchParams.set('eventId', options.eventId);
  if (options.brandId) checkoutUrl.searchParams.set('brand', options.brandId);
  if (options.locale) checkoutUrl.searchParams.set('locale', options.locale);
  if (options.theme) checkoutUrl.searchParams.set('theme', options.theme);
  if (options.products) checkoutUrl.searchParams.set('products', options.products);
  if (options.items) checkoutUrl.searchParams.set('items', options.items);
  if (options.discountCode) checkoutUrl.searchParams.set('discount', options.discountCode);
  if (options.accessCode) checkoutUrl.searchParams.set('accessCode', options.accessCode);
  if (options.trackingId) checkoutUrl.searchParams.set('tracking', options.trackingId);
  if (options.affiliateCode) checkoutUrl.searchParams.set('affiliateCode', options.affiliateCode);
  const fallbackLabel =
    options.buttonLabel ??
    (options.mode === 'button' ? 'Buy tickets' : 'Continue to secure checkout');
  const fallback = `<a href="${escapeHtml(checkoutUrl.toString())}">${escapeHtml(fallbackLabel)}</a>`;
  const opening = `<${tagName} id="${escapeHtml(elementId)}"\n  ${elementAttributes(options)}`;
  const element =
    options.mode === 'button'
      ? `${opening}>\n  ${fallback}\n</${tagName}>`
      : `${opening}>\n  ${fallback}\n</${tagName}>`;
  const lifecycle = options.includeLifecycle
    ? `\n\n${lifecycleScript(elementId, options.lifecycleCallbackName ?? 'onTixkitEvent', options.nonce)}`
    : '';
  const integrity = options.widgetIntegrity
    ? ` integrity="${escapeHtml(options.widgetIntegrity)}" crossorigin="anonymous"`
    : '';
  return `<!-- Tixkit Embed Contract ${EMBED_CONTRACT_VERSION}: ${escapeHtml(options.platform)} -->\n<script type="module" src="${escapeHtml(scriptUrl)}"${integrity}${scriptNonceAttribute(options.nonce)}></script>\n\n${element}${lifecycle}`;
}

function frameworkSnippet(options: EmbedGeneratorOptions): string {
  const html = htmlSnippet({ ...options, platform: 'html' });
  if (options.platform === 'react')
    return `import '@tixkit/widget';\n\nexport function TixkitEmbed() {\n  return (\n    <tixkit-${options.mode === 'button' ? 'button' : 'widget'} brand="${escapeHtml(options.brandId)}" event="${escapeHtml(options.eventId)}" checkout-mode="${options.mode === 'button' ? 'modal' : options.mode}" api-base-url="${escapeHtml(options.checkoutBaseUrl ?? DEFAULT_CHECKOUT_BASE_URL)}" />\n  );\n}`;
  if (options.platform === 'vue')
    return `<script setup lang="ts">\nimport '@tixkit/widget';\n</script>\n\n<template>\n  <tixkit-${options.mode === 'button' ? 'button' : 'widget'} brand="${escapeHtml(options.brandId)}" event="${escapeHtml(options.eventId)}" checkout-mode="${options.mode === 'button' ? 'modal' : options.mode}" api-base-url="${escapeHtml(options.checkoutBaseUrl ?? DEFAULT_CHECKOUT_BASE_URL)}" />\n</template>`;
  if (options.platform === 'svelte')
    return `<script lang="ts">\n  import '@tixkit/widget';\n</script>\n\n<tixkit-${options.mode === 'button' ? 'button' : 'widget'} brand="${escapeHtml(options.brandId)}" event="${escapeHtml(options.eventId)}" checkout-mode="${options.mode === 'button' ? 'modal' : options.mode}" api-base-url="${escapeHtml(options.checkoutBaseUrl ?? DEFAULT_CHECKOUT_BASE_URL)}" />`;
  return html;
}

export function generateCspProfile(features: EmbedCspFeatures = {}): EmbedCspProfile {
  const checkout =
    httpUrl(features.checkoutBaseUrl ?? DEFAULT_CHECKOUT_BASE_URL)?.origin ??
    DEFAULT_CHECKOUT_BASE_URL;
  const widget =
    httpUrl(features.widgetScriptUrl ?? DEFAULT_WIDGET_SCRIPT_URL)?.origin ??
    'http://localhost:3000';
  const reporting = features.reportingApiUrl
    ? httpUrl(features.reportingApiUrl)?.origin
    : undefined;
  const nonce = features.nonce ? `'nonce-${features.nonce}'` : undefined;
  const directives: Record<string, readonly string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      widget,
      ...(nonce ? [nonce] : []),
      ...(features.marketing
        ? ['https://www.googletagmanager.com', 'https://connect.facebook.net']
        : []),
    ],
    'frame-src': [checkout],
    'connect-src': [
      "'self'",
      checkout,
      ...(reporting ? [reporting] : []),
      ...(features.marketing ? ['https://www.google-analytics.com'] : []),
    ],
    'img-src': ["'self'", 'data:', ...(features.marketing ? ['https://www.facebook.com'] : [])],
    'style-src': ["'self'"],
    'font-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'frame-ancestors': ["'self'"],
  };
  const header = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
  return {
    directives: Object.freeze(directives),
    header: `${header};`,
    metaTag: `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(`${header};`)}">`,
  };
}

export function generatePlatformInstructions(platform: EmbedPlatform): string {
  const instructions: Record<EmbedPlatform, string> = {
    html: 'Load the pinned module script once, then place the generated custom element where tickets should appear.',
    react:
      'Import the pinned @tixkit/widget package once in a client entry and render the typed custom element.',
    vue: 'Import the pinned @tixkit/widget package in a client entry and allow the tixkit custom element in compiler options when required.',
    svelte:
      'Import the pinned @tixkit/widget package in a browser entry and render the custom element directly.',
    webflow:
      'Add the pinned module script in Footer Code, add an Embed component, paste the generated element, and publish.',
    framer:
      'Add the pinned module script in site custom code, place an Embed layer, paste the generated element, and preview before publishing.',
  };
  return instructions[platform];
}

export function generateEmbed(
  options: EmbedGeneratorOptions,
): EmbedGeneratorResult | EmbedGeneratorFailure {
  const errors = validateEmbedOptions(options);
  if (errors.length > 0) return { ok: false, errors };
  const config: EmbedElementConfig = {
    brandId: options.brandId,
    eventId: options.eventId,
    mode: options.mode,
    ...(options.locale ? { locale: options.locale } : {}),
    ...(options.theme ? { theme: options.theme } : {}),
    ...(options.themeTokens ? { themeTokens: options.themeTokens } : {}),
    ...(options.products ? { products: options.products } : {}),
    ...(options.items ? { items: options.items } : {}),
    ...(options.discountCode ? { discountCode: options.discountCode } : {}),
    ...(options.accessCode ? { accessCode: options.accessCode } : {}),
    ...(options.trackingId ? { trackingId: options.trackingId } : {}),
    ...(options.affiliateCode ? { affiliateCode: options.affiliateCode } : {}),
    ...(options.checkoutBaseUrl ? { checkoutBaseUrl: options.checkoutBaseUrl } : {}),
    ...(options.reportingApiUrl ? { reportingApiUrl: options.reportingApiUrl } : {}),
    ...(options.hostOrigin ? { hostOrigin: options.hostOrigin } : {}),
  };
  return {
    ok: true,
    snippet: frameworkSnippet(options),
    csp: generateCspProfile({
      checkoutBaseUrl: options.checkoutBaseUrl,
      widgetScriptUrl: options.widgetScriptUrl,
      reportingApiUrl: options.reportingApiUrl,
      marketing: options.marketing,
      nonce: options.nonce,
    }),
    instructions: generatePlatformInstructions(options.platform),
    config,
  };
}

export function generateEmbedSnippet(options: EmbedGeneratorOptions): string {
  const result = generateEmbed(options);
  if (!result.ok)
    throw new Error(result.errors.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
  return result.snippet;
}

export const embedHostHelloSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://schemas.tixkit.com/embed/v1/host-hello.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['contractVersion', 'source', 'type', 'widgetId', 'eventId', 'nonce', 'hostOrigin'],
  properties: {
    contractVersion: { const: EMBED_CONTRACT_VERSION },
    source: { const: EMBED_SOURCE_HOST },
    type: { const: 'host:hello' },
    widgetId: { type: 'string', minLength: 1, maxLength: 160 },
    eventId: { type: 'string', pattern: ID_PATTERN.source },
    nonce: { type: 'string', minLength: 22, maxLength: 128 },
    hostOrigin: { type: 'string', format: 'uri' },
  },
} as const;

// oxlint-disable unicorn/no-thenable -- `then` is a required JSON Schema keyword.
export const embedCheckoutMessageSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://schemas.tixkit.com/embed/v1/checkout-message.schema.json',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['contractVersion', 'source', 'type', 'widgetId', 'eventId', 'nonce'],
      properties: {
        contractVersion: { const: EMBED_CONTRACT_VERSION },
        source: { const: EMBED_SOURCE_CHECKOUT },
        type: { const: 'checkout:ready' },
        widgetId: { type: 'string' },
        eventId: { type: 'string' },
        nonce: { type: 'string', minLength: 22, maxLength: 128 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['contractVersion', 'source', 'type', 'widgetId', 'eventId', 'nonce'],
      properties: {
        contractVersion: { const: EMBED_CONTRACT_VERSION },
        source: { const: EMBED_SOURCE_CHECKOUT },
        type: { const: 'checkout:close-requested' },
        widgetId: { type: 'string' },
        eventId: { type: 'string' },
        nonce: { type: 'string', minLength: 22, maxLength: 128 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['contractVersion', 'source', 'type', 'widgetId', 'eventId', 'nonce', 'lifecycle'],
      properties: {
        contractVersion: { const: EMBED_CONTRACT_VERSION },
        source: { const: EMBED_SOURCE_CHECKOUT },
        type: { const: 'checkout:lifecycle' },
        widgetId: { type: 'string' },
        eventId: { type: 'string' },
        nonce: { type: 'string', minLength: 22, maxLength: 128 },
        lifecycle: {
          enum: [
            'checkout-started',
            'checkout-session-created',
            'order-completed',
            'recoverable-error',
            'fatal-error',
          ],
        },
        sessionId: { type: 'string' },
        orderId: { type: 'string' },
        errorCode: { enum: EMBED_ERROR_CODES },
        message: { type: 'string', maxLength: 240 },
        retryable: { type: 'boolean' },
      },
      allOf: [
        {
          if: { properties: { lifecycle: { const: 'checkout-session-created' } } },
          then: { required: ['sessionId'] },
        },
        {
          if: { properties: { lifecycle: { const: 'order-completed' } } },
          then: { required: ['orderId'] },
        },
        {
          if: {
            properties: {
              lifecycle: { enum: ['recoverable-error', 'fatal-error'] },
            },
          },
          then: {
            required: ['errorCode', 'message', 'retryable'],
            not: { anyOf: [{ required: ['sessionId'] }, { required: ['orderId'] }] },
          },
        },
        {
          if: {
            properties: {
              lifecycle: {
                enum: ['checkout-started', 'checkout-session-created', 'order-completed'],
              },
            },
          },
          then: {
            not: {
              anyOf: [
                { required: ['errorCode'] },
                { required: ['message'] },
                { required: ['retryable'] },
              ],
            },
          },
        },
        {
          if: {
            properties: { lifecycle: { enum: ['checkout-started', 'checkout-session-created'] } },
          },
          then: { not: { required: ['orderId'] } },
        },
      ],
    },
  ],
} as const;

export const embedLifecycleSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://schemas.tixkit.com/embed/v1/lifecycle.schema.json',
  type: 'object',
  additionalProperties: false,
  required: ['contractVersion', 'widgetId', 'eventId', 'mode', 'timestamp', 'name'],
  properties: {
    contractVersion: { const: EMBED_CONTRACT_VERSION },
    widgetId: { type: 'string' },
    event: { type: 'string' },
    eventId: { type: 'string' },
    mode: { enum: ['inline', 'modal', 'redirect'] },
    timestamp: { type: 'string', format: 'date-time' },
    name: { enum: EMBED_LIFECYCLE_NAMES },
    sessionId: { type: 'string' },
    orderId: { type: 'string' },
    reason: { enum: ['host', 'buyer', 'navigation', 'disconnected', 'unknown'] },
    errorCode: { enum: EMBED_ERROR_CODES },
    message: { type: 'string', maxLength: 240 },
    retryable: { type: 'boolean' },
  },
  allOf: [
    {
      if: { properties: { name: { const: 'closed' } } },
      then: { required: ['reason'] },
    },
    {
      if: { properties: { name: { const: 'checkout-session-created' } } },
      then: { required: ['sessionId'] },
    },
    {
      if: { properties: { name: { const: 'order-completed' } } },
      then: { required: ['orderId'] },
    },
    {
      if: { properties: { name: { enum: ['recoverable-error', 'fatal-error'] } } },
      then: {
        required: ['errorCode', 'message', 'retryable'],
        not: {
          anyOf: [{ required: ['sessionId'] }, { required: ['orderId'] }, { required: ['reason'] }],
        },
      },
    },
    {
      if: { properties: { name: { enum: ['loading', 'ready', 'opened'] } } },
      then: {
        not: {
          anyOf: [
            { required: ['sessionId'] },
            { required: ['orderId'] },
            { required: ['reason'] },
            { required: ['errorCode'] },
            { required: ['message'] },
            { required: ['retryable'] },
          ],
        },
      },
    },
    {
      if: { properties: { name: { const: 'closed' } } },
      then: {
        not: {
          anyOf: [
            { required: ['sessionId'] },
            { required: ['orderId'] },
            { required: ['errorCode'] },
            { required: ['message'] },
            { required: ['retryable'] },
          ],
        },
      },
    },
    {
      if: {
        properties: {
          name: { enum: ['checkout-started', 'checkout-session-created', 'order-completed'] },
        },
      },
      then: {
        not: {
          anyOf: [
            { required: ['reason'] },
            { required: ['errorCode'] },
            { required: ['message'] },
            { required: ['retryable'] },
          ],
        },
      },
    },
    {
      if: { properties: { name: { enum: ['checkout-started', 'checkout-session-created'] } } },
      then: { not: { required: ['orderId'] } },
    },
  ],
} as const;
// oxlint-enable unicorn/no-thenable

declare global {
  interface HTMLElementTagNameMap {
    'tixkit-widget': TixkitWidgetElement;
    'tixkit-button': TixkitButtonElement;
  }

  interface GlobalEventHandlersEventMap {
    'tixkit:v1:loading': CustomEvent<EmbedLifecycleLoadingDetail>;
    'tixkit:v1:ready': CustomEvent<EmbedLifecycleReadyDetail>;
    'tixkit:v1:opened': CustomEvent<EmbedLifecycleOpenedDetail>;
    'tixkit:v1:closed': CustomEvent<EmbedLifecycleClosedDetail>;
    'tixkit:v1:checkout-started': CustomEvent<EmbedLifecycleCheckoutStartedDetail>;
    'tixkit:v1:checkout-session-created': CustomEvent<EmbedLifecycleSessionCreatedDetail>;
    'tixkit:v1:order-completed': CustomEvent<EmbedLifecycleOrderCompletedDetail>;
    'tixkit:v1:recoverable-error': CustomEvent<EmbedLifecycleErrorDetail>;
    'tixkit:v1:fatal-error': CustomEvent<EmbedLifecycleErrorDetail>;
  }
}

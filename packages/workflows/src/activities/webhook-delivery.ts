import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { createDb } from '@tixkit/db';
import { WebhookDeliveryRepository, WebhookEndpointRepository } from '@tixkit/db';
import { signWebhookPayload } from '@tixkit/domain/developer';
import { withSpan } from '@tixkit/shared';
import type { WorkflowActivityResult } from '../shared/types.js';
import { okResult, errResult } from '../shared/types.js';

const WEBHOOK_API_VERSION = '2026-01-01';
const WEBHOOK_USER_AGENT = 'Tixkit-Webhook/1.0';
const WEBHOOK_REQUEST_TIMEOUT_MS = 20_000;
const WEBHOOK_RESPONSE_MAX_BYTES = 64 * 1024;
const WEBHOOK_DELIVERY_CLAIM_LEASE_MS = 35_000;
const NAT64_WELL_KNOWN_PREFIX = ipv6ToBigInt('64:ff9b::');
const IPV4_BLOCKED_RANGES: Array<[number, number]> = [
  [ipv4ToInt('0.0.0.0'), ipv4ToInt('0.255.255.255')],
  [ipv4ToInt('10.0.0.0'), ipv4ToInt('10.255.255.255')],
  [ipv4ToInt('100.64.0.0'), ipv4ToInt('100.127.255.255')],
  [ipv4ToInt('127.0.0.0'), ipv4ToInt('127.255.255.255')],
  [ipv4ToInt('169.254.0.0'), ipv4ToInt('169.254.255.255')],
  [ipv4ToInt('172.16.0.0'), ipv4ToInt('172.31.255.255')],
  [ipv4ToInt('192.0.0.0'), ipv4ToInt('192.0.0.255')],
  [ipv4ToInt('192.0.2.0'), ipv4ToInt('192.0.2.255')],
  [ipv4ToInt('192.88.99.0'), ipv4ToInt('192.88.99.255')],
  [ipv4ToInt('192.168.0.0'), ipv4ToInt('192.168.255.255')],
  [ipv4ToInt('198.18.0.0'), ipv4ToInt('198.19.255.255')],
  [ipv4ToInt('198.51.100.0'), ipv4ToInt('198.51.100.255')],
  [ipv4ToInt('203.0.113.0'), ipv4ToInt('203.0.113.255')],
  [ipv4ToInt('224.0.0.0'), ipv4ToInt('239.255.255.255')],
  [ipv4ToInt('240.0.0.0'), ipv4ToInt('255.255.255.255')],
];

type WebhookHttpResponse = {
  status: number;
  response: string;
};

type WebhookDeliveryAttempt = Awaited<ReturnType<WebhookDeliveryRepository['findByAttempt']>>;
type WebhookDeliveryResult = WorkflowActivityResult<{ statusCode: number; response: string }>;
type EndpointDeadLetterResult = {
  delivery: NonNullable<WebhookDeliveryAttempt>;
  activityResult: WebhookDeliveryResult | null;
};

class WebhookDeadLetterPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebhookDeadLetterPersistenceError';
  }
}

class WebhookDeliveryOutcomePersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WebhookDeliveryOutcomePersistenceError';
  }
}

const IPV6_BLOCKED_RANGES: Array<[bigint, number]> = [
  [ipv6ToBigInt('::'), 128],
  [ipv6ToBigInt('::1'), 128],
  [ipv6ToBigInt('::ffff:0:0'), 96],
  [ipv6ToBigInt('64:ff9b:1::'), 48],
  [ipv6ToBigInt('100::'), 64],
  [ipv6ToBigInt('2001::'), 23],
  [ipv6ToBigInt('2001:2::'), 48],
  [ipv6ToBigInt('2001:db8::'), 32],
  [ipv6ToBigInt('2002::'), 16],
  [ipv6ToBigInt('fc00::'), 7],
  [ipv6ToBigInt('fe80::'), 10],
  [ipv6ToBigInt('fec0::'), 10],
  [ipv6ToBigInt('ff00::'), 8],
];

export async function deliverWebhookActivity(input: {
  apiVersion?: string;
  endpointId: string;
  eventId: string;
  eventType?: string;
  replayNonce?: string;
  payload: string;
  attempt: number;
  finalAttempt?: boolean;
}): Promise<WorkflowActivityResult<{ statusCode: number; response: string }>> {
  const db = createDb();
  let claimedDeliveryId: string | undefined;
  let claimedLeaseExpiresAt: Date | undefined;
  try {
    const endpointRepo = new WebhookEndpointRepository(db);
    const deliveryRepo = new WebhookDeliveryRepository(db);
    const deliveryKey = input.replayNonce ? `replay:${input.replayNonce}` : 'live';
    let delivery = await deliveryRepo.findByAttempt({
      eventId: input.eventId,
      requestedEndpointId: input.endpointId,
      deliveryKey,
      attempt: input.attempt,
    });
    const terminalResult = resultForTerminalDelivery(delivery);
    if (terminalResult) {
      return terminalResult;
    }

    const endpoint = await endpointRepo.findById(input.endpointId);
    if (!endpoint) {
      const result = await persistEndpointDeadLetter({
        deliveryRepo,
        delivery,
        createInput: {
          endpointId: null,
          requestedEndpointId: input.endpointId,
          deliveryKey,
          eventId: input.eventId,
          attempt: input.attempt,
          status: 'dead_lettered',
          response: 'Webhook endpoint not found',
          nextRetryAt: null,
        },
        updateInput: {
          endpoint_id: null,
          status_code: null,
          response: 'Webhook endpoint not found',
          status: 'dead_lettered',
          delivered_at: null,
          next_retry_at: null,
        },
        response: 'Webhook endpoint not found',
      });
      if (result.activityResult) {
        return result.activityResult;
      }
      return errResult('ENDPOINT_NOT_FOUND', 'Webhook endpoint not found', false);
    }

    const inactiveEndpoint = endpoint.status !== 'active';
    if (inactiveEndpoint) {
      const result = await persistEndpointDeadLetter({
        deliveryRepo,
        delivery,
        createInput: {
          endpointId: input.endpointId,
          deliveryKey,
          eventId: input.eventId,
          attempt: input.attempt,
          status: 'dead_lettered',
          response: 'Webhook endpoint is not active',
          nextRetryAt: null,
        },
        updateInput: {
          endpoint_id: input.endpointId,
          status_code: null,
          response: 'Webhook endpoint is not active',
          status: 'dead_lettered',
          delivered_at: null,
          next_retry_at: null,
        },
        response: 'Webhook endpoint is not active',
      });
      if (result.activityResult) {
        return result.activityResult;
      }
      return errResult('ENDPOINT_INACTIVE', 'Webhook endpoint is not active', false);
    }

    delivery =
      delivery ??
      (await deliveryRepo.create({
        endpointId: input.endpointId,
        deliveryKey,
        eventId: input.eventId,
        attempt: input.attempt,
      }));
    const racedTerminalResult = resultForTerminalDelivery(delivery);
    if (racedTerminalResult) {
      return racedTerminalResult;
    }

    const leaseExpiresAt = new Date(Date.now() + WEBHOOK_DELIVERY_CLAIM_LEASE_MS);
    const claim = await deliveryRepo.claimAttempt({
      endpointId: input.endpointId,
      deliveryKey,
      eventId: input.eventId,
      attempt: input.attempt,
      leaseExpiresAt,
    });
    delivery = claim.delivery;
    const claimedTerminalResult = resultForTerminalDelivery(delivery);
    if (claimedTerminalResult) {
      return claimedTerminalResult;
    }
    if (!claim.claimed) {
      const currentDelivery = await deliveryRepo.findByAttempt({
        eventId: input.eventId,
        requestedEndpointId: input.endpointId,
        deliveryKey,
        attempt: input.attempt,
      });
      const currentTerminalResult = resultForTerminalDelivery(currentDelivery);
      if (currentTerminalResult) {
        return currentTerminalResult;
      }
      return errResult(
        'WEBHOOK_DELIVERY_IN_PROGRESS',
        'Webhook delivery attempt is already in progress',
        true,
      );
    }
    claimedDeliveryId = delivery.id;
    claimedLeaseExpiresAt =
      delivery.next_retry_at instanceof Date ? delivery.next_retry_at : leaseExpiresAt;

    const signature = signWebhookPayload({
      payload: input.payload,
      secret: endpoint.secret as string,
    });
    const eventType = input.eventType ?? parseWebhookEventType(input.payload);
    const response = await withSpan(
      'provider.webhook.deliver',
      {
        'tixkit.provider': 'webhook',
        'tixkit.provider.operation': 'deliver',
        'tixkit.webhook.endpoint_id': input.endpointId,
        'tixkit.webhook.event_id': input.eventId,
        'tixkit.webhook.delivery_id': delivery.id,
        'tixkit.webhook.event_type': eventType,
      },
      async (span) => {
        const deliveredResponse = await postWebhook(endpoint.url, {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': WEBHOOK_USER_AGENT,
            'X-Tixkit-API-Version': input.apiVersion ?? WEBHOOK_API_VERSION,
            'X-Tixkit-Delivery': delivery.id,
            'X-Tixkit-Event-ID': input.eventId,
            ...(eventType ? { 'X-Tixkit-Event-Type': eventType } : {}),
            'X-Tixkit-Signature': signature,
          },
          body: input.payload,
        });
        span.setAttribute('http.response.status_code', deliveredResponse.status);
        return deliveredResponse;
      },
    );
    const responseText = response.response;
    const delivered = response.status >= 200 && response.status < 300;
    const terminalFailure = !delivered && input.finalAttempt === true;
    const racedOutcomeResult = await persistDeliveryOutcome(
      deliveryRepo,
      delivery.id,
      claimedLeaseExpiresAt,
      {
        status_code: response.status,
        response: responseText,
        status: delivered ? 'delivered' : terminalFailure ? 'dead_lettered' : 'failed',
        delivered_at: delivered ? new Date() : null,
        next_retry_at:
          delivered || terminalFailure
            ? null
            : new Date(Date.now() + 5 * Math.pow(2, input.attempt - 1) * 1000),
      },
    );
    if (racedOutcomeResult) {
      return racedOutcomeResult;
    }
    return okResult({ statusCode: response.status, response: responseText });
  } catch (err) {
    if (
      err instanceof WebhookDeadLetterPersistenceError ||
      err instanceof WebhookDeliveryOutcomePersistenceError
    ) {
      throw err;
    }

    const nonRetryableDeliveryError = isNonRetryableWebhookDeliveryError(err);
    if (claimedDeliveryId && claimedLeaseExpiresAt) {
      try {
        const deliveryRepo = new WebhookDeliveryRepository(db);
        const racedOutcomeResult = await persistDeliveryOutcome(
          deliveryRepo,
          claimedDeliveryId,
          claimedLeaseExpiresAt,
          {
            status_code: null,
            response: err instanceof Error ? err.message : 'Unknown error',
            status:
              input.finalAttempt === true || nonRetryableDeliveryError
                ? 'dead_lettered'
                : 'failed',
            delivered_at: null,
            next_retry_at:
              input.finalAttempt === true || nonRetryableDeliveryError
                ? null
                : new Date(Date.now() + 5 * Math.pow(2, input.attempt - 1) * 1000),
          },
        );
        if (racedOutcomeResult) {
          return racedOutcomeResult;
        }
      } catch (updateErr) {
        if (input.finalAttempt === true || nonRetryableDeliveryError) {
          throw updateErr;
        }

        // Preserve the original delivery failure so Temporal retries retain the
        // actionable endpoint/fetch error.
      }
    }
    return errResult(
      'WEBHOOK_DELIVERY_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      input.finalAttempt !== true && !nonRetryableDeliveryError,
    );
  } finally {
    await db.destroy();
  }
}

function resultForTerminalDelivery(
  delivery: WebhookDeliveryAttempt,
  expectedDeadLetterResponse?: string,
): WebhookDeliveryResult | null {
  if (!delivery) {
    return null;
  }

  if (delivery.status === 'delivered') {
    return okResult({
      statusCode: delivery.status_code ?? 204,
      response: delivery.response ?? '',
    });
  }

  if (delivery.status === 'dead_lettered') {
    if (expectedDeadLetterResponse && delivery.response === expectedDeadLetterResponse) {
      return null;
    }

    return errResult(
      'WEBHOOK_DELIVERY_ALREADY_TERMINAL',
      delivery.response ?? 'Webhook delivery is already terminal',
      false,
    );
  }

  return null;
}

async function persistEndpointDeadLetter(input: {
  deliveryRepo: WebhookDeliveryRepository;
  delivery: WebhookDeliveryAttempt;
  createInput: Parameters<WebhookDeliveryRepository['create']>[0];
  updateInput: Record<string, unknown>;
  response: string;
}): Promise<EndpointDeadLetterResult> {
  try {
    const delivery = input.delivery ?? (await input.deliveryRepo.create(input.createInput));
    const terminalResult = resultForTerminalDelivery(delivery, input.response);
    if (terminalResult) {
      return { delivery, activityResult: terminalResult };
    }

    if (delivery.status !== 'dead_lettered') {
      const { updated, delivery: currentDelivery } = await input.deliveryRepo.deadLetterAttempt(
        delivery.id,
        input.updateInput,
      );
      const currentTerminalResult = resultForTerminalDelivery(currentDelivery);
      if (currentTerminalResult) {
        return { delivery: currentDelivery, activityResult: currentTerminalResult };
      }
      if (!updated && isDeliveryLeaseInProgress(currentDelivery)) {
        return {
          delivery: currentDelivery,
          activityResult: errResult(
            'WEBHOOK_DELIVERY_IN_PROGRESS',
            'Webhook delivery attempt is already in progress',
            true,
          ),
        };
      }
      if (!updated) {
        throw new Error(`Webhook delivery ${delivery.id} was not dead-lettered`);
      }
      return { delivery: currentDelivery, activityResult: null };
    }

    return { delivery, activityResult: null };
  } catch (err) {
    throw new WebhookDeadLetterPersistenceError(
      err instanceof Error
        ? `Failed to persist webhook dead-letter delivery: ${err.message}`
        : 'Failed to persist webhook dead-letter delivery',
      err instanceof Error ? { cause: err } : undefined,
    );
  }
}

function isDeliveryLeaseInProgress(delivery: NonNullable<WebhookDeliveryAttempt>): boolean {
  return (
    delivery.status === 'pending' &&
    delivery.next_retry_at instanceof Date &&
    delivery.next_retry_at.getTime() > Date.now()
  );
}

async function persistDeliveryOutcome(
  deliveryRepo: WebhookDeliveryRepository,
  deliveryId: string,
  leaseExpiresAt: Date,
  input: Record<string, unknown>,
): Promise<WebhookDeliveryResult | null> {
  try {
    const { updated, delivery } = await deliveryRepo.completeClaimedAttempt(
      deliveryId,
      leaseExpiresAt,
      input,
    );
    if (updated) {
      return null;
    }

    const terminalResult = resultForTerminalDelivery(delivery);
    if (terminalResult) {
      return terminalResult;
    }
    if (isDeliveryLeaseInProgress(delivery)) {
      return errResult(
        'WEBHOOK_DELIVERY_IN_PROGRESS',
        'Webhook delivery attempt is already in progress',
        true,
      );
    }

    throw new Error(`Webhook delivery ${deliveryId} was not completed by the claimed lease`);
  } catch (err) {
    throw new WebhookDeliveryOutcomePersistenceError(
      err instanceof Error
        ? `Failed to persist webhook delivery outcome: ${err.message}`
        : 'Failed to persist webhook delivery outcome',
      err instanceof Error ? { cause: err } : undefined,
    );
  }
}

function postWebhook(
  rawUrl: string,
  input: { headers: Record<string, string>; body: string },
): Promise<WebhookHttpResponse> {
  const url = parseWebhookDeliveryUrl(rawUrl);
  const requestBody = input.body;

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (
      result:
        | { ok: true; response: WebhookHttpResponse }
        | { ok: false; error: Error },
    ) => {
      if (settled) return;
      settled = true;
      if (deadline) {
        clearTimeout(deadline);
      }
      if (result.ok) {
        resolve(result.response);
        return;
      }
      reject(result.error);
    };

    try {
      const request = httpsRequest(
        {
          protocol: 'https:',
          hostname: url.hostname,
          port: url.port ? Number(url.port) : 443,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            ...input.headers,
            'Content-Length': Buffer.byteLength(requestBody).toString(),
          },
          lookup: secureWebhookLookup,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          response.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            responseBytes += chunkBuffer.byteLength;
            if (responseBytes > WEBHOOK_RESPONSE_MAX_BYTES) {
              const error = new Error(
                `Webhook response exceeded ${WEBHOOK_RESPONSE_MAX_BYTES} bytes`,
              );
              request.destroy(error);
              settle({ ok: false, error });
              return;
            }
            chunks.push(chunkBuffer);
          });
          response.on('end', () => {
            if (settled) return;
            settle({
              ok: true,
              response: {
                status: response.statusCode ?? 0,
                response: Buffer.concat(chunks).toString('utf8'),
              },
            });
          });
          response.on('error', (error) => {
            settle({ ok: false, error });
          });
        },
      );

      request.on('error', (error) => {
        settle({ ok: false, error });
      });
      request.setTimeout(WEBHOOK_REQUEST_TIMEOUT_MS, () => {
        const error = new Error('Webhook request timed out');
        request.destroy(error);
        settle({ ok: false, error });
      });
      deadline = setTimeout(() => {
        const error = new Error('Webhook request timed out');
        request.destroy(error);
        settle({ ok: false, error });
      }, WEBHOOK_REQUEST_TIMEOUT_MS);
      request.write(requestBody);
      request.end();
    } catch (error) {
      settle({
        ok: false,
        error: error instanceof Error ? error : new Error('Webhook request failed'),
      });
    }
  });
}

function parseWebhookDeliveryUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw createBlockedHostError('Webhook URL is invalid');
  }

  if (url.protocol !== 'https:') {
    throw createBlockedHostError('Webhook URL must use https');
  }

  const hostname = normalizeHostname(url.hostname);
  const hostnameIpVersion = isIP(hostname);
  if (hostnameIpVersion === 0 && isPrivateHostname(hostname)) {
    throw createBlockedHostError('Webhook URL host is private or internal');
  }

  if (hostnameIpVersion !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw createBlockedHostError('Webhook URL host is private or internal');
    }
  }

  return url;
}

const secureWebhookLookup: LookupFunction = (hostname, options, callback) => {
  const normalizedHostname = normalizeHostname(hostname);
  const literalIpVersion = isIP(normalizedHostname);
  if (literalIpVersion !== 0) {
    if (isBlockedIpAddress(normalizedHostname)) {
      callback(createBlockedHostError('Webhook URL host is private or internal'), '', 0);
      return;
    }
    if (options.all === true) {
      callback(null, [{ address: normalizedHostname, family: literalIpVersion }]);
      return;
    }
    callback(null, normalizedHostname, literalIpVersion);
    return;
  }

  if (isPrivateHostname(normalizedHostname)) {
    callback(createBlockedHostError('Webhook URL host is private or internal'), '', 0);
    return;
  }

  const lookupOptions = {
    all: true,
    family: options.family,
    hints: options.hints,
    order: options.order,
    verbatim: options.verbatim,
  } satisfies LookupAllOptions;

  dnsLookup(normalizedHostname, lookupOptions, (error, addresses) => {
    if (error) {
      callback(error, '', 0);
      return;
    }

    const blockedAddress = addresses.find(({ address }) => isBlockedIpAddress(address));
    if (blockedAddress) {
      callback(
        createBlockedHostError(
          `Webhook URL host resolves to private or internal address ${blockedAddress.address}`,
        ),
        '',
        0,
      );
      return;
    }

    if (addresses.length === 0) {
      callback(createBlockedHostError('Webhook URL host has no A or AAAA records'), '', 0);
      return;
    }

    if (options.all === true) {
      callback(null, addresses);
      return;
    }

    const selectedAddress = selectLookupAddress(addresses, options.family);
    callback(null, selectedAddress.address, selectedAddress.family);
  });
};

function selectLookupAddress(
  addresses: LookupAddress[],
  family: LookupAllOptions['family'],
): LookupAddress {
  if (family === 4 || family === 'IPv4') {
    return addresses.find((address) => address.family === 4) ?? addresses[0];
  }
  if (family === 6 || family === 'IPv6') {
    return addresses.find((address) => address.family === 6) ?? addresses[0];
  }
  return addresses[0];
}

function createBlockedHostError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'ERR_WEBHOOK_BLOCKED_HOST';
  return error;
}

function isNonRetryableWebhookDeliveryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_WEBHOOK_BLOCKED_HOST'
  );
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function isPrivateHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    !hostname.includes('.')
  );
}

function isBlockedIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parsed = ipv4ToInt(address);
    return isBlockedIpv4Int(parsed);
  }
  if (version === 6) {
    const parsed = ipv6ToBigInt(address);
    const nat64Ipv4 = extractWellKnownNat64Ipv4(parsed);
    if (nat64Ipv4 !== null && isBlockedIpv4Int(nat64Ipv4)) {
      return true;
    }
    return IPV6_BLOCKED_RANGES.some(([prefix, prefixLength]) =>
      isIpv6InPrefix(parsed, prefix, prefixLength),
    );
  }
  return true;
}

function isBlockedIpv4Int(parsed: number): boolean {
  return IPV4_BLOCKED_RANGES.some(([start, end]) => parsed >= start && parsed <= end);
}

function extractWellKnownNat64Ipv4(address: bigint): number | null {
  if (!isIpv6InPrefix(address, NAT64_WELL_KNOWN_PREFIX, 96)) {
    return null;
  }
  return Number(address & 0xffffffffn);
}

function ipv4ToInt(address: string): number {
  const parts = address.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new Error(`Invalid IPv4 address: ${address}`);
  }

  return (parts[0] * 256 ** 3 + parts[1] * 256 ** 2 + parts[2] * 256 + parts[3]) >>> 0;
}

function ipv6ToBigInt(address: string): bigint {
  let normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = ipv4ToInt(normalized.slice(lastColon + 1));
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) {
    throw new Error(`Invalid IPv6 address: ${address}`);
  }

  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (parts.length !== 8) {
    throw new Error(`Invalid IPv6 address: ${address}`);
  }

  return parts.reduce((value, part) => {
    if (!/^[\da-f]{1,4}$/.test(part)) {
      throw new Error(`Invalid IPv6 address: ${address}`);
    }
    return (value << 16n) + BigInt(Number.parseInt(part, 16));
  }, 0n);
}

function isIpv6InPrefix(address: bigint, prefix: bigint, prefixLength: number): boolean {
  const hostBits = BigInt(128 - prefixLength);
  const mask = ((1n << BigInt(prefixLength)) - 1n) << hostBits;
  return (address & mask) === (prefix & mask);
}

function parseWebhookEventType(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

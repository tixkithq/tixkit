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
  payload: string;
  attempt: number;
  finalAttempt?: boolean;
}): Promise<WorkflowActivityResult<{ statusCode: number; response: string }>> {
  const db = createDb();
  let deliveryId: string | undefined;
  try {
    const endpointRepo = new WebhookEndpointRepository(db);
    const endpoint = await endpointRepo.findById(input.endpointId);
    const deliveryRepo = new WebhookDeliveryRepository(db);
    if (!endpoint) {
      await deliveryRepo.create({
        endpointId: null,
        requestedEndpointId: input.endpointId,
        eventId: input.eventId,
        attempt: input.attempt,
        status: 'dead_lettered',
        response: 'Webhook endpoint not found',
        nextRetryAt: null,
      });
      return errResult('ENDPOINT_NOT_FOUND', 'Webhook endpoint not found', false);
    }

    const inactiveEndpoint = endpoint.status !== 'active';
    const delivery = await deliveryRepo.create({
      endpointId: input.endpointId,
      eventId: input.eventId,
      attempt: input.attempt,
      status: inactiveEndpoint ? 'dead_lettered' : undefined,
      response: inactiveEndpoint ? 'Webhook endpoint is not active' : undefined,
      nextRetryAt: inactiveEndpoint ? null : undefined,
    });
    deliveryId = delivery.id;
    if (inactiveEndpoint) {
      return errResult('ENDPOINT_INACTIVE', 'Webhook endpoint is not active', false);
    }

    const signature = signWebhookPayload({ payload: input.payload, secret: endpoint.secret as string });
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
    await deliveryRepo.update(delivery.id, {
      status_code: response.status,
      response: responseText,
      status: delivered ? 'delivered' : terminalFailure ? 'dead_lettered' : 'failed',
      delivered_at: delivered ? new Date() : null,
      next_retry_at:
        delivered || terminalFailure
          ? null
          : new Date(Date.now() + 5 * Math.pow(2, input.attempt - 1) * 1000),
    });
    return okResult({ statusCode: response.status, response: responseText });
  } catch (err) {
    if (deliveryId) {
      try {
        const deliveryRepo = new WebhookDeliveryRepository(db);
        await deliveryRepo.update(deliveryId, {
          status_code: null,
          response: err instanceof Error ? err.message : 'Unknown error',
          status: input.finalAttempt === true ? 'dead_lettered' : 'failed',
          delivered_at: null,
          next_retry_at:
            input.finalAttempt === true
              ? null
              : new Date(Date.now() + 5 * Math.pow(2, input.attempt - 1) * 1000),
        });
      } catch {
        // Preserve the original delivery failure so Temporal retries retain the
        // actionable endpoint/fetch error.
      }
    }
    return errResult(
      'WEBHOOK_DELIVERY_FAILED',
      err instanceof Error ? err.message : 'Unknown error',
      input.finalAttempt !== true,
    );
  } finally {
    await db.destroy();
  }
}

function postWebhook(
  rawUrl: string,
  input: { headers: Record<string, string>; body: string },
): Promise<WebhookHttpResponse> {
  const url = parseWebhookDeliveryUrl(rawUrl);
  const requestBody = input.body;

  return new Promise((resolve, reject) => {
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
        response.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            response: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );

    request.on('error', reject);
    request.write(requestBody);
    request.end();
  });
}

function parseWebhookDeliveryUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Webhook URL is invalid');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Webhook URL must use https');
  }

  const hostname = normalizeHostname(url.hostname);
  const hostnameIpVersion = isIP(hostname);
  if (hostnameIpVersion === 0 && isPrivateHostname(hostname)) {
    throw new Error('Webhook URL host is private or internal');
  }

  if (hostnameIpVersion !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error('Webhook URL host is private or internal');
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

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
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
    return IPV4_BLOCKED_RANGES.some(([start, end]) => parsed >= start && parsed <= end);
  }
  if (version === 6) {
    const parsed = ipv6ToBigInt(address);
    return IPV6_BLOCKED_RANGES.some(([prefix, prefixLength]) =>
      isIpv6InPrefix(parsed, prefix, prefixLength),
    );
  }
  return true;
}

function ipv4ToInt(address: string): number {
  const parts = address.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new Error(`Invalid IPv4 address: ${address}`);
  }

  return (
    (parts[0] * 256 ** 3 + parts[1] * 256 ** 2 + parts[2] * 256 + parts[3]) >>>
    0
  );
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

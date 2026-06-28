import { config } from './config.js';

const secretBearingEnvKeys = ['DATABASE_URL', 'REDIS_URL', 'TEMPORAL_ADDRESS'] as const;
const sensitiveQueryParamPattern =
  /(password|passwd|pwd|token|secret|api[-_]?key|access[-_]?token|auth[-_]?token|session|signature|sig)/i;
const sensitiveKeyValuePattern =
  /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?token|auth[_-]?token|session|signature|sig)=([^&\s'")]+)/gi;
const urlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi;

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      url.username = 'redacted';
      url.password = '';
    }

    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveQueryParamPattern.test(key)) {
        url.searchParams.set(key, 'redacted');
      }
    }

    return url.toString();
  } catch {
    return rawUrl;
  }
}

function redactEndpointValue(value: string): string {
  if (!value) return value;

  const redactedUrl = redactUrl(value);
  if (redactedUrl !== value) return redactedUrl;

  if (value.includes('@') && !value.includes('://')) {
    const redactedAddress = redactUrl(`tixkit://${value}`);
    return redactedAddress.startsWith('tixkit://')
      ? redactedAddress.slice('tixkit://'.length)
      : value;
  }

  return value;
}

function redactSensitiveDiagnostics(text: string): string {
  let redacted = text;

  for (const key of secretBearingEnvKeys) {
    const value = process.env[key];
    if (!value) continue;

    const redactedValue = redactEndpointValue(value);
    if (redactedValue !== value) {
      redacted = redacted.replaceAll(value, redactedValue);
    }
  }

  redacted = redacted.replace(urlPattern, (url) => redactUrl(url));
  return redacted.replace(sensitiveKeyValuePattern, '$1=[redacted]');
}

export function buildWorkerStartupFailureMessage(error: unknown): string {
  const detail = redactSensitiveDiagnostics(errorText(error));
  const temporalAddress = redactEndpointValue(config.temporalAddress);

  return [
    'Tixkit worker failed to start.',
    '- Start local infrastructure with `bun run infra:up`.',
    `- Verify Temporal is reachable at ${temporalAddress}.`,
    '- Run `bun run db:migrate` before starting worker activities that touch storage.',
    '',
    `Original error: ${detail}`,
  ].join('\n');
}

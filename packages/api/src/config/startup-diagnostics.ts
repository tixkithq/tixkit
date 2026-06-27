type DiagnosticInput = {
  service: 'API' | 'migration';
  databaseUrl?: string;
  temporalAddress?: string;
};

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function matchesAny(value: string, needles: string[]): boolean {
  const lower = value.toLowerCase();
  return needles.some((needle) => lower.includes(needle));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeUrlComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function redactToken(text: string, token: string): string {
  if (!token) return text;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(token)}(?=$|[^A-Za-z0-9_])`, 'g');
  return text.replace(pattern, '$1[redacted]');
}

function databaseUrlContext(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const protocol = url.protocol.replace(/:$/, '');
    const database = url.pathname.replace(/^\/+|\/+$/g, '');
    const parts = [
      protocol ? `protocol ${protocol}` : undefined,
      url.host ? `host ${url.host}` : undefined,
      database ? `database ${database}` : undefined,
    ].filter(Boolean);

    return parts.length > 0 ? ` (${parts.join(', ')})` : ' (connection details unavailable)';
  } catch {
    return ' (connection details unavailable)';
  }
}

function redactDatabaseUrlDetail(detail: string, databaseUrl?: string): string {
  if (!databaseUrl) return detail;

  let redacted = detail.split(databaseUrl).join('[redacted DATABASE_URL]');

  try {
    const url = new URL(databaseUrl);
    const tokens = new Set(
      [url.username, decodeUrlComponent(url.username), url.password, decodeUrlComponent(url.password)].filter(
        Boolean,
      ) as string[],
    );

    for (const token of tokens) {
      redacted = redactToken(redacted, token);
    }
  } catch {
    return redacted;
  }

  return redacted;
}

export function buildStartupFailureMessage(error: unknown, input: DiagnosticInput): string {
  const detail = redactDatabaseUrlDetail(errorText(error), input.databaseUrl);
  const hints: string[] = [];

  if (matchesAny(detail, ['econnrefused', 'enotfound', 'timeout', 'failed to connect'])) {
    hints.push('Start local infrastructure with `bun run infra:up`.');
  }

  if (input.databaseUrl && matchesAny(detail, ['postgres', 'mysql', 'database', 'pool', 'password authentication'])) {
    hints.push(`Verify DATABASE_URL points at the local database${databaseUrlContext(input.databaseUrl)}.`);
  }

  if (input.temporalAddress && matchesAny(detail, ['temporal', 'transport error', '14 unavailable', 'nativeconnection'])) {
    hints.push(`Verify Temporal is reachable at ${input.temporalAddress}.`);
  }

  hints.push('Then run `bun run db:migrate` before starting the API and worker.');

  const hintText = [...new Set(hints)].map((hint) => `- ${hint}`).join('\n');
  return `Tixkit ${input.service} failed to start.\n${hintText}\n\nOriginal error: ${detail}`;
}

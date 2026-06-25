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

export function buildStartupFailureMessage(error: unknown, input: DiagnosticInput): string {
  const detail = errorText(error);
  const hints: string[] = [];

  if (matchesAny(detail, ['econnrefused', 'enotfound', 'timeout', 'failed to connect'])) {
    hints.push('Start local infrastructure with `bun run infra:up`.');
  }

  if (input.databaseUrl && matchesAny(detail, ['postgres', 'mysql', 'database', 'pool', 'password authentication'])) {
    hints.push(`Verify DATABASE_URL points at the local database (${input.databaseUrl}).`);
  }

  if (input.temporalAddress && matchesAny(detail, ['temporal', 'transport error', '14 unavailable', 'nativeconnection'])) {
    hints.push(`Verify Temporal is reachable at ${input.temporalAddress}.`);
  }

  hints.push('Then run `bun run db:migrate` before starting the API and worker.');

  const hintText = [...new Set(hints)].map((hint) => `- ${hint}`).join('\n');
  return `GateKit ${input.service} failed to start.\n${hintText}\n\nOriginal error: ${detail}`;
}

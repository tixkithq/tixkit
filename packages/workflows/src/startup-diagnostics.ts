import { config } from './config.js';

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function buildWorkerStartupFailureMessage(error: unknown): string {
  const detail = errorText(error);
  return [
    'GateKit worker failed to start.',
    '- Start local infrastructure with `bun run infra:up`.',
    `- Verify Temporal is reachable at ${config.temporalAddress}.`,
    '- Run `bun run db:migrate` before starting worker activities that touch storage.',
    '',
    `Original error: ${detail}`,
  ].join('\n');
}

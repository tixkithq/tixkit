import { vi } from 'vitest';

vi.mock('@opentelemetry/core', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    TracesSamplerValues: actual.TracesSamplerValues ?? {
      AlwaysOn: 'always_on',
      AlwaysOff: 'always_off',
      TraceIdRatioBased: 'traceidratiobased',
    },
    DEFAULT_ENVIRONMENT: actual.DEFAULT_ENVIRONMENT ?? {},
    parseEnvironment: actual.parseEnvironment ?? (() => ({})),
  };
});

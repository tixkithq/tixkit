import { vi } from 'vitest';

vi.mock('@opentelemetry/core', async (importOriginal) => {
  try {
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
  } catch {
    return {
      TracesSamplerValues: {
        AlwaysOn: 'always_on',
        AlwaysOff: 'always_off',
        TraceIdRatioBased: 'traceidratiobased',
      },
      DEFAULT_ENVIRONMENT: {},
      parseEnvironment: () => ({}),
    };
  }
});

// Also patch the CJS cache directly in case vi.mock doesn't intercept
// bun's require() calls inside @opentelemetry/sdk-trace-base
try {
  const core = require('@opentelemetry/core') as Record<string, unknown>;
  if (!core.TracesSamplerValues) {
    core.TracesSamplerValues = {
      AlwaysOn: 'always_on',
      AlwaysOff: 'always_off',
      TraceIdRatioBased: 'traceidratiobased',
    };
  }
  if (!core.DEFAULT_ENVIRONMENT) {
    core.DEFAULT_ENVIRONMENT = {};
  }
  if (!core.parseEnvironment) {
    core.parseEnvironment = () => ({});
  }
} catch {
  // Module not resolvable from this context
}

import { vi } from 'vitest';

// Bun CJS interop bug: @opentelemetry/core uses Object.defineProperty(exports, "X", { get: () => ... })
// which bun's require() doesn't resolve, causing TracesSamplerValues to be undefined.
// When @opentelemetry/sdk-trace-base loads, its config.ts does require('@opentelemetry/core')
// and accesses TracesSamplerValues.AlwaysOn, throwing "Cannot read properties of undefined".
// Mock the heavy OTel SDK modules to prevent the error. Only the API package's tests need this;
// the shared package's observability test has its own mocks.

vi.mock('@opentelemetry/sdk-trace-base', () => ({
  BasicTracerProvider: class BasicTracerProvider {
    constructor() {}
    register() {}
    async shutdown() {}
    forceFlush() { return Promise.resolve(); }
  },
  BatchSpanProcessor: class BatchSpanProcessor {
    constructor() {}
    async shutdown() {}
    async forceFlush() {}
  },
  SimpleSpanProcessor: class SimpleSpanProcessor {
    constructor() {}
    async shutdown() {}
    async forceFlush() {}
  },
  SpanExporter: class SpanExporter {},
  ConsoleSpanExporter: class ConsoleSpanExporter {
    async shutdown() {}
    async forceFlush() {}
  },
  InMemorySpanExporter: class InMemorySpanExporter {
    async shutdown() {}
    async forceFlush() {}
  },
}));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class NodeSDK {
    start() {}
    async shutdown() {}
  },
}));

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class OTLPTraceExporter {
    async shutdown() {}
    async forceFlush() {}
  },
}));

vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: (attrs: Record<string, string>) => ({ attributes: attrs }),
}));

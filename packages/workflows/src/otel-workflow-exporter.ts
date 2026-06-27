import {
  createTraceState,
  type Attributes,
  type AttributeValue,
  type HrTime,
  type Link,
  type SpanContext,
  type SpanKind,
  type SpanStatus,
} from '@opentelemetry/api';
import type { InstrumentationScope } from '@opentelemetry/core';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanExporter, TimedEvent } from '@opentelemetry/sdk-trace-base';
import type { InjectedSink } from '@temporalio/worker';
import type { Sink } from '@temporalio/workflow';

const TEMPORAL_WORKFLOW_SCOPE: InstrumentationScope = { name: '@temporalio/interceptor-workflow' };

type SerializableSpanContext = Omit<SpanContext, 'traceState'> & {
  traceState?: string;
};

type SerializableWorkflowSpan = {
  readonly name: string;
  readonly kind: SpanKind;
  readonly spanContext: SerializableSpanContext;
  readonly parentSpanId?: string;
  readonly startTime: HrTime;
  readonly endTime: HrTime;
  readonly status: SpanStatus;
  readonly attributes: Attributes;
  readonly links: Link[];
  readonly events: TimedEvent[];
  readonly duration: HrTime;
  readonly ended: boolean;
  readonly droppedAttributesCount: number;
  readonly droppedEventsCount: number;
  readonly droppedLinksCount: number;
  readonly instrumentationLibrary?: InstrumentationScope;
  readonly instrumentationScope?: InstrumentationScope;
};

type WorkflowExporterSink = Sink & {
  export(spans: SerializableWorkflowSpan[]): void;
};

export function createWorkflowExporterSink(
  spanExporter: SpanExporter,
  resource: Resource,
): InjectedSink<WorkflowExporterSink> {
  return {
    export: {
      fn: (info, spanData) => {
        const spans = spanData.map((serialized) => {
          const attributes: Attributes = {
            ...toSpanAttributes(serialized.attributes),
            ...toSpanAttributes(info),
          };
          return toReadableSpan(
            {
              ...serialized,
              attributes,
            },
            resource,
          );
        });

        spanExporter.export(spans, () => undefined);
      },
    },
  };
}

function toSpanAttributes(value: object): Attributes {
  const attributes: Attributes = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isAttributeValue(entry)) {
      attributes[key] = entry;
    }
  }
  return attributes;
}

function isAttributeValue(value: unknown): value is AttributeValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean');
}

function toReadableSpan(serialized: SerializableWorkflowSpan, resource: Resource): ReadableSpan {
  const { traceState, ...restSpanContext } = serialized.spanContext;
  const spanContext = {
    ...restSpanContext,
    traceState: traceState ? createTraceState(traceState) : undefined,
  };

  return {
    name: serialized.name,
    kind: serialized.kind,
    spanContext: () => spanContext,
    parentSpanContext: serialized.parentSpanId
      ? {
          ...spanContext,
          spanId: serialized.parentSpanId,
        }
      : undefined,
    startTime: serialized.startTime,
    endTime: serialized.endTime,
    status: serialized.status,
    attributes: serialized.attributes,
    links: serialized.links,
    events: serialized.events,
    duration: serialized.duration,
    ended: serialized.ended,
    resource,
    instrumentationScope:
      serialized.instrumentationScope ?? serialized.instrumentationLibrary ?? TEMPORAL_WORKFLOW_SCOPE,
    droppedAttributesCount: serialized.droppedAttributesCount,
    droppedEventsCount: serialized.droppedEventsCount,
    droppedLinksCount: serialized.droppedLinksCount,
  };
}

import { type AdminExportJob, getAdminApiAuthHeaders, normalizeExportJob } from '@/lib/api';
import { resolveAdminApiUrl } from './api-http';

type ExportJobSubscription = {
  onUpdate: (job: AdminExportJob) => void;
  onError: (error: Error) => void;
  onDone: (job: AdminExportJob) => void;
};

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

export function subscribeToExportJob(
  exportId: string,
  handlers: ExportJobSubscription,
): () => void {
  let controller = new AbortController();
  let closed = false;
  let lastEventId: string | undefined;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;

  void (async () => {
    while (!closed) {
      controller = new AbortController();
      try {
        const url = resolveAdminApiUrl(`/v1/exports/${encodeURIComponent(exportId)}/events`);
        if (!url) {
          handlers.onError(new Error('The authenticated export stream URL is invalid'));
          closed = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- reconnect attempts must preserve the latest SSE cursor.
        const headers = await getAdminApiAuthHeaders({
          Accept: 'text/event-stream',
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        });
        // eslint-disable-next-line no-await-in-loop -- each SSE connection is opened only after the previous stream ends.
        const response = await fetch(url, {
          method: 'GET',
          headers,
          credentials: 'omit',
          redirect: 'error',
          signal: controller.signal,
        });

        if (!response.ok) {
          // eslint-disable-next-line no-await-in-loop -- failed stream responses are handled before retrying or surfacing the error.
          const body = await response.json().catch(() => null);
          const message =
            body?.error?.message ?? `Export status stream failed with status ${response.status}`;
          handlers.onError(new Error(message));
          closed = true;
          break;
        }
        if (!response.body) {
          handlers.onError(new Error('Export status stream is not supported by this browser'));
          closed = true;
          break;
        }

        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          if (closed) break;
          // eslint-disable-next-line no-await-in-loop -- stream chunks must be read sequentially from this reader.
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = splitSseFrames(buffer);
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            lastEventId = handleEventFrame(frame, handlers, lastEventId, () => {
              closed = true;
              controller.abort();
            });
          }
        }
      } catch (error) {
        if (closed || (error instanceof DOMException && error.name === 'AbortError')) {
          break;
        }
      }

      if (!closed) {
        // eslint-disable-next-line no-await-in-loop -- SSE reconnect backoff is sequential by definition.
        await sleep(reconnectDelayMs);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  })();

  return () => {
    closed = true;
    controller.abort();
  };
}

function handleEventFrame(
  frame: string,
  handlers: ExportJobSubscription,
  lastEventId: string | undefined,
  close: () => void,
): string | undefined {
  const eventId = readSseField(frame, 'id') ?? lastEventId;
  const event = readSseField(frame, 'event') ?? 'message';
  const data = readSseField(frame, 'data');
  if (!data) return eventId;

  if (event === 'error') {
    const payload = parseSseJson<{ message?: string }>(
      data,
      'Export status stream sent an invalid error event',
      handlers,
      close,
    );
    if (!payload) return eventId;
    handlers.onError(new Error(payload.message ?? 'Export status stream failed'));
    close();
    return eventId;
  }

  if (event !== 'export' && event !== 'message') return eventId;

  const payload = parseSseJson<Record<string, unknown>>(
    data,
    'Export status stream sent an invalid export event',
    handlers,
    close,
  );
  if (!payload) return eventId;

  let job: AdminExportJob;
  try {
    job = normalizeExportJob(payload);
  } catch {
    handlers.onError(new Error('Export status stream sent an invalid export event'));
    close();
    return eventId;
  }
  handlers.onUpdate(job);
  if (job.status === 'completed' || job.status === 'failed') {
    handlers.onDone(job);
    close();
  }
  return eventId;
}

function splitSseFrames(buffer: string): string[] {
  return buffer.split(/\r?\n\r?\n/);
}

function parseSseJson<T>(
  data: string,
  message: string,
  handlers: ExportJobSubscription,
  close: () => void,
): T | undefined {
  try {
    return JSON.parse(data) as T;
  } catch {
    handlers.onError(new Error(message));
    close();
    return undefined;
  }
}

function readSseField(frame: string, field: string): string | undefined {
  const prefix = `${field}:`;
  const values = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trimStart());
  if (values.length === 0) return undefined;
  return values.join('\n');
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

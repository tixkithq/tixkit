import {
  type CheckInActivityItem,
  type CheckInActivitySummary,
  getAdminApiAuthHeaders,
  getAdminApiBaseUrl,
} from '@/lib/api';

type ScanActivityHandlers = {
  onScan: (item: CheckInActivityItem) => void;
  onSummary?: (summary: CheckInActivitySummary) => void;
  onError?: (error: Error) => void;
  onReady?: () => void;
  onReconnecting?: (details: { attempt: number; retryInMs: number; error?: Error }) => void;
};

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

export function subscribeToCheckInActivity(
  eventId: string,
  checkInListId: string,
  handlers: ScanActivityHandlers,
  initialLastEventId?: string,
): () => void {
  let controller = new AbortController();
  let closed = false;
  let lastEventId = initialLastEventId;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let reconnectAttempt = 0;

  void (async () => {
    while (!closed) {
      controller = new AbortController();
      try {
        // eslint-disable-next-line no-await-in-loop -- reconnect attempts must preserve the latest SSE cursor.
        const headers = await getAdminApiAuthHeaders({
          Accept: 'text/event-stream',
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        });
        // eslint-disable-next-line no-await-in-loop -- each SSE connection is opened only after the previous stream ends.
        const response = await fetch(
          `${getAdminApiBaseUrl()}/v1/events/${encodeURIComponent(eventId)}/check-in-lists/${encodeURIComponent(checkInListId)}/activity/stream`,
          {
            method: 'GET',
            headers,
            credentials: 'include',
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          // eslint-disable-next-line no-await-in-loop -- failed stream responses are handled before retrying or surfacing the error.
          const body = await response.json().catch(() => null);
          const message =
            body?.error?.message ?? `Scan activity stream failed with status ${response.status}`;
          handlers.onError?.(new Error(message));
          closed = true;
          break;
        }
        if (!response.body) {
          handlers.onError?.(new Error('Scan activity stream is not supported by this browser'));
          closed = true;
          break;
        }

        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        reconnectAttempt = 0;
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
            const parsed = parseSseFrame(frame);
            if (parsed.id) lastEventId = parsed.id;
            if (parsed.event === 'ready') {
              handlers.onReady?.();
              continue;
            }
            if (parsed.event === 'scan' && parsed.data) {
              handlers.onScan(parsed.data as CheckInActivityItem);
              continue;
            }
            if (parsed.event === 'summary' && parsed.data) {
              handlers.onSummary?.(parsed.data as CheckInActivitySummary);
              continue;
            }
            if (parsed.event === 'error' && parsed.data) {
              const message =
                typeof (parsed.data as { message?: unknown }).message === 'string'
                  ? (parsed.data as { message: string }).message
                  : 'Scan activity stream failed';
              handlers.onError?.(new Error(message));
            }
          }
        }
      } catch (error) {
        if (closed || (error instanceof DOMException && error.name === 'AbortError')) {
          break;
        }
        const connectionError =
          error instanceof Error ? error : new Error('Unable to connect to live door activity');
        reconnectAttempt += 1;
        handlers.onReconnecting?.({
          attempt: reconnectAttempt,
          retryInMs: reconnectDelayMs,
          error: connectionError,
        });
      }

      if (!closed) {
        if (reconnectAttempt === 0) {
          reconnectAttempt = 1;
          handlers.onReconnecting?.({
            attempt: reconnectAttempt,
            retryInMs: reconnectDelayMs,
          });
        }
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

function splitSseFrames(buffer: string): string[] {
  return buffer.split(/\r?\n\r?\n/);
}

function parseSseFrame(frame: string): {
  id?: string;
  event?: string;
  data?: unknown;
} {
  const lines = frame.split(/\r?\n/);
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return { id, event };
  try {
    return { id, event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return { id, event, data: dataLines.join('\n') };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

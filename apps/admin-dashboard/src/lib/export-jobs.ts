import {
  type AdminExportJob,
  getAdminApiAuthHeaders,
  getAdminApiBaseUrl,
  normalizeExportJob,
} from '@/lib/api'

type ExportJobSubscription = {
  onUpdate: (job: AdminExportJob) => void
  onError: (error: Error) => void
  onDone: (job: AdminExportJob) => void
}

const INITIAL_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 15_000

export function subscribeToExportJob(
  exportId: string,
  handlers: ExportJobSubscription
): () => void {
  let controller = new AbortController()
  let closed = false
  let lastEventId: string | undefined
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS

  void (async () => {
    while (!closed) {
      controller = new AbortController()
      try {
        // eslint-disable-next-line no-await-in-loop -- reconnect attempts must preserve the latest SSE cursor.
        const headers = await getAdminApiAuthHeaders({
          Accept: 'text/event-stream',
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        })
        // eslint-disable-next-line no-await-in-loop -- each SSE connection is opened only after the previous stream ends.
        const response = await fetch(
          `${getAdminApiBaseUrl()}/v1/exports/${encodeURIComponent(exportId)}/events`,
          {
            method: 'GET',
            headers,
            credentials: 'include',
            signal: controller.signal,
          }
        )

        if (!response.ok) {
          // eslint-disable-next-line no-await-in-loop -- failed stream responses are handled before retrying or surfacing the error.
          const body = await response.json().catch(() => null)
          const message =
            body?.error?.message ?? `Export status stream failed with status ${response.status}`
          handlers.onError(new Error(message))
          closed = true
          break
        }
        if (!response.body) {
          handlers.onError(new Error('Export status stream is not supported by this browser'))
          closed = true
          break
        }

        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        for (;;) {
          if (closed) break
          // eslint-disable-next-line no-await-in-loop -- stream chunks must be read sequentially from this reader.
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            lastEventId = handleEventFrame(frame, handlers, lastEventId, () => {
              closed = true
              controller.abort()
            })
          }
        }
      } catch (error) {
        if (closed || (error instanceof DOMException && error.name === 'AbortError')) {
          break
        }
      }

      if (!closed) {
        // eslint-disable-next-line no-await-in-loop -- SSE reconnect backoff is sequential by definition.
        await sleep(reconnectDelayMs)
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
      }
    }
  })()

  return () => {
    closed = true
    controller.abort()
  }
}

function handleEventFrame(
  frame: string,
  handlers: ExportJobSubscription,
  lastEventId: string | undefined,
  close: () => void
): string | undefined {
  const eventId = readSseField(frame, 'id') ?? lastEventId
  const event = readSseField(frame, 'event') ?? 'message'
  const data = readSseField(frame, 'data')
  if (!data) return eventId

  if (event === 'error') {
    const payload = JSON.parse(data) as { message?: string }
    handlers.onError(new Error(payload.message ?? 'Export status stream failed'))
    close()
    return eventId
  }

  if (event !== 'export' && event !== 'message') return eventId

  const job = normalizeExportJob(JSON.parse(data) as Record<string, unknown>)
  handlers.onUpdate(job)
  if (job.status === 'completed' || job.status === 'failed') {
    handlers.onDone(job)
    close()
  }
  return eventId
}

function readSseField(frame: string, field: string): string | undefined {
  const prefix = `${field}:`
  const values = frame
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trimStart())
  if (values.length === 0) return undefined
  return values.join('\n')
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, delayMs))
}

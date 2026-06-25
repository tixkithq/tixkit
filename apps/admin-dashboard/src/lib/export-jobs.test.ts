import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdminExportJob } from '@/lib/api'
import { subscribeToExportJob } from './export-jobs'

vi.mock('@/lib/api', () => ({
  getAdminApiAuthHeaders: vi.fn(async (headers: Record<string, string>) => ({
    ...headers,
    Authorization: 'Bearer test-token',
  })),
  getAdminApiBaseUrl: vi.fn(() => 'https://api.test'),
  normalizeExportJob: vi.fn((value: Record<string, unknown>) => ({
    exportId: String(value.exportId ?? value.export_id ?? value.id),
    eventId: value.eventId ?? value.event_id,
    type: value.type,
    format: value.format,
    status: value.status,
    fileUrl: value.fileUrl ?? value.file_url,
    downloadUrl: value.downloadUrl ?? value.download_url,
    createdAt: value.createdAt ?? value.created_at,
    completedAt: value.completedAt ?? value.completed_at,
  })),
}))

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  globalThis.fetch = originalFetch
})

describe('subscribeToExportJob', () => {
  it('delivers terminal export events and closes the stream', async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock.mockResolvedValueOnce(
      new Response(
        sseStream([
          {
            id: 'eev_completed',
            data: {
              exportId: 'exp_1',
              status: 'completed',
              type: 'sales',
              format: 'csv',
              downloadUrl: 'https://files.test/export.csv',
            },
          },
        ]),
        { status: 200 }
      )
    )

    const onUpdate = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    const unsubscribe = subscribeToExportJob('exp_1', { onUpdate, onDone, onError })

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ exportId: 'exp_1', status: 'completed' })
    )
    expect(onError).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    unsubscribe()
  })

  it('reconnects with Last-Event-ID after a dropped nonterminal stream', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.mocked(globalThis.fetch)
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          sseStream([
            {
              id: 'eev_processing',
              data: {
                exportId: 'exp_2',
                status: 'processing',
                type: 'attendees',
                format: 'csv',
              },
            },
          ]),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          sseStream([
            {
              id: 'eev_completed',
              data: {
                exportId: 'exp_2',
                status: 'completed',
                type: 'attendees',
                format: 'csv',
                downloadUrl: 'https://files.test/attendees.csv',
              },
            },
          ]),
          { status: 200 }
        )
      )

    const updates: AdminExportJob[] = []
    const onDone = vi.fn()
    const onError = vi.fn()
    const unsubscribe = subscribeToExportJob('exp_2', {
      onUpdate: (job) => updates.push(job),
      onDone,
      onError,
    })

    await vi.waitFor(() => expect(updates).toHaveLength(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(secondRequest.headers).toMatchObject({
      'Last-Event-ID': 'eev_processing',
      Accept: 'text/event-stream',
    })

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(updates.map((job) => job.status)).toEqual(['processing', 'completed'])
    expect(onError).not.toHaveBeenCalled()

    unsubscribe()
  })
})

function sseStream(
  frames: Array<{ id: string; data: Record<string, unknown>; event?: string }>
): ReadableStream<Uint8Array> {
  const body = frames
    .map(
      (frame) =>
        `id: ${frame.id}\nevent: ${frame.event ?? 'export'}\ndata: ${JSON.stringify(frame.data)}\n\n`
    )
    .join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
}

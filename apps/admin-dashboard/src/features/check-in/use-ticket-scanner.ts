'use client';

import * as React from 'react';
import { type CheckInScanResult, adminApi } from '@/lib/api';

export type UseTicketScannerOptions = {
  eventId: string;
  checkInListId: string;
  /**
   * When false, `scan` will no-op. Used to block scans while a check-in list
   * has not been selected or while scanning is otherwise disallowed.
   */
  enabled?: boolean;
};

export type UseTicketScannerResult = {
  scanning: boolean;
  lastResult: CheckInScanResult | null;
  scanError: string | null;
  acceptedScanCount: number;
  /**
   * Submits a QR payload to the scan endpoint. Returns the resolved
   * `CheckInScanResult`, or `null` when the scan was skipped (disabled, empty
   * payload, or a scan already in flight).
   */
  scan: (qrPayload: string) => Promise<CheckInScanResult | null>;
  /** Retries the exact payload from the most recent failed scan. */
  retryLastScan: () => Promise<CheckInScanResult | null>;
  /** Clears the last result and resets the accepted count. */
  reset: () => void;
};

/**
 * Shared scan state machine for the check-in scanner. Both the standalone
 * Check-in page and the per-event check-in view use this hook so that camera
 * and manual entry share a single submission path.
 */
export function useTicketScanner({
  eventId,
  checkInListId,
  enabled = true,
}: UseTicketScannerOptions): UseTicketScannerResult {
  const [scanning, setScanning] = React.useState(false);
  const [lastResult, setLastResult] = React.useState<CheckInScanResult | null>(null);
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [acceptedScanCount, setAcceptedScanCount] = React.useState(0);
  const contextKey = `${eventId.length}:${eventId}:${checkInListId}`;
  const [stateContextKey, setStateContextKey] = React.useState(contextKey);
  const contextKeyRef = React.useRef(contextKey);
  const generationRef = React.useRef(0);
  const nextOperationRef = React.useRef(0);
  const activeOperationRef = React.useRef<number | null>(null);
  const lastFailedPayloadRef = React.useRef<{
    contextKey: string;
    generation: number;
    payload: string;
  } | null>(null);

  if (contextKeyRef.current !== contextKey) {
    contextKeyRef.current = contextKey;
    generationRef.current += 1;
    activeOperationRef.current = null;
    lastFailedPayloadRef.current = null;
  }

  React.useEffect(() => {
    setStateContextKey(contextKey);
    setScanning(false);
    setLastResult(null);
    setScanError(null);
    setAcceptedScanCount(0);
  }, [contextKey]);

  const reset = React.useCallback(() => {
    generationRef.current += 1;
    activeOperationRef.current = null;
    setStateContextKey(contextKeyRef.current);
    setScanning(false);
    setLastResult(null);
    setScanError(null);
    setAcceptedScanCount(0);
    lastFailedPayloadRef.current = null;
  }, []);

  const executeScan = React.useCallback(
    async (
      qrPayload: string,
      options: { preserveErrorWhilePending?: boolean } = {},
    ): Promise<CheckInScanResult | null> => {
      const trimmed = qrPayload.trim();
      if (
        !enabled ||
        !eventId ||
        !checkInListId ||
        !trimmed ||
        activeOperationRef.current !== null
      ) {
        return null;
      }
      const generation = generationRef.current;
      const operationId = nextOperationRef.current + 1;
      nextOperationRef.current = operationId;
      activeOperationRef.current = operationId;
      setStateContextKey(contextKey);
      setScanning(true);
      setLastResult(null);
      if (!options.preserveErrorWhilePending) setScanError(null);
      try {
        const result = await adminApi.scanTicket({
          eventId,
          checkInListId,
          qrPayload: trimmed,
          scannedAt: new Date().toISOString(),
        });
        if (
          generationRef.current !== generation ||
          contextKeyRef.current !== contextKey ||
          activeOperationRef.current !== operationId
        ) {
          return null;
        }
        if (!result.ok) {
          throw new Error(result.error.message || 'Unable to reach the check-in service.');
        }
        const resolved = result.data;
        setLastResult(resolved);
        setScanError(null);
        lastFailedPayloadRef.current = null;
        if (resolved.status === 'accepted') {
          setAcceptedScanCount((count) => count + 1);
        }
        return resolved;
      } catch (error) {
        if (
          generationRef.current !== generation ||
          contextKeyRef.current !== contextKey ||
          activeOperationRef.current !== operationId
        ) {
          return null;
        }
        const message =
          error instanceof Error ? error.message : 'Unable to reach the check-in service.';
        lastFailedPayloadRef.current = { contextKey, generation, payload: trimmed };
        setScanError(message);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        if (activeOperationRef.current === operationId) {
          activeOperationRef.current = null;
          setScanning(false);
        }
      }
    },
    [checkInListId, contextKey, enabled, eventId],
  );

  const retryLastScan = React.useCallback(async (): Promise<CheckInScanResult | null> => {
    const failed = lastFailedPayloadRef.current;
    if (
      !failed ||
      failed.contextKey !== contextKeyRef.current ||
      failed.generation !== generationRef.current
    ) {
      return null;
    }
    return executeScan(failed.payload, { preserveErrorWhilePending: true });
  }, [executeScan]);

  const stateBelongsToCurrentContext = stateContextKey === contextKey;

  return {
    scanning: stateBelongsToCurrentContext ? scanning : false,
    lastResult: stateBelongsToCurrentContext ? lastResult : null,
    scanError: stateBelongsToCurrentContext ? scanError : null,
    acceptedScanCount: stateBelongsToCurrentContext ? acceptedScanCount : 0,
    scan: executeScan,
    retryLastScan,
    reset,
  };
}

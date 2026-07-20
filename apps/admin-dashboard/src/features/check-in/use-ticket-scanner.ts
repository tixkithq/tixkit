'use client';

import * as React from 'react';
import { type CheckInScanResult, adminApi } from '@/lib/api';
import {
  prepareBrowserOfflineCheckIn,
  type BrowserOfflineCheckInSession,
} from './browser-offline-checkin';

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
  offlineReady: boolean;
  offlinePreparing: boolean;
  offlineSyncing: boolean;
  offlineSyncError: string | null;
  pendingOfflineCount: number;
  /**
   * Submits a QR payload to the scan endpoint. Returns the resolved
   * `CheckInScanResult`, or `null` when the scan was skipped (disabled, empty
   * payload, or a scan already in flight).
   */
  scan: (qrPayload: string) => Promise<CheckInScanResult | null>;
  /** Retries the exact payload from the most recent failed scan. */
  retryLastScan: () => Promise<CheckInScanResult | null>;
  /** Reconciles all durable offline admissions with the live API. */
  syncPendingOffline: () => Promise<void>;
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
  const [offlineReady, setOfflineReady] = React.useState(false);
  const [offlinePreparing, setOfflinePreparing] = React.useState(false);
  const [offlineSyncing, setOfflineSyncing] = React.useState(false);
  const [offlineSyncError, setOfflineSyncError] = React.useState<string | null>(null);
  const [pendingOfflineCount, setPendingOfflineCount] = React.useState(0);
  const contextKey = `${eventId.length}:${eventId}:${checkInListId}`;
  const [stateContextKey, setStateContextKey] = React.useState(contextKey);
  const contextKeyRef = React.useRef(contextKey);
  const enabledRef = React.useRef(enabled);
  const generationRef = React.useRef(0);
  const nextOperationRef = React.useRef(0);
  const activeOperationRef = React.useRef<number | null>(null);
  const lastFailedPayloadRef = React.useRef<{
    contextKey: string;
    generation: number;
    payload: string;
  } | null>(null);
  const offlineSessionRef = React.useRef<BrowserOfflineCheckInSession | null>(null);
  const offlineSyncInFlightRef = React.useRef<{
    contextKey: string;
    session: BrowserOfflineCheckInSession;
  } | null>(null);

  if (contextKeyRef.current !== contextKey) {
    contextKeyRef.current = contextKey;
    generationRef.current += 1;
    activeOperationRef.current = null;
    lastFailedPayloadRef.current = null;
    offlineSyncInFlightRef.current = null;
  }
  if (enabledRef.current !== enabled) {
    enabledRef.current = enabled;
    generationRef.current += 1;
    activeOperationRef.current = null;
    lastFailedPayloadRef.current = null;
    offlineSyncInFlightRef.current = null;
  }

  React.useEffect(() => {
    setStateContextKey(contextKey);
    setScanning(false);
    setLastResult(null);
    setScanError(null);
    setAcceptedScanCount(0);
    setOfflineSyncing(false);
    setOfflineSyncError(null);
  }, [contextKey]);

  React.useEffect(() => {
    let cancelled = false;
    offlineSessionRef.current = null;
    offlineSyncInFlightRef.current = null;
    setOfflineReady(false);
    setOfflineSyncing(false);
    setOfflineSyncError(null);
    setPendingOfflineCount(0);
    if (!enabled || !eventId || !checkInListId) {
      setOfflinePreparing(false);
      return () => {
        cancelled = true;
      };
    }
    setOfflinePreparing(true);
    void prepareBrowserOfflineCheckIn({ eventId, checkInListId })
      .then(async (session) => {
        if (cancelled) return;
        offlineSessionRef.current = session;
        setOfflineReady(true);
        setPendingOfflineCount(await session.pendingCount());
      })
      .catch(() => {
        if (!cancelled) setOfflineReady(false);
      })
      .finally(() => {
        if (!cancelled) setOfflinePreparing(false);
      });
    return () => {
      cancelled = true;
      offlineSessionRef.current = null;
    };
  }, [checkInListId, enabled, eventId]);

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

  const syncPendingOffline = React.useCallback(async (): Promise<void> => {
    const session = offlineSessionRef.current;
    if (!session) return;
    const generation = generationRef.current;
    const expectedContextKey = contextKeyRef.current;
    const operation = { contextKey: expectedContextKey, session };
    if (offlineSyncInFlightRef.current) return;
    offlineSyncInFlightRef.current = operation;
    setOfflineSyncing(true);
    setOfflineSyncError(null);
    try {
      await session.sync();
      const pending = await session.pendingCount();
      if (
        generationRef.current === generation &&
        contextKeyRef.current === expectedContextKey &&
        offlineSessionRef.current === session
      ) {
        setPendingOfflineCount(pending);
      }
    } catch (error) {
      if (
        generationRef.current === generation &&
        contextKeyRef.current === expectedContextKey &&
        offlineSessionRef.current === session
      ) {
        setOfflineSyncError(
          error instanceof Error ? error.message : 'Offline scans could not be synchronized.',
        );
      }
    } finally {
      if (offlineSyncInFlightRef.current === operation) {
        offlineSyncInFlightRef.current = null;
      }
      if (
        generationRef.current === generation &&
        contextKeyRef.current === expectedContextKey &&
        offlineSessionRef.current === session
      ) {
        setOfflineSyncing(false);
      }
    }
  }, []);

  React.useEffect(() => {
    if (!offlineReady || pendingOfflineCount === 0) return;
    const retry = () => void syncPendingOffline();
    const initialRetry = window.setTimeout(retry, 1_000);
    const retryInterval = window.setInterval(retry, 15_000);
    window.addEventListener('online', retry);
    return () => {
      window.clearTimeout(initialRetry);
      window.clearInterval(retryInterval);
      window.removeEventListener('online', retry);
    };
  }, [offlineReady, pendingOfflineCount, syncPendingOffline]);

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
          const canUseOffline =
            result.error.code === 'network_error' ||
            result.error.code === 'timeout' ||
            (result.error.status ?? 0) >= 500 ||
            result.error.status === 408;
          const offlineSession = offlineSessionRef.current;
          if (canUseOffline && offlineSession) {
            const offlineResult = await offlineSession.scan(trimmed);
            if (
              generationRef.current !== generation ||
              contextKeyRef.current !== contextKey ||
              activeOperationRef.current !== operationId
            ) {
              return null;
            }
            setLastResult(offlineResult);
            setScanError(null);
            lastFailedPayloadRef.current = null;
            setPendingOfflineCount(await offlineSession.pendingCount());
            if (offlineResult.status === 'accepted') {
              setAcceptedScanCount((count) => count + 1);
            }
            return offlineResult;
          }
          throw new Error(result.error.message || 'Unable to reach the check-in service.');
        }
        const resolved = result.data;
        setLastResult(resolved);
        setScanError(null);
        lastFailedPayloadRef.current = null;
        if (resolved.status === 'accepted') {
          setAcceptedScanCount((count) => count + 1);
        }
        const offlineSession = offlineSessionRef.current;
        if (offlineSession) {
          void syncPendingOffline();
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
    [checkInListId, contextKey, enabled, eventId, syncPendingOffline],
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
    offlineReady: stateBelongsToCurrentContext ? offlineReady : false,
    offlinePreparing: stateBelongsToCurrentContext ? offlinePreparing : false,
    offlineSyncing: stateBelongsToCurrentContext ? offlineSyncing : false,
    offlineSyncError: stateBelongsToCurrentContext ? offlineSyncError : null,
    pendingOfflineCount: stateBelongsToCurrentContext ? pendingOfflineCount : 0,
    scan: executeScan,
    retryLastScan,
    syncPendingOffline,
    reset,
  };
}

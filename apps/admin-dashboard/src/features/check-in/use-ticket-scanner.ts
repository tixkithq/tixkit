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
  acceptedScanCount: number;
  /**
   * Submits a QR payload to the scan endpoint. Returns the resolved
   * `CheckInScanResult`, or `null` when the scan was skipped (disabled, empty
   * payload, or a scan already in flight).
   */
  scan: (qrPayload: string) => Promise<CheckInScanResult | null>;
  /** Clears the last result and resets the accepted count. */
  reset: () => void;
};

function invalidResult(message: string): CheckInScanResult {
  return {
    status: 'invalid',
    message,
    scannedAt: new Date().toISOString(),
  };
}

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
  const [acceptedScanCount, setAcceptedScanCount] = React.useState(0);
  const scanningRef = React.useRef(false);

  const reset = React.useCallback(() => {
    setLastResult(null);
    setAcceptedScanCount(0);
  }, []);

  const scan = React.useCallback(
    async (qrPayload: string): Promise<CheckInScanResult | null> => {
      const trimmed = qrPayload.trim();
      if (!enabled || !eventId || !checkInListId || !trimmed || scanningRef.current) {
        return null;
      }
      scanningRef.current = true;
      setScanning(true);
      try {
        const result = await adminApi.scanTicket({
          eventId,
          checkInListId,
          qrPayload: trimmed,
          scannedAt: new Date().toISOString(),
        });
        const resolved: CheckInScanResult = result.ok
          ? result.data
          : invalidResult(result.error.message);
        setLastResult(resolved);
        if (resolved.status === 'accepted') {
          setAcceptedScanCount((count) => count + 1);
        }
        return resolved;
      } catch (error) {
        const fallback = invalidResult(
          error instanceof Error ? error.message : 'Unable to scan this ticket.',
        );
        setLastResult(fallback);
        return fallback;
      } finally {
        scanningRef.current = false;
        setScanning(false);
      }
    },
    [enabled, eventId, checkInListId],
  );

  return { scanning, lastResult, acceptedScanCount, scan, reset };
}

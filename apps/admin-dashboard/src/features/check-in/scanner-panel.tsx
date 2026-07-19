'use client';

import * as React from 'react';
import { AlertTriangle, QrCode, Camera, Keyboard, RefreshCw } from 'lucide-react';
import { type CheckInScanResult } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isCameraSupported } from './camera-support';
import { ScanResult } from './scan-result';

export type ScannerPanelProps = {
  eventId: string;
  checkInListId: string;
  /** When set, scanning is blocked and the reason is shown instead of the panel. */
  scanBlockedReason?: string;
  scanning: boolean;
  lastResult: CheckInScanResult | null;
  scanError: string | null;
  onScan: (qrPayload: string) => Promise<CheckInScanResult | null>;
  onRetry: () => Promise<CheckInScanResult | null>;
};

type ScanMode = 'camera' | 'manual';

const CameraScanner = React.lazy(async () => {
  const module = await import('./camera-scanner');
  return { default: module.CameraScanner };
});

/**
 * Shared scan card with a Camera / Manual toggle. Both modes route through
 * `onScan`, so idempotency, result rendering, and the accepted-count live in
 * the parent's `useTicketScanner` hook.
 */
export function ScannerPanel({
  eventId,
  checkInListId,
  scanBlockedReason,
  scanning,
  lastResult,
  scanError,
  onScan,
  onRetry,
}: ScannerPanelProps) {
  const [mode, setMode] = React.useState<ScanMode>('manual');
  const [qrPayload, setQrPayload] = React.useState('');
  const [mounted, setMounted] = React.useState(false);
  const ticketInputId = React.useId();
  const scanStatusId = React.useId();

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    setQrPayload('');
  }, [eventId, checkInListId]);

  // Default to Camera when a camera is available; otherwise stay on Manual.
  React.useEffect(() => {
    if (mounted && mode === 'manual' && isCameraSupported()) {
      setMode('camera');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  const trimmedQrPayload = qrPayload.trim();
  const canScanManual = Boolean(trimmedQrPayload) && !scanBlockedReason && !scanning;

  const executeScan = React.useCallback(
    async (payload: string): Promise<CheckInScanResult | null> => {
      const exactPayload = payload.trim();
      if (!exactPayload) return null;
      try {
        return await onScan(exactPayload);
      } catch {
        return null;
      }
    },
    [onScan],
  );

  const handleManualSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canScanManual) return;
    const result = await executeScan(trimmedQrPayload);
    if (result) setQrPayload('');
  };

  const handleRetry = async () => {
    if (scanning) return;
    const result = await onRetry().catch(() => null);
    if (result) setQrPayload('');
  };

  if (scanBlockedReason) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <QrCode className="size-5" />
            Scan Ticket
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p id={scanStatusId} className="text-sm text-muted-foreground">
            {scanBlockedReason}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <QrCode className="size-5" />
          Scan Ticket
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={mode} onValueChange={(value) => setMode(value as ScanMode)}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="camera" disabled={!mounted || !isCameraSupported()}>
              <Camera className="size-4" />
              Camera
            </TabsTrigger>
            <TabsTrigger value="manual">
              <Keyboard className="size-4" />
              Manual
            </TabsTrigger>
          </TabsList>

          <TabsContent value="camera" className="mt-4">
            {/* Only mount the camera when the tab is active so the stream is
            released immediately when switching to Manual. */}
            {mode === 'camera' && (
              <React.Suspense
                fallback={
                  <div
                    className="relative w-full overflow-hidden rounded-lg border bg-black aspect-[4/3]"
                    aria-label="Loading camera scanner"
                  />
                }
              >
                <CameraScanner onScan={executeScan} disabled={scanning} />
              </React.Suspense>
            )}
          </TabsContent>

          <TabsContent value="manual" className="mt-4">
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                void handleManualSubmit(event);
              }}
            >
              <Label htmlFor={ticketInputId} className="sr-only">
                Ticket QR or ID
              </Label>
              <Input
                id={ticketInputId}
                autoComplete="off"
                inputMode="text"
                aria-describedby={scanError ? scanStatusId : undefined}
                disabled={scanning}
                placeholder="Enter QR code or ticket ID"
                value={qrPayload}
                onChange={(event) => setQrPayload(event.target.value)}
              />
              <Button type="submit" disabled={!canScanManual} aria-busy={scanning}>
                {scanning ? 'Scanning...' : 'Scan'}
              </Button>
            </form>
          </TabsContent>
        </Tabs>

        {scanError ? (
          <div
            id={scanStatusId}
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
            aria-busy={scanning}
            className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-amber-800 sm:flex-row sm:items-center sm:justify-between dark:text-amber-300"
          >
            <span className="flex items-start gap-2 text-sm">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                <span className="block font-medium">Scan not submitted</span>
                <span className="block">{scanError} The ticket result is still unknown.</span>
              </span>
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={scanning}
              onClick={() => void handleRetry()}
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {scanning ? 'Retrying…' : 'Retry scan'}
            </Button>
          </div>
        ) : null}

        {!scanning && !scanError && lastResult ? <ScanResult result={lastResult} /> : null}
      </CardContent>
    </Card>
  );
}

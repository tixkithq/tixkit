'use client';

import * as React from 'react';
import { QrCode, Camera, Keyboard } from 'lucide-react';
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
  onScan: (qrPayload: string) => Promise<CheckInScanResult | null>;
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
  eventId: _eventId,
  checkInListId: _checkInListId,
  scanBlockedReason,
  scanning,
  lastResult,
  onScan,
}: ScannerPanelProps) {
  const [mode, setMode] = React.useState<ScanMode>('manual');
  const [qrPayload, setQrPayload] = React.useState('');
  const [mounted, setMounted] = React.useState(false);
  const ticketInputId = React.useId();
  const scanStatusId = React.useId();

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Default to Camera when a camera is available; otherwise stay on Manual.
  React.useEffect(() => {
    if (mounted && mode === 'manual' && isCameraSupported()) {
      setMode('camera');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  const trimmedQrPayload = qrPayload.trim();
  const canScanManual = Boolean(trimmedQrPayload) && !scanBlockedReason && !scanning;

  const handleManualSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canScanManual) return;
    const result = await onScan(trimmedQrPayload);
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
                <CameraScanner onScan={onScan} disabled={scanning} />
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
                aria-describedby={scanStatusId}
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

        {lastResult && <ScanResult result={lastResult} />}
      </CardContent>
    </Card>
  );
}

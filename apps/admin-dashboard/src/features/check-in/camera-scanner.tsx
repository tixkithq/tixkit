'use client';

import * as React from 'react';
import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import type { Result } from '@zxing/library';
import { Camera, CameraOff, Loader2, ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CheckInScanResult } from '@/lib/api';
import { isCameraSupported } from './camera-support';

export type CameraScannerProps = {
  /**
   * Invoked with each freshly decoded QR payload. The scanner pauses for
   * `cooldownMs` after a successful decode so the same code is not re-scanned
   * while the attendee holds their phone in view.
   */
  onScan: (qrPayload: string) => Promise<CheckInScanResult | null>;
  /** Ignore decodes while true (e.g. a manual scan is in flight). */
  disabled?: boolean;
  /** Cooldown after each accepted decode, in milliseconds. */
  cooldownMs?: number;
};

type CameraStatus =
  | 'idle'
  | 'starting'
  | 'scanning'
  | 'paused'
  | 'backgrounded'
  | 'denied'
  | 'unsupported'
  | 'error';

const COOLDOWN_DEFAULT_MS = 1500;

/**
 * Live camera QR scanner built on @zxing/browser. Starts after an explicit user
 * action, releases the stream on unmount, and degrades to a
 * graceful fallback message when the browser lacks camera support or the user
 * denies permission.
 */
export function CameraScanner({
  onScan,
  disabled = false,
  cooldownMs = COOLDOWN_DEFAULT_MS,
}: CameraScannerProps) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const controlsRef = React.useRef<IScannerControls | null>(null);
  const lastScanRef = React.useRef<{ payload: string; at: number } | null>(null);
  const disabledRef = React.useRef(disabled);
  const onScanRef = React.useRef(onScan);
  const resumeEligibleRef = React.useRef(false);
  const mountedRef = React.useRef(true);
  const attemptGenerationRef = React.useRef(0);
  const pendingAttemptRef = React.useRef<number | undefined>(undefined);
  const pageActiveRef = React.useRef(
    typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  const [status, setStatus] = React.useState<CameraStatus>(() =>
    isCameraSupported() ? 'idle' : 'unsupported',
  );
  const [cameraEnabled, setCameraEnabled] = React.useState(false);
  const [pageActive, setPageActive] = React.useState(pageActiveRef.current);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [retryNonce, setRetryNonce] = React.useState(0);

  React.useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);

  React.useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    const pauseForBackground = () => {
      pageActiveRef.current = false;
      controlsRef.current?.stop();
      controlsRef.current = null;
      setPageActive(false);
    };
    const resumeFromBackground = () => {
      const active = document.visibilityState !== 'hidden';
      pageActiveRef.current = active;
      setPageActive(active);
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') pauseForBackground();
      else resumeFromBackground();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', pauseForBackground);
    window.addEventListener('pageshow', resumeFromBackground);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', pauseForBackground);
      window.removeEventListener('pageshow', resumeFromBackground);
    };
  }, []);

  React.useEffect(() => {
    if (!isCameraSupported()) {
      setStatus('unsupported');
      return;
    }
    if (!cameraEnabled) {
      setStatus('idle');
      return;
    }
    if (!resumeEligibleRef.current) return;
    if (!pageActive) {
      setStatus('backgrounded');
      return;
    }
    if (pendingAttemptRef.current !== undefined) return;

    let cancelled = false;
    let controls: IScannerControls | null = null;
    const attemptGeneration = ++attemptGenerationRef.current;
    pendingAttemptRef.current = attemptGeneration;
    setStatus('starting');
    setErrorMessage(null);

    const reader = new BrowserQRCodeReader();
    const video = videoRef.current;

    void reader
      .decodeFromConstraints(
        {
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        },
        video ?? undefined,
        (result: Result | undefined) => {
          if (cancelled || !pageActiveRef.current || disabledRef.current || !result) return;
          const payload = result.getText();
          if (!payload.trim()) return;
          const now = Date.now();
          const last = lastScanRef.current;
          if (last && last.payload === payload && now - last.at < cooldownMs) return;
          lastScanRef.current = { payload, at: now };
          setStatus('paused');
          void onScanRef.current(payload).finally(() => {
            if (!cancelled && pageActiveRef.current) setStatus('scanning');
          });
        },
      )
      .then((resolvedControls) => {
        if (pendingAttemptRef.current === attemptGeneration) {
          pendingAttemptRef.current = undefined;
        }
        if (cancelled) {
          resolvedControls.stop();
          if (mountedRef.current && pageActiveRef.current && resumeEligibleRef.current) {
            setRetryNonce((current) => current + 1);
          }
          return;
        }
        controls = resolvedControls;
        controlsRef.current = resolvedControls;
        setStatus('scanning');
      })
      .catch((error: unknown) => {
        if (attemptGenerationRef.current !== attemptGeneration) return;
        if (pendingAttemptRef.current === attemptGeneration) {
          pendingAttemptRef.current = undefined;
        }
        if (!mountedRef.current) return;
        resumeEligibleRef.current = false;
        classifyCameraError(error, { setStatus, setErrorMessage });
      });

    return () => {
      cancelled = true;
      controls?.stop();
      controlsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraEnabled, cooldownMs, pageActive, retryNonce]);

  const handleEnable = React.useCallback(() => {
    resumeEligibleRef.current = true;
    setStatus('starting');
    setCameraEnabled(true);
  }, []);

  const handleRetry = React.useCallback(() => {
    resumeEligibleRef.current = true;
    setStatus('starting');
    setCameraEnabled(true);
    setRetryNonce((n) => n + 1);
  }, []);

  if (status === 'idle') {
    return (
      <CameraFallback
        icon={ScanLine}
        title="Ready to scan"
        description="Camera access starts only after you choose Enable camera. Your browser may ask for permission."
        actionLabel="Enable camera"
        onRetry={handleEnable}
      />
    );
  }

  if (status === 'unsupported') {
    return (
      <CameraFallback
        icon={CameraOff}
        title="Camera not available"
        description="This browser does not expose a usable camera, or the page is not served over HTTPS. Switch to Manual entry to type the ticket ID."
      />
    );
  }

  if (status === 'denied') {
    return (
      <CameraFallback
        icon={CameraOff}
        title="Camera permission denied"
        description="Enable camera access in your browser settings, then retry or switch to Manual entry."
        onRetry={handleRetry}
      />
    );
  }

  if (status === 'error') {
    return (
      <CameraFallback
        icon={CameraOff}
        title="Camera error"
        description={errorMessage ?? 'Unable to start the camera.'}
        onRetry={handleRetry}
      />
    );
  }

  const showOverlay = status === 'starting' || status === 'paused' || status === 'backgrounded';

  return (
    <div
      className="relative w-full overflow-hidden rounded-lg border bg-black aspect-[4/3]"
      data-testid="camera-viewport"
      data-camera-status={status}
    >
      <video
        ref={videoRef}
        className="size-full object-cover"
        muted
        playsInline
        autoPlay
        data-testid="camera-video"
      />
      {/* Reticle */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div className="h-2/3 w-2/3 max-w-[260px] rounded-xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
      </div>
      <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white">
        <ScanLine className="size-3.5" />
        {status === 'starting'
          ? 'Starting camera…'
          : status === 'paused'
            ? 'Processing…'
            : status === 'backgrounded'
              ? 'Camera paused in background…'
              : 'Point at a QR code'}
      </div>
      {showOverlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <Loader2 className="size-8 animate-spin text-white" aria-label="Loading" />
        </div>
      )}
    </div>
  );
}

function CameraFallback({
  icon: Icon,
  title,
  description,
  onRetry,
  actionLabel = 'Retry camera',
}: {
  icon: typeof CameraOff;
  title: string;
  description: string;
  onRetry?: () => void;
  actionLabel?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center"
      data-testid="camera-fallback"
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-1 gap-1.5">
          <Camera className="size-3.5" />
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

function classifyCameraError(
  error: unknown,
  handlers: {
    setStatus: (status: CameraStatus) => void;
    setErrorMessage: (message: string | null) => void;
  },
): void {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    handlers.setStatus('denied');
    return;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    handlers.setStatus('unsupported');
    handlers.setErrorMessage('No camera device was found on this device.');
    return;
  }
  if (name === 'NotReadableError') {
    handlers.setStatus('error');
    handlers.setErrorMessage('The camera is in use by another application.');
    return;
  }
  handlers.setStatus('error');
  handlers.setErrorMessage(error instanceof Error ? error.message : 'Unable to start camera.');
}

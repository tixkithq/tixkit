import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckInScanResult } from '@/lib/api';
import { CameraScanner } from './camera-scanner';
import { isCameraSupported } from './camera-support';

// --- Mock @zxing/browser ---
// The mock reader captures the continuous decode callback so tests can fire
// synthetic QR detections.
type DecodeCallback = (
  result: { getText(): string } | undefined,
  error: unknown,
  controls: { stop(): void },
) => void;

let mockDecodeCallback: DecodeCallback | null = null;
let mockStopFn: ReturnType<typeof vi.fn>;
let mockDecodeFromConstraints: ReturnType<typeof vi.fn>;

vi.mock('@zxing/browser', () => {
  return {
    BrowserQRCodeReader: class MockBrowserQRCodeReader {
      decodeFromConstraints = mockDecodeFromConstraints;
    },
  };
});

// --- Helpers ---

function installMediaDevices() {
  const stop = vi.fn();
  const track = { stop };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi.fn().mockResolvedValue([]),
    },
    writable: true,
    configurable: true,
  });
  // jsdom defaults isSecureContext to true, but ensure it.
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'isSecureContext', {
      value: true,
      writable: true,
      configurable: true,
    });
  }
}

function removeMediaDevices() {
  // @ts-expect-error -- deleting for test isolation
  delete navigator.mediaDevices;
}

function fireDecode(payload: string) {
  act(() => {
    mockDecodeCallback?.({ getText: () => payload }, undefined, { stop: vi.fn() });
  });
}

async function enableCamera() {
  fireEvent.click(await screen.findByRole('button', { name: 'Enable camera' }));
  return screen.findByTestId('camera-viewport');
}

function makeAcceptedResult(): CheckInScanResult {
  return {
    status: 'accepted',
    message: 'Check-in successful',
    scannedAt: '2026-07-05T12:00:00.000Z',
  };
}

// --- Tests ---

beforeEach(() => {
  mockStopFn = vi.fn();
  mockDecodeCallback = null;
  mockDecodeFromConstraints = vi.fn((_constraints, _video, callback: DecodeCallback) => {
    mockDecodeCallback = callback;
    return Promise.resolve({ stop: mockStopFn });
  });
  installMediaDevices();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeMediaDevices();
});

describe('isCameraSupported', () => {
  it('returns false when navigator.mediaDevices is undefined', () => {
    removeMediaDevices();
    expect(isCameraSupported()).toBe(false);
  });

  it('returns true when getUserMedia is available and context is secure', () => {
    installMediaDevices();
    expect(isCameraSupported()).toBe(true);
  });

  it('returns false in insecure context (http)', () => {
    installMediaDevices();
    Object.defineProperty(window, 'isSecureContext', {
      value: false,
      writable: true,
      configurable: true,
    });
    expect(isCameraSupported()).toBe(false);
  });
});

describe('CameraScanner', () => {
  it('renders the unsupported fallback when no camera is available', async () => {
    removeMediaDevices();
    render(<CameraScanner onScan={vi.fn()} />);
    expect(await screen.findByTestId('camera-fallback')).toBeInTheDocument();
    expect(screen.getByText('Camera not available')).toBeInTheDocument();
  });

  it('starts after an explicit action and prefers the rear camera', async () => {
    render(<CameraScanner onScan={vi.fn()} />);
    expect(await screen.findByText('Ready to scan')).toBeInTheDocument();
    expect(mockDecodeFromConstraints).not.toHaveBeenCalled();
    await enableCamera();
    expect(screen.getByTestId('camera-video')).toBeInTheDocument();
    expect(mockDecodeFromConstraints).toHaveBeenCalledWith(
      { audio: false, video: { facingMode: { ideal: 'environment' } } },
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('calls onScan with the decoded QR payload', async () => {
    const onScan = vi.fn().mockResolvedValue(makeAcceptedResult());
    render(
      <CameraScanner
        onScan={onScan as unknown as (p: string) => Promise<CheckInScanResult | null>}
      />,
    );
    await enableCamera();
    fireDecode('tkt_demo_001');
    expect(onScan).toHaveBeenCalledWith('tkt_demo_001');
  });

  it('ignores empty QR payloads', async () => {
    const onScan = vi.fn().mockResolvedValue(makeAcceptedResult());
    render(
      <CameraScanner
        onScan={onScan as unknown as (p: string) => Promise<CheckInScanResult | null>}
      />,
    );
    await enableCamera();
    fireDecode('   ');
    fireDecode('');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('applies cooldown so the same QR is not re-scanned immediately', async () => {
    let currentTime = 1_000_000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    const onScan = vi.fn().mockResolvedValue(makeAcceptedResult());
    render(
      <CameraScanner
        onScan={onScan as unknown as (p: string) => Promise<CheckInScanResult | null>}
        cooldownMs={2000}
      />,
    );
    await enableCamera();
    fireDecode('tkt_cooldown');
    expect(onScan).toHaveBeenCalledTimes(1);
    // Same payload, same time -> within cooldown -> ignored
    fireDecode('tkt_cooldown');
    expect(onScan).toHaveBeenCalledTimes(1);
    // Advance past cooldown
    currentTime += 2100;
    fireDecode('tkt_cooldown');
    expect(onScan).toHaveBeenCalledTimes(2);
    dateSpy.mockRestore();
  });

  it('allows a different QR to be scanned without waiting for cooldown', async () => {
    const onScan = vi.fn().mockResolvedValue(makeAcceptedResult());
    render(
      <CameraScanner
        onScan={onScan as unknown as (p: string) => Promise<CheckInScanResult | null>}
      />,
    );
    await enableCamera();
    fireDecode('tkt_a');
    fireDecode('tkt_b');
    expect(onScan).toHaveBeenCalledWith('tkt_a');
    expect(onScan).toHaveBeenCalledWith('tkt_b');
  });

  it('ignores decodes while disabled (scan in flight)', async () => {
    const onScan = vi.fn().mockResolvedValue(makeAcceptedResult());
    const { rerender } = render(
      <CameraScanner
        onScan={onScan as unknown as (p: string) => Promise<CheckInScanResult | null>}
        disabled={false}
      />,
    );
    await enableCamera();
    rerender(
      <CameraScanner
        onScan={onScan as unknown as (p: string) => Promise<CheckInScanResult | null>}
        disabled
      />,
    );
    fireDecode('tkt_while_disabled');
    expect(onScan).not.toHaveBeenCalled();
  });

  it('stops the camera stream on unmount', async () => {
    const { unmount } = render(<CameraScanner onScan={vi.fn()} />);
    await enableCamera();
    unmount();
    expect(mockStopFn).toHaveBeenCalled();
  });

  it('releases the camera while backgrounded and reacquires it on visibility resume', async () => {
    const onScan = vi.fn().mockResolvedValue(makeAcceptedResult());
    render(<CameraScanner onScan={onScan} />);
    const viewport = await enableCamera();
    await waitFor(() => expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(mockStopFn).toHaveBeenCalled();
    expect(viewport).toHaveAttribute('data-camera-status', 'backgrounded');
    expect(screen.getByText('Camera paused in background…')).toBeVisible();
    fireDecode('tkt_backgrounded');
    expect(onScan).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(viewport).toHaveAttribute('data-camera-status', 'scanning'));
  });

  it('releases the camera on pagehide and restarts it on pageshow', async () => {
    render(<CameraScanner onScan={vi.fn()} />);
    await enableCamera();
    await waitFor(() => expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(1));

    act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    expect(mockStopFn).toHaveBeenCalled();
    act(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
    await waitFor(() => expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(2));
  });

  it('does not reacquire on pageshow while the document remains hidden', async () => {
    render(<CameraScanner onScan={vi.fn()} />);
    await enableCamera();
    await waitFor(() => expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(1));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });

    act(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    act(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
    expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(2));
  });

  it('shows the denied permission fallback when getUserMedia is blocked', async () => {
    mockDecodeFromConstraints = vi.fn(() =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    );
    render(<CameraScanner onScan={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable camera' }));
    expect(await screen.findByText('Camera permission denied')).toBeInTheDocument();
    expect(screen.getByTestId('camera-fallback')).toBeInTheDocument();
  });

  it('keeps a denied camera terminal until the user explicitly retries', async () => {
    mockDecodeFromConstraints = vi.fn(() =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    );
    render(<CameraScanner onScan={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable camera' }));
    expect(await screen.findByText('Camera permission denied')).toBeInTheDocument();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Camera permission denied')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry camera' }));
    await waitFor(() => expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(2));
  });

  it('keeps a deferred denial terminal when it arrives after background cancellation', async () => {
    let rejectStartup!: (error: unknown) => void;
    mockDecodeFromConstraints = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectStartup = reject;
        }),
    );
    render(<CameraScanner onScan={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable camera' }));
    await waitFor(() => expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(1));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => {
      rejectStartup(new DOMException('Permission denied', 'NotAllowedError'));
      await Promise.resolve();
    });
    expect(await screen.findByText('Camera permission denied')).toBeVisible();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Camera permission denied')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Retry camera' }));
    await waitFor(() => expect(mockDecodeFromConstraints).toHaveBeenCalledTimes(2));
  });

  it('shows the unsupported fallback when no camera device is found', async () => {
    mockDecodeFromConstraints = vi.fn(() =>
      Promise.reject(new DOMException('Not found', 'NotFoundError')),
    );
    render(<CameraScanner onScan={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable camera' }));
    expect(await screen.findByTestId('camera-fallback')).toBeInTheDocument();
    expect(screen.getByText('Camera not available')).toBeInTheDocument();
  });

  it('shows a generic error fallback with a retry button', async () => {
    mockDecodeFromConstraints = vi.fn(() => Promise.reject(new Error('Something broke')));
    render(<CameraScanner onScan={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable camera' }));
    expect(await screen.findByText('Camera error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry camera' })).toBeInTheDocument();
  });

  it('retry button re-initialises the scanner after an error', async () => {
    let shouldFail = true;
    mockDecodeFromConstraints = vi.fn((_a: unknown, _b: unknown, cb: DecodeCallback) => {
      if (shouldFail) return Promise.reject(new Error('boom'));
      mockDecodeCallback = cb;
      return Promise.resolve({ stop: vi.fn() });
    });
    render(<CameraScanner onScan={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable camera' }));
    expect(await screen.findByText('Camera error')).toBeInTheDocument();
    shouldFail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry camera' }));
    expect(await screen.findByTestId('camera-viewport')).toBeInTheDocument();
  });
});

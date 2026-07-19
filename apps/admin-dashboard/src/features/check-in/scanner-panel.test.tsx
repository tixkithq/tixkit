import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckInScanResult } from '@/lib/api';
import { ScannerPanel } from './scanner-panel';

// --- Mock @zxing/browser so CameraScanner can render in jsdom ---
type DecodeCallback = (
  result: { getText(): string } | undefined,
  error: unknown,
  controls: { stop(): void },
) => void;

vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: class MockBrowserQRCodeReader {
    decodeFromConstraints = vi.fn((_a: unknown, _b: unknown, _cb: DecodeCallback) =>
      Promise.resolve({ stop: vi.fn() }),
    );
  },
}));

// --- Helpers ---

const CAMERA_LAZY_LOAD_TIMEOUT_MS = 4_000;

function findCameraReady() {
  return screen.findByText('Ready to scan', {}, { timeout: CAMERA_LAZY_LOAD_TIMEOUT_MS });
}

function installMediaDevices() {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
      enumerateDevices: vi.fn().mockResolvedValue([]),
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, 'isSecureContext', {
    value: true,
    writable: true,
    configurable: true,
  });
}

function removeMediaDevices() {
  // @ts-expect-error -- deleting for test isolation
  delete navigator.mediaDevices;
}

function makeAcceptedResult(): CheckInScanResult {
  return {
    status: 'accepted',
    message: 'Check-in successful',
    scannedAt: '2026-07-05T12:00:00.000Z',
  };
}

function makeInvalidResult(): CheckInScanResult {
  return {
    status: 'invalid',
    message: 'No matching ticket found.',
    scannedAt: '2026-07-05T12:00:00.000Z',
  };
}

const defaultProps = () => ({
  eventId: 'evt_1',
  checkInListId: 'cil_1',
  scanning: false,
  lastResult: null as CheckInScanResult | null,
  scanError: null as string | null,
  scanBlockedReason: undefined as string | undefined,
  onScan: vi.fn().mockResolvedValue(makeAcceptedResult()) as unknown as (
    payload: string,
  ) => Promise<CheckInScanResult | null>,
  onRetry: vi
    .fn()
    .mockResolvedValue(makeAcceptedResult()) as unknown as () => Promise<CheckInScanResult | null>,
});

beforeEach(() => {
  // jsdom default: no camera support
  removeMediaDevices();
});

afterEach(() => {
  vi.restoreAllMocks();
  removeMediaDevices();
});

describe('ScannerPanel', () => {
  it('renders the Camera and Manual toggle tabs', () => {
    const props = defaultProps();
    render(<ScannerPanel {...props} />);
    expect(screen.getByRole('tab', { name: /camera/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /manual/i })).toBeInTheDocument();
  });

  it('defaults to Manual mode when camera is not supported', () => {
    const props = defaultProps();
    render(<ScannerPanel {...props} />);
    // Manual input should be visible
    expect(screen.getByPlaceholderText('Enter QR code or ticket ID')).toBeInTheDocument();
  });

  it('disables the Camera tab when camera is not supported', () => {
    const props = defaultProps();
    render(<ScannerPanel {...props} />);
    const cameraTab = screen.getByRole('tab', { name: /camera/i });
    expect(cameraTab).toBeDisabled();
  });

  it('submits the trimmed payload via onScan when the Scan button is clicked', async () => {
    const props = defaultProps();
    render(<ScannerPanel {...props} />);
    const input = screen.getByPlaceholderText('Enter QR code or ticket ID');
    fireEvent.change(input, { target: { value: '  tkt_123  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    await waitFor(() => {
      expect(props.onScan).toHaveBeenCalledWith('tkt_123');
    });
  });

  it('submits on Enter key press in the input', async () => {
    const props = defaultProps();
    render(<ScannerPanel {...props} />);
    const input = screen.getByPlaceholderText('Enter QR code or ticket ID');
    fireEvent.change(input, { target: { value: 'tkt_enter' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => {
      expect(props.onScan).toHaveBeenCalledWith('tkt_enter');
    });
  });

  it('clears the input after a successful scan', async () => {
    const props = defaultProps();
    render(<ScannerPanel {...props} />);
    const input = screen.getByPlaceholderText('Enter QR code or ticket ID') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'tkt_clear' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    await waitFor(() => {
      expect(input.value).toBe('');
    });
  });

  it('retains the payload and announces a retryable transport failure', async () => {
    const props = defaultProps();
    props.onScan = vi.fn().mockRejectedValue(new Error('Network unavailable'));
    const view = render(<ScannerPanel {...props} />);
    const input = screen.getByPlaceholderText('Enter QR code or ticket ID') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  tkt_retry  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    await waitFor(() => expect(props.onScan).toHaveBeenCalledTimes(1));
    view.rerender(<ScannerPanel {...props} scanError="Network unavailable" />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveTextContent('Network unavailable');
    expect(alert).toHaveTextContent('The ticket result is still unknown.');
    expect(input.value).toBe('  tkt_retry  ');
    expect(screen.queryByText('invalid')).not.toBeInTheDocument();
  });

  it('keeps the focused retry alert mounted and busy until recovery completes', async () => {
    const props = defaultProps();
    let resolveRetry!: (result: CheckInScanResult) => void;
    const pendingRetry = new Promise<CheckInScanResult>((resolve) => {
      resolveRetry = resolve;
    });
    props.onScan = vi.fn().mockRejectedValueOnce(new Error('Network unavailable'));
    props.onRetry = vi.fn(() => pendingRetry);
    const view = render(<ScannerPanel {...props} />);
    const input = screen.getByPlaceholderText('Enter QR code or ticket ID') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  tkt_retry_exact  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    await waitFor(() => expect(props.onScan).toHaveBeenCalledTimes(1));
    view.rerender(<ScannerPanel {...props} scanError="Network unavailable" />);

    const retry = screen.getByRole('button', { name: 'Retry scan' });
    retry.focus();
    expect(retry).toHaveFocus();
    fireEvent.click(retry);

    await waitFor(() => expect(props.onRetry).toHaveBeenCalledTimes(1));
    expect(props.onScan).toHaveBeenNthCalledWith(1, 'tkt_retry_exact');
    props.scanning = true;
    props.scanError = 'Network unavailable';
    view.rerender(<ScannerPanel {...props} />);

    const pendingButton = screen.getByRole('button', { name: 'Retrying…' });
    expect(pendingButton).toBe(retry);
    expect(pendingButton).toHaveFocus();
    expect(pendingButton).toBeDisabled();
    const pendingAlert = screen.getByRole('alert');
    expect(pendingAlert).toHaveAttribute('aria-live', 'assertive');
    expect(pendingAlert).toHaveAttribute('aria-busy', 'true');
    expect(pendingAlert).toHaveTextContent('Network unavailable');

    await act(async () => {
      resolveRetry(makeAcceptedResult());
      await pendingRetry;
    });
    await waitFor(() => expect(input.value).toBe(''));
    props.scanning = false;
    props.scanError = null;
    view.rerender(<ScannerPanel {...props} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears manual input when the event or check-in list changes', () => {
    const props = defaultProps();
    const view = render(<ScannerPanel {...props} />);
    const input = screen.getByPlaceholderText('Enter QR code or ticket ID') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'tkt_old_context' } });

    view.rerender(<ScannerPanel {...props} checkInListId="cil_2" />);

    expect(input.value).toBe('');
  });

  it('hides a prior ticket result while the current outcome is unknown', () => {
    const props = defaultProps();
    props.lastResult = makeAcceptedResult();
    props.scanError = 'Network unavailable';
    render(<ScannerPanel {...props} />);

    expect(screen.getByRole('alert')).toHaveTextContent('result is still unknown');
    expect(screen.queryByText('accepted')).not.toBeInTheDocument();
  });

  it('disables the Scan button when the input is empty', () => {
    const props = defaultProps();
    render(<ScannerPanel {...props} />);
    expect(screen.getByRole('button', { name: 'Scan' })).toBeDisabled();
  });

  it('disables the Scan button while scanning is in flight', () => {
    const props = defaultProps();
    props.scanning = true;
    render(<ScannerPanel {...props} />);
    const input = screen.getByPlaceholderText('Enter QR code or ticket ID');
    fireEvent.change(input, { target: { value: 'tkt_busy' } });
    expect(screen.getByRole('button', { name: 'Scanning...' })).toBeDisabled();
  });

  it('renders the ScanResult when lastResult is provided', () => {
    const props = defaultProps();
    props.lastResult = makeAcceptedResult();
    render(<ScannerPanel {...props} />);
    expect(screen.getByText('accepted')).toBeInTheDocument();
  });

  it('renders an invalid scan result message', () => {
    const props = defaultProps();
    props.lastResult = makeInvalidResult();
    render(<ScannerPanel {...props} />);
    expect(screen.getByText('invalid')).toBeInTheDocument();
    expect(screen.getByText('No matching ticket found.')).toBeInTheDocument();
  });

  it('shows the blocked reason instead of the toggle when scanBlockedReason is set', () => {
    const props = defaultProps();
    props.scanBlockedReason = 'Choose a check-in list before scanning.';
    render(<ScannerPanel {...props} />);
    expect(screen.getByText('Choose a check-in list before scanning.')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /camera/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Enter QR code or ticket ID')).not.toBeInTheDocument();
  });
});

describe('ScannerPanel camera mode', () => {
  beforeEach(() => {
    installMediaDevices();
  });

  it('defaults to Camera mode without requesting permission automatically', async () => {
    const props = defaultProps();
    render(<ScannerPanel {...props} />);
    expect(await findCameraReady()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable camera' })).toBeInTheDocument();
  });

  it('switches to Manual mode when the Manual tab is clicked', async () => {
    const props = defaultProps();
    render(<ScannerPanel {...props} />);
    expect(await findCameraReady()).toBeInTheDocument();
    // Radix Tabs activates on mouseDown, not click.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /manual/i }));
    expect(await screen.findByPlaceholderText('Enter QR code or ticket ID')).toBeInTheDocument();
  });

  it('renders the camera even while a scan is in flight', async () => {
    const props = defaultProps();
    props.scanning = true;
    render(<ScannerPanel {...props} />);
    await findCameraReady();
    fireEvent.click(screen.getByRole('button', { name: 'Enable camera' }));
    expect(await screen.findByTestId('camera-viewport')).toBeInTheDocument();
  });
});

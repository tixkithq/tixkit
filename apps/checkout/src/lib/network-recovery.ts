/**
 * Offline / slow-network recovery helpers for hosted checkout.
 * Distinguishes transport failure from authoritative API rejection and
 * provides generation tokens so late responses cannot overwrite newer state.
 */

export type ConnectivityStatus = 'online' | 'offline' | 'unknown';

export function readConnectivityStatus(online?: boolean | null): ConnectivityStatus {
  const value =
    online === undefined
      ? typeof navigator !== 'undefined'
        ? navigator.onLine
        : undefined
      : online;
  if (value === true) return 'online';
  if (value === false) return 'offline';
  return 'unknown';
}

export function isTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  const status = 'status' in error ? Number((error as { status?: unknown }).status) : NaN;
  if (code === 'NETWORK_ERROR' || code === 'SERVICE_UNAVAILABLE') return true;
  if (status === 0) return true;
  if (Number.isFinite(status) && status >= 500) return true;
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return false;
}

export function transportFailureMessage(status: ConnectivityStatus): string {
  if (status === 'offline') {
    return 'You appear to be offline. Your details are still here. Reconnect, then retry.';
  }
  return 'We could not reach checkout. Your details are still here. Check your connection and retry.';
}

/**
 * Monotonic request generation guard. Callers bump generation before each
 * attempt and ignore responses whose generation no longer matches.
 */
export class RequestGeneration {
  private value = 0;

  next(): number {
    this.value += 1;
    return this.value;
  }

  current(): number {
    return this.value;
  }

  isCurrent(generation: number): boolean {
    return generation === this.value;
  }

  /** Abort helpers can call this when unmounting so in-flight work is stale. */
  invalidate(): void {
    this.value += 1;
  }
}

export type SingleFlightState<T> = {
  inFlight: Promise<T> | null;
};

/**
 * Coalesce concurrent identical mutations into one in-flight promise.
 * Callers still own idempotency keys; this only prevents client double-fire.
 */
export async function runSingleFlight<T>(
  state: SingleFlightState<T>,
  run: () => Promise<T>,
): Promise<T> {
  if (state.inFlight) return state.inFlight;
  const pending = run().finally(() => {
    if (state.inFlight === pending) state.inFlight = null;
  });
  state.inFlight = pending;
  return pending;
}

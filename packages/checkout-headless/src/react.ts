import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  CheckoutController,
  type CheckoutControllerOptions,
  type CheckoutSnapshot,
} from './index.js';

export function useTixkitCheckout(options: CheckoutControllerOptions): {
  controller: CheckoutController;
  state: Readonly<CheckoutSnapshot>;
} {
  const { eventId, transport, storage, storageKey, now, pollIntervalMs } = options;
  const controller = useMemo(
    () =>
      new CheckoutController({
        eventId,
        transport,
        storage,
        storageKey,
        now,
        pollIntervalMs,
      }),
    [eventId, transport, storage, storageKey, now, pollIntervalMs],
  );
  const state = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getState(),
    () => controller.getState(),
  );
  useEffect(() => () => controller.destroy(), [controller]);
  return { controller, state };
}

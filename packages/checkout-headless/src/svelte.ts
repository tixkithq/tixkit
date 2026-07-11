import { readable, type Readable } from 'svelte/store';
import {
  CheckoutController,
  type CheckoutControllerOptions,
  type CheckoutSnapshot,
} from './index.js';

export function createTixkitCheckoutStore(options: CheckoutControllerOptions): {
  controller: CheckoutController;
  state: Readable<Readonly<CheckoutSnapshot>>;
  destroy(): void;
} {
  const controller = new CheckoutController(options);
  const state = readable(controller.getState(), (set) => controller.subscribe(set));
  return { controller, state, destroy: () => controller.destroy() };
}

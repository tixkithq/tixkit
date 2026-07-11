import { onScopeDispose, shallowRef, type ShallowRef } from 'vue';
import {
  CheckoutController,
  type CheckoutControllerOptions,
  type CheckoutSnapshot,
} from './index.js';

export function useTixkitCheckout(options: CheckoutControllerOptions): {
  controller: CheckoutController;
  state: ShallowRef<Readonly<CheckoutSnapshot>>;
} {
  const controller = new CheckoutController(options);
  const state = shallowRef<Readonly<CheckoutSnapshot>>(controller.getState());
  const unsubscribe = controller.subscribe((next) => {
    state.value = next;
  });
  onScopeDispose(() => {
    unsubscribe();
    controller.destroy();
  });
  return { controller, state };
}

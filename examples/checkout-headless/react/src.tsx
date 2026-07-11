import { createRoot } from 'react-dom/client';
import { createFetchCheckoutTransport } from '@tixkit/checkout-headless';
import { useTixkitCheckout } from '@tixkit/checkout-headless/react';
const transport = createFetchCheckoutTransport({ apiBaseUrl: 'https://api.example.test/v1' });
function App() {
  const { state } = useTixkitCheckout({ eventId: 'evt_example', transport });
  return <main>Checkout state: {state.phase}</main>;
}
createRoot(document.getElementById('root')!).render(<App />);

import { createContext, useContext, type ReactNode } from 'react';

type GateKitClientConfig = {
  apiBaseUrl?: string;
  checkoutBaseUrl?: string;
  widgetBaseUrl?: string;
};

const GateKitContext = createContext<GateKitClientConfig | null>(null);

export function GateKitProvider({ children, config }: { children: ReactNode; config: GateKitClientConfig }) {
  return <GateKitContext.Provider value={config}>{children}</GateKitContext.Provider>;
}

export function useGateKit(): GateKitClientConfig {
  const ctx = useContext(GateKitContext);
  if (!ctx) throw new Error('useGateKit must be used within GateKitProvider');
  return ctx;
}

export function GateKitCheckoutButton({
  eventId,
  items,
  checkoutMode = 'redirect',
  children,
}: {
  eventId: string;
  items: { ticketTypeId: string; quantity: number }[];
  checkoutMode?: 'modal' | 'redirect';
  children: ReactNode;
}) {
  const config = useGateKit();
  const handleClick = () => {
    const params = new URLSearchParams({
      eventId,
      items: items.map((i) => `${i.ticketTypeId}=${i.quantity}`).join(','),
      mode: checkoutMode,
    });
    const checkoutUrl = `${config.checkoutBaseUrl ?? 'https://checkout.gatekit.com'}/checkout?${params.toString()}`;
    if (checkoutMode === 'modal') {
      window.open(checkoutUrl, 'gatekit-checkout', 'width=600,height=700');
    } else {
      window.location.href = checkoutUrl;
    }
  };

  return <button onClick={handleClick}>{children}</button>;
}

export function GateKitTicketWidget({
  brand,
  event: eventId,
  locale = 'en-US',
  theme = 'auto',
}: {
  brand: string;
  event: string;
  locale?: string;
  theme?: string;
}) {
  const config = useGateKit();

  const base = config.widgetBaseUrl ?? 'https://widget.gatekit.com';
  const params = new URLSearchParams();
  if (brand) params.set('brand', brand);
  if (locale) params.set('locale', locale);
  if (theme) params.set('theme', theme);
  const widgetUrl = `${base}/e/${eventId}?${params.toString()}`;

  return (
    <iframe
      src={widgetUrl}
      style={{ border: 'none', width: '100%', minHeight: '400px' }}
      title="GateKit Ticket Widget"
      loading="lazy"
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      allow="payment; publickey-credentials-create *; publickey-credentials-get *"
    />
  );
}

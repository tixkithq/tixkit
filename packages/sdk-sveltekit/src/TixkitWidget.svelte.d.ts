import type { TixkitCheckoutEvent, TixkitWidgetPostMessage } from './client.js';

export type TixkitWidgetProps = {
  widgetBaseUrl?: string;
  apiBaseUrl?: string;
  brand: string;
  event: string;
  locale?: string;
  theme?: string;
  products?: string[];
  discountCode?: string;
  trackingId?: string;
  mode?: 'inline' | 'modal' | 'redirect';
  title?: string;
  height?: string;
  class?: string;
  style?: string;
  allowedOrigin?: string;
  onEvent?: (event: TixkitWidgetPostMessage) => void;
  onCheckoutEvent?: (event: TixkitCheckoutEvent) => void;
};

declare const TixkitWidget: unknown;

export default TixkitWidget;

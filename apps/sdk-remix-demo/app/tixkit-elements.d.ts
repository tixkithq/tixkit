declare namespace JSX {
  interface IntrinsicElements {
    'tixkit-widget': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      brand?: string;
      event?: string;
      'checkout-mode'?: string;
      'api-base-url'?: string;
      items?: string;
    };
    'tixkit-button': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
      brand?: string;
      event?: string;
      'checkout-mode'?: string;
      'api-base-url'?: string;
      items?: string;
    };
  }
}

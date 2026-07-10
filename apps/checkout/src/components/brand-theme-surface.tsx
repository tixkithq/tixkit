'use client';

import { createElement, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { brandThemeStyle, type ResolvedBrand } from '@/lib/brand';

export function BrandThemeSurface({
  as = 'div',
  brand,
  children,
  className,
  testId,
}: {
  as?: 'div' | 'main';
  brand: ResolvedBrand;
  children: ReactNode;
  className: string;
  testId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const theme = useMemo(() => brandThemeStyle(brand), [brand]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !theme) return;
    const sanitizer = document.createElement('div').style;
    for (const [name, value] of Object.entries(theme)) {
      if (typeof value === 'string') sanitizer.setProperty(name, value);
    }
    const declarations = Array.from(sanitizer)
      .map((name) => `${name}:${sanitizer.getPropertyValue(name)}`)
      .join(';');
    if (!declarations) return;

    if ('adoptedStyleSheets' in document && typeof CSSStyleSheet !== 'undefined') {
      const selector = `tixkit-theme-${crypto.randomUUID()}`;
      element.dataset.tixkitTheme = selector;
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`[data-tixkit-theme="${selector}"]{${declarations}}`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return () => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
          (candidate) => candidate !== sheet,
        );
        delete element.dataset.tixkitTheme;
      };
    }

    for (const name of sanitizer) element.style.setProperty(name, sanitizer.getPropertyValue(name));
    return () => element.removeAttribute('style');
  }, [theme]);

  return createElement(as, { ref, className, 'data-testid': testId }, children);
}

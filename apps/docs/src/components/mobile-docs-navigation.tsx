'use client';

import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef } from 'react';

export function MobileDocsNavigation({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const navigationRef = useRef<HTMLElement>(null);
  const previousPathname = useRef(pathname);

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  useEffect(() => {
    if (previousPathname.current !== pathname) {
      close();
      document.querySelector<HTMLElement>('main')?.focus();
      previousPathname.current = pathname;
    }
  }, [pathname]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !detailsRef.current?.open) return;
      event.preventDefault();
      close();
      summaryRef.current?.focus();
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  useEffect(() => {
    const navigation = navigationRef.current;
    const handleNavigationClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('a[href]')) close();
    };
    navigation?.addEventListener('click', handleNavigationClick);
    return () => navigation?.removeEventListener('click', handleNavigationClick);
  }, []);

  return (
    <details ref={detailsRef} className="mobile-navigation">
      <summary ref={summaryRef}>Menu</summary>
      <nav ref={navigationRef} aria-label="Mobile documentation">
        {children}
      </nav>
    </details>
  );
}

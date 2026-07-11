"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { DocsNavigation } from "./docs-navigation";

export function MobileDocsNavigation() {
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const previousPathname = useRef(pathname);

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  useEffect(() => {
    if (previousPathname.current !== pathname) {
      close();
      document.querySelector<HTMLElement>("main")?.focus();
      previousPathname.current = pathname;
    }
  }, [pathname]);

  return (
    <details
      ref={detailsRef}
      className="mobile-navigation"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        close();
        summaryRef.current?.focus();
      }}
    >
      <summary ref={summaryRef}>Menu</summary>
      <nav aria-label="Mobile documentation">
        <DocsNavigation onNavigate={close} />
      </nav>
    </details>
  );
}

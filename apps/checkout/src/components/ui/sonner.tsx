'use client';

import { useEffect, useState, type ReactNode } from 'react';

type ToastOptions = {
  description?: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
  icon?: ReactNode;
};
type ToastDetail = ToastOptions & { id: string; message: string };
const TOAST_EVENT = 'tixkit:toast';

function announce(message: string, options: ToastOptions = {}): void {
  window.dispatchEvent(
    new CustomEvent<ToastDetail>(TOAST_EVENT, {
      detail: { id: crypto.randomUUID(), message, ...options },
    }),
  );
}

export const toast = Object.assign(announce, {
  success: announce,
  error: announce,
  info: announce,
  warning: announce,
});

export function Toaster({ position = 'bottom-right' }: { position?: 'bottom-right' }) {
  const [items, setItems] = useState<ToastDetail[]>([]);

  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<ToastDetail>).detail;
      if (!detail?.id || !detail.message) return;
      setItems((current) => [...current, detail]);
      if (detail.duration !== Infinity)
        window.setTimeout(
          () => setItems((current) => current.filter((item) => item.id !== detail.id)),
          detail.duration ?? 5_000,
        );
    };
    window.addEventListener(TOAST_EVENT, listener);
    return () => window.removeEventListener(TOAST_EVENT, listener);
  }, []);

  return (
    <output
      className={`tixkit-toaster tixkit-toaster-${position}`}
      aria-live="polite"
      aria-atomic="false"
    >
      {items.map((item) => (
        <div className="tixkit-toast" key={item.id}>
          {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
          <strong>{item.message}</strong>
          {item.description ? <span>{item.description}</span> : null}
          {item.action ? (
            <button type="button" onClick={item.action.onClick}>
              {item.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </output>
  );
}

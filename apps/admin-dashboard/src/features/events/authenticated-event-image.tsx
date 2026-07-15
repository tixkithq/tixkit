'use client';

import * as React from 'react';
import { ImageIcon } from 'lucide-react';
import { requestBlob } from '@/lib/api-http';
import { cn } from '@/lib/utils';

export type AuthenticatedEventImageSource = {
  url: string;
  altText: string;
  width: number;
  height: number;
};

export function AuthenticatedEventImage({
  source,
  className,
  fallbackClassName,
}: {
  source?: AuthenticatedEventImageSource | null;
  className?: string;
  fallbackClassName?: string;
}) {
  const [objectUrl, setObjectUrl] = React.useState<string>();
  const [visible, setVisible] = React.useState(false);
  const placeholderRef = React.useRef<HTMLSpanElement>(null);
  const sourceUrl = source?.url;

  React.useEffect(() => {
    setVisible(false);
    const element = placeholderRef.current;
    if (!sourceUrl || !element || typeof IntersectionObserver === 'undefined') {
      setVisible(Boolean(sourceUrl));
      return () => undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '160px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [sourceUrl]);

  React.useEffect(() => {
    let active = true;
    let createdUrl: string | undefined;
    const controller = new AbortController();
    setObjectUrl(undefined);
    if (!sourceUrl || !visible) return () => controller.abort();
    void requestBlob(sourceUrl, { signal: controller.signal }).then((result) => {
      if (!active || !result.ok) return;
      createdUrl = URL.createObjectURL(result.data);
      setObjectUrl(createdUrl);
    });
    return () => {
      active = false;
      controller.abort();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [sourceUrl, visible]);

  if (!source || !objectUrl) {
    return (
      <span
        ref={placeholderRef}
        aria-hidden="true"
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground',
          fallbackClassName,
        )}
      >
        <ImageIcon className="size-4" />
      </span>
    );
  }

  return (
    <img
      src={objectUrl}
      loading="lazy"
      alt={source.altText}
      width={source.width}
      height={source.height}
      className={cn('shrink-0 object-cover', className)}
    />
  );
}

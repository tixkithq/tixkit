'use client';

import * as React from 'react';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type GatedControlProps = Omit<React.ComponentProps<typeof Button>, 'disabled' | 'aria-disabled'> & {
  reason: string;
};

function preventGatedActivation(event: React.MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  event.stopPropagation();
}

export function GatedControl({
  reason,
  children,
  className,
  onClick: _onClick,
  onKeyDown,
  ...props
}: GatedControlProps) {
  const descriptionId = React.useId();

  const preventKeyboardActivation = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
    }
    onKeyDown?.(event);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            aria-disabled="true"
            aria-describedby={descriptionId}
            data-gated-control="true"
            className={cn('cursor-not-allowed opacity-70', className)}
            onClick={preventGatedActivation}
            onKeyDown={preventKeyboardActivation}
            {...props}
          >
            {children}
            <Info className="size-4 text-muted-foreground" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-start">{reason}</TooltipContent>
      </Tooltip>
      <span id={descriptionId} className="sr-only">
        {reason}
      </span>
    </>
  );
}

'use client';

import * as React from 'react';
import {
  ChevronLeft,
  Code,
  Eye,
  MoreHorizontal,
  PanelRightClose,
  Pencil,
  SquarePen,
} from 'lucide-react';
import type { ContentEditorAutosaveState } from './shell.js';
import { cn } from './cn.js';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from './ui.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type EditorMode = 'editor' | 'preview' | 'code';

export type DropdownMenuItemConfig = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  separatorAfter?: boolean;
  children?: DropdownMenuItemConfig[];
  activeChildId?: string;
};

/* ------------------------------------------------------------------ */
/*  Badges                                                             */
/* ------------------------------------------------------------------ */

export function AutosaveBadge({ state }: { state: ContentEditorAutosaveState }) {
  const label =
    state === 'saving'
      ? 'Saving'
      : state === 'saved'
        ? 'Saved'
        : state === 'error'
          ? 'Save failed'
          : 'Ready';
  const tone = cn(
    'rounded-md border px-2 py-0.5 text-xs font-medium',
    state === 'error'
      ? 'border-destructive/30 bg-destructive/5 text-destructive'
      : state === 'saving'
        ? 'border-amber-400/40 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
        : state === 'saved'
          ? 'border-emerald-400/40 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
          : 'border-border bg-muted text-foreground',
  );
  return <span className={tone}>{label}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = cn(
    'rounded-md border px-2 py-0.5 text-xs font-medium capitalize',
    status === 'published'
      ? 'border-emerald-400/40 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
      : status === 'archived'
        ? 'border-destructive/30 bg-destructive/5 text-destructive'
        : 'border-border bg-muted text-foreground',
  );
  return <span className={tone}>{status}</span>;
}

/* ------------------------------------------------------------------ */
/*  Editor top bar                                                     */
/* ------------------------------------------------------------------ */

export type EditorTopBarProps = {
  backHref: string;
  channelLabel: string;
  documentName: string;
  status: string;
  autosave: ContentEditorAutosaveState;
  onDocumentNameClick?: () => void;
  notice?: string;
  error?: string;
  moreActions: DropdownMenuItemConfig[];
  onPublish: () => void;
  publishDisabled?: boolean;
  publishLabel?: string;
  secondaryActions?: React.ReactNode;
};

export function EditorTopBar({
  backHref,
  channelLabel,
  documentName,
  status,
  autosave,
  onDocumentNameClick,
  notice,
  error,
  moreActions,
  onPublish,
  publishDisabled,
  publishLabel = 'Publish',
  secondaryActions,
}: EditorTopBarProps) {
  return (
    <section
      aria-label="Editor header"
      className="relative z-10 flex h-[60px] shrink-0 items-center justify-between border-b px-3 sm:px-4"
    >
      {/* Left: back + breadcrumb + name + status + autosave */}
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <a
          aria-label="Back"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          href={backHref}
        >
          <ChevronLeft className="size-4" />
        </a>
        <span className="hidden text-muted-foreground sm:inline">{channelLabel}</span>
        <span className="hidden text-muted-foreground/50 sm:inline">/</span>
        <button
          className="min-w-0 truncate font-semibold text-foreground transition-colors hover:text-muted-foreground disabled:opacity-60"
          disabled={!onDocumentNameClick}
          onClick={onDocumentNameClick}
          type="button"
        >
          {documentName}
        </button>
        <StatusBadge status={status} />
        <AutosaveBadge state={autosave} />
      </div>

      {/* Center: notice / error */}
      {(notice || error) && (
        <p
          className={cn(
            'absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 truncate text-xs lg:block',
            error ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {error ?? notice}
        </p>
      )}

      {/* Right: actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        {secondaryActions}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button aria-label="More actions" size="icon" variant="outline">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {moreActions.map((item) => (
              <React.Fragment key={item.id}>
                {item.children ? (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger disabled={item.disabled}>
                      {item.icon}
                      <span className="min-w-0 truncate">{item.label}</span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-40">
                      {item.children.map((child) => (
                        <DropdownMenuItem
                          key={child.id}
                          disabled={child.disabled}
                          onClick={child.onClick}
                          variant={child.destructive ? 'destructive' : 'default'}
                        >
                          {child.activeChildId === child.id && (
                            <span className="size-2 shrink-0 rounded-full bg-primary" />
                          )}
                          {child.activeChildId !== child.id && child.icon}
                          <span className="min-w-0 truncate">{child.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ) : (
                  <DropdownMenuItem
                    disabled={item.disabled}
                    key={`${item.id}-item`}
                    onClick={item.onClick}
                    variant={item.destructive ? 'destructive' : 'default'}
                  >
                    {item.icon}
                    <span className="min-w-0 truncate">{item.label}</span>
                  </DropdownMenuItem>
                )}
                {item.separatorAfter && <DropdownMenuSeparator key={`${item.id}-separator`} />}
              </React.Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button disabled={publishDisabled} onClick={onPublish} size="sm">
          {publishLabel}
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Editor left rail                                                   */
/* ------------------------------------------------------------------ */

export type EditorLeftRailProps = {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  inserts: React.ReactNode;
  insertsDisabled?: boolean;
  disabledModes?: Partial<Record<EditorMode, boolean>>;
  hiddenModes?: Partial<Record<EditorMode, boolean>>;
};

export function EditorLeftRail({
  mode,
  onModeChange,
  inserts,
  insertsDisabled,
  disabledModes,
  hiddenModes,
}: EditorLeftRailProps) {
  return (
    <nav
      aria-label="Editor tools"
      className="flex w-16 shrink-0 flex-col items-center border-r py-3"
    >
      {/* Mode toggle at top */}
      <div className="flex flex-col items-center gap-1">
        {!hiddenModes?.editor && (
          <RailToggleButton
            active={mode === 'editor'}
            disabled={disabledModes?.editor}
            label="Editor"
            onClick={() => onModeChange('editor')}
          >
            <Pencil className="size-4" />
          </RailToggleButton>
        )}
        {!hiddenModes?.preview && (
          <RailToggleButton
            active={mode === 'preview'}
            disabled={disabledModes?.preview}
            label="Preview"
            onClick={() => onModeChange('preview')}
          >
            <Eye className="size-4" />
          </RailToggleButton>
        )}
        {!hiddenModes?.code && (
          <RailToggleButton
            active={mode === 'code'}
            disabled={disabledModes?.code}
            label="Code"
            onClick={() => onModeChange('code')}
          >
            <Code className="size-4" />
          </RailToggleButton>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Insert popover buttons at bottom */}
      <div
        className={cn(
          'flex flex-col items-center gap-1',
          insertsDisabled && 'pointer-events-none opacity-40',
        )}
      >
        {inserts}
      </div>
    </nav>
  );
}

function RailToggleButton({
  active,
  children,
  disabled,
  label,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          aria-pressed={active}
          className={cn(
            'inline-flex size-8 items-center justify-center rounded-md border transition-colors disabled:pointer-events-none disabled:opacity-50',
            active
              ? 'border-foreground/20 bg-accent text-accent-foreground'
              : 'border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
          disabled={disabled}
          onClick={onClick}
          type="button"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/*  Insert popover button                                              */
/* ------------------------------------------------------------------ */

export type InsertPopoverButtonProps = {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  children: React.ReactNode;
};

export function InsertPopoverButton({ label, icon, disabled, children }: InsertPopoverButtonProps) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label={`Insert ${label}`}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
              disabled={disabled}
              type="button"
            >
              {icon}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-56 p-1" side="right" sideOffset={8}>
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function InsertPopoverItem({
  icon,
  label,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
      onClick={onClick}
      type="button"
    >
      {icon && <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Inspector panel (right sidebar)                                    */
/* ------------------------------------------------------------------ */

export type InspectorPanelProps = {
  eyebrow?: string;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  headerActions?: React.ReactNode;
};

export function InspectorPanel({
  eyebrow,
  title,
  onClose,
  children,
  footer,
  headerActions,
}: InspectorPanelProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          {eyebrow && (
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {eyebrow}
            </p>
          )}
          <h2 className="mt-0.5 truncate text-sm font-semibold">{title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {headerActions}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Close sidebar"
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={onClose}
                type="button"
              >
                <PanelRightClose className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">Close sidebar</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

      {footer && <div className="border-t px-4 py-3">{footer}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Metadata bar                                                       */
/* ------------------------------------------------------------------ */

export type MetadataFieldProps = {
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  collapsible?: boolean;
  defaultOpen?: boolean;
  type?: 'text' | 'email';
};

export function MetadataField({
  label,
  value,
  placeholder,
  disabled,
  onChange,
  collapsible = false,
  defaultOpen = true,
  type = 'text',
}: MetadataFieldProps) {
  const [open, setOpen] = React.useState(defaultOpen);

  if (collapsible) {
    return (
      <div className="flex items-center gap-2 border-t border-border/60 py-1.5">
        <button
          aria-expanded={open}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpen((v) => !v)}
          type="button"
        >
          {label}
        </button>
        {open && (
          <input
            aria-label={label}
            className="min-w-0 flex-1 border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/50 disabled:opacity-50"
            disabled={disabled}
            onChange={(e) => onChange(e.currentTarget.value)}
            placeholder={placeholder}
            type={type}
            value={value}
          />
        )}
      </div>
    );
  }

  return (
    <label className="flex items-center gap-2 border-t border-border/60 py-1.5">
      <span className="shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <input
        aria-label={label}
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/50 disabled:opacity-50"
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        type={type}
        value={value}
      />
    </label>
  );
}

export function MetadataBar({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mx-auto w-full max-w-[600px] border-b border-border/60"
      data-testid="email-metadata-bar"
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Editor chrome (outer layout)                                       */
/* ------------------------------------------------------------------ */

export type EditorChromeProps = {
  channel: string;
  testId?: string;
  topBar: React.ReactNode;
  leftRail: React.ReactNode;
  canvas: React.ReactNode;
  inspector: React.ReactNode | null;
  reopenInspectorButton?: React.ReactNode;
  /** Floating mobile-only buttons */
  children?: React.ReactNode;
};

export function EditorChrome({
  channel,
  testId,
  topBar,
  leftRail,
  canvas,
  inspector,
  reopenInspectorButton,
  children,
}: EditorChromeProps) {
  const hasInspector = inspector !== null;
  return (
    <section
      className="flex h-svh flex-col overflow-hidden bg-background text-foreground"
      data-channel={channel}
      data-testid={testId}
    >
      {topBar}
      <div className="flex min-h-0 flex-1">
        {leftRail}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{canvas}</div>
        {hasInspector && (
          <aside
            aria-label="Inspector"
            className="fixed inset-x-0 bottom-0 z-40 h-[min(78svh,42rem)] overflow-hidden rounded-t-2xl border-t bg-background shadow-2xl lg:static lg:z-auto lg:h-auto lg:w-80 lg:shrink-0 lg:rounded-none lg:border-t-0 lg:border-l lg:shadow-none xl:w-[22rem]"
          >
            {inspector}
          </aside>
        )}
      </div>
      {reopenInspectorButton}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Floating buttons                                                   */
/* ------------------------------------------------------------------ */

export function InspectorReopenButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      className="fixed bottom-4 right-4 z-30 shadow-lg"
      onClick={onClick}
      size="sm"
      variant="outline"
    >
      <SquarePen className="size-4" />
      Inspector
    </Button>
  );
}

export function MobileInsertButton({
  label = 'Insert',
  onClick,
  disabled,
}: {
  label?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      className="fixed bottom-4 left-20 z-30 shadow-lg lg:hidden"
      disabled={disabled}
      onClick={onClick}
      size="sm"
      variant="outline"
    >
      <SquarePen className="size-4" />
      {label}
    </Button>
  );
}

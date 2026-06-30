'use client';

import * as React from 'react';
import { ChevronLeft, Eye, MoreHorizontal, PanelRightClose, Pencil, SquarePen } from 'lucide-react';
import type { ContentEditorAutosaveState } from './shell.js';

/* ------------------------------------------------------------------ */
/*  Tiny hooks                                                         */
/* ------------------------------------------------------------------ */

/** Close on outside-click or Escape. Returns a ref to attach to the panel. */
function useDismiss(onClose: () => void) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!ref.current) return;
    const controller = new AbortController();
    document.addEventListener(
      'pointerdown',
      (event) => {
        if (ref.current && !ref.current.contains(event.target as Node)) onClose();
      },
      { signal: controller.signal },
    );
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') onClose();
      },
      { signal: controller.signal },
    );
    return () => controller.abort();
  }, [onClose]);
  return ref;
}

/* ------------------------------------------------------------------ */
/*  Popover primitive                                                  */
/* ------------------------------------------------------------------ */

export type PopoverProps = {
  /** Render the trigger button */
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  /** Popover body */
  children: (props: { close: () => void }) => React.ReactNode;
  /** Panel alignment relative to trigger */
  align?: 'start' | 'end';
  /** Panel position relative to trigger */
  side?: 'right' | 'bottom';
  /** Panel min width */
  panelMinWidth?: number;
  /** Called when popover closes */
  onClose?: () => void;
};

export function Popover({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  panelMinWidth = 200,
  onClose,
}: PopoverProps) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => {
    setOpen(false);
    onClose?.();
  }, [onClose]);
  const dismissRef = useDismiss(close);

  const alignClass = align === 'end' ? 'right-0' : side === 'right' ? 'left-full top-0' : 'left-0';
  const sideClass = side === 'right' ? 'ml-1' : 'top-full mt-1';

  return (
    <div className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          className={`absolute z-50 ${alignClass} ${sideClass} animate-in fade-in zoom-in-95 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md`}
          ref={dismissRef}
          style={{ minWidth: panelMinWidth }}
        >
          {children({ close })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Dropdown menu primitive                                            */
/* ------------------------------------------------------------------ */

export type DropdownMenuItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Render a separator after this item */
  separatorAfter?: boolean;
};

export type DropdownMenuProps = {
  trigger?: React.ReactNode;
  items: DropdownMenuItem[];
  align?: 'start' | 'end';
};

export function DropdownMenu({ trigger, items, align = 'end' }: DropdownMenuProps) {
  return (
    <Popover
      align={align}
      panelMinWidth={224}
      trigger={({ toggle, open }) => (
        <button
          aria-expanded={open}
          aria-label="More actions"
          className="inline-flex size-9 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          onClick={toggle}
          title="More actions"
          type="button"
        >
          {trigger ?? <MoreHorizontal className="size-4" />}
        </button>
      )}
    >
      {({ close }) => (
        <div className="py-0.5">
          {items.map((item) => (
            <React.Fragment key={item.id}>
              <button
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 ${
                  item.destructive ? 'text-destructive hover:bg-destructive/10' : 'text-foreground'
                }`}
                disabled={item.disabled}
                onClick={() => {
                  item.onClick();
                  close();
                }}
                type="button"
              >
                {item.icon && <span className="shrink-0">{item.icon}</span>}
                <span className="min-w-0 truncate">{item.label}</span>
              </button>
              {item.separatorAfter && <div className="my-1 h-px bg-border" />}
            </React.Fragment>
          ))}
        </div>
      )}
    </Popover>
  );
}

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
  const tone =
    state === 'error'
      ? 'border-destructive/30 bg-destructive/5 text-destructive'
      : state === 'saving'
        ? 'border-amber-300/50 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
        : state === 'saved'
          ? 'border-emerald-300/50 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
          : 'border-border bg-muted text-muted-foreground';
  return (
    <span className={`rounded-md border px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'published'
      ? 'border-emerald-300/50 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
      : status === 'archived'
        ? 'border-destructive/30 bg-destructive/5 text-destructive'
        : 'border-border bg-muted text-muted-foreground';
  return (
    <span className={`rounded-md border px-2 py-0.5 text-xs font-medium capitalize ${tone}`}>
      {status}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Editor top bar                                                     */
/* ------------------------------------------------------------------ */

export type EditorTopBarProps = {
  backHref: string;
  /** Breadcrumb label, e.g. "Templates" or "Pages" */
  channelLabel: string;
  documentName: string;
  status: string;
  autosave: ContentEditorAutosaveState;
  onDocumentNameClick?: () => void;
  notice?: string;
  error?: string;
  moreActions: DropdownMenuItem[];
  onPublish: () => void;
  publishDisabled?: boolean;
  publishLabel?: string;
  /** Extra action buttons rendered before More actions */
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
    <header className="relative z-10 flex h-[60px] items-center justify-between border-b px-3 sm:px-4">
      {/* Left: back + breadcrumb + name + status + autosave */}
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <a
          aria-label="Back"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          href={backHref}
        >
          <ChevronLeft className="size-4" />
        </a>
        <span className="text-muted-foreground">{channelLabel}</span>
        <span className="text-muted-foreground/50">/</span>
        <button
          className="min-w-0 truncate font-semibold text-foreground transition-colors hover:text-muted-foreground"
          disabled={!onDocumentNameClick}
          onClick={onDocumentNameClick}
          type="button"
        >
          {documentName}
        </button>
        <StatusBadge status={status} />
        <AutosaveBadge state={autosave} />
      </div>

      {/* Center: notice / error (absolute, so it doesn't push layout) */}
      {(notice || error) && (
        <p
          className={`absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 truncate text-xs lg:block ${
            error ? 'text-destructive' : 'text-muted-foreground'
          }`}
        >
          {error ?? notice}
        </p>
      )}

      {/* Right: actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        {secondaryActions}
        <DropdownMenu align="end" items={moreActions} />
        <button
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 sm:px-4"
          disabled={publishDisabled}
          onClick={onPublish}
          type="button"
        >
          {publishLabel}
        </button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/*  Editor left rail                                                   */
/* ------------------------------------------------------------------ */

export type EditorMode = 'editor' | 'preview';

export type EditorLeftRailProps = {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  /** Insert popover buttons rendered at the bottom of the rail */
  inserts: React.ReactNode;
  /** Disable insert buttons (e.g. archived) */
  insertsDisabled?: boolean;
};

export function EditorLeftRail({
  mode,
  onModeChange,
  inserts,
  insertsDisabled,
}: EditorLeftRailProps) {
  return (
    <nav
      aria-label="Editor tools"
      className="flex w-16 shrink-0 flex-col items-center border-r py-3"
    >
      {/* Mode toggle at top */}
      <div className="flex flex-col items-center gap-1">
        <RailToggleButton
          active={mode === 'editor'}
          label="Editor"
          onClick={() => onModeChange('editor')}
        >
          <Pencil className="size-4" />
        </RailToggleButton>
        <RailToggleButton
          active={mode === 'preview'}
          label="Preview"
          onClick={() => onModeChange('preview')}
        >
          <Eye className="size-4" />
        </RailToggleButton>
      </div>

      {/* Spacer pushes inserts to bottom */}
      <div className="flex-1" />

      {/* Insert popover buttons at bottom */}
      <div
        className={`flex flex-col items-center gap-1 ${insertsDisabled ? 'pointer-events-none opacity-40' : ''}`}
      >
        {inserts}
      </div>
    </nav>
  );
}

function RailToggleButton({
  active,
  children,
  label,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex size-8 items-center justify-center rounded-md border transition-colors ${
        active
          ? 'border-foreground/20 bg-accent text-accent-foreground'
          : 'border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      }`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Insert popover button                                              */
/* ------------------------------------------------------------------ */

export type InsertPopoverButtonProps = {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  /** Popover panel content */
  children: React.ReactNode;
};

export function InsertPopoverButton({ label, icon, disabled, children }: InsertPopoverButtonProps) {
  return (
    <Popover
      align="start"
      panelMinWidth={220}
      side="right"
      trigger={({ toggle, open }) => (
        <button
          aria-expanded={open}
          aria-label={`Insert ${label}`}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
          disabled={disabled}
          onClick={toggle}
          title={label}
          type="button"
        >
          {icon}
        </button>
      )}
    >
      {() => <div className="py-0.5">{children}</div>}
    </Popover>
  );
}

/** A single item inside an insert popover. */
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
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
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
  /** Extra header actions (e.g. theme/css toggle buttons) */
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
      {/* Header */}
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
          <button
            aria-label="Close sidebar"
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            onClick={onClose}
            title="Close sidebar"
            type="button"
          >
            <PanelRightClose className="size-4" />
          </button>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

      {/* Optional footer */}
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
  /** Start collapsed (user clicks label to expand) */
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
  /** Right inspector panel; pass null to hide */
  inspector: React.ReactNode | null;
  /** Floating button to re-open inspector when closed */
  reopenInspectorButton?: React.ReactNode;
};

export function EditorChrome({
  channel,
  testId,
  topBar,
  leftRail,
  canvas,
  inspector,
  reopenInspectorButton,
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
        <div className={`flex min-w-0 flex-1 flex-col overflow-hidden ${hasInspector ? '' : ''}`}>
          {canvas}
        </div>
        {hasInspector && (
          <aside
            aria-label="Inspector"
            className="hidden w-80 shrink-0 border-l bg-background lg:block xl:w-[22rem]"
          >
            {inspector}
          </aside>
        )}
      </div>
      {reopenInspectorButton}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Inspector reopen button (floating)                                 */
/* ------------------------------------------------------------------ */

export function InspectorReopenButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      aria-label="Open inspector"
      className="fixed bottom-4 right-4 z-30 inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium text-foreground shadow-lg transition-colors hover:bg-accent"
      onClick={onClick}
      type="button"
    >
      <SquarePen className="size-4" />
      Inspector
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Reopen inserts button (mobile)                                     */
/* ------------------------------------------------------------------ */

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
    <button
      aria-label="Open insert menu"
      className="fixed bottom-4 left-20 z-30 inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium text-foreground shadow-lg transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50 lg:hidden"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <SquarePen className="size-4" />
      {label}
    </button>
  );
}

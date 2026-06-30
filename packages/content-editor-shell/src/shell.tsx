'use client';

import * as React from 'react';
import {
  AlertTriangle,
  Archive,
  Blocks,
  CalendarPlus,
  Code2,
  Copy,
  Eye,
  Image,
  Link,
  MapPin,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Save,
  Send,
  ShieldCheck,
  Ticket,
  Type,
  Variable,
} from 'lucide-react';
import type {
  ContentChannel,
  ContentDocument,
  ContentDocumentVersion,
  ContentValidationIssue,
  ContentVariableDefinition,
} from '@tixkit/content-core';

export type ContentEditorAutosaveState = 'idle' | 'saving' | 'saved' | 'error';

export type ContentEditorInsertAction = {
  id: string;
  label: string;
  icon: 'calendar' | 'code' | 'image' | 'link' | 'map' | 'shield' | 'text' | 'ticket' | 'variable';
};

export type ContentEditorCanvasBlock = {
  id: string;
  label: string;
  summary: string;
  content: React.ReactNode;
  presentation?: 'document';
  selected?: boolean;
  onSelect?: () => void;
};

export type ContentEditorVersionSummary = {
  id: string;
  label: string;
  status: ContentDocumentVersion['status'];
  timestamp: string;
  author: string;
};

export type ContentEditorPreview = {
  label: string;
  output: string;
  format: 'html' | 'text' | 'json';
};

export type ContentEditorInspectorPanel = {
  id: string;
  label: string;
  content: React.ReactNode;
};

export type ContentEditorShellProps = {
  document: ContentDocument;
  draft: ContentDocumentVersion;
  channelLabel: string;
  autosave: ContentEditorAutosaveState;
  insertActions: ContentEditorInsertAction[];
  canvasBlocks: ContentEditorCanvasBlock[];
  versions: ContentEditorVersionSummary[];
  preview: ContentEditorPreview;
  actionsUnavailableReason?: string;
  testSendUnavailableReason?: string;
  unavailableReason?: string;
  canvasHeader?: React.ReactNode;
  inspectorPanels?: ContentEditorInspectorPanel[];
  activeInspectorPanelId?: string;
  showInspectorPanelTabs?: boolean;
  onInsertAction?: (actionId: string) => void;
  onInspectorPanelChange?: (panelId: string) => void;
  onPublish?: () => void;
  onPreview?: () => void;
  onTestSend?: () => void;
  onDuplicate?: () => void;
  onArchive?: () => void;
};

type InspectorPanel = 'settings' | 'variables' | 'versions' | 'blockers';

export function ContentEditorShell({
  document,
  draft,
  channelLabel,
  autosave,
  insertActions,
  canvasBlocks,
  versions,
  preview,
  actionsUnavailableReason,
  testSendUnavailableReason,
  unavailableReason,
  canvasHeader,
  inspectorPanels,
  activeInspectorPanelId,
  showInspectorPanelTabs = true,
  onInsertAction,
  onInspectorPanelChange,
  onPublish,
  onPreview,
  onTestSend,
  onDuplicate,
  onArchive,
}: ContentEditorShellProps) {
  const [inspectorOpen, setInspectorOpen] = React.useState(true);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [panel, setPanel] = React.useState<InspectorPanel>(
    draft.validation.issues.length > 0 ? 'blockers' : 'settings',
  );
  const publishBlocked = draft.validation.issues.some((issue) => issue.severity === 'error');
  const defaultPanels = React.useMemo<ContentEditorInspectorPanel[]>(
    () => [
      { id: 'settings', label: 'Settings', content: <SettingsPanel draft={draft} /> },
      {
        id: 'variables',
        label: 'Variables',
        content: <VariablePanel variables={draft.variables} />,
      },
      { id: 'versions', label: 'Versions', content: <VersionPanel versions={versions} /> },
      {
        id: 'blockers',
        label: 'Blockers',
        content: <BlockerPanel issues={draft.validation.issues} />,
      },
    ],
    [draft, versions],
  );
  const panels = inspectorPanels?.length ? inspectorPanels : defaultPanels;
  const selectedPanelId = activeInspectorPanelId ?? panel;
  const selectedPanel = panels.find((item) => item.id === selectedPanelId) ?? panels[0];

  function handlePanelChange(panelId: string) {
    setPanel(panelId as InspectorPanel);
    onInspectorPanelChange?.(panelId);
  }

  return (
    <section
      className="min-h-[calc(100svh-8rem)] overflow-hidden border bg-background text-foreground"
      data-channel={document.channel}
      data-testid="content-editor-shell"
    >
      <EditorTopBar
        autosave={autosave}
        channel={document.channel}
        channelLabel={channelLabel}
        documentName={document.name}
        draft={draft}
        inspectorOpen={inspectorOpen}
        publishBlocked={publishBlocked || Boolean(unavailableReason)}
        actionsUnavailableReason={actionsUnavailableReason}
        previewOpen={previewOpen}
        testSendUnavailableReason={testSendUnavailableReason}
        unavailableReason={unavailableReason}
        onDuplicate={onDuplicate}
        onArchive={onArchive}
        onInspectorToggle={() => setInspectorOpen((current) => !current)}
        onPreviewToggle={() => {
          setPreviewOpen((current) => !current);
          onPreview?.();
        }}
        onPublish={onPublish}
        onTestSend={onTestSend}
      />

      <div className="grid min-h-[calc(100svh-12rem)] grid-cols-[4rem_minmax(0,1fr)] lg:grid-cols-[4rem_minmax(0,1fr)_20rem]">
        <InsertRail actions={insertActions} onInsertAction={onInsertAction} />
        <section
          aria-label="Editor canvas workspace"
          className="min-w-0 overflow-auto bg-zinc-100 px-3 py-4 dark:bg-zinc-950 sm:px-5 lg:px-7"
        >
          <CanvasFrame
            blocks={canvasBlocks}
            channel={document.channel}
            empty={canvasBlocks.length === 0}
            header={canvasHeader}
            title={document.name}
            unavailableReason={unavailableReason}
          />
        </section>
        {inspectorOpen && (
          <Inspector
            activePanelId={selectedPanel.id}
            panels={panels}
            preview={preview}
            previewOpen={previewOpen}
            selectedPanel={selectedPanel}
            showPanelTabs={showInspectorPanelTabs}
            onPanelChange={handlePanelChange}
            onPreviewClose={() => setPreviewOpen(false)}
          />
        )}
      </div>
    </section>
  );
}

function EditorTopBar({
  autosave,
  channel,
  channelLabel,
  documentName,
  draft,
  inspectorOpen,
  previewOpen,
  publishBlocked,
  actionsUnavailableReason,
  testSendUnavailableReason,
  unavailableReason,
  onDuplicate,
  onArchive,
  onInspectorToggle,
  onPreviewToggle,
  onPublish,
  onTestSend,
}: {
  autosave: ContentEditorAutosaveState;
  channel: ContentChannel;
  channelLabel: string;
  documentName: string;
  draft: ContentDocumentVersion;
  inspectorOpen: boolean;
  previewOpen: boolean;
  publishBlocked: boolean;
  actionsUnavailableReason?: string;
  testSendUnavailableReason?: string;
  unavailableReason?: string;
  onDuplicate?: () => void;
  onArchive?: () => void;
  onInspectorToggle: () => void;
  onPreviewToggle: () => void;
  onPublish?: () => void;
  onTestSend?: () => void;
}) {
  return (
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b px-3 py-2 sm:px-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-md border px-2 py-1">{channelLabel}</span>
          <span>Draft v{draft.versionNumber}</span>
          <AutosaveBadge autosave={autosave} />
        </div>
        <h1 className="mt-1 truncate text-base font-semibold sm:text-lg">{documentName}</h1>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {(unavailableReason || actionsUnavailableReason) && (
          <span className="max-w-56 rounded-md border border-amber-500/40 bg-amber-50 px-2 py-1 text-xs text-amber-950 dark:bg-amber-950 dark:text-amber-100">
            {unavailableReason ?? actionsUnavailableReason}
          </span>
        )}
        <IconButton
          disabled={Boolean(actionsUnavailableReason)}
          label={previewOpen ? 'Close preview' : 'Open preview'}
          onClick={onPreviewToggle}
        >
          <Eye className="size-4" />
        </IconButton>
        <IconButton
          disabled={Boolean(actionsUnavailableReason || testSendUnavailableReason)}
          label={
            actionsUnavailableReason || testSendUnavailableReason
              ? 'Test send unavailable'
              : 'Send test'
          }
          onClick={onTestSend}
        >
          <Send className="size-4" />
        </IconButton>
        <IconButton
          disabled={publishBlocked || Boolean(actionsUnavailableReason)}
          label={
            actionsUnavailableReason
              ? 'Publish unavailable'
              : publishBlocked
                ? 'Resolve publish blockers'
                : 'Publish'
          }
          onClick={onPublish}
        >
          <Save className="size-4" />
        </IconButton>
        <IconButton
          label={inspectorOpen ? 'Close inspector' : 'Open inspector'}
          onClick={onInspectorToggle}
        >
          {inspectorOpen ? (
            <PanelRightClose className="size-4" />
          ) : (
            <PanelRightOpen className="size-4" />
          )}
        </IconButton>
        <details className="relative">
          <summary
            aria-label="More actions"
            className="flex size-9 list-none items-center justify-center rounded-md border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="More actions"
          >
            <MoreHorizontal className="size-4" />
          </summary>
          <div className="absolute right-0 z-20 mt-2 w-44 rounded-md border bg-popover p-1 text-sm shadow-md">
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(actionsUnavailableReason) || !onDuplicate}
              onClick={onDuplicate}
              type="button"
            >
              <Copy className="size-4" />
              Duplicate {channel === 'event_page' ? 'page' : 'template'}
            </button>
            <button
              className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={Boolean(actionsUnavailableReason) || !onArchive}
              onClick={onArchive}
              type="button"
            >
              <Archive className="size-4" />
              Archive {channel === 'event_page' ? 'page' : 'template'}
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}

function AutosaveBadge({ autosave }: { autosave: ContentEditorAutosaveState }) {
  const label = {
    idle: 'Ready',
    saving: 'Saving',
    saved: 'Saved',
    error: 'Save failed',
  }[autosave];
  const tone =
    autosave === 'error'
      ? 'border-destructive/30 text-destructive'
      : autosave === 'saving'
        ? 'border-amber-300 text-amber-700'
        : 'border-emerald-300 text-emerald-700';

  return <span className={`rounded-md border px-2 py-1 ${tone}`}>{label}</span>;
}

function InsertRail({
  actions,
  onInsertAction,
}: {
  actions: ContentEditorInsertAction[];
  onInsertAction?: (actionId: string) => void;
}) {
  return (
    <aside
      aria-label="Insert content"
      className="flex flex-col items-center gap-2 border-r bg-background px-2 py-4"
    >
      <Blocks className="mb-1 size-4 text-muted-foreground" />
      {actions.map((action) => (
        <IconButton
          key={action.id}
          label={`Insert ${action.label}`}
          onClick={onInsertAction ? () => onInsertAction(action.id) : undefined}
        >
          <InsertIcon icon={action.icon} />
        </IconButton>
      ))}
    </aside>
  );
}

function CanvasFrame({
  blocks,
  channel,
  empty,
  header,
  title,
  unavailableReason,
}: {
  blocks: ContentEditorCanvasBlock[];
  channel: ContentChannel;
  empty: boolean;
  header?: React.ReactNode;
  title: string;
  unavailableReason?: string;
}) {
  const canvasWidth =
    channel === 'email' ? 'max-w-[680px]' : channel === 'sms' ? 'max-w-[390px]' : 'max-w-4xl';
  const isDocumentCanvas = channel === 'email' || channel === 'event_page';

  return (
    <div
      aria-label={isDocumentCanvas ? `${title} editable document` : undefined}
      className={`mx-auto min-h-[34rem] ${canvasWidth}`}
      data-testid="editor-canvas"
    >
      {header && (
        <div className="mb-3 border-b bg-background/95 px-4 py-3 dark:bg-zinc-900/95">{header}</div>
      )}
      <div
        className={
          isDocumentCanvas
            ? 'min-h-[34rem] bg-white shadow-sm ring-1 ring-border/70 dark:bg-zinc-950'
            : 'overflow-hidden rounded-md border bg-background shadow-sm'
        }
      >
        {!isDocumentCanvas && (
          <div className="border-b bg-background px-5 py-4">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              {canvasLabel(channel)}
            </p>
            <h2 className="mt-1 text-xl font-semibold">{title}</h2>
          </div>
        )}
        {unavailableReason ? (
          <EmptyCanvas
            icon={<AlertTriangle className="size-7" />}
            title="Channel unavailable"
            description={unavailableReason}
          />
        ) : empty ? (
          <EmptyCanvas
            icon={<Blocks className="size-7" />}
            title="Start writing"
            description={
              isDocumentCanvas
                ? 'Use the insert rail to add the first piece of editable content.'
                : 'Use the insert rail to add editable content.'
            }
          />
        ) : (
          <div
            className={
              channel === 'email'
                ? 'p-6 sm:p-9'
                : channel === 'event_page'
                  ? 'space-y-10 p-6 sm:p-10'
                  : 'space-y-3 p-4 sm:p-5'
            }
          >
            {blocks.map((block) => {
              if (isDocumentCanvas) {
                if (!block.content || block.presentation !== 'document') {
                  throw new Error(
                    `Document canvas block must render document content: ${block.id}`,
                  );
                }
                return (
                  <section
                    aria-label={block.label}
                    aria-current={block.selected ? 'true' : undefined}
                    className="contents"
                    key={block.id}
                    onFocusCapture={block.onSelect}
                  >
                    {block.content}
                  </section>
                );
              }

              return (
                <article
                  className={`rounded-md border bg-background p-4 transition ${
                    block.selected
                      ? 'border-ring shadow-[0_0_0_1px_hsl(var(--ring))]'
                      : 'hover:border-ring/70'
                  }`}
                  key={block.id}
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold">{block.label}</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">{block.summary}</p>
                    </div>
                    <button
                      aria-pressed={Boolean(block.selected)}
                      className="rounded-md border border-ring/40 px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                      onClick={block.onSelect}
                      type="button"
                    >
                      {block.selected ? 'Selected' : 'Select'}
                    </button>
                  </div>
                  {block.content}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyCanvas({
  description,
  icon,
  title,
}: {
  description: string;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <div className="flex min-h-80 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 text-muted-foreground">{icon}</div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function Inspector({
  activePanelId,
  panels,
  preview,
  previewOpen,
  selectedPanel,
  showPanelTabs,
  onPanelChange,
  onPreviewClose,
}: {
  activePanelId: string;
  panels: ContentEditorInspectorPanel[];
  preview: ContentEditorPreview;
  previewOpen: boolean;
  selectedPanel: ContentEditorInspectorPanel;
  showPanelTabs: boolean;
  onPanelChange: (panelId: string) => void;
  onPreviewClose: () => void;
}) {
  return (
    <aside className="col-span-2 max-h-[52svh] overflow-auto border-t bg-background p-3 lg:col-span-1 lg:max-h-none lg:border-l lg:border-t-0 lg:p-0">
      {showPanelTabs && (
        <div className="flex gap-1 overflow-x-auto border-b pb-2 lg:grid lg:grid-cols-2 lg:p-2">
          {panels.map((panel) => (
            <PanelButton
              active={activePanelId === panel.id}
              key={panel.id}
              label={panel.label}
              onClick={() => onPanelChange(panel.id)}
            />
          ))}
        </div>
      )}
      <div className="space-y-4 p-3">
        {previewOpen && <PreviewDrawer preview={preview} onClose={onPreviewClose} />}
        {selectedPanel.content}
      </div>
    </aside>
  );
}

function PanelButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`rounded-md px-3 py-2 text-sm ${
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
      }`}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function PreviewDrawer({
  preview,
  onClose,
}: {
  preview: ContentEditorPreview;
  onClose: () => void;
}) {
  return (
    <section className="rounded-md border bg-muted/30 p-3" data-testid="preview-drawer">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{preview.label}</h2>
          <p className="text-xs text-muted-foreground">{preview.format.toUpperCase()} output</p>
        </div>
        <button
          className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
      <pre className="mt-3 whitespace-pre-wrap rounded-md bg-background p-3 text-xs leading-5">
        {preview.output}
      </pre>
    </section>
  );
}

function SettingsPanel({ draft }: { draft: ContentDocumentVersion }) {
  return (
    <section>
      <h2 className="text-sm font-semibold">Version settings</h2>
      <dl className="mt-3 space-y-3 text-sm">
        <InspectorRow label="Status" value={draft.status} />
        <InspectorRow label="Version" value={`v${draft.versionNumber}`} />
        <InspectorRow label="Schema" value={`v${draft.schemaVersion}`} />
        {draft.subject && <InspectorRow label="Subject" value={draft.subject} />}
        {draft.previewText && <InspectorRow label="Preview" value={draft.previewText} />}
      </dl>
    </section>
  );
}

function VariablePanel({ variables }: { variables: ContentVariableDefinition[] }) {
  return (
    <section>
      <h2 className="text-sm font-semibold">Variables</h2>
      <div className="mt-3 space-y-2">
        {variables.map((variable) => (
          <div className="rounded-md border p-2" key={variable.key}>
            <div className="flex items-center justify-between gap-2">
              <code className="text-xs">{`{{${variable.key}}}`}</code>
              {variable.required && <span className="text-xs text-amber-700">Required</span>}
            </div>
            {variable.description && (
              <p className="mt-1 text-xs text-muted-foreground">{variable.description}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function VersionPanel({ versions }: { versions: ContentEditorVersionSummary[] }) {
  return (
    <section>
      <h2 className="text-sm font-semibold">Version history</h2>
      <ol className="mt-3 space-y-2">
        {versions.map((version) => (
          <li className="rounded-md border p-2 text-sm" key={version.id}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{version.label}</span>
              <span className="text-xs text-muted-foreground">{version.status}</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {version.author} · {formatDate(version.timestamp)}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function BlockerPanel({ issues }: { issues: ContentValidationIssue[] }) {
  return (
    <section>
      <h2 className="text-sm font-semibold">Publish blockers</h2>
      {issues.length === 0 ? (
        <p className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800">
          No publish blockers.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {issues.map((issue) => (
            <li
              className="rounded-md border border-destructive/40 bg-background p-2 text-sm"
              key={`${issue.code}-${issue.field ?? issue.message}`}
            >
              <div className="font-medium text-destructive">{issue.code}</div>
              <p className="mt-1 text-foreground">{issue.message}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InspectorRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium">{value}</dd>
    </div>
  );
}

function IconButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="flex size-9 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function InsertIcon({ icon }: { icon: ContentEditorInsertAction['icon'] }) {
  switch (icon) {
    case 'calendar':
      return <CalendarPlus className="size-4" />;
    case 'code':
      return <Code2 className="size-4" />;
    case 'image':
      return <Image className="size-4" />;
    case 'link':
      return <Link className="size-4" />;
    case 'map':
      return <MapPin className="size-4" />;
    case 'shield':
      return <ShieldCheck className="size-4" />;
    case 'text':
      return <Type className="size-4" />;
    case 'ticket':
      return <Ticket className="size-4" />;
    case 'variable':
      return <Variable className="size-4" />;
  }
}

function canvasLabel(channel: ContentChannel): string {
  if (channel === 'sms') return 'Mobile canvas';
  if (channel === 'email') return 'Email canvas';
  if (channel === 'event_page') return 'Page canvas';
  return 'Unavailable channel';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

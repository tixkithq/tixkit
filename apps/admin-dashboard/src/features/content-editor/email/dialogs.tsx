'use client';

import * as React from 'react';
import type { ContentValidationIssue } from '@tixkit/content-core';
import type { EmailTemplateDocument } from '@tixkit/content-email';
import { inputClassName } from '@tixkit/content-editor-shell';
import { getTemplateLifecycle } from '@tixkit/domain';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  AdminBrand,
  AdminBrandSenderIdentity,
  AdminContentDocument,
  AdminEventDetail,
  SendMessageInput,
} from '@/lib/api';
import { emailCategoryOptions, validationIssueKey } from './document-rules';

type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';
type EmailAudience = SendMessageInput['audience'];
type EmailReviewState = 'idle' | 'checking' | 'checked' | 'error';
type EmailSendMode = 'now' | 'scheduled';
type EmailVersionSummary = {
  id: string;
  label: string;
  timestamp: string;
};

export type EmailDialogsProps = {
  audience: EmailAudience;
  autosave: AutosaveState;
  brand?: AdminBrand;
  canEdit: boolean;
  detailsDialogOpen: boolean;
  document: AdminContentDocument;
  emailDocument: EmailTemplateDocument;
  event: AdminEventDetail;
  history: EmailVersionSummary[];
  historyDialogOpen: boolean;
  jsonDialogOpen: boolean;
  onApplyTemplate: (template: AdminContentDocument) => void;
  onAudienceChange: (audience: EmailAudience) => void;
  onCategoryChange: (category: EmailTemplateDocument['settings']['category']) => void;
  onDetailsDialogOpenChange: (open: boolean) => void;
  onHistoryDialogOpenChange: (open: boolean) => void;
  onJsonDialogOpenChange: (open: boolean) => void;
  onLocaleChange: (locale: string) => void;
  onPublish: () => void;
  onRecipientChange: (recipient: string) => void;
  onReviewConfirmedChange: (confirmed: boolean) => void;
  onReviewDialogOpenChange: (open: boolean) => void;
  onScheduledAtChange: (value: string) => void;
  onSendModeChange: (mode: EmailSendMode) => void;
  onSendTest: () => void;
  onTemplateKeyChange: (templateKey: string) => void;
  onTemplatePickerOpenChange: (open: boolean) => void;
  onTestDialogOpenChange: (open: boolean) => void;
  recipient: string;
  reviewAnalysisFailed: boolean;
  reviewBlockingIssues: ContentValidationIssue[];
  reviewCanConfirm: boolean;
  reviewConfirmed: boolean;
  reviewDialogOpen: boolean;
  reviewHasInvalidSchedule: boolean;
  reviewIsAnalyzing: boolean;
  reviewState: EmailReviewState;
  reviewWarningIssues: ContentValidationIssue[];
  scheduledAt: string;
  selectedSenderIdentity?: AdminBrandSenderIdentity;
  sendMode: EmailSendMode;
  templateChoices: AdminContentDocument[];
  templatePickerOpen: boolean;
  testDialogOpen: boolean;
};

export function EmailDialogs({
  audience,
  autosave,
  brand,
  canEdit,
  detailsDialogOpen,
  document,
  emailDocument,
  event,
  history,
  historyDialogOpen,
  jsonDialogOpen,
  onApplyTemplate,
  onAudienceChange,
  onCategoryChange,
  onDetailsDialogOpenChange,
  onHistoryDialogOpenChange,
  onJsonDialogOpenChange,
  onLocaleChange,
  onPublish,
  onRecipientChange,
  onReviewConfirmedChange,
  onReviewDialogOpenChange,
  onScheduledAtChange,
  onSendModeChange,
  onSendTest,
  onTemplateKeyChange,
  onTemplatePickerOpenChange,
  onTestDialogOpenChange,
  recipient,
  reviewAnalysisFailed,
  reviewBlockingIssues,
  reviewCanConfirm,
  reviewConfirmed,
  reviewDialogOpen,
  reviewHasInvalidSchedule,
  reviewIsAnalyzing,
  reviewState,
  reviewWarningIssues,
  scheduledAt,
  selectedSenderIdentity,
  sendMode,
  templateChoices,
  templatePickerOpen,
  testDialogOpen,
}: EmailDialogsProps) {
  const lifecycle = getTemplateLifecycle(
    emailDocument.settings.templateKey as Parameters<typeof getTemplateLifecycle>[0],
  );

  return (
    <>
      <Dialog open={detailsDialogOpen} onOpenChange={onDetailsDialogOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Template details</DialogTitle>
            <DialogDescription>
              Manage lifecycle metadata and delivery classification for this template.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="space-y-1.5 text-sm font-medium text-foreground">
              Template key
              <input
                aria-label="Template key"
                className={inputClassName}
                disabled={!canEdit}
                onChange={(change) => onTemplateKeyChange(change.currentTarget.value)}
                value={emailDocument.settings.templateKey}
              />
            </label>
            <label className="space-y-1.5 text-sm font-medium text-foreground">
              Locale
              <input
                aria-label="Locale"
                className={inputClassName}
                disabled={!canEdit}
                onChange={(change) => onLocaleChange(change.currentTarget.value)}
                value={emailDocument.settings.locale}
              />
            </label>
            <label className="space-y-1.5 text-sm font-medium text-foreground">
              Category
              <select
                aria-label="Category"
                className={inputClassName}
                disabled={!canEdit}
                onChange={(change) =>
                  onCategoryChange(
                    change.currentTarget.value as EmailTemplateDocument['settings']['category'],
                  )
                }
                value={emailDocument.settings.category}
              >
                {emailCategoryOptions.map((category) => (
                  <option className="bg-background text-foreground" key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <dl className="space-y-2 pt-2 text-xs">
              <div className="flex justify-between gap-4 border-b border-border pb-2">
                <dt className="text-muted-foreground">Brand scope</dt>
                <dd className="max-w-[12rem] truncate font-mono text-foreground/80">
                  {document.brandId}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-border pb-2">
                <dt className="text-muted-foreground">Event scope</dt>
                <dd className="max-w-[12rem] truncate font-mono text-foreground/80">
                  {document.eventId ?? 'brand'}
                </dd>
              </div>
              {lifecycle ? (
                <>
                  <div className="flex justify-between gap-4 border-b border-border pb-2">
                    <dt className="text-muted-foreground">Lifecycle family</dt>
                    <dd className="max-w-[12rem] truncate text-foreground/80">
                      {lifecycle.family}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-border pb-2">
                    <dt className="text-muted-foreground">Tier</dt>
                    <dd className="max-w-[12rem] truncate text-foreground/80">
                      {lifecycle.tier}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-b border-border pb-2">
                    <dt className="text-muted-foreground">Audience</dt>
                    <dd className="max-w-[12rem] truncate text-foreground/80">
                      {lifecycle.defaultAudience}
                    </dd>
                  </div>
                </>
              ) : null}
            </dl>
          </div>
          <DialogFooter>
            <Button onClick={() => onDetailsDialogOpenChange(false)} type="button" variant="outline">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={historyDialogOpen} onOpenChange={onHistoryDialogOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Version history</DialogTitle>
            <DialogDescription>Review saved versions for this template.</DialogDescription>
          </DialogHeader>
          {history.length === 0 ? (
            <p className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
              No saved versions yet.
            </p>
          ) : (
            <ol className="max-h-[28rem] space-y-2 overflow-auto">
              {history.map((version) => (
                <li className="rounded-md border p-3 text-sm" key={version.id}>
                  <div className="font-medium text-foreground">{version.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{version.timestamp}</div>
                </li>
              ))}
            </ol>
          )}
          <DialogFooter>
            <Button onClick={() => onHistoryDialogOpenChange(false)} type="button" variant="outline">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={jsonDialogOpen} onOpenChange={onJsonDialogOpenChange}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Editor JSON</DialogTitle>
            <DialogDescription>Inspect the canonical saved email payload.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[34rem] overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
            {JSON.stringify(emailDocument, null, 2)}
          </pre>
          <DialogFooter>
            <Button onClick={() => onJsonDialogOpenChange(false)} type="button" variant="outline">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={testDialogOpen} onOpenChange={onTestDialogOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send test email</DialogTitle>
            <DialogDescription>
              Send the current draft to one or more test recipients before review.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="space-y-1.5 text-sm font-medium text-foreground">
              Recipients
              <textarea
                aria-label="Test recipients"
                className={`${inputClassName} min-h-28 resize-y`}
                disabled={!canEdit || autosave === 'saving'}
                onChange={(change) => onRecipientChange(change.currentTarget.value)}
                onKeyDown={(keyboardEvent) => {
                  if (
                    (keyboardEvent.metaKey || keyboardEvent.ctrlKey) &&
                    keyboardEvent.key === 'Enter'
                  ) {
                    keyboardEvent.preventDefault();
                    onSendTest();
                  }
                }}
                placeholder="ada@example.test, grace@example.test"
                value={recipient}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              Separate addresses with commas or line breaks.
            </p>
          </div>
          <DialogFooter>
            <Button onClick={() => onTestDialogOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!canEdit || autosave === 'saving'} onClick={onSendTest} type="button">
              Send test
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={templatePickerOpen} onOpenChange={onTemplatePickerOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Pick a template</DialogTitle>
            <DialogDescription>
              Start from another email template saved for this brand.
            </DialogDescription>
          </DialogHeader>
          {templateChoices.length === 0 ? (
            <p className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
              No brand email templates are available yet.
            </p>
          ) : (
            <div className="max-h-[28rem] space-y-2 overflow-auto">
              {templateChoices.map((template) => (
                <div
                  className="flex items-start justify-between gap-3 rounded-md border p-3"
                  key={template.id}
                >
                  <div className="min-w-0 space-y-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {template.name}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{template.key}</span>
                      <span>{template.locale}</span>
                      <span>{template.status}</span>
                      {template.eventId ? <span>event template</span> : <span>brand template</span>}
                    </div>
                  </div>
                  <Button
                    disabled={!canEdit}
                    onClick={() => onApplyTemplate(template)}
                    type="button"
                    variant="outline"
                  >
                    Apply
                  </Button>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => onTemplatePickerOpenChange(false)} type="button" variant="outline">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={reviewDialogOpen}
        onOpenChange={(open) => {
          onReviewDialogOpenChange(open);
          if (!open) onReviewConfirmedChange(false);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Ready to send?</DialogTitle>
            <DialogDescription>
              Review the campaign details and checks before this email is queued.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
              <h3 className="text-sm font-medium text-foreground">Campaign settings</h3>
              <label className="flex items-center gap-2 py-1">
                <span className="w-28 shrink-0 text-xs font-medium text-muted-foreground">To</span>
                <select
                  aria-label="Audience"
                  className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  disabled={!canEdit}
                  onChange={(change) =>
                    onAudienceChange(change.currentTarget.value as EmailAudience)
                  }
                  value={audience}
                >
                  <option className="bg-background text-foreground" value="all">
                    All attendees
                  </option>
                  <option className="bg-background text-foreground" value="checked_in">
                    Checked in
                  </option>
                  <option className="bg-background text-foreground" value="not_checked_in">
                    Not checked in
                  </option>
                  <option className="bg-background text-foreground" value="specific">
                    Specific attendees
                  </option>
                </select>
              </label>
              <div className="flex items-center gap-2 py-1">
                <span className="w-28 shrink-0 text-xs font-medium text-muted-foreground">
                  Subscribe to
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {emailDocument.settings.category === 'bulk'
                    ? `${brand?.name ?? event.title} updates`
                    : 'Transactional ticket messages'}
                </span>
              </div>
              <label className="flex items-center gap-2 py-1">
                <span className="w-28 shrink-0 text-xs font-medium text-muted-foreground">When</span>
                <select
                  aria-label="Send timing"
                  className="w-28 rounded-md border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  disabled={!canEdit}
                  onChange={(change) =>
                    onSendModeChange(change.currentTarget.value as EmailSendMode)
                  }
                  value={sendMode}
                >
                  <option className="bg-background text-foreground" value="now">
                    Now
                  </option>
                  <option className="bg-background text-foreground" value="scheduled">
                    Scheduled
                  </option>
                </select>
                {sendMode === 'scheduled' && (
                  <input
                    aria-label="Scheduled send time"
                    className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                    disabled={!canEdit}
                    onChange={(change) => onScheduledAtChange(change.currentTarget.value)}
                    type="datetime-local"
                    value={scheduledAt}
                  />
                )}
              </label>
            </div>
            <dl className="grid gap-2 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-[7rem_1fr]">
              <dt className="text-muted-foreground">From</dt>
              <dd className="font-medium text-foreground">
                {selectedSenderIdentity
                  ? selectedSenderIdentity.name
                    ? `${selectedSenderIdentity.name} <${selectedSenderIdentity.email}>`
                    : selectedSenderIdentity.email
                  : 'No verified sender'}
              </dd>
              <dt className="text-muted-foreground">Subject</dt>
              <dd className="font-medium text-foreground">{emailDocument.settings.subject}</dd>
              <dt className="text-muted-foreground">Template</dt>
              <dd className="font-mono text-xs text-foreground">
                {emailDocument.settings.templateKey}
              </dd>
            </dl>
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">Preflight checks</h3>
              <output
                className={
                  reviewAnalysisFailed
                    ? 'rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200'
                    : reviewIsAnalyzing
                      ? 'rounded-md border border-sky-400/40 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200'
                      : 'rounded-md border border-sky-400/40 bg-sky-50 p-3 text-sm text-sky-800 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200'
                }
              >
                <div className="font-medium">
                  {reviewAnalysisFailed
                    ? 'Content analysis failed'
                    : reviewIsAnalyzing
                      ? 'Analyzing your content...'
                      : 'Content analysis complete'}
                </div>
                <p className="mt-1 opacity-80">
                  {reviewAnalysisFailed
                    ? 'Review the error message and try again before sending.'
                    : reviewIsAnalyzing
                      ? 'Checking the current editor export, links, sender, audience, and unsubscribe requirements from the React Email output.'
                      : 'The current editor export, links, sender, audience, and unsubscribe requirements were checked from the saved React Email output.'}
                </p>
              </output>
              {reviewHasInvalidSchedule && (
                <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">
                  Choose a valid scheduled send time before confirming.
                </p>
              )}
              {reviewState !== 'checked' ? null : reviewBlockingIssues.length === 0 ? (
                <p className="rounded-md border border-emerald-400/40 bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
                  No blocking issues found.
                </p>
              ) : (
                <ul className="space-y-2">
                  {reviewBlockingIssues.map((issue) => (
                    <li
                      className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
                      key={validationIssueKey(issue)}
                    >
                      <div className="font-medium">{issue.code}</div>
                      <p className="mt-1 opacity-80">{issue.message}</p>
                    </li>
                  ))}
                </ul>
              )}
              {reviewState === 'checked' && reviewWarningIssues.length > 0 && (
                <ul className="space-y-2">
                  {reviewWarningIssues.map((issue) => (
                    <li
                      className="rounded-md border border-amber-400/40 bg-amber-50 p-3 text-sm text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
                      key={validationIssueKey(issue)}
                    >
                      <div className="font-medium">{issue.code}</div>
                      <p className="mt-1 opacity-80">{issue.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-md border p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-foreground">
                    {sendMode === 'scheduled' ? 'Slide to schedule' : 'Slide to send'}
                  </div>
                  <p className="text-muted-foreground">
                    Confirms the reviewed email, audience, and send time.
                  </p>
                </div>
                <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-foreground">
                  {reviewConfirmed ? 'Confirmed' : 'Locked'}
                </span>
              </div>
              <input
                aria-label="Slide to confirm email campaign send"
                className="mt-3 h-2 w-full accent-foreground"
                disabled={!reviewCanConfirm}
                max="100"
                min="0"
                onChange={(change) =>
                  onReviewConfirmedChange(Number(change.currentTarget.value) >= 100)
                }
                type="range"
                value={reviewConfirmed ? 100 : 0}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                onReviewDialogOpenChange(false);
                onReviewConfirmedChange(false);
              }}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={!reviewConfirmed || !reviewCanConfirm} onClick={onPublish} type="button">
              {sendMode === 'scheduled' ? 'Schedule email' : 'Send email'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

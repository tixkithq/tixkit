'use client';

import * as React from 'react';
import type { EmailTemplateDocument } from '@tixkit/content-email';
import type { AdminBrandSenderIdentity } from '@/lib/api';

export type EnvelopeHeaderProps = {
  disabled: boolean;
  emailDocument: EmailTemplateDocument;
  senderIdentities: AdminBrandSenderIdentity[];
  onChange: (next: EmailTemplateDocument) => void;
};

export function applySenderIdentity(
  document: EmailTemplateDocument,
  identity: AdminBrandSenderIdentity,
): EmailTemplateDocument {
  return {
    ...document,
    settings: {
      ...document.settings,
      sender: {
        ...document.settings.sender,
        fromEmail: identity.email,
        fromName: identity.name || document.settings.sender.fromName,
        replyToEmail: identity.replyToEmail,
      },
    },
  };
}

function selectedSenderIdentity(
  identities: AdminBrandSenderIdentity[],
  fromEmail?: string,
): AdminBrandSenderIdentity | undefined {
  const normalizedFromEmail = fromEmail?.trim().toLowerCase();
  if (!normalizedFromEmail) return identities[0];
  return identities.find((identity) => identity.email.trim().toLowerCase() === normalizedFromEmail);
}

export function EnvelopeHeader({
  disabled,
  emailDocument,
  senderIdentities,
  onChange,
}: EnvelopeHeaderProps) {
  const [replyToOpen, setReplyToOpen] = React.useState(
    Boolean(emailDocument.settings.sender.replyToEmail),
  );
  const [previewOpen, setPreviewOpen] = React.useState(Boolean(emailDocument.settings.previewText));
  const selectedSender = selectedSenderIdentity(
    senderIdentities,
    emailDocument.settings.sender.fromEmail,
  );
  const replyToValue = emailDocument.settings.sender.replyToEmail ?? '';
  const previewTextValue = emailDocument.settings.previewText ?? '';

  return (
    <section
      aria-label="Email envelope"
      className="mb-3 overflow-hidden rounded-md border border-border bg-background"
      data-testid="email-metadata-bar"
    >
      <div className="grid min-h-11 grid-cols-[84px_minmax(0,1fr)_84px_minmax(0,1fr)] items-center gap-x-4 gap-y-2 border-b border-border/70 px-4 py-2">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="email-envelope-from">
          From
        </label>
        <select
          id="email-envelope-from"
          aria-label="Verified sender"
          className="min-w-0 border-none bg-transparent text-sm text-foreground outline-none disabled:opacity-50"
          disabled={disabled || senderIdentities.length === 0}
          onChange={(change) => {
            const identity = senderIdentities.find(
              (sender) => sender.id === change.currentTarget.value,
            );
            if (!identity) return;
            onChange(applySenderIdentity(emailDocument, identity));
          }}
          value={selectedSender?.id ?? ''}
        >
          {senderIdentities.length === 0 ? (
            <option className="bg-background text-foreground" value="">
              No verified senders
            </option>
          ) : null}
          {senderIdentities.map((sender) => (
            <option className="bg-background text-foreground" key={sender.id} value={sender.id}>
              {sender.name ? `${sender.name} <${sender.email}>` : sender.email}
            </option>
          ))}
        </select>
        <span className="text-left text-xs font-medium text-muted-foreground">Reply-To</span>
        {replyToOpen ? (
          <input
            aria-label="Reply-To"
            className="min-w-0 border-none bg-transparent text-left text-sm text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
            disabled={disabled}
            onChange={(change) =>
              onChange({
                ...emailDocument,
                settings: {
                  ...emailDocument.settings,
                  sender: {
                    ...emailDocument.settings.sender,
                    replyToEmail: change.currentTarget.value || undefined,
                  },
                },
              })
            }
            placeholder="Use From address"
            type="email"
            value={replyToValue}
          />
        ) : (
          <button
            aria-label="Reply-To"
            className="min-w-0 truncate text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            onClick={() => setReplyToOpen(true)}
            type="button"
          >
            {replyToValue || 'Use From address'}
          </button>
        )}
      </div>
      <div className="grid min-h-11 grid-cols-[84px_minmax(0,1fr)_84px_minmax(0,1fr)] items-center gap-x-4 gap-y-2 px-4 py-2">
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor="email-envelope-subject"
        >
          Subject
        </label>
        <input
          id="email-envelope-subject"
          aria-label="Subject"
          className="min-w-0 border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
          disabled={disabled}
          onChange={(change) =>
            onChange({
              ...emailDocument,
              settings: {
                ...emailDocument.settings,
                subject: change.currentTarget.value,
              },
            })
          }
          placeholder="Subject"
          value={emailDocument.settings.subject}
        />
        <span className="text-left text-xs font-medium text-muted-foreground">Preview</span>
        {previewOpen ? (
          <input
            aria-label="Preview text"
            className="min-w-0 border-none bg-transparent text-left text-sm text-foreground outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
            disabled={disabled}
            onChange={(change) =>
              onChange({
                ...emailDocument,
                settings: {
                  ...emailDocument.settings,
                  previewText: change.currentTarget.value,
                },
              })
            }
            placeholder="Preview text"
            value={previewTextValue}
          />
        ) : (
          <button
            aria-label="Preview text"
            className="min-w-0 truncate text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            onClick={() => setPreviewOpen(true)}
            type="button"
          >
            {previewTextValue || 'Add preview text'}
          </button>
        )}
      </div>
    </section>
  );
}

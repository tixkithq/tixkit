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

const envelopeRowClass =
  'grid min-h-11 grid-cols-[96px_minmax(0,1fr)] items-center gap-4 px-4 py-2';
const envelopeDividerRowClass = `${envelopeRowClass} border-t border-border/70`;
const envelopeControlClass =
  'min-w-0 rounded-none border-0 border-b border-transparent bg-transparent px-0 py-1.5 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-muted-foreground/35 focus:border-ring focus:bg-transparent focus:ring-0 disabled:opacity-50';

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
      className="mx-auto mb-3 w-full max-w-[600px] overflow-hidden bg-background"
      data-testid="email-metadata-bar"
    >
      <div className={envelopeRowClass}>
        <label className="text-xs font-medium text-muted-foreground" htmlFor="email-envelope-from">
          From
        </label>
        <select
          id="email-envelope-from"
          aria-label="Verified sender"
          className={envelopeControlClass}
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
      </div>
      <div className={envelopeDividerRowClass}>
        <span className="text-left text-xs font-medium text-muted-foreground">Reply-To</span>
        {replyToOpen ? (
          <input
            aria-label="Reply-To"
            className={envelopeControlClass}
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
            className={`${envelopeControlClass} truncate text-left text-muted-foreground hover:text-foreground`}
            disabled={disabled}
            onClick={() => setReplyToOpen(true)}
            type="button"
          >
            {replyToValue || 'Use From address'}
          </button>
        )}
      </div>
      <div className={envelopeDividerRowClass}>
        <label
          className="text-xs font-medium text-muted-foreground"
          htmlFor="email-envelope-subject"
        >
          Subject
        </label>
        <input
          id="email-envelope-subject"
          aria-label="Subject"
          className={envelopeControlClass}
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
      </div>
      <div className={envelopeDividerRowClass}>
        <span className="text-left text-xs font-medium text-muted-foreground">Preview</span>
        {previewOpen ? (
          <input
            aria-label="Preview text"
            className={envelopeControlClass}
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
            className={`${envelopeControlClass} truncate text-left text-muted-foreground hover:text-foreground`}
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

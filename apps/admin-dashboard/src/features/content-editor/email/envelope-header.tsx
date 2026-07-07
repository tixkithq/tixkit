'use client';

import * as React from 'react';
import { MetadataBar, MetadataField } from '@tixkit/content-editor-shell';
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
  const selectedSender = selectedSenderIdentity(
    senderIdentities,
    emailDocument.settings.sender.fromEmail,
  );

  return (
    <MetadataBar>
      <label className="flex items-center gap-2 py-1.5">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">From</span>
        <select
          aria-label="Verified sender"
          className="min-w-0 flex-1 border-none bg-transparent text-sm text-foreground outline-none disabled:opacity-50"
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
      </label>
      <label className="flex items-center gap-2 border-t border-border/60 py-1.5">
        <span className="shrink-0 text-xs font-medium text-muted-foreground">Reply-To</span>
        <select
          aria-label="Reply-To"
          className="min-w-0 flex-1 border-none bg-transparent text-sm text-foreground outline-none disabled:opacity-50"
          disabled={disabled || !selectedSender}
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
          value={emailDocument.settings.sender.replyToEmail ?? ''}
        >
          <option className="bg-background text-foreground" value="">
            Use From address
          </option>
          {selectedSender?.replyToEmail ? (
            <option className="bg-background text-foreground" value={selectedSender.replyToEmail}>
              {selectedSender.replyToEmail}
            </option>
          ) : null}
        </select>
      </label>
      <MetadataField
        disabled={disabled}
        label="Subject"
        onChange={(value) =>
          onChange({
            ...emailDocument,
            settings: { ...emailDocument.settings, subject: value },
          })
        }
        placeholder="Subject"
        value={emailDocument.settings.subject}
      />
      <MetadataField
        collapsible
        defaultOpen={false}
        disabled={disabled}
        label="Preview text"
        onChange={(value) =>
          onChange({
            ...emailDocument,
            settings: { ...emailDocument.settings, previewText: value },
          })
        }
        placeholder="Preview text"
        value={emailDocument.settings.previewText ?? ''}
      />
    </MetadataBar>
  );
}

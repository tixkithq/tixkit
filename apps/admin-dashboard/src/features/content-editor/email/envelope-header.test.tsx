import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { REACT_EMAIL_EDITOR_PACKAGE, createDefaultEmailTemplate } from '@tixkit/content-email';
import type { AdminBrandSenderIdentity } from '@/lib/api';
import { EnvelopeHeader } from './envelope-header';

const senderIdentity: AdminBrandSenderIdentity = {
  id: 'bsi_1',
  tenantId: 'tnt_1',
  brandId: 'brd_1',
  email: 'tickets@example.test',
  name: 'Tixkit',
  replyToEmail: 'support@example.test',
  verified: true,
};

const secondSenderIdentity: AdminBrandSenderIdentity = {
  ...senderIdentity,
  id: 'bsi_2',
  email: 'hello@example.test',
  name: 'Hello Team',
  replyToEmail: 'hello-replies@example.test',
};

function createEmailDocument() {
  return createDefaultEmailTemplate({
    editor: {
      provider: REACT_EMAIL_EDITOR_PACKAGE,
      contentHtml: '<p>Hello {{recipient.name}}</p>',
      contentText: 'Hello {{recipient.name}}',
    },
    settings: {
      templateKey: 'order-confirmed',
      subject: 'Your tickets',
      previewText: '',
      locale: 'en',
      category: 'transactional',
      sender: {
        fromEmail: senderIdentity.email,
        fromName: senderIdentity.name,
      },
    },
    blocks: [],
  });
}

describe('EnvelopeHeader', () => {
  it('applies the selected sender identity to the email document', () => {
    const onChange = vi.fn();
    const emailDocument = createEmailDocument();

    render(
      <EnvelopeHeader
        disabled={false}
        emailDocument={emailDocument}
        onChange={onChange}
        senderIdentities={[senderIdentity, secondSenderIdentity]}
      />,
    );

    fireEvent.change(screen.getByLabelText('Verified sender'), {
      target: { value: secondSenderIdentity.id },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          sender: expect.objectContaining({
            fromEmail: secondSenderIdentity.email,
            fromName: secondSenderIdentity.name,
            replyToEmail: secondSenderIdentity.replyToEmail,
          }),
        }),
      }),
    );
  });

  it('keeps reply-to collapsed by default and edits it after expansion', () => {
    const onChange = vi.fn();
    const baseDocument = createEmailDocument();
    const emailDocument = {
      ...baseDocument,
      settings: {
        ...baseDocument.settings,
        sender: {
          fromEmail: senderIdentity.email,
          fromName: senderIdentity.name,
        },
      },
    };

    render(
      <EnvelopeHeader
        disabled={false}
        emailDocument={emailDocument}
        onChange={onChange}
        senderIdentities={[senderIdentity]}
      />,
    );

    const replyToToggle = screen.getByRole('button', { name: 'Reply-To' });
    expect(replyToToggle).toHaveTextContent('Use From address');

    fireEvent.click(replyToToggle);
    fireEvent.change(screen.getByLabelText('Reply-To'), {
      target: { value: 'ops@example.test' },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          sender: expect.objectContaining({
            replyToEmail: 'ops@example.test',
          }),
        }),
      }),
    );
  });

  it('edits subject and preview text', () => {
    const onChange = vi.fn();
    const emailDocument = createEmailDocument();

    render(
      <EnvelopeHeader
        disabled={false}
        emailDocument={emailDocument}
        onChange={onChange}
        senderIdentities={[senderIdentity]}
      />,
    );

    fireEvent.change(screen.getByLabelText('Subject'), {
      target: { value: 'Updated subject' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview text' }));
    fireEvent.change(screen.getByLabelText('Preview text'), {
      target: { value: 'Updated preview' },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ subject: 'Updated subject' }),
      }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ previewText: 'Updated preview' }),
      }),
    );
  });

  it('disables all envelope controls', () => {
    const onChange = vi.fn();
    const emailDocument = {
      ...createEmailDocument(),
      settings: {
        ...createEmailDocument().settings,
        previewText: 'Preview',
        sender: {
          ...createEmailDocument().settings.sender,
          replyToEmail: 'support@example.test',
        },
      },
    };

    render(
      <EnvelopeHeader
        disabled
        emailDocument={emailDocument}
        onChange={onChange}
        senderIdentities={[senderIdentity]}
      />,
    );

    expect(screen.getByLabelText('Verified sender')).toBeDisabled();
    expect(screen.getByLabelText('Reply-To')).toBeDisabled();
    expect(screen.getByLabelText('Subject')).toBeDisabled();
    expect(screen.getByLabelText('Preview text')).toBeDisabled();
  });

  it('renders a no verified senders affordance', () => {
    render(
      <EnvelopeHeader
        disabled={false}
        emailDocument={createEmailDocument()}
        onChange={vi.fn()}
        senderIdentities={[]}
      />,
    );

    expect(screen.getByLabelText('Verified sender')).toBeDisabled();
    expect(screen.getByText('No verified senders')).toBeInTheDocument();
  });
});

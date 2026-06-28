import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AttendeeForm, type AttendeeAnswers } from '@/components/checkout/attendee-form';
import { publicApi, type Buyer, type CheckoutQuestion } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    publicApi: {
      ...actual.publicApi,
      uploadCheckoutArtifact: vi.fn(),
    },
  };
});

const buyer: Buyer = { email: 'a@b.com', firstName: '', lastName: '', phone: '' };

type AttendeeFormProps = React.ComponentProps<typeof AttendeeForm>;

function createAttendeeForm(props: Omit<AttendeeFormProps, 'buyer' | 'onChange' | 'disabled'>) {
  return React.createElement(AttendeeForm, {
    buyer,
    onChange: () => {},
    disabled: false,
    ...props,
  });
}

describe('AttendeeForm dynamic question types', () => {
  it('renders a multi-checkbox group for multiselect questions', () => {
    const question: CheckoutQuestion = {
      id: 'q_multi',
      label: 'Interests',
      type: 'multiselect',
      required: false,
      appliesTo: 'attendee',
      options: ['Music', 'Food', 'Art'],
    };
    const answers: AttendeeAnswers = {};
    const onChange = vi.fn();

    render(
      createAttendeeForm({
        buyerQuestions: [question],
        buyerAnswers: answers,
        onBuyerAnswersChange: onChange,
      }),
    );

    // Each option renders its own checkbox labelled with the option text.
    expect(screen.getByText('Music')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(screen.getByText('Art')).toBeInTheDocument();

    // Ticking an option propagates the typed multiselect value upward.
    fireEvent.click(screen.getByText('Music'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ q_multi: ['Music'] }));
  });

  it('renders conditional questions only when their condition matches', () => {
    const questions: CheckoutQuestion[] = [
      {
        id: 'q_parent',
        label: 'Bring guest?',
        type: 'select',
        required: true,
        appliesTo: 'buyer',
        options: ['yes', 'no'],
      },
      {
        id: 'q_guest',
        label: 'Guest name',
        type: 'text',
        required: true,
        appliesTo: 'buyer',
        conditionalVisibility: {
          field: 'q_parent',
          operator: 'equals',
          value: 'yes',
        },
      },
    ];
    const { rerender } = render(
      createAttendeeForm({
        buyerQuestions: questions,
        buyerAnswers: { q_parent: 'no' },
        onBuyerAnswersChange: () => {},
      }),
    );

    expect(screen.queryByLabelText(/Guest name/)).toBeNull();

    rerender(
      createAttendeeForm({
        buyerQuestions: questions,
        buyerAnswers: { q_parent: 'yes' },
        onBuyerAnswersChange: () => {},
      }),
    );

    expect(screen.getByLabelText(/Guest name/)).toBeInTheDocument();
  });

  it('uploads file question answers as upload artifacts', async () => {
    const question: CheckoutQuestion = {
      id: 'q_file',
      label: 'Upload ID',
      type: 'file',
      required: true,
      appliesTo: 'attendee',
    };
    const onChange = vi.fn();

    render(
      createAttendeeForm({
        eventId: 'evt_1',
        buyerQuestions: [question],
        buyerAnswers: {},
        onBuyerAnswersChange: onChange,
      }),
    );

    vi.mocked(publicApi.uploadCheckoutArtifact).mockResolvedValueOnce({
      artifactId: 'upl_01JYTESTARTIFACT',
      fileName: 'id.png',
      contentType: 'image/png',
      sizeBytes: 12,
    });
    const file = new File(['test-upload'], 'id.png', { type: 'image/png' });
    expect(screen.getByText('Upload ID')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Upload ID/), {
      target: { files: [file] },
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        q_file: {
          artifactId: 'upl_01JYTESTARTIFACT',
          fileName: 'id.png',
          contentType: 'image/png',
          sizeBytes: 12,
        },
      });
    });
    expect(publicApi.uploadCheckoutArtifact).toHaveBeenCalledWith('evt_1', file, 'q_file');
  });

  it('renders a select dropdown for select questions', () => {
    const question: CheckoutQuestion = {
      id: 'q_sel',
      label: 'Dietary',
      type: 'select',
      required: false,
      appliesTo: 'attendee',
      options: ['None', 'Vegan'],
    };
    render(
      createAttendeeForm({
        buyerQuestions: [question],
        buyerAnswers: {},
        onBuyerAnswersChange: () => {},
      }),
    );
    expect(screen.getByText('None')).toBeInTheDocument();
  });

  it('renders HTML-looking question text as escaped content', () => {
    const questions: CheckoutQuestion[] = [
      {
        id: 'q_text_xss',
        label: '<img src=x onerror=alert(1)>',
        description: '<script>alert(1)</script>',
        type: 'text',
        required: false,
        appliesTo: 'buyer',
      },
      {
        id: 'q_select_xss',
        label: 'Select payload',
        type: 'select',
        required: false,
        appliesTo: 'buyer',
        options: ['<svg onload=alert(1)>'],
      },
    ];

    const { container } = render(
      createAttendeeForm({
        buyerQuestions: questions,
        buyerAnswers: {},
        onBuyerAnswersChange: () => {},
      }),
    );

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.getByText('<svg onload=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onload]')).toBeNull();
  });
});

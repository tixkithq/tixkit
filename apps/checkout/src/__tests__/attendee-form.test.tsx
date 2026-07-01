import './test-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AttendeeForm, type AttendeeAnswers } from '@/components/checkout/attendee-form';
import { publicApi, type Buyer, type CheckoutQuestion } from '@/lib/api';

vi.mock('@/lib/api', () => {
  return {
    publicApi: {
      uploadCheckoutArtifact: vi.fn(),
    },
  };
});

const publicApiMock = publicApi as unknown as {
  uploadCheckoutArtifact: ReturnType<typeof vi.fn>;
};

afterEach(() => {
  cleanup();
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

    const view = render(
      createAttendeeForm({
        buyerQuestions: [question],
        buyerAnswers: answers,
        onBuyerAnswersChange: onChange,
      }),
    );

    // Each option renders its own checkbox labelled with the option text.
    expect(view.getByText('Music')).toBeInTheDocument();
    expect(view.getByText('Food')).toBeInTheDocument();
    expect(view.getByText('Art')).toBeInTheDocument();

    // Ticking an option propagates the typed multiselect value upward.
    fireEvent.click(view.getByText('Music'));
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
    const view = render(
      createAttendeeForm({
        buyerQuestions: questions,
        buyerAnswers: { q_parent: 'no' },
        onBuyerAnswersChange: () => {},
      }),
    );

    expect(view.queryByLabelText(/Guest name/)).toBeNull();

    view.rerender(
      createAttendeeForm({
        buyerQuestions: questions,
        buyerAnswers: { q_parent: 'yes' },
        onBuyerAnswersChange: () => {},
      }),
    );

    expect(view.getByLabelText(/Guest name/)).toBeInTheDocument();
  });

  it('uses unique DOM ids for repeated buyer and attendee questions', () => {
    const question: CheckoutQuestion = {
      id: 'q_name',
      label: 'Legal name',
      type: 'text',
      required: true,
      appliesTo: 'attendee',
    };
    const view = render(
      createAttendeeForm({
        buyerQuestions: [question],
        buyerAnswers: {},
        onBuyerAnswersChange: () => {},
        attendeeQuestionGroups: [
          {
            lineId: 'line_1',
            ticketTypeId: 'tt_1',
            ticketName: 'General Admission',
            quantity: 2,
            questions: [question],
          },
        ],
        attendeeAnswers: {},
        onAttendeeAnswersChange: () => {},
      }),
    );

    const controls = view.getAllByLabelText(/Legal name/);
    const ids = controls.map((control) => control.id);

    expect(controls).toHaveLength(3);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'q_buyer-q_name',
      'q_attendee-line_1-0-q_name',
      'q_attendee-line_1-1-q_name',
    ]);
  });

  it('keeps attendee answer keys stable while labels target unique inputs', () => {
    const question: CheckoutQuestion = {
      id: 'q_name',
      label: 'Legal name',
      type: 'text',
      required: true,
      appliesTo: 'attendee',
    };
    const onChange = vi.fn();
    const view = render(
      createAttendeeForm({
        attendeeQuestionGroups: [
          {
            lineId: 'line_1',
            ticketTypeId: 'tt_1',
            ticketName: 'General Admission',
            quantity: 2,
            questions: [question],
          },
        ],
        attendeeAnswers: {},
        onAttendeeAnswersChange: onChange,
      }),
    );

    const [, secondAttendeeInput] = view.getAllByLabelText(/Legal name/);
    fireEvent.change(secondAttendeeInput, { target: { value: 'Ada Lovelace' } });

    expect(onChange).toHaveBeenCalledWith({
      'line_1:1:q_name': 'Ada Lovelace',
    });
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

    const view = render(
      createAttendeeForm({
        eventId: 'evt_1',
        buyerQuestions: [question],
        buyerAnswers: {},
        onBuyerAnswersChange: onChange,
      }),
    );

    publicApiMock.uploadCheckoutArtifact.mockResolvedValueOnce({
      artifactId: 'upl_01JYTESTARTIFACT',
      fileName: 'id.png',
      contentType: 'image/png',
      sizeBytes: 12,
    });
    const file = new File(['test-upload'], 'id.png', { type: 'image/png' });
    expect(view.getByText('Upload ID')).toBeInTheDocument();
    fireEvent.change(view.getByLabelText(/Upload ID/), {
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
    expect(publicApiMock.uploadCheckoutArtifact).toHaveBeenCalledWith('evt_1', file, 'q_file');
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
    const view = render(
      createAttendeeForm({
        buyerQuestions: [question],
        buyerAnswers: {},
        onBuyerAnswersChange: () => {},
      }),
    );
    expect(view.getByText('None')).toBeInTheDocument();
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

    const { container, getByText } = render(
      createAttendeeForm({
        buyerQuestions: questions,
        buyerAnswers: {},
        onBuyerAnswersChange: () => {},
      }),
    );

    expect(getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(getByText('<svg onload=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onload]')).toBeNull();
  });
});

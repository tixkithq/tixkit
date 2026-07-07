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

  it('marks required buyer multiselect groups visually and accessibly', () => {
    const question: CheckoutQuestion = {
      id: 'q_multi',
      label: 'Interests',
      description: 'Select every topic you want updates for.',
      type: 'multiselect',
      required: true,
      appliesTo: 'buyer',
      options: ['Music', 'Food', 'Art'],
    };

    const view = render(
      createAttendeeForm({
        buyerQuestions: [question],
        buyerAnswers: {},
        buyerQuestionErrors: {
          q_multi: 'Choose at least one option for Interests.',
        },
        onBuyerAnswersChange: () => {},
      }),
    );

    const group = view.getByRole('group', { name: /Interests/ });
    const checkbox = view.getByLabelText('Music');

    expect(group).toHaveAttribute('aria-required', 'true');
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(group).toHaveAccessibleDescription(
      /Select every topic you want updates for\.[\s\S]*Choose at least one option for Interests\./,
    );
    expect(checkbox).toHaveAttribute('aria-required', 'true');
    expect(checkbox).toHaveAttribute('aria-invalid', 'true');
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

  it('marks required buyer checkbox questions visually and accessibly', () => {
    const question: CheckoutQuestion = {
      id: 'q_ack',
      label: 'I agree to the photo policy',
      description: 'Required for entry.',
      type: 'checkbox',
      required: true,
      appliesTo: 'buyer',
    };

    const view = render(
      createAttendeeForm({
        buyerQuestions: [question],
        buyerAnswers: {},
        onBuyerAnswersChange: () => {},
      }),
    );

    const checkbox = view.getByLabelText(/I agree to the photo policy\s+\*/);

    expect(checkbox).toBeRequired();
    expect(checkbox).toHaveAttribute('aria-required', 'true');
    expect(checkbox).toHaveAccessibleDescription('Required for entry.');
  });

  it('marks repeated required attendee checkboxes with unique accessible controls', () => {
    const question: CheckoutQuestion = {
      id: 'q_attend_ack',
      label: 'Confirm attendance acknowledgement',
      type: 'checkbox',
      required: true,
      appliesTo: 'attendee',
    };

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
        onAttendeeAnswersChange: () => {},
      }),
    );

    const controls = view.getAllByLabelText(/Confirm attendance acknowledgement\s+\*/);
    const ids = controls.map((control) => control.id);

    expect(controls).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['q_attendee-line_1-0-q_attend_ack', 'q_attendee-line_1-1-q_attend_ack']);
    for (const control of controls) {
      expect(control).toBeRequired();
      expect(control).toHaveAttribute('aria-required', 'true');
    }
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

  it('applies server validation patterns to text-like questions before submit', () => {
    const question: CheckoutQuestion = {
      id: 'q_member_id',
      label: 'Member ID',
      type: 'text',
      required: true,
      appliesTo: 'buyer',
      validationPattern: '^MEM-[0-9]{4}$',
    };
    const onChange = vi.fn();
    function PatternHarness() {
      const [answers, setAnswers] = React.useState<AttendeeAnswers>({});
      return createAttendeeForm({
        buyerQuestions: [question],
        buyerAnswers: answers,
        onBuyerAnswersChange: (nextAnswers) => {
          setAnswers(nextAnswers);
          onChange(nextAnswers);
        },
      });
    }

    const view = render(React.createElement(PatternHarness));

    const input = view.getByLabelText(/Member ID/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'BAD' } });
    fireEvent.invalid(input);

    expect(input.validationMessage).toBe('Member ID format is invalid');
    fireEvent.change(input, { target: { value: 'MEM-1234' } });
    expect(input.validationMessage).toBe('');
    expect(onChange).toHaveBeenLastCalledWith({ q_member_id: 'MEM-1234' });
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

  it('links descriptions via aria-describedby for text, phone, and date fields', () => {
    const questions: CheckoutQuestion[] = [
      {
        id: 'q_text',
        label: 'Nickname',
        description: 'What should we call you?',
        type: 'text',
        required: false,
        appliesTo: 'buyer',
      },
      {
        id: 'q_phone',
        label: 'Phone Number',
        description: 'Required for entry.',
        type: 'phone',
        required: true,
        appliesTo: 'buyer',
      },
      {
        id: 'q_date',
        label: 'D.O.B',
        description: 'Date of birth for age verification.',
        type: 'date',
        required: true,
        appliesTo: 'buyer',
      },
    ];

    const view = render(
      createAttendeeForm({
        buyerQuestions: questions,
        buyerAnswers: {},
        onBuyerAnswersChange: () => {},
      }),
    );

    for (const question of questions) {
      const input = view.getByLabelText(new RegExp(question.label)) as HTMLInputElement;
      const describedBy = input.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const descriptionEl = view.container.querySelector(`#${describedBy}`);
      expect(descriptionEl).not.toBeNull();
      expect(descriptionEl?.textContent).toBe(question.description);
    }
  });

  it('links descriptions via aria-describedby for textarea and select fields', () => {
    const questions: CheckoutQuestion[] = [
      {
        id: 'q_textarea',
        label: 'Dietary requirements',
        description: 'Tell us about allergies.',
        type: 'textarea',
        required: false,
        appliesTo: 'buyer',
      },
      {
        id: 'q_select',
        label: 'T-shirt size',
        description: 'Pick your size.',
        type: 'select',
        required: false,
        appliesTo: 'buyer',
        options: ['S', 'M', 'L'],
      },
    ];

    const view = render(
      createAttendeeForm({
        buyerQuestions: questions,
        buyerAnswers: {},
        onBuyerAnswersChange: () => {},
      }),
    );

    for (const question of questions) {
      const input = view.getByLabelText(new RegExp(question.label)) as HTMLElement;
      const describedBy = input.getAttribute('aria-describedby');
      expect(describedBy).toBeTruthy();
      const descriptionEl = view.container.querySelector(`#${describedBy}`);
      expect(descriptionEl).not.toBeNull();
      expect(descriptionEl?.textContent).toBe(question.description);
    }
  });
});

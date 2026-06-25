import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AttendeeForm, type AttendeeAnswers } from '@/components/checkout/attendee-form'
import type { Buyer, CheckoutQuestion } from '@/lib/api'

const buyer: Buyer = { email: 'a@b.com', firstName: '', lastName: '', phone: '' }

describe('AttendeeForm dynamic question types', () => {
  it('renders a multi-checkbox group for multiselect questions', () => {
    const question: CheckoutQuestion = {
      id: 'q_multi',
      label: 'Interests',
      type: 'multiselect',
      required: false,
      appliesTo: 'attendee',
      options: ['Music', 'Food', 'Art'],
    }
    const answers: AttendeeAnswers = {}
    const onChange = vi.fn()

    render(
      <AttendeeForm
        buyer={buyer}
        onChange={() => {}}
        disabled={false}
        buyerQuestions={[question]}
        buyerAnswers={answers}
        onBuyerAnswersChange={onChange}
      />,
    )

    // Each option renders its own checkbox labelled with the option text.
    expect(screen.getByText('Music')).toBeInTheDocument()
    expect(screen.getByText('Food')).toBeInTheDocument()
    expect(screen.getByText('Art')).toBeInTheDocument()

    // Ticking an option propagates the typed multiselect value upward.
    fireEvent.click(screen.getByText('Music'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ q_multi: ['Music'] }))
  })

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
    ]
    const { rerender } = render(
      <AttendeeForm
        buyer={buyer}
        onChange={() => {}}
        disabled={false}
        buyerQuestions={questions}
        buyerAnswers={{ q_parent: 'no' }}
        onBuyerAnswersChange={() => {}}
      />,
    )

    expect(screen.queryByLabelText(/Guest name/)).toBeNull()

    rerender(
      <AttendeeForm
        buyer={buyer}
        onChange={() => {}}
        disabled={false}
        buyerQuestions={questions}
        buyerAnswers={{ q_parent: 'yes' }}
        onBuyerAnswersChange={() => {}}
      />,
    )

    expect(screen.getByLabelText(/Guest name/)).toBeInTheDocument()
  })

  it('renders an unsupported state for file questions', () => {
    const question: CheckoutQuestion = {
      id: 'q_file',
      label: 'Upload ID',
      type: 'file',
      required: true,
      appliesTo: 'attendee',
    }
    const onChange = vi.fn()

    render(
      <AttendeeForm
        buyer={buyer}
        onChange={() => {}}
        disabled={false}
        buyerQuestions={[question]}
        buyerAnswers={{}}
        onBuyerAnswersChange={onChange}
      />,
    )

    expect(screen.getByText('Upload ID')).toBeInTheDocument()
    expect(screen.getByText(/File upload questions are not available/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Upload ID/)).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders a select dropdown for select questions', () => {
    const question: CheckoutQuestion = {
      id: 'q_sel',
      label: 'Dietary',
      type: 'select',
      required: false,
      appliesTo: 'attendee',
      options: ['None', 'Vegan'],
    }
    render(
      <AttendeeForm
        buyer={buyer}
        onChange={() => {}}
        disabled={false}
        buyerQuestions={[question]}
        buyerAnswers={{}}
        onBuyerAnswersChange={() => {}}
      />,
    )
    expect(screen.getByText('None')).toBeInTheDocument()
  })
})

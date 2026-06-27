import { describe, expect, it } from 'vitest'
import type { AdminCheckoutQuestion } from '@/lib/api'
import { conditionMatches, questionFormSchema } from './event-checkout-form-view'

const validBase = {
  type: 'text',
  label: 'Company',
  description: '',
  required: false,
  appliesTo: 'buyer',
  ticketTypeId: '__all__',
  optionsText: '',
  placeholder: '',
  validationPattern: '',
  conditionalField: '__none__',
  conditionalOperator: 'equals',
  conditionalValue: '',
  sortOrder: 10,
  isConsentField: false,
  consentText: '',
  consentVersion: '1',
} as const

describe('questionFormSchema', () => {
  it('accepts a basic buyer field', () => {
    const result = questionFormSchema.safeParse(validBase)
    expect(result.success).toBe(true)
  })

  it('requires options for select fields', () => {
    const result = questionFormSchema.safeParse({
      ...validBase,
      type: 'select',
      optionsText: '',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('optionsText'))).toBe(true)
    }
  })

  it('requires consent text and version for consent fields', () => {
    const result = questionFormSchema.safeParse({
      ...validBase,
      type: 'waiver',
      isConsentField: true,
      consentText: '',
      consentVersion: '',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('consentText'))).toBe(true)
      expect(result.error.issues.some((issue) => issue.path.includes('consentVersion'))).toBe(true)
    }
  })

  it('rejects consent snapshots on non-consent field types', () => {
    const result = questionFormSchema.safeParse({
      ...validBase,
      type: 'text',
      isConsentField: true,
      consentText: 'I accept',
      consentVersion: '1',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('isConsentField'))).toBe(true)
    }
  })

  it('requires a value when a conditional source field is selected', () => {
    const result = questionFormSchema.safeParse({
      ...validBase,
      conditionalField: 'q_source',
      conditionalValue: '',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('conditionalValue'))).toBe(true)
    }
  })
})

const conditionalQuestion = (
  operator: 'equals' | 'not_equals' | 'contains',
  value = 'VIP'
): AdminCheckoutQuestion => ({
  id: 'q_target',
  eventId: 'evt_1',
  type: 'text',
  label: 'Target',
  required: false,
  appliesTo: 'buyer',
  sortOrder: 20,
  isConsentField: false,
  conditionalVisibility: {
    field: 'q_source',
    operator,
    value,
  },
})

describe('conditionMatches', () => {
  it('matches equals for scalar and multi-value answers', () => {
    expect(conditionMatches(conditionalQuestion('equals'), { q_source: 'VIP' })).toBe(true)
    expect(conditionMatches(conditionalQuestion('equals'), { q_source: ['GA', 'VIP'] })).toBe(true)
    expect(conditionMatches(conditionalQuestion('equals'), { q_source: ['GA'] })).toBe(false)
  })

  it('matches not_equals for scalar, multi-value, and empty answers', () => {
    expect(conditionMatches(conditionalQuestion('not_equals'), { q_source: 'GA' })).toBe(true)
    expect(conditionMatches(conditionalQuestion('not_equals'), { q_source: ['GA', 'VIP'] })).toBe(false)
    expect(conditionMatches(conditionalQuestion('not_equals'), {})).toBe(true)
  })

  it('matches contains against every selected value without treating an empty answer as visible', () => {
    expect(conditionMatches(conditionalQuestion('contains', 'IP'), { q_source: 'VIP' })).toBe(true)
    expect(conditionMatches(conditionalQuestion('contains', 'IP'), { q_source: ['GA', 'VIP'] })).toBe(true)
    expect(conditionMatches(conditionalQuestion('contains', 'IP'), {})).toBe(false)
  })
})

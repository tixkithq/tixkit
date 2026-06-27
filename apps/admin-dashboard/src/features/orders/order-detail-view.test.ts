import { describe, expect, it } from 'vitest'
import { attendeeDisplayName } from './order-detail-view'

describe('attendeeDisplayName', () => {
  it('uses a non-empty explicit attendee name', () => {
    expect(attendeeDisplayName({ id: 'att_1', name: ' Ada Lovelace ', email: 'ada@example.test' })).toBe('Ada Lovelace')
  })

  it('falls back from empty names to first and last name', () => {
    expect(attendeeDisplayName({
      id: 'att_1',
      name: '',
      firstName: ' Grace ',
      lastName: ' Hopper ',
      email: 'grace@example.test',
    })).toBe('Grace Hopper')
  })

  it('falls back from empty name parts to email and then id', () => {
    expect(attendeeDisplayName({ id: 'att_1', name: '', firstName: '', lastName: '', email: ' buyer@example.test ' })).toBe('buyer@example.test')
    expect(attendeeDisplayName({ id: 'att_2', name: '', firstName: '', lastName: '', email: '' })).toBe('att_2')
  })
})

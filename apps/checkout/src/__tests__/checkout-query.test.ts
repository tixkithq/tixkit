import { describe, expect, it } from 'vitest'
import {
  parseItemsParam,
  parseProductFilterParam,
} from '@/lib/checkout-query'

describe('checkout query parsing', () => {
  it('parses comma-separated item quantities', () => {
    expect(parseItemsParam('tt_1=2,tt_2:3')).toEqual([
      { ticketTypeId: 'tt_1', quantity: 2 },
      { ticketTypeId: 'tt_2', quantity: 3 },
    ])
  })

  it('parses JSON object and array item quantities', () => {
    expect(parseItemsParam('{"tt_1":2,"tt_2":"4"}')).toEqual([
      { ticketTypeId: 'tt_1', quantity: 2 },
      { ticketTypeId: 'tt_2', quantity: 4 },
    ])
    expect(parseItemsParam('[{"ticketTypeId":"tt_3","quantity":1}]')).toEqual([
      { ticketTypeId: 'tt_3', quantity: 1 },
    ])
  })

  it('drops invalid or non-positive item quantities', () => {
    expect(parseItemsParam('tt_1=0,tt_2=-2,tt_3=abc,tt_4=1')).toEqual([
      { ticketTypeId: 'tt_4', quantity: 1 },
    ])
  })

  it('parses product filters as trimmed ids', () => {
    const filter = parseProductFilterParam(' tt_1,tt_2 ,, ')
    expect(filter?.has('tt_1')).toBe(true)
    expect(filter?.has('tt_2')).toBe(true)
    expect(parseProductFilterParam(' ,, ')).toBeNull()
  })
})

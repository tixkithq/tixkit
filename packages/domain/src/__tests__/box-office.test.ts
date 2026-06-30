import { describe, it, expect } from 'vitest';
import {
  validateBoxOfficeOrder,
  groupRevenueByChannel,
  BoxOfficeError,
  type BoxOfficeOrderInput,
  type SalesChannel,
} from '../ticketing/box-office.js';

const baseInput: BoxOfficeOrderInput = {
  eventId: 'evt_1',
  tenantId: 'tnt_1',
  operatorId: 'usr_operator',
  tenderType: 'cash',
  items: [{ ticketTypeId: 'tt_1', quantity: 2 }],
  amountCents: 5000,
  currency: 'USD',
};

describe('validateBoxOfficeOrder', () => {
  it('validates a well-formed cash box-office order with box_office channel attribution', () => {
    const order = validateBoxOfficeOrder(baseInput);
    expect(order.salesChannel).toBe('box_office');
    expect(order.operatorId).toBe('usr_operator');
    expect(order.tenderType).toBe('cash');
    expect(order.amountCents).toBe(5000);
  });

  it('requires operator attribution', () => {
    expect(() => validateBoxOfficeOrder({ ...baseInput, operatorId: '' })).toThrow(BoxOfficeError);
  });

  it('rejects an invalid tender type', () => {
    expect(() => validateBoxOfficeOrder({ ...baseInput, tenderType: 'crypto' as any })).toThrow(
      BoxOfficeError,
    );
  });

  it('comp orders must have a zero amount', () => {
    expect(() =>
      validateBoxOfficeOrder({ ...baseInput, tenderType: 'comp', amountCents: 100 }),
    ).toThrow(BoxOfficeError);
    const comp = validateBoxOfficeOrder({ ...baseInput, tenderType: 'comp', amountCents: 0 });
    expect(comp.amountCents).toBe(0);
  });

  it('cash tender must have a positive amount', () => {
    expect(() =>
      validateBoxOfficeOrder({ ...baseInput, tenderType: 'cash', amountCents: 0 }),
    ).toThrow(BoxOfficeError);
  });

  it('manual_card tender requires a non-negative amount', () => {
    const order = validateBoxOfficeOrder({
      ...baseInput,
      tenderType: 'manual_card',
      amountCents: 5000,
    });
    expect(order.tenderType).toBe('manual_card');
  });

  it('rejects empty line items and non-positive quantities', () => {
    expect(() => validateBoxOfficeOrder({ ...baseInput, items: [] })).toThrow(BoxOfficeError);
    expect(() =>
      validateBoxOfficeOrder({ ...baseInput, items: [{ ticketTypeId: 'tt_1', quantity: 0 }] }),
    ).toThrow(BoxOfficeError);
  });
});

describe('groupRevenueByChannel', () => {
  it('groups revenue by sales channel', () => {
    const orders: { salesChannel: SalesChannel; amountCents: number }[] = [
      { salesChannel: 'online', amountCents: 1000 },
      { salesChannel: 'box_office', amountCents: 5000 },
      { salesChannel: 'online', amountCents: 2000 },
      { salesChannel: 'box_office', amountCents: 0 },
    ];
    expect(groupRevenueByChannel(orders)).toEqual({ online: 3000, box_office: 5000 });
  });
});

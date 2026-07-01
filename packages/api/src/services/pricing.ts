import type {
  PriceQuote,
  PriceLineItem,
  CartInput,
  TaxRule,
  FeeRule,
  DiscountCode,
  CurrencyCode,
  Ulid,
} from '@tixkit/domain';
import { ulid } from 'ulid';
import { DiscountInvalidError, ValidationError } from '@tixkit/domain';

export type TicketTypeForPricing = {
  id: string;
  name: string;
  kind: 'free' | 'paid' | 'donation';
  priceCents: number;
  minimumPriceCents?: number;
  currency: string;
  minPerOrder: number;
  maxPerOrder: number;
};

export type ProductForPricing = {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  maxPerOrder: number;
  status: 'active' | 'paused' | 'archived';
  availableFrom?: string;
  availableUntil?: string;
};

export type PricingInput = {
  currency: CurrencyCode;
  cart: CartInput;
  ticketTypes: Map<string, TicketTypeForPricing>;
  products?: Map<string, ProductForPricing>;
  taxRules: TaxRule[];
  feeRules: FeeRule[];
  discountCodes: DiscountCode[];
  buyerCountry?: string;
  buyerRegion?: string;
  quoteTtlSeconds?: number;
};

export class PricingEngine {
  calculate(input: PricingInput): PriceQuote {
    const { currency, cart, ticketTypes, taxRules, feeRules, discountCodes } = input;
    const products = input.products ?? new Map<string, ProductForPricing>();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (input.quoteTtlSeconds ?? 600) * 1000);

    let subtotalCents = 0;
    const pricedLines: Array<{
      type: 'ticket' | 'product';
      ticketTypeId?: string;
      eventOccurrenceId?: string;
      productId?: string;
      name: string;
      quantity: number;
      unitPriceCents: number;
      subtotalCents: number;
    }> = [];

    for (const item of cart.items) {
      if (item.ticketTypeId) {
        const tt = ticketTypes.get(item.ticketTypeId);
        if (!tt) {
          throw new DiscountInvalidError(item.ticketTypeId, 'ticket type not found');
        }
        if (tt.currency !== currency) {
          throw new ValidationError(
            `Ticket type ${tt.id} currency ${tt.currency} does not match cart currency ${currency}`,
          );
        }

        const quantity = item.quantity;
        if (quantity < tt.minPerOrder || quantity > tt.maxPerOrder) {
          throw new DiscountInvalidError(
            item.ticketTypeId,
            `quantity ${quantity} outside allowed range ${tt.minPerOrder}-${tt.maxPerOrder}`,
          );
        }

        const unitPrice = this.resolveUnitPrice(tt, item.unitAmountCents);

        if (tt.kind === 'donation' && tt.minimumPriceCents && unitPrice < tt.minimumPriceCents) {
          throw new DiscountInvalidError(
            item.ticketTypeId,
            `donation amount ${unitPrice} below minimum ${tt.minimumPriceCents}`,
          );
        }

        const lineSubtotal = unitPrice * quantity;
        subtotalCents += lineSubtotal;
        pricedLines.push({
          type: 'ticket',
          ticketTypeId: item.ticketTypeId,
          eventOccurrenceId: item.occurrenceId,
          name: tt.name,
          quantity,
          unitPriceCents: unitPrice,
          subtotalCents: lineSubtotal,
        });
        continue;
      }

      if (!item.productId) {
        throw new ValidationError('Cart item must include ticketTypeId or productId');
      }
      const product = products.get(item.productId);
      if (!product) {
        throw new DiscountInvalidError(item.productId, 'product not found');
      }
      this.validateProduct(product, item.quantity, currency, now);
      if (item.unitAmountCents !== undefined) {
        throw new ValidationError(`unitAmountCents is not accepted for product ${item.productId}`);
      }

      const lineSubtotal = product.priceCents * item.quantity;
      subtotalCents += lineSubtotal;
      pricedLines.push({
        type: 'product',
        productId: item.productId,
        name: product.name,
        quantity: item.quantity,
        unitPriceCents: product.priceCents,
        subtotalCents: lineSubtotal,
      });
    }

    let discountCents = 0;
    let taxCents = 0;
    let feeCents = 0;
    const lineItems: PriceLineItem[] = [];

    let appliedDiscount: DiscountCode | null = null;
    if (cart.discountCode) {
      appliedDiscount = this.findDiscount(
        discountCodes,
        cart.discountCode,
        subtotalCents,
        currency,
      );
    }

    if (
      appliedDiscount?.ticketTypeIds?.length &&
      (appliedDiscount.type === 'free_ticket' || appliedDiscount.value > 0) &&
      !pricedLines.some(
        (line) =>
          line.ticketTypeId !== undefined &&
          appliedDiscount.ticketTypeIds?.includes(line.ticketTypeId),
      )
    ) {
      throw new DiscountInvalidError(appliedDiscount.code, 'not applicable to selected items');
    }

    let remainingDiscountCap = appliedDiscount?.maxDiscountCents ?? Number.POSITIVE_INFINITY;

    for (const line of pricedLines) {
      let lineDiscount = 0;
      if (
        appliedDiscount &&
        (!appliedDiscount.ticketTypeIds ||
          (line.ticketTypeId && appliedDiscount.ticketTypeIds.includes(line.ticketTypeId)))
      ) {
        lineDiscount = Math.min(
          this.calculateDiscountForLine(appliedDiscount, line.subtotalCents, line.quantity),
          remainingDiscountCap,
        );
        remainingDiscountCap -= lineDiscount;
      }

      let lineFee = 0;
      for (const feeRule of feeRules) {
        if (feeRule.appliedTo === 'per_ticket') {
          const feeAmount =
            feeRule.type === 'percentage'
              ? Math.round(
                  ((line.subtotalCents - lineDiscount) * feeRule.value) / 10000 / line.quantity,
                )
              : feeRule.value;
          lineFee += feeAmount * line.quantity;
        } else if (feeRule.appliedTo === 'per_order') {
          continue;
        }
      }

      let lineTax = 0;
      const taxBreakdown: NonNullable<PriceLineItem['taxBreakdown']> = [];
      for (const taxRule of taxRules) {
        if (!this.taxApplies(taxRule, input.buyerCountry, input.buyerRegion)) continue;
        const taxableBase =
          taxRule.appliedTo === 'ticket' || taxRule.appliedTo === 'all'
            ? line.subtotalCents - lineDiscount
            : 0;
        const feeTaxable = taxRule.appliedTo === 'fee' || taxRule.appliedTo === 'all' ? lineFee : 0;
        const totalTaxable = taxableBase + feeTaxable;
        if (totalTaxable <= 0) continue;
        let ruleTax = 0;
        if (taxRule.type === 'inclusive') {
          const taxPortion = Math.round(totalTaxable - totalTaxable / (1 + taxRule.rate / 10000));
          ruleTax = taxPortion;
        } else {
          ruleTax = Math.round((totalTaxable * taxRule.rate) / 10000);
        }
        lineTax += ruleTax;
        taxBreakdown.push({
          taxRuleId: taxRule.id,
          taxRuleName: taxRule.name,
          rate: taxRule.rate,
          type: taxRule.type,
          appliedTo: taxRule.appliedTo,
          taxableAmountCents: totalTaxable,
          taxCents: ruleTax,
          jurisdictionCountry: taxRule.countries?.[0],
          jurisdictionRegion: taxRule.regions?.[0],
          provider: 'tixkit_rules',
        });
      }

      const hasInclusiveTax = taxRules.some(
        (r) => r.type === 'inclusive' && this.taxApplies(r, input.buyerCountry, input.buyerRegion),
      );
      const lineTotal = hasInclusiveTax
        ? line.subtotalCents - lineDiscount + lineFee
        : line.subtotalCents - lineDiscount + lineFee + lineTax;

      lineItems.push({
        type: line.type,
        ticketTypeId: line.ticketTypeId as Ulid | undefined,
        eventOccurrenceId: line.eventOccurrenceId as Ulid | undefined,
        productId: line.productId as Ulid | undefined,
        name: line.name,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        subtotalCents: line.subtotalCents,
        discountCents: lineDiscount,
        taxCents: lineTax,
        taxBreakdown,
        feeCents: lineFee,
        totalCents: lineTotal,
      });

      discountCents += lineDiscount;
      taxCents += lineTax;
      feeCents += lineFee;
    }

    for (const feeRule of feeRules) {
      if (feeRule.appliedTo === 'per_order') {
        const feeAmount =
          feeRule.type === 'percentage'
            ? Math.round(((subtotalCents - discountCents) * feeRule.value) / 10000)
            : feeRule.value;
        feeCents += feeAmount;
      }
    }

    const hasInclusiveTax = taxRules.some(
      (r) => r.type === 'inclusive' && this.taxApplies(r, input.buyerCountry, input.buyerRegion),
    );
    const totalCents = hasInclusiveTax
      ? subtotalCents - discountCents + feeCents
      : subtotalCents - discountCents + taxCents + feeCents;

    return {
      id: `pq_${ulid()}`,
      currency,
      subtotalCents,
      discountCents,
      taxCents,
      feeCents,
      totalCents,
      lineItems,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private resolveUnitPrice(tt: TicketTypeForPricing, requestedUnitAmountCents?: number): number {
    if (tt.kind === 'free') return 0;
    if (tt.kind === 'paid') return tt.priceCents;
    if (requestedUnitAmountCents === undefined) {
      throw new DiscountInvalidError(tt.id, 'donation amount is required');
    }
    return requestedUnitAmountCents;
  }

  private validateProduct(
    product: ProductForPricing,
    quantity: number,
    currency: CurrencyCode,
    now: Date,
  ): void {
    if (product.currency !== currency) {
      throw new ValidationError(
        `Product ${product.id} currency ${product.currency} does not match cart currency ${currency}`,
      );
    }
    if (quantity < 1 || quantity > product.maxPerOrder) {
      throw new DiscountInvalidError(
        product.id,
        `quantity ${quantity} outside allowed range 1-${product.maxPerOrder}`,
      );
    }
    if (product.status !== 'active') {
      throw new DiscountInvalidError(product.id, `status is ${product.status}`);
    }
    if (product.availableFrom && now < new Date(product.availableFrom)) {
      throw new DiscountInvalidError(product.id, 'not yet available');
    }
    if (product.availableUntil && now > new Date(product.availableUntil)) {
      throw new DiscountInvalidError(product.id, 'no longer available');
    }
  }

  private findDiscount(
    codes: DiscountCode[],
    code: string,
    subtotalCents: number,
    currency: CurrencyCode,
  ): DiscountCode | null {
    const upperCode = code.toUpperCase();
    const discount = codes.find((d) => d.code.toUpperCase() === upperCode);
    if (!discount) {
      throw new DiscountInvalidError(code, 'code not found');
    }

    if (discount.status !== 'active') {
      throw new DiscountInvalidError(code, `status is ${discount.status}`);
    }

    const now = new Date();
    if (discount.validFrom && now < new Date(discount.validFrom)) {
      throw new DiscountInvalidError(code, 'not yet valid');
    }
    if (discount.validUntil && now > new Date(discount.validUntil)) {
      throw new DiscountInvalidError(code, 'expired');
    }
    if (discount.usesCount >= discount.maxUses) {
      throw new DiscountInvalidError(code, 'max uses reached');
    }
    if (discount.currency !== currency) {
      throw new DiscountInvalidError(
        code,
        `currency ${discount.currency} does not match ${currency}`,
      );
    }
    if (discount.minOrderCents != null && subtotalCents < discount.minOrderCents) {
      throw new DiscountInvalidError(code, `minimum order is ${discount.minOrderCents} cents`);
    }

    return discount;
  }

  private calculateDiscountForLine(
    discount: DiscountCode,
    lineSubtotal: number,
    quantity: number,
  ): number {
    switch (discount.type) {
      case 'percentage':
        return Math.round((lineSubtotal * discount.value) / 10000);
      case 'fixed_amount':
        return Math.min(discount.value * quantity, lineSubtotal);
      case 'free_ticket':
        return lineSubtotal;
      default:
        return 0;
    }
  }

  private taxApplies(rule: TaxRule, buyerCountry?: string, buyerRegion?: string): boolean {
    if (!rule.countries && !rule.regions) return true;
    if (rule.countries && buyerCountry && !rule.countries.includes(buyerCountry)) return false;
    if (rule.regions && buyerRegion && !rule.regions.includes(buyerRegion)) return false;
    return true;
  }
}

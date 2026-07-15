import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openApiSpec, generateOpenApiTypes } from '../index.js';

/**
 * Generated-client compile validation (T33).
 *
 * Uses TixKit's TypeScript 7-compatible generator to generate types from the
 * OpenAPI spec and verifies the output contains the supported SDK contracts.
 * This catches schema regressions that would break generated SDK clients.
 */

async function generateTypes(): Promise<string> {
  return generateOpenApiTypes(openApiSpec);
}

describe('Generated client compile validation (T33)', () => {
  it('generates valid TypeScript from the spec', async () => {
    const output = await generateTypes();

    // Verify the output is non-empty and contains expected patterns.
    expect(output).toBeTruthy();
    expect(output.length).toBeGreaterThan(1000);
    expect(output).toContain('paths');
    expect(output).toContain('components');
    expect(output).toContain('schemas');

    // Verify key schema types are present in the generated output.
    expect(output).toContain('Event');
    expect(output).toContain('Order');
    expect(output).toContain('CheckoutSession');
    expect(output).toContain('EventFeePolicy');
    expect(output).toContain('Organization');
    expect(output).toContain('Brand');
    expect(output).toContain('paymentAccountId');
    expect(output).toContain('/agent/plans/{planId}/transitions');
    expect(output).toContain('PersistedAgentPlan');

    const directory = mkdtempSync(join(tmpdir(), 'tixkit-openapi-types-'));
    try {
      const generatedPath = join(directory, 'openapi.generated.ts');
      const compilerPath = resolve(
        import.meta.dirname,
        '../../../../node_modules/typescript/bin/tsc',
      );
      writeFileSync(
        generatedPath,
        `${output}\n\ntype CheckoutRequest = paths["/checkout/sessions"]["post"]["requestBody"]["content"]["application/json"];\ntype MemberUpdateResponse = paths["/organizations/{organizationId}/members/{memberId}"]["patch"]["responses"][200]["content"]["application/json"];\nconst validCheckout: CheckoutRequest = { eventId: "evt_1", items: [{ ticketTypeId: "tt_1", quantity: 1 }], buyer: { email: "buyer@example.test" } };\nconst validMember: MemberUpdateResponse = { id: "mem_1", organizationId: "org_1", name: "Ada Lovelace", email: "ada@example.test", role: "organizer", status: "invited", invitedAt: "2026-01-01T00:00:00.000Z", joinedAt: null, brandIds: [], eventIds: [] };\n// @ts-expect-error member update responses always include joinedAt, even when null\nconst invalidMember: MemberUpdateResponse = { id: "mem_1", organizationId: "org_1", name: "Ada Lovelace", email: "ada@example.test", role: "organizer", status: "invited", invitedAt: "2026-01-01T00:00:00.000Z", brandIds: [], eventIds: [] };\n// @ts-expect-error ticket and product identifiers are mutually exclusive\nconst invalidMixedCheckout: CheckoutRequest = { eventId: "evt_1", items: [{ ticketTypeId: "tt_1", productId: "prod_1", quantity: 1 }], buyer: { email: "buyer@example.test" } };\nvoid validCheckout;\nvoid validMember;\nvoid invalidMember;\nvoid invalidMixedCheckout;\n`,
      );
      execFileSync(
        process.execPath,
        [compilerPath, '--ignoreConfig', '--noEmit', '--strict', generatedPath],
        {
          stdio: 'pipe',
        },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);

  it('generated types include all paginated envelope schemas', async () => {
    const output = await generateTypes();

    // Paginated envelopes should be present as schemas.
    expect(output).toContain('EventPage');
    expect(output).toContain('OrderPage');
    expect(output).toContain('prevCursor?: string | null');
    expect(output).toContain('filterTotal?: number');
    expect(output).toContain('[key: string]: components["schemas"]["AdminTableFacet"]');
    expect(output).toContain('applied?: components["schemas"]["AdminTableAppliedQuery"]');
    expect(output).not.toContain(
      'EventPage: {\\n            items: components["schemas"]["Event"][];\\n            nextCursor: string | null;\\n            hasMore: boolean;',
    );
    expect(output).not.toContain('OrganizationPage');
    expect(output).not.toContain('BrandPage');
    expect(output).not.toContain('PaymentAccountPage');
  });

  it('generated types preserve public event-page and resale SDK surfaces', async () => {
    const output = await generateTypes();

    for (const path of [
      '/public/events/{eventId}/page',
      '/public/events/{eventId}/bootstrap',
      '/public/events/{eventId}/page-bootstrap',
      '/public/events/{eventId}/content-page',
      '/public/events/{eventId}/discovery-card',
      '/public/events/by-slug/{slug}',
      '/public/events/{eventId}/revision',
      '/public/events/{eventId}/resale-listings',
      '/public/events/by-slug/{slug}/page',
      '/public/events/by-slug/{slug}/page-bootstrap',
      '/public/brand-logos/{artifactId}',
      '/public/content-event-page-images/{artifactId}',
      '/s/{slug}',
      '/tickets/{ticketId}/resale-listings',
      '/checkout/sessions/{sessionId}/tickets/{ticketId}/resale-listing',
      '/ticket-listings/{listingId}/delist',
      '/ticket-listings/{listingId}/complete',
    ]) {
      expect(output).toContain(path);
    }

    for (const schema of [
      'PublicContentPage',
      'PublicCheckoutBootstrap',
      'PublicEventPageBootstrap',
      'EventPageDocumentV2',
      'PuckData',
      'PuckComponentData',
      'DraftPreviewPage',
      'PublicEvent',
      'PublicMarketingIntegration',
      'PublicEventDiscoveryCard',
      'PublicEventRevision',
      'PublicTicketListing',
      'PublicTicketListingPage',
      'TicketListing',
      'TicketListingPage',
      'TicketResaleCompletion',
    ]) {
      expect(output).toContain(schema);
    }

    expect(output).toContain('"X-Checkout-Session-Token"');
    expect(output).toContain('"Idempotency-Key"');
    expect(output).toContain('DraftPreviewPage');
    expect(output).toContain('data: components["schemas"]["PuckData"]');
    expect(output).toContain('puckData: components["schemas"]["PuckData"]');
    expect(output).toContain('content: Array<components["schemas"]["PuckComponentData"]>');
    expect(output).not.toContain('ResolvedEventPage');
    expect(output).not.toContain('headless: components["schemas"]["PublicEventPageBlock"][]');
    expect(output).not.toContain('renderModel:');
    expect(output).toContain('version: {');
    expect(output).toContain('versionNumber: number');
    expect(output).toContain('status: string');
    expect(output).toContain(
      'marketingIntegrations: Array<components["schemas"]["PublicMarketingIntegration"]>',
    );
  });

  it('generated types preserve public availability product rows', async () => {
    const output = await generateTypes();

    expect(output).toContain('/public/events/{eventId}/availability');
    expect(output).toContain('PublicAvailabilityItem');
    expect(output).toContain('PublicAvailabilityTicketItem');
    expect(output).toContain('PublicAvailabilityProductItem');
    expect(output).toContain('productId: string');
    expect(output).toContain('type: "product"');
    expect(output).toContain('products?: string');
  });

  it('generated types preserve the event-scoped message render-preview contract', async () => {
    const output = await generateTypes();

    expect(output).toContain('/events/{eventId}/messages/render-preview');
    expect(output).toContain('unknownTags');
    expect(output).toContain('charsPerSegment');
    expect(output).toContain('unitsUsed');
    expect(output).toContain('remaining');
  });

  it('generated types include checkout session and attendee update request bodies', async () => {
    const output = await generateTypes();

    expect(output).toContain('CheckoutSessionUpdateInput');
    expect(output).toContain('AttendeeUpdateInput');
    expect(output).toContain('UpdateEventFeePolicyInput');
    expect(output).toContain('/checkout/sessions/{sessionId}');
    expect(output).toContain('/attendees/{attendeeId}');
    expect(output).toContain('/events/{eventId}/fee-policy');
    expect(output).toContain('buyerFeeCents?: number');
    expect(output).toContain('organizerAbsorbedFeeCents?: number');
    expect(output).toContain('successUrl?: string');
    expect(output).toContain('cancelUrl?: string');
    expect(output).toContain(
      'status?: "pending" | "confirmed" | "cancelled" | "refunded" | "checked_in"',
    );
  });

  it('preserves schema combinators and array element unions', async () => {
    const output = await generateTypes();

    expect(output).toContain('PrivacyRequestInput: ({');
    expect(output).not.toContain('PrivacyRequestInput: unknown');
    expect(output).toContain('items: Array<(');
    expect(output).not.toContain('PuckComponentData>[] |');
  });
});

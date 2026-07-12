import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPortableLogicalExport,
  createPortableConfigurationPayloadPolicies,
  PORTABLE_CONFIGURATION_POLICY_VERSION,
} from '../index.js';

const organization = {
  portableId: 'organization_1',
  attributes: {
    name: 'Organizer',
    slug: 'organizer',
    status: 'active',
    boxOfficeSettings: {
      enabled: true,
      allowedTenderTypes: ['cash'],
      requireBuyerEmail: false,
      receiptMode: 'email',
    },
    eventDefaults: {},
  },
};

describe('portable configuration section policies', () => {
  it('uses stable real hashes and rejects unknown fields or incorrect types', () => {
    const first = createPortableConfigurationPayloadPolicies().get('organizations')!;
    const second = createPortableConfigurationPayloadPolicies().get('organizations')!;
    expect(PORTABLE_CONFIGURATION_POLICY_VERSION).toBe('tixkit-portable-configuration-policy-v1');
    expect(first.schemaSha256).toBe(
      '273cb7dbcdfa1081a0cddc64a6cca8ba1bac5ac8ed996e9419b1c0570d799f4d',
    );
    expect(first.policySha256).toBe(
      '061d057e3c2838d63e993ea2216aa53d2a7af61901f848b81735454ebff8e8ee',
    );
    expect(second.schemaSha256).toBe(first.schemaSha256);
    expect(first.validateRecord('organizations', organization)).toBe(true);
    expect(
      first.validateRecord('organizations', {
        ...organization,
        attributes: { ...organization.attributes, paymentAccountId: 'managed-account' },
      }),
    ).toBe(false);
    expect(
      first.validateRecord('organizations', {
        ...organization,
        attributes: { ...organization.attributes, status: 1 },
      }),
    ).toBe(false);
  });

  it('rejects unsafe enums, amounts, timestamps, ranges, and consent combinations', () => {
    const policies = createPortableConfigurationPayloadPolicies();
    const ticket = {
      portableId: 'ticket_type_1',
      attributes: {
        name: 'General',
        description: null,
        kind: 'paid',
        status: 'active',
        visibility: 'public',
        currency: 'USD',
        priceMinor: 2500,
        minimumPriceMinor: null,
        salesStartAt: '2026-01-01T00:00:00.000Z',
        salesEndAt: '2026-02-01T00:00:00.000Z',
        minPerOrder: 1,
        maxPerOrder: 8,
        sortOrder: 0,
        requiresAccessCode: false,
      },
    };
    const ticketPolicy = policies.get('ticket_types')!;
    expect(ticketPolicy.validateRecord('ticket_types', ticket)).toBe(true);
    for (const attributes of [
      { ...ticket.attributes, status: 'invented' },
      { ...ticket.attributes, currency: 'usd' },
      { ...ticket.attributes, priceMinor: -1 },
      { ...ticket.attributes, priceMinor: 1.5 },
      { ...ticket.attributes, priceMinor: Number.MAX_SAFE_INTEGER + 1 },
      { ...ticket.attributes, salesStartAt: 'tomorrow' },
      { ...ticket.attributes, minPerOrder: 9, maxPerOrder: 8 },
      {
        ...ticket.attributes,
        salesStartAt: '2026-03-01T00:00:00.000Z',
        salesEndAt: '2026-02-01T00:00:00.000Z',
      },
    ]) {
      expect(ticketPolicy.validateRecord('ticket_types', { ...ticket, attributes })).toBe(false);
    }
    expect(
      policies.get('checkout_questions')!.validateRecord('checkout_questions', {
        portableId: 'question_1',
        attributes: {
          label: 'Consent',
          type: 'checkbox',
          description: null,
          required: true,
          appliesTo: 'buyer',
          options: null,
          placeholder: null,
          sortOrder: 0,
          isConsentField: true,
          consentText: null,
          consentVersion: null,
        },
      }),
    ).toBe(false);
  });

  it('rejects malformed nested settings and credential-bearing public URLs', () => {
    const policies = createPortableConfigurationPayloadPolicies();
    const organizationPolicy = policies.get('organizations')!;
    for (const attributes of [
      { ...organization.attributes, boxOfficeSettings: null },
      { ...organization.attributes, boxOfficeSettings: [] },
      {
        ...organization.attributes,
        boxOfficeSettings: {
          ...(organization.attributes.boxOfficeSettings as object),
          unexpected: true,
        },
      },
      { ...organization.attributes, eventDefaults: { unknownDefault: true } },
    ]) {
      expect(
        organizationPolicy.validateRecord('organizations', { ...organization, attributes }),
      ).toBe(false);
    }
    const brandPolicy = policies.get('brands')!;
    const brand = {
      portableId: 'brand_1',
      attributes: {
        name: 'Brand',
        slug: 'brand',
        status: 'active',
        theme: {
          primaryColor: '#123456',
          secondaryColor: '#234567',
          accentColor: '#345678',
          backgroundColor: '#ffffff',
          textColor: '#111111',
          fontFamily: 'Inter, sans-serif',
          borderRadius: 8,
        },
        supportUrl: 'https://support.example.test',
        legalUrls: { privacy: 'https://example.test/privacy' },
        whiteLabel: false,
      },
    };
    expect(brandPolicy.validateRecord('brands', brand)).toBe(true);
    for (const attributes of [
      { ...brand.attributes, theme: [] },
      { ...brand.attributes, theme: { unknownToken: 'value' } },
      { ...brand.attributes, theme: { borderRadius: '8px' } },
      { ...brand.attributes, theme: { primaryColor: 'red; background: url(x)' } },
      { ...brand.attributes, theme: { logoArtifactId: 'upl_local_artifact' } },
      { ...brand.attributes, theme: { iconArtifactId: 'upl_local_artifact' } },
      { ...brand.attributes, theme: { logoUrl: 'https://example.test/logo.png' } },
      { ...brand.attributes, theme: { faviconUrl: 'https://example.test/favicon.ico' } },
      { ...brand.attributes, theme: { customCss: 'body { display: none; }' } },
      { ...brand.attributes, supportUrl: 'https://user:password@example.test/help' },
      { ...brand.attributes, supportUrl: 'https://example.test/help?api_key=value' },
      {
        ...brand.attributes,
        legalUrls: { privacy: 'https://example.test/privacy?token=value' },
      },
    ]) {
      expect(brandPolicy.validateRecord('brands', { ...brand, attributes })).toBe(false);
    }
  });

  it('rejects secret material nested inside configuration JSON before signing', () => {
    const keys = generateKeyPairSync('ed25519');
    expect(() =>
      buildPortableLogicalExport({
        bundleId: 'bundle_secret_regression_01',
        mode: 'configuration',
        source: {
          operatingModel: 'self-hosted',
          deploymentId: 'deployment_source',
          tenantId: 'tenant_1',
          exportSequence: 1,
          changeCursor: 'cursor_1',
        },
        apiVersion: '2026-01-01',
        dataSchemaVersion: '0067',
        exportedAt: '2026-07-12T20:00:00.000Z',
        currentTime: '2026-07-12T20:00:00.000Z',
        compatibility: {
          minimumApiVersion: '2026-01-01',
          maximumApiVersion: '2026-12-31',
          minimumDataSchemaVersion: '0064',
          maximumDataSchemaVersion: '0069',
          requiredCapabilities: [],
          requiredEntitlements: [],
        },
        sections: new Map([
          [
            'organizations',
            [
              {
                ...organization,
                attributes: {
                  ...organization.attributes,
                  eventDefaults: { nested: { apiKey: 'not-exportable' } },
                },
              },
            ],
          ],
        ]),
        bundleSigning: { keyId: 'bundle_key_01', privateKey: keys.privateKey },
        payloadSigning: { keyId: 'payload_key_01', privateKey: keys.privateKey },
        payloadPolicies: createPortableConfigurationPayloadPolicies(),
      }),
    ).toThrow(/forbidden field/u);
  });
});

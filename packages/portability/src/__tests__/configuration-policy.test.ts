import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildPortableLogicalExport,
  createPortableConfigurationPayloadPolicies,
  PORTABLE_CONFIGURATION_POLICY_VERSION,
  verifyAndPreflightPortableImport,
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
    expect(PORTABLE_CONFIGURATION_POLICY_VERSION).toBe('tixkit-portable-configuration-policy-v2');
    expect(first.schemaSha256).toBe(
      '7b21f14c0c8a67266b4d993a27a809feb7d7ef9336d25afbd0efb6b685223565',
    );
    expect(first.policySha256).toBe(
      '92fcb06b8eae3a609981b1097f2c07b9fba03619619c6c85d2c203340932fe1d',
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

  it('round-trips both rotating code-format boundaries and rejects neighboring values', () => {
    const policies = createPortableConfigurationPayloadPolicies();
    const policy = policies.get('events')!;
    const event = (codeFormat: Record<string, unknown>, portableId = 'event_code_format_1') => ({
      portableId,
      attributes: {
        title: 'Portable scanner event',
        slug: 'portable-scanner-event',
        status: 'draft',
        currency: 'USD',
        timezone: 'UTC',
        startsAt: '2027-01-01T18:00:00.000Z',
        visibility: 'public',
        codeFormat,
      },
    });
    const minimum = {
      symbology: 'qr',
      payloadFormat: 'signed_v1',
      rotating: { timeStepSeconds: 15, toleranceWindows: 0, digits: 6 },
    };
    const maximum = {
      symbology: 'data_matrix',
      payloadFormat: 'compact_v2',
      rotating: { timeStepSeconds: 300, toleranceWindows: 5, digits: 10 },
    };
    expect(policy.validateRecord('events', event(minimum))).toBe(true);
    expect(policy.validateRecord('events', event(maximum))).toBe(true);
    for (const rotating of [
      { timeStepSeconds: 14, toleranceWindows: 0, digits: 6 },
      { timeStepSeconds: 301, toleranceWindows: 0, digits: 6 },
      { timeStepSeconds: 15, toleranceWindows: -1, digits: 6 },
      { timeStepSeconds: 15, toleranceWindows: 6, digits: 6 },
      { timeStepSeconds: 15, toleranceWindows: 0, digits: 5 },
      { timeStepSeconds: 15, toleranceWindows: 0, digits: 11 },
    ]) {
      expect(policy.validateRecord('events', event({ ...minimum, rotating }))).toBe(false);
    }

    const keys = generateKeyPairSync('ed25519');
    const built = buildPortableLogicalExport({
      bundleId: 'bundle_code_format_boundaries_01',
      mode: 'configuration',
      source: {
        operatingModel: 'self-hosted',
        deploymentId: 'deployment_source',
        tenantId: 'tenant_1',
        organizationId: 'organization_1',
        exportSequence: 1,
        changeCursor: 'cursor_code_format_1',
      },
      apiVersion: '2026-07-17',
      dataSchemaVersion: '0077',
      exportedAt: '2026-07-17T12:00:00.000Z',
      currentTime: '2026-07-17T12:00:00.000Z',
      compatibility: {
        minimumApiVersion: '2026-01-01',
        maximumApiVersion: '2026-12-31',
        minimumDataSchemaVersion: '0077',
        maximumDataSchemaVersion: '0077',
        requiredCapabilities: ['portable-bundle-v2'],
        requiredEntitlements: [],
      },
      sections: new Map([
        [
          'events',
          [event(minimum, 'event_code_format_min'), event(maximum, 'event_code_format_max')],
        ],
      ]),
      bundleSigning: { keyId: 'bundle_key_code_format', privateKey: keys.privateKey },
      payloadSigning: { keyId: 'payload_key_code_format', privateKey: keys.privateKey },
      payloadPolicies: policies,
    });
    expect(built.envelope.manifest.entityCounts).toEqual({ events: 2 });
    expect(
      verifyAndPreflightPortableImport(
        built.envelope,
        {
          deploymentId: 'deployment_destination',
          apiVersion: '2026-07-17',
          dataSchemaVersion: '0077',
          capabilities: ['portable-bundle-v2'],
          entitlements: [],
          availableStorageBytes: 1024 * 1024,
          acceptedSourceOperatingModels: ['self-hosted'],
        },
        new Map([['bundle_key_code_format', keys.publicKey]]),
        new Map([['payload_key_code_format', keys.publicKey]]),
        new Map([
          [
            'events',
            {
              schemaId: policy.schemaId,
              schemaSha256: policy.schemaSha256,
              policySha256: policy.policySha256,
              scannerId: policy.scannerId,
              keyId: 'payload_key_code_format',
            },
          ],
        ]),
        new Map([['payload_key_code_format', keys.publicKey]]),
        new Map(),
      ).compatible,
    ).toBe(true);
  });

  it('accepts logical content versions and rejects malformed or duplicate version identity', () => {
    const policy = createPortableConfigurationPayloadPolicies().get('content')!;
    const content = {
      portableId: 'content_document_1',
      attributes: {
        channel: 'event_page',
        key: 'main',
        name: 'Event page',
        locale: 'en',
        versions: [
          {
            portableId: 'content_version_1',
            versionNumber: 1,
            schemaVersion: 2,
            subject: null,
            previewText: null,
            contentJson: {
              schemaVersion: 2,
              editor: {
                provider: '@puckeditor/core',
                data: {
                  root: { props: {} },
                  content: [
                    {
                      type: 'Media',
                      props: {
                        id: 'portable-poster',
                        imageUrl: 'tixkit:event-media:poster',
                        imageAlt: 'Poster',
                      },
                    },
                  ],
                },
              },
              settings: { locale: 'en', discovery: { summary: 'Portable event page', tags: [] } },
            },
            variables: [],
            validation: { valid: true, severity: 'warning', issues: [] },
            createdAt: '2026-07-15T00:00:00.000Z',
          },
        ],
      },
    };

    expect(policy.validateRecord('content', content)).toBe(true);
    const version = content.attributes.versions[0];
    expect(
      policy.validateRecord('content', {
        ...content,
        attributes: {
          ...content.attributes,
          versions: [{ ...version, contentJson: null }],
        },
      }),
    ).toBe(false);
    for (const malformedContentJson of [
      {
        ...version.contentJson,
        editor: {
          ...version.contentJson.editor,
          data: {
            ...version.contentJson.editor.data,
            content: [{ type: 'TotallyUnknown', props: { id: 'unknown' } }],
          },
        },
      },
      {
        ...version.contentJson,
        editor: {
          ...version.contentJson.editor,
          data: {
            ...version.contentJson.editor.data,
            content: [{ type: 'Media', props: { id: 'missing-required-image-props' } }],
          },
        },
      },
      {
        ...version.contentJson,
        editor: {
          ...version.contentJson.editor,
          data: {
            ...version.contentJson.editor.data,
            content: [
              { type: 'EventDetails', props: { id: 'empty-details', title: 'Details', items: [] } },
            ],
          },
        },
      },
      {
        ...version.contentJson,
        editor: {
          ...version.contentJson.editor,
          data: {
            ...version.contentJson.editor.data,
            content: [
              {
                type: 'Button',
                props: { id: 'unsafe-button', label: 'Unsafe', url: 'javascript:alert(1)' },
              },
            ],
          },
        },
      },
      {
        ...version.contentJson,
        editor: {
          ...version.contentJson.editor,
          data: {
            ...version.contentJson.editor.data,
            content: [
              {
                type: 'CustomEmbed',
                props: { id: 'unsafe-embed', html: '<script>alert(1)</script>' },
              },
            ],
          },
        },
      },
      { ...version.contentJson, editor: { ...version.contentJson.editor, data: { root: [] } } },
      { ...version.contentJson, settings: { locale: 'en', discovery: { summary: 1, tags: [] } } },
    ]) {
      expect(
        policy.validateRecord('content', {
          ...content,
          attributes: {
            ...content.attributes,
            versions: [{ ...version, contentJson: malformedContentJson }],
          },
        }),
      ).toBe(false);
    }
    expect(
      policy.validateRecord('content', {
        ...content,
        attributes: {
          ...content.attributes,
          versions: [
            {
              ...version,
              contentJson: {
                ...version.contentJson,
                editor: {
                  ...version.contentJson.editor,
                  data: {
                    ...version.contentJson.editor.data,
                    content: [
                      {
                        type: 'Button',
                        props: {
                          id: 'misplaced-media-reference',
                          url: 'tixkit:event-media:cover',
                          label: 'Unsafe',
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
    ).toBe(false);
    for (const imageUrl of [
      'blob:https://source.example/private',
      '/v1/events/evt_source/media/renditions/emr_source',
      '/v1/upload-artifacts/upl_source',
      '/v1/public/content-event-page-images/upl_source',
      'https://user:password@cdn.example.test/private.webp',
      'https://cdn.example.test/private.webp?token=secret',
      'https://172.20.0.4/private.webp',
      'https://media.internal.local/private.webp',
      '<img src="&#x2f;v1&#x2f;events&#x2f;evt_secret">',
      '<img src="/%76%31/events/evt_secret">',
      '<img src="https://[::ffff:127.0.0.1]/secret">',
      '<img src="https&colon;&sol;&sol;&lbrack;&colon;&colon;ffff&colon;127&period;0&period;0&period;1&rbrack;&sol;secret">',
      '<img src="/%76%31/events/secret"><i data-x="%ZZ">',
    ]) {
      expect(
        policy.validateRecord('content', {
          ...content,
          attributes: {
            ...content.attributes,
            versions: [
              {
                ...version,
                contentJson: {
                  ...version.contentJson,
                  editor: {
                    ...version.contentJson.editor,
                    data: {
                      ...version.contentJson.editor.data,
                      content: [
                        {
                          type: 'Media',
                          props: { id: 'unsafe-image', imageUrl, imageAlt: 'Unsafe' },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        }),
        imageUrl,
      ).toBe(false);
    }
    for (const body of [
      '<img src="//127.0.0.1/private">',
      '<img src="https:\\127.0.0.1\\private">',
      '<div style="background:url(https\\3a\\2f\\2f127\\2e0\\2e0\\2e1/private)">x</div>',
      '<img src="\\\\127.0.0.1\\private">',
      '<img src="/\\127.0.0.1/private">',
      '<img src="ht&#x09;tps://127.0.0.1/private">',
      '<img src="htt&#10;ps://127.0.0.1/private">',
    ]) {
      const richTextDocument = structuredClone(version.contentJson);
      richTextDocument.editor.data.content = [
        { type: 'RichText', props: { id: 'browser-normalization-probe', body } },
      ];
      expect(
        policy.validateRecord('content', {
          ...content,
          attributes: {
            ...content.attributes,
            versions: [{ ...version, contentJson: richTextDocument }],
          },
        }),
        body,
      ).toBe(false);
    }
    expect(
      policy.validateRecord('content', {
        ...content,
        attributes: { ...content.attributes, channel: 'unknown' },
      }),
    ).toBe(false);
    expect(
      policy.validateRecord('content', {
        ...content,
        attributes: {
          ...content.attributes,
          versions: [content.attributes.versions[0], content.attributes.versions[0]],
        },
      }),
    ).toBe(false);
    expect(
      policy.validateRecord('content', {
        ...content,
        attributes: {
          ...content.attributes,
          versions: [{ ...content.attributes.versions[0], organizerUrl: '/v1/events/evt_1/media' }],
        },
      }),
    ).toBe(false);
  });

  it('validates portable email and SMS bodies against their channel contracts', () => {
    const policy = createPortableConfigurationPayloadPolicies().get('content')!;
    const record = (channel: string, contentJson: unknown) => ({
      portableId: `content_${channel}`,
      attributes: {
        channel,
        key: 'main',
        name: `${channel} content`,
        locale: 'en',
        versions: [
          {
            portableId: `version_${channel}`,
            versionNumber: 1,
            schemaVersion: 1,
            subject: null,
            previewText: null,
            contentJson,
            variables: [],
            validation: { valid: true, severity: 'warning', issues: [] },
            createdAt: '2026-07-15T00:00:00.000Z',
          },
        ],
      },
    });
    const email = {
      schemaVersion: 1,
      editor: { provider: '@react-email/editor', contentHtml: '<p>Hello</p>' },
      settings: {
        templateKey: 'event-update',
        subject: 'Event update',
        locale: 'en',
        category: 'transactional',
        sender: {},
      },
      blocks: [],
    };
    const sms = {
      schemaVersion: 1,
      editor: {
        provider: '@tixkit/content-message/sms-composer',
        body: 'Your event starts soon.',
      },
      settings: {
        templateKey: 'event-update',
        locale: 'en',
        category: 'transactional',
        consentCategory: 'transactional',
        segmentLimit: 3,
        estimatedCostPerSegmentCents: 2,
      },
      shortLinks: [],
    };

    expect(policy.validateRecord('content', record('email', email))).toBe(true);
    for (const contentHtml of [
      '<img src="&#x2f;v1&#x2f;events&#x2f;evt_secret">',
      '<img src="/%76%31/events/evt_secret">',
      '<img src="https://[::ffff:127.0.0.1]/secret">',
      '<img src="https&colon;&sol;&sol;&lbrack;&colon;&colon;ffff&colon;127&period;0&period;0&period;1&rbrack;&sol;secret">',
      '<img src="/%76%31/events/secret"><i data-x="%ZZ">',
      '<img src="//127.0.0.1/private">',
      '<img src="https:\\127.0.0.1\\private">',
      '<div style="background:url(https\\3a\\2f\\2f127\\2e0\\2e0\\2e1/private)">x</div>',
      '<img src="\\\\127.0.0.1\\private">',
      '<img src="/\\127.0.0.1/private">',
      '<img src="ht&#x09;tps://127.0.0.1/private">',
      '<img src="htt&#10;ps://127.0.0.1/private">',
    ]) {
      expect(
        policy.validateRecord(
          'content',
          record('email', { ...email, editor: { ...email.editor, contentHtml } }),
        ),
      ).toBe(false);
    }
    expect(
      policy.validateRecord(
        'content',
        record('email', {
          ...email,
          editor: {
            ...email.editor,
            globalCss: 'body{background:url(https\\3a\\2f\\2f127\\2e0\\2e0\\2e1/private)}',
          },
        }),
      ),
    ).toBe(false);
    expect(policy.validateRecord('content', record('sms', sms))).toBe(true);
    expect(
      policy.validateRecord(
        'content',
        record('email', { ...email, editor: { provider: 'unknown', contentHtml: '<p>x</p>' } }),
      ),
    ).toBe(false);
    expect(
      policy.validateRecord('content', {
        ...record('sms', sms),
        attributes: {
          ...record('sms', sms).attributes,
          versions: [
            {
              ...record('sms', sms).attributes.versions[0],
              contentJson: {
                ...sms,
                editor: { ...sms.editor, body: 'Open https://127.0.0.1/private?token=secret' },
              },
            },
          ],
        },
      }),
    ).toBe(false);
    expect(policy.validateRecord('content', record('imessage', {}))).toBe(false);
    expect(policy.validateRecord('content', record('social_invite', {}))).toBe(false);
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
          organizationId: 'organization_1',
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

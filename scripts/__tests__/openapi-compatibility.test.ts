import { describe, expect, it } from 'vitest';
import { compareOpenApi } from '../lib/openapi-compatibility.js';

const operation = {
  operationId: 'createThing',
  security: [{ OAuth: ['things.write'] }],
  parameters: [
    {
      in: 'query',
      name: 'mode',
      required: false,
      schema: { type: 'string', enum: ['a', 'b'] },
    },
  ],
  requestBody: {
    required: false,
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/Thing' } },
    },
  },
  responses: {
    '201': {
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Thing' } },
      },
    },
    '400': {},
  },
};
const base = {
  paths: { '/things': { post: operation } },
  components: {
    schemas: {
      Thing: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          state: { type: 'string', enum: ['new', 'ready'] },
        },
      },
    },
  },
};

describe('OpenAPI compatibility', () => {
  it('resolves component parameter references before classifying required additions', () => {
    const previous = structuredClone(base);
    const current = structuredClone(base) as typeof base & {
      components: typeof base.components & { parameters: Record<string, unknown> };
    };
    current.components.parameters = {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      },
    };
    current.paths['/things'].post.parameters.push({
      $ref: '#/components/parameters/IdempotencyKey',
    } as never);

    expect(compareOpenApi(previous as never, current as never)).toContainEqual({
      severity: 'breaking',
      category: 'required-parameter-added',
      path: 'POST /things.parameters.header:Idempotency-Key',
      message: 'A required parameter was added.',
    });
  });

  it('accepts additive anyOf response alternatives while preserving every prior branch', () => {
    const previous = {
      ...base,
      components: {
        schemas: {
          ...base.components.schemas,
          ThingResponse: {
            anyOf: [
              { $ref: '#/components/schemas/Thing' },
              { $ref: '#/components/schemas/Thing20260802' },
            ],
          },
          Thing20260802: { type: 'object', properties: { id: { type: 'string' } } },
        },
      },
    };
    const current = {
      ...previous,
      components: {
        schemas: {
          ...previous.components.schemas,
          ThingResponse: {
            anyOf: [
              ...previous.components.schemas.ThingResponse.anyOf,
              { $ref: '#/components/schemas/Thing20260803' },
            ],
          },
          Thing20260803: { type: 'object', properties: { id: { type: 'string' } } },
        },
      },
    };
    const changes = compareOpenApi(previous as never, current as never);
    expect(changes).toContainEqual(
      expect.objectContaining({ category: 'schema-anyOf-widened', severity: 'compatible' }),
    );
    expect(changes.filter((change) => change.severity === 'breaking')).toEqual([]);

    const narrowed = structuredClone(current);
    narrowed.components.schemas.ThingResponse.anyOf = [
      { $ref: '#/components/schemas/Thing20260803' },
    ];
    expect(compareOpenApi(previous as never, narrowed as never)).toContainEqual(
      expect.objectContaining({ category: 'schema-anyOf-changed', severity: 'breaking' }),
    );
  });

  it('accepts an additional authentication alternative without weakening existing clients', () => {
    const current = {
      ...base,
      paths: {
        '/things': {
          post: {
            ...operation,
            security: [...operation.security, { BearerAuth: [] }],
          },
        },
      },
    };

    expect(compareOpenApi(base as never, current as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'security-relaxed', severity: 'compatible' }),
      ]),
    );
  });

  it('accepts a less restrictive scope alternative while rejecting a more restrictive one', () => {
    const lessRestrictive = {
      ...base,
      paths: {
        '/things': {
          post: { ...operation, security: [{ OAuth: [] }] },
        },
      },
    };
    const moreRestrictive = {
      ...base,
      paths: {
        '/things': {
          post: { ...operation, security: [{ OAuth: ['things.write', 'things.admin'] }] },
        },
      },
    };

    expect(compareOpenApi(base as never, lessRestrictive as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'security-relaxed', severity: 'compatible' }),
      ]),
    );
    expect(compareOpenApi(base as never, moreRestrictive as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'security-changed', severity: 'breaking' }),
      ]),
    );
  });

  it('records additive request media types and named schemas', () => {
    const previous = {
      paths: {
        '/jobs': {
          post: { operationId: 'commitJob', responses: { '202': { description: 'Accepted' } } },
        },
      },
      components: { schemas: {} },
    };
    const current = {
      paths: {
        '/jobs': {
          post: {
            operationId: 'commitJob',
            'x-compatibility-breaking-change': {
              id: 'proof-required-for-portable-jobs',
              previousVersion: '2026-07-14',
            },
            requestBody: {
              required: false,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Proof' } } },
            },
            responses: { '202': { description: 'Accepted' } },
          },
        },
      },
      components: { schemas: { Proof: { type: 'object' } } },
    };
    expect(compareOpenApi(previous as never, current as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'media-type-added', severity: 'compatible' }),
        expect.objectContaining({ category: 'schema-added', severity: 'compatible' }),
        expect.objectContaining({ category: 'declared-behavior-change', severity: 'breaking' }),
      ]),
    );
  });

  it.each([
    ['operation removal', { ...base, paths: {} }, 'operation-removed'],
    [
      'operationId change',
      {
        ...base,
        paths: { '/things': { post: { ...operation, operationId: 'other' } } },
      },
      'operation-id-changed',
    ],
    [
      'scope change',
      {
        ...base,
        paths: {
          '/things': {
            post: { ...operation, security: [{ OAuth: ['admin'] }] },
          },
        },
      },
      'security-changed',
    ],
    [
      'required parameter',
      {
        ...base,
        paths: {
          '/things': {
            post: {
              ...operation,
              parameters: [
                ...operation.parameters,
                {
                  in: 'header',
                  name: 'x-new',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
            },
          },
        },
      },
      'required-parameter-added',
    ],
    [
      'response removal',
      {
        ...base,
        paths: {
          '/things': {
            post: {
              ...operation,
              responses: { '201': operation.responses['201'] },
            },
          },
        },
      },
      'response-removed',
    ],
    [
      'required property',
      {
        ...base,
        components: {
          schemas: {
            Thing: {
              ...base.components.schemas.Thing,
              required: ['id', 'state'],
            },
          },
        },
      },
      'required-added',
    ],
    [
      'enum narrowing',
      {
        ...base,
        components: {
          schemas: {
            Thing: {
              ...base.components.schemas.Thing,
              properties: {
                ...base.components.schemas.Thing.properties,
                state: { type: 'string', enum: ['ready'] },
              },
            },
          },
        },
      },
      'enum-narrowed',
    ],
    [
      'shared response enum expansion',
      {
        ...base,
        components: {
          schemas: {
            Thing: {
              ...base.components.schemas.Thing,
              properties: {
                ...base.components.schemas.Thing.properties,
                state: { type: 'string', enum: ['new', 'ready', 'archived'] },
              },
            },
          },
        },
      },
      'enum-expanded',
    ],
    [
      'type change',
      {
        ...base,
        components: {
          schemas: {
            Thing: {
              ...base.components.schemas.Thing,
              properties: {
                ...base.components.schemas.Thing.properties,
                id: { type: 'number' },
              },
            },
          },
        },
      },
      'schema-type',
    ],
  ])('detects breaking %s', (_name, current, category) => {
    expect(compareOpenApi(base as never, current as never)).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'breaking', category })]),
    );
  });

  it('classifies additive optional properties as compatible', () => {
    const current = {
      ...base,
      components: {
        schemas: {
          Thing: {
            ...base.components.schemas.Thing,
            properties: {
              ...base.components.schemas.Thing.properties,
              note: { type: 'string' },
            },
          },
        },
      },
    };
    expect(compareOpenApi(base as never, current as never)).toContainEqual(
      expect.objectContaining({
        severity: 'compatible',
        category: 'property-added',
      }),
    );
  });

  it('classifies a request const widened to a typed enum as compatible', () => {
    const previous = structuredClone(base);
    const current = structuredClone(base);
    previous.paths['/things'].post.requestBody.content['application/json'].schema = {
      const: 'v1',
    };
    current.paths['/things'].post.requestBody.content['application/json'].schema = {
      type: 'string',
      enum: ['v2', 'v1'],
    };

    const changes = compareOpenApi(previous as never, current as never);
    expect(changes).toContainEqual(
      expect.objectContaining({
        severity: 'compatible',
        category: 'enum-expanded',
        message: 'Enum value v2 was added.',
      }),
    );
    expect(changes).not.toContainEqual(expect.objectContaining({ severity: 'breaking' }));
  });

  it('records additive required-permission metadata and fails closed on later drift', () => {
    const added = structuredClone(base);
    added.paths['/things'].post['x-required-permissions'] = ['things.write'];
    expect(compareOpenApi(base as never, added as never)).toContainEqual({
      severity: 'compatible',
      category: 'required-permission-metadata-added',
      path: 'POST /things',
      message: 'Explicit required-permission metadata was added for the existing operation.',
    });

    const changed = structuredClone(added);
    changed.paths['/things'].post['x-required-permissions'] = ['things.admin'];
    expect(compareOpenApi(added as never, changed as never)).toContainEqual(
      expect.objectContaining({
        severity: 'breaking',
        category: 'required-permission-metadata-changed',
      }),
    );

    const removed = structuredClone(added);
    delete removed.paths['/things'].post['x-required-permissions'];
    expect(compareOpenApi(added as never, removed as never)).toContainEqual(
      expect.objectContaining({
        severity: 'breaking',
        category: 'required-permission-metadata-removed',
      }),
    );
  });

  it('detects request and response schema reference changes', () => {
    const current = structuredClone(base);
    current.paths['/things'].post.requestBody.content['application/json'].schema.$ref =
      '#/components/schemas/Other';
    current.paths['/things'].post.responses['201'].content['application/json'].schema.$ref =
      '#/components/schemas/Other';
    expect(compareOpenApi(base as never, current as never)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'schema-$ref' }),
        expect.objectContaining({ category: 'schema-$ref' }),
      ]),
    );
  });

  it('accepts an additive response union that retains the prior schema reference', () => {
    const current = structuredClone(base);
    current.paths['/things'].post.responses['201'].content['application/json'].schema = {
      anyOf: [
        { $ref: '#/components/schemas/Thing' },
        { $ref: '#/components/schemas/Thing20260802' },
      ],
    } as never;
    (current.components.schemas as Record<string, unknown>).Thing20260802 = {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' }, capability: { const: 'content.prepare' } },
    };

    const changes = compareOpenApi(base as never, current as never);
    expect(changes).toContainEqual(
      expect.objectContaining({
        category: 'schema-reference-widened',
        severity: 'compatible',
      }),
    );
    expect(changes).not.toContainEqual(expect.objectContaining({ severity: 'breaking' }));
  });

  it('detects path-level and existing parameter requiredness', () => {
    const previous = structuredClone(base) as typeof base & {
      paths: Record<string, never>;
    };
    const current = structuredClone(base) as typeof base & {
      paths: Record<string, never>;
    };
    previous.paths['/things'].parameters = [
      {
        in: 'path',
        name: 'thingId',
        required: false,
        schema: { type: 'string' },
      },
    ];
    current.paths['/things'].parameters = [
      {
        in: 'path',
        name: 'thingId',
        required: true,
        schema: { type: 'string' },
      },
    ];
    expect(compareOpenApi(previous as never, current as never)).toContainEqual(
      expect.objectContaining({ category: 'parameter-became-required' }),
    );
  });

  it.each([
    [{ pattern: '^[A-Z]+$' }, 'schema-pattern'],
    [{ minLength: 1 }, 'constraint-minLength'],
    [{ maximum: 10 }, 'constraint-maximum'],
    [{ minProperties: 1 }, 'constraint-minProperties'],
    [{ uniqueItems: true }, 'constraint-uniqueItems'],
    [{ enum: ['allowed'] }, 'enum-introduced'],
  ])('detects newly introduced restrictive schema constraint %j', (constraint, category) => {
    const previous = { components: { schemas: { Value: {} } }, paths: {} };
    const current = {
      components: { schemas: { Value: constraint } },
      paths: {},
    };
    expect(compareOpenApi(previous as never, current as never)).toContainEqual(
      expect.objectContaining({ severity: 'breaking', category }),
    );
  });

  it.each([
    [{ type: 'string', nullable: true }, { type: 'string' }, 'schema-nullable-removed'],
    [{ oneOf: [{ type: 'string' }, { type: 'null' }] }, {}, 'schema-oneOf-changed'],
    [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, {}, 'schema-anyOf-changed'],
  ])('detects removal of accepted schema variants', (before, after, category) => {
    const previous = {
      components: { schemas: { Value: before } },
      paths: {},
    };
    const current = {
      components: { schemas: { Value: after } },
      paths: {},
    };
    expect(compareOpenApi(previous as never, current as never)).toContainEqual(
      expect.objectContaining({ severity: 'breaking', category }),
    );
  });

  it('does not report nullable-to-json-schema-null normalization as a breaking change', () => {
    const previous = {
      components: {
        schemas: { Value: { type: 'string', nullable: true } },
      },
      paths: {},
    };
    const current = {
      components: {
        schemas: { Value: { type: ['string', 'null'] } },
      },
      paths: {},
    };

    expect(compareOpenApi(previous as never, current as never)).toEqual([]);
  });

  it('detects an unconstrained nullable schema narrowed to null only', () => {
    const previous = { components: { schemas: { Value: { nullable: true } } }, paths: {} };
    const current = {
      components: { schemas: { Value: { type: 'null' } } },
      paths: {},
    };

    expect(compareOpenApi(previous as never, current as never)).toContainEqual(
      expect.objectContaining({ severity: 'breaking', category: 'schema-type' }),
    );
  });

  it('does not treat nullable removal as breaking when an unconstrained schema remains unconstrained', () => {
    const previous = { components: { schemas: { Value: { nullable: true } } }, paths: {} };
    const current = { components: { schemas: { Value: {} } }, paths: {} };

    expect(compareOpenApi(previous as never, current as never)).toEqual([]);
  });
});

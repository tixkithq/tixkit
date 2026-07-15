export type OpenApiChange = {
  severity: 'breaking' | 'compatible';
  category: string;
  path: string;
  message: string;
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
const object = (value: Json | undefined): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : []);
const stable = (value: Json | undefined): string => JSON.stringify(value ?? null);

function compareSchema(
  previous: Json,
  current: Json,
  path: string,
  changes: OpenApiChange[],
): void {
  const before = object(previous);
  const after = object(current);
  const priorReference = typeof before.$ref === 'string' ? before.$ref : undefined;
  const referenceWidened =
    priorReference !== undefined &&
    array(after.anyOf).some((entry) => object(entry).$ref === priorReference);
  const beforeConstType =
    before.const === null ? 'null' : before.const === undefined ? undefined : typeof before.const;
  for (const key of ['type', 'format', 'const', '$ref', 'pattern']) {
    const inferredConstType =
      key === 'type' && before.type === undefined && beforeConstType === after.type;
    if (
      !(key === '$ref' && referenceWidened) &&
      after[key] !== undefined &&
      !inferredConstType &&
      stable(before[key]) !== stable(after[key])
    )
      changes.push({
        severity: 'breaking',
        category: `schema-${key}`,
        path,
        message: `${key} changed.`,
      });
  }
  if (referenceWidened)
    changes.push({
      severity: 'compatible',
      category: 'schema-reference-widened',
      path,
      message: 'The prior response schema remains accepted by an additive anyOf branch.',
    });
  if (before.nullable === true && after.nullable !== true)
    changes.push({
      severity: 'breaking',
      category: 'schema-nullable-removed',
      path,
      message: 'Null is no longer accepted.',
    });
  else if (after.nullable !== undefined && stable(before.nullable) !== stable(after.nullable))
    changes.push({
      severity: 'breaking',
      category: 'schema-nullable',
      path,
      message: 'nullable changed.',
    });
  for (const key of ['oneOf', 'anyOf', 'allOf', 'not']) {
    if (
      !(key === 'anyOf' && referenceWidened) &&
      (before[key] !== undefined || after[key] !== undefined) &&
      stable(before[key]) !== stable(after[key])
    )
      changes.push({
        severity: 'breaking',
        category: `schema-${key}-changed`,
        path,
        message: `${key} changed.`,
      });
  }
  for (const [key, direction] of [
    ['minimum', 'higher'],
    ['minLength', 'higher'],
    ['minItems', 'higher'],
    ['minProperties', 'higher'],
    ['exclusiveMinimum', 'higher'],
    ['maximum', 'lower'],
    ['exclusiveMaximum', 'lower'],
    ['maxLength', 'lower'],
    ['maxItems', 'lower'],
    ['maxProperties', 'lower'],
  ] as const) {
    const oldValue = typeof before[key] === 'number' ? before[key] : undefined;
    const newValue = typeof after[key] === 'number' ? after[key] : undefined;
    if (
      newValue !== undefined &&
      (oldValue === undefined ||
        (direction === 'higher' ? newValue > oldValue : newValue < oldValue))
    )
      changes.push({
        severity: 'breaking',
        category: `constraint-${key}`,
        path,
        message: `${key} became more restrictive.`,
      });
  }
  const beforeEnum = (
    before.enum === undefined && before.const !== undefined ? [before.const] : array(before.enum)
  ).map(String);
  const afterEnum = new Set(
    (after.enum === undefined && after.const !== undefined ? [after.const] : array(after.enum)).map(
      String,
    ),
  );
  if (!beforeEnum.length && afterEnum.size)
    changes.push({
      severity: 'breaking',
      category: 'enum-introduced',
      path,
      message: 'An enum constraint was introduced.',
    });
  for (const value of beforeEnum) {
    if (!afterEnum.has(value))
      changes.push({
        severity: 'breaking',
        category: 'enum-narrowed',
        path,
        message: `Enum value ${value} was removed.`,
      });
  }
  const beforeEnumSet = new Set(beforeEnum);
  for (const value of afterEnum) {
    if (!beforeEnumSet.has(value))
      changes.push({
        severity:
          path.includes('.parameters.') || path.includes('.requestBody.')
            ? 'compatible'
            : 'breaking',
        category: 'enum-expanded',
        path,
        message: `Enum value ${value} was added.`,
      });
  }
  if (before.uniqueItems !== true && after.uniqueItems === true)
    changes.push({
      severity: 'breaking',
      category: 'constraint-uniqueItems',
      path,
      message: 'Array items must now be unique.',
    });
  const beforeRequired = new Set(array(before.required).map(String));
  const afterRequired = new Set(array(after.required).map(String));
  for (const name of afterRequired) {
    if (!beforeRequired.has(name))
      changes.push({
        severity: 'breaking',
        category: 'required-added',
        path: `${path}.required.${name}`,
        message: 'A required property was added.',
      });
  }
  const beforeProperties = object(before.properties);
  const afterProperties = object(after.properties);
  for (const [name, schema] of Object.entries(beforeProperties)) {
    if (!(name in afterProperties))
      changes.push({
        severity: 'breaking',
        category: 'property-removed',
        path: `${path}.properties.${name}`,
        message: 'A property was removed.',
      });
    else compareSchema(schema, afterProperties[name]!, `${path}.properties.${name}`, changes);
  }
  for (const name of Object.keys(afterProperties)) {
    if (!(name in beforeProperties))
      changes.push({
        severity: 'compatible',
        category: 'property-added',
        path: `${path}.properties.${name}`,
        message: 'An optional property was added.',
      });
  }
  if (before.items && after.items)
    compareSchema(before.items, after.items, `${path}.items`, changes);
  if (
    stable(before.additionalProperties) !== stable(after.additionalProperties) &&
    after.additionalProperties === false
  )
    changes.push({
      severity: 'breaking',
      category: 'additional-properties-closed',
      path,
      message: 'Additional properties are no longer accepted.',
    });
}

function compareContent(
  previous: Json | undefined,
  current: Json | undefined,
  path: string,
  changes: OpenApiChange[],
): void {
  const before = object(previous);
  const after = object(current);
  for (const [mediaType, media] of Object.entries(before)) {
    if (!(mediaType in after)) {
      changes.push({
        severity: 'breaking',
        category: 'media-type-removed',
        path: `${path}.${mediaType}`,
        message: 'A media type was removed.',
      });
      continue;
    }
    compareSchema(
      object(media).schema ?? {},
      object(after[mediaType]).schema ?? {},
      `${path}.${mediaType}.schema`,
      changes,
    );
  }
  for (const mediaType of Object.keys(after))
    if (!(mediaType in before))
      changes.push({
        severity: 'compatible',
        category: 'media-type-added',
        path: `${path}.${mediaType}`,
        message: 'A media type was added.',
      });
}

function parameters(value: Json | undefined): Map<string, Record<string, Json>> {
  return new Map(
    array(value).map((item) => {
      const parameter = object(item);
      return [`${parameter.in}:${parameter.name}`, parameter];
    }),
  );
}

function securityRequirementAccepts(previousValue: Json, currentValue: Json): boolean {
  const previous = object(previousValue);
  const current = object(currentValue);
  return Object.entries(current).every(([scheme, currentScopesValue]) => {
    if (!(scheme in previous)) return false;
    const previousScopes = new Set(array(previous[scheme]).map(String));
    return array(currentScopesValue)
      .map(String)
      .every((scope) => previousScopes.has(scope));
  });
}

function preservesSecurity(
  previousValue: Json | undefined,
  currentValue: Json | undefined,
): boolean {
  const previous = array(previousValue);
  const current = array(currentValue);
  if (current.length === 0) return true;
  if (previous.length === 0) return false;
  return previous.every((previousRequirement) =>
    current.some((currentRequirement) =>
      securityRequirementAccepts(previousRequirement, currentRequirement),
    ),
  );
}

export function compareOpenApi(previous: Json, current: Json): OpenApiChange[] {
  const changes: OpenApiChange[] = [];
  const before = object(previous);
  const after = object(current);
  const beforePaths = object(before.paths);
  const afterPaths = object(after.paths);
  for (const [route, previousItemValue] of Object.entries(beforePaths)) {
    const previousItem = object(previousItemValue);
    const currentItem = object(afterPaths[route]);
    for (const method of methods) {
      const previousOperation = object(previousItem[method]);
      if (!Object.keys(previousOperation).length) continue;
      const operationPath = `${method.toUpperCase()} ${route}`;
      const currentOperation = object(currentItem[method]);
      if (!Object.keys(currentOperation).length) {
        changes.push({
          severity: 'breaking',
          category: 'operation-removed',
          path: operationPath,
          message: 'Operation was removed.',
        });
        continue;
      }
      if (previousOperation.operationId !== currentOperation.operationId)
        changes.push({
          severity: 'breaking',
          category: 'operation-id-changed',
          path: operationPath,
          message: 'Stable operationId changed.',
        });
      if (stable(previousOperation.security) !== stable(currentOperation.security))
        changes.push({
          severity: preservesSecurity(previousOperation.security, currentOperation.security)
            ? 'compatible'
            : 'breaking',
          category: preservesSecurity(previousOperation.security, currentOperation.security)
            ? 'security-relaxed'
            : 'security-changed',
          path: operationPath,
          message: preservesSecurity(previousOperation.security, currentOperation.security)
            ? 'Authentication alternatives or required scopes became less restrictive.'
            : 'Authentication schemes or scopes changed.',
        });
      const previousBehaviorChange = previousOperation['x-compatibility-breaking-change'];
      const currentBehaviorChange = currentOperation['x-compatibility-breaking-change'];
      if (
        currentBehaviorChange !== undefined &&
        stable(previousBehaviorChange) !== stable(currentBehaviorChange)
      )
        changes.push({
          severity: 'breaking',
          category: 'declared-behavior-change',
          path: operationPath,
          message: 'The operation declares a conditional behavioral breaking change.',
        });
      const beforeParameters = new Map([
        ...parameters(previousItem.parameters),
        ...parameters(previousOperation.parameters),
      ]);
      const afterParameters = new Map([
        ...parameters(currentItem.parameters),
        ...parameters(currentOperation.parameters),
      ]);
      for (const [key, parameter] of afterParameters) {
        const old = beforeParameters.get(key);
        if (!old && parameter.required === true)
          changes.push({
            severity: 'breaking',
            category: 'required-parameter-added',
            path: `${operationPath}.parameters.${key}`,
            message: 'A required parameter was added.',
          });
        else if (old) {
          if (old.required !== true && parameter.required === true)
            changes.push({
              severity: 'breaking',
              category: 'parameter-became-required',
              path: `${operationPath}.parameters.${key}`,
              message: 'An existing parameter became required.',
            });
          compareSchema(
            old.schema ?? {},
            parameter.schema ?? {},
            `${operationPath}.parameters.${key}`,
            changes,
          );
        }
      }
      for (const key of beforeParameters.keys())
        if (!afterParameters.has(key))
          changes.push({
            severity: 'breaking',
            category: 'parameter-removed',
            path: `${operationPath}.parameters.${key}`,
            message: 'A parameter was removed.',
          });
      const oldBody = object(previousOperation.requestBody);
      const newBody = object(currentOperation.requestBody);
      if (oldBody.required !== true && newBody.required === true)
        changes.push({
          severity: 'breaking',
          category: 'request-body-required',
          path: operationPath,
          message: 'Request body became required.',
        });
      const oldResponses = object(previousOperation.responses);
      const newResponses = object(currentOperation.responses);
      for (const status of Object.keys(oldResponses))
        if (!(status in newResponses))
          changes.push({
            severity: 'breaking',
            category: 'response-removed',
            path: `${operationPath}.responses.${status}`,
            message: 'A response status was removed.',
          });
      compareContent(
        oldBody.content,
        newBody.content,
        `${operationPath}.requestBody.content`,
        changes,
      );
      for (const [status, response] of Object.entries(oldResponses))
        if (newResponses[status])
          compareContent(
            object(response).content,
            object(newResponses[status]).content,
            `${operationPath}.responses.${status}.content`,
            changes,
          );
    }
  }
  for (const [route, item] of Object.entries(afterPaths))
    for (const method of methods)
      if (
        object(object(item)[method]).operationId &&
        !object(object(beforePaths[route])[method]).operationId
      )
        changes.push({
          severity: 'compatible',
          category: 'operation-added',
          path: `${method.toUpperCase()} ${route}`,
          message: 'Operation was added.',
        });
  const beforeSchemas = object(object(before.components).schemas);
  const afterSchemas = object(object(after.components).schemas);
  for (const [name, schema] of Object.entries(beforeSchemas)) {
    if (!(name in afterSchemas))
      changes.push({
        severity: 'breaking',
        category: 'schema-removed',
        path: `components.schemas.${name}`,
        message: 'Named schema was removed.',
      });
    else compareSchema(schema, afterSchemas[name]!, `components.schemas.${name}`, changes);
  }
  for (const name of Object.keys(afterSchemas))
    if (!(name in beforeSchemas))
      changes.push({
        severity: 'compatible',
        category: 'schema-added',
        path: `components.schemas.${name}`,
        message: 'A named schema was added.',
      });
  return changes;
}

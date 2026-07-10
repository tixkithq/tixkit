type JsonObject = Record<string, unknown>;

export type OpenApiTypeGenerationOptions = {
  banner?: string;
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propertyName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function literal(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'unknown';
}

function referenceType(reference: string): string {
  const parts = reference
    .split('/')
    .map((part) => decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~')));
  if (parts.length === 4 && parts[0] === '#' && parts[1] === 'components') {
    return `components[${JSON.stringify(parts[2])}][${JSON.stringify(parts[3])}]`;
  }
  return 'unknown';
}

function indent(value: string, depth = 1): string {
  const prefix = '    '.repeat(depth);
  return value
    .split('\n')
    .map((line) => (line ? `${prefix}${line}` : line))
    .join('\n');
}

function union(types: string[]): string {
  return [...new Set(types)].join(' | ') || 'unknown';
}

function schemaType(schema: unknown): string {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (!isObject(schema)) return 'unknown';

  if (typeof schema.$ref === 'string') return referenceType(schema.$ref);
  if ('const' in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map(literal));

  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null;
  const { oneOf: _oneOf, anyOf: _anyOf, allOf: _allOf, ...baseSchema } = schema;
  const hasBaseConstraint =
    'type' in baseSchema ||
    'properties' in baseSchema ||
    'additionalProperties' in baseSchema ||
    'items' in baseSchema ||
    (Array.isArray(baseSchema.required) && baseSchema.required.length > 0);
  if (alternatives) {
    const alternativeType = union(alternatives.map(schemaType));
    return hasBaseConstraint
      ? `(${schemaType(baseSchema)}) & (${alternativeType})`
      : alternativeType;
  }
  if (Array.isArray(schema.allOf)) {
    const intersection = schema.allOf.map(schemaType).join(' & ') || 'unknown';
    return hasBaseConstraint ? `(${schemaType(baseSchema)}) & (${intersection})` : intersection;
  }

  const declaredTypes = Array.isArray(schema.type)
    ? schema.type.filter((value): value is string => typeof value === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];
  const effectiveTypes = declaredTypes.length
    ? declaredTypes
    : isObject(schema.properties) ||
        'additionalProperties' in schema ||
        (Array.isArray(schema.required) && schema.required.length > 0)
      ? ['object']
      : [];

  const rendered = effectiveTypes.map((type) => {
    switch (type) {
      case 'null':
        return 'null';
      case 'string':
        return 'string';
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'array':
        return `Array<${schemaType(schema.items)}>`;
      case 'object':
        return objectType(schema);
      default:
        return 'unknown';
    }
  });
  if (schema.nullable === true) rendered.push('null');
  return union(rendered);
}

function objectType(schema: JsonObject): string {
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === 'string')
      : [],
  );
  const lines = Object.entries(properties).map(
    ([name, property]) =>
      `${propertyName(name)}${required.has(name) ? '' : '?'}: ${schemaType(property)};`,
  );
  for (const name of required) {
    if (!(name in properties)) lines.push(`${propertyName(name)}: unknown;`);
  }
  const notSchema = isObject(schema.not) ? schema.not : undefined;
  const forbiddenAlternatives =
    notSchema && Array.isArray(notSchema.anyOf) ? notSchema.anyOf : notSchema ? [notSchema] : [];
  const forbidden = new Set<string>();
  for (const alternative of forbiddenAlternatives) {
    if (!isObject(alternative) || !Array.isArray(alternative.required)) continue;
    for (const name of alternative.required) {
      if (typeof name === 'string') forbidden.add(name);
    }
  }
  for (const name of forbidden) {
    if (!required.has(name)) lines.push(`${propertyName(name)}?: never;`);
  }

  if (schema.additionalProperties === true) lines.push('[key: string]: unknown;');
  else if (isObject(schema.additionalProperties)) {
    lines.push(`[key: string]: ${schemaType(schema.additionalProperties)};`);
  }

  return lines.length ? `{\n${indent(lines.join('\n'))}\n}` : 'Record<string, unknown>';
}

function resolveParameter(parameter: unknown, document: JsonObject): JsonObject | null {
  if (!isObject(parameter)) return null;
  if (typeof parameter.$ref !== 'string') return parameter;
  const match = /^#\/components\/parameters\/([^/]+)$/.exec(parameter.$ref);
  if (!match) return null;
  const components = isObject(document.components) ? document.components : {};
  const parameters = isObject(components.parameters) ? components.parameters : {};
  const resolved = parameters[decodeURIComponent(match[1])];
  return isObject(resolved) ? resolved : null;
}

function parameterType(parameters: unknown[], document: JsonObject): string | null {
  const merged = new Map<string, JsonObject>();
  for (const candidate of parameters) {
    const parameter = resolveParameter(candidate, document);
    if (!parameter || typeof parameter.name !== 'string' || typeof parameter.in !== 'string')
      continue;
    merged.set(`${parameter.in}\0${parameter.name}`, parameter);
  }
  const groups = new Map<string, JsonObject[]>();
  for (const parameter of merged.values()) {
    const location = String(parameter.in);
    groups.set(location, [...(groups.get(location) ?? []), parameter]);
  }
  if (groups.size === 0) return null;
  const lines = [...groups.entries()].map(([location, entries]) => {
    const properties = entries.map(
      (parameter) =>
        `${propertyName(String(parameter.name))}${parameter.required === true ? '' : '?'}: ${schemaType(parameter.schema)};`,
    );
    const optional = entries.some((parameter) => parameter.required === true) ? '' : '?';
    return `${propertyName(location)}${optional}: {\n${indent(properties.join('\n'))}\n};`;
  });
  return `{\n${indent(lines.join('\n'))}\n}`;
}

function contentType(content: unknown): string | null {
  if (!isObject(content)) return null;
  const entries = Object.entries(content).map(([mediaType, media]) => {
    const schema = isObject(media) ? media.schema : undefined;
    return `${propertyName(mediaType)}: ${schemaType(schema)};`;
  });
  return entries.length ? `{\n${indent(entries.join('\n'))}\n}` : null;
}

function requestBodyType(requestBody: unknown): string | null {
  if (!isObject(requestBody)) return null;
  if (typeof requestBody.$ref === 'string') return referenceType(requestBody.$ref);
  const content = contentType(requestBody.content);
  return content ? `{\n${indent(`content: ${content};`)}\n}` : null;
}

function responsesType(responses: unknown): string {
  if (!isObject(responses)) return 'Record<string, never>';
  const entries = Object.entries(responses).map(([status, response]) => {
    if (isObject(response) && typeof response.$ref === 'string') {
      return `${propertyName(status)}: ${referenceType(response.$ref)};`;
    }
    const content = isObject(response) ? contentType(response.content) : null;
    const headers =
      isObject(response) && isObject(response.headers)
        ? Object.entries(response.headers).map(([name, header]) => {
            const type =
              isObject(header) && typeof header.$ref === 'string'
                ? referenceType(header.$ref)
                : schemaType(isObject(header) ? header.schema : undefined);
            return `${propertyName(name)}: ${type};`;
          })
        : [];
    const fields = [
      ...(content ? [`content: ${content};`] : []),
      ...(headers.length > 0 ? [`headers: {\n${indent(headers.join('\n'))}\n};`] : []),
    ];
    return `${propertyName(status)}: ${fields.length > 0 ? `{\n${indent(fields.join('\n'))}\n}` : 'Record<string, never>'};`;
  });
  return entries.length ? `{\n${indent(entries.join('\n'))}\n}` : 'Record<string, never>';
}

function operationType(
  operation: JsonObject,
  pathParameters: unknown[],
  document: JsonObject,
): string {
  const operationParameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  const parameters = parameterType([...pathParameters, ...operationParameters], document);
  const requestBody = requestBodyType(operation.requestBody);
  const lines: string[] = [];
  if (parameters) lines.push(`parameters: ${parameters};`);
  if (requestBody)
    lines.push(
      `requestBody${isObject(operation.requestBody) && operation.requestBody.required === true ? '' : '?'}: ${requestBody};`,
    );
  lines.push(`responses: ${responsesType(operation.responses)};`);
  return `{\n${indent(lines.join('\n'))}\n}`;
}

function pathsType(document: JsonObject): string {
  const paths = isObject(document.paths) ? document.paths : {};
  const entries = Object.entries(paths).map(([path, item]) => {
    const pathItem = isObject(item) ? item : {};
    const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    const methods = HTTP_METHODS.flatMap((method) => {
      const operation = pathItem[method];
      return isObject(operation)
        ? [`${method}: ${operationType(operation, pathParameters, document)};`]
        : [];
    });
    return `${JSON.stringify(path)}: {\n${indent(methods.join('\n'))}\n};`;
  });
  return entries.length ? `{\n${indent(entries.join('\n'))}\n}` : 'Record<string, never>';
}

function operationsType(document: JsonObject): string {
  const paths = isObject(document.paths) ? document.paths : {};
  const entries: string[] = [];
  for (const item of Object.values(paths)) {
    const pathItem = isObject(item) ? item : {};
    const pathParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation) || typeof operation.operationId !== 'string') continue;
      entries.push(
        `${propertyName(operation.operationId)}: ${operationType(operation, pathParameters, document)};`,
      );
    }
  }
  return entries.length ? `{\n${indent(entries.join('\n'))}\n}` : 'Record<string, never>';
}

function webhooksType(document: JsonObject): string {
  const webhooks = isObject(document.webhooks) ? document.webhooks : {};
  const entries = Object.entries(webhooks).map(([name, item]) => {
    const pathItem = isObject(item) ? item : {};
    const methods = HTTP_METHODS.flatMap((method) => {
      const operation = pathItem[method];
      return isObject(operation) ? [`${method}: ${operationType(operation, [], document)};`] : [];
    });
    return `${propertyName(name)}: {\n${indent(methods.join('\n'))}\n};`;
  });
  return entries.length ? `{\n${indent(entries.join('\n'))}\n}` : 'Record<string, never>';
}

function componentValueType(category: string, value: unknown): string {
  if (!isObject(value)) return 'unknown';
  if (category === 'schemas') return schemaType(value);
  if (category === 'parameters' || category === 'headers') return schemaType(value.schema);
  if (category === 'requestBodies') return requestBodyType(value) ?? 'unknown';
  if (category === 'responses') {
    const content = contentType(value.content);
    return content ? `{\n${indent(`content: ${content};`)}\n}` : 'Record<string, never>';
  }
  return schemaType(value);
}

function componentCategoryType(categoryName: string, category: unknown): string {
  if (!isObject(category)) return 'Record<string, never>';
  const entries = Object.entries(category).map(
    ([name, value]) => `${propertyName(name)}: ${componentValueType(categoryName, value)};`,
  );
  return entries.length ? `{\n${indent(entries.join('\n'))}\n}` : 'Record<string, never>';
}

function componentsType(document: JsonObject): string {
  const components = isObject(document.components) ? document.components : {};
  const entries = Object.entries(components).map(
    ([category, values]) =>
      `${propertyName(category)}: ${componentCategoryType(category, values)};`,
  );
  return entries.length ? `{\n${indent(entries.join('\n'))}\n}` : 'Record<string, never>';
}

/** Generate dependency-free TypeScript declarations from an OpenAPI 3 document. */
export function generateOpenApiTypes(
  document: unknown,
  options: OpenApiTypeGenerationOptions = {},
): string {
  if (!isObject(document) || !isObject(document.paths)) {
    throw new TypeError('Expected an OpenAPI document with a paths object.');
  }
  const banner =
    options.banner ??
    '/* This file is generated from the TixKit OpenAPI document. Do not edit manually. */';
  return `${banner}\n\nexport interface paths ${pathsType(document)}\n\nexport type operations = ${operationsType(document)};\n\nexport type webhooks = ${webhooksType(document)};\n\nexport interface components ${componentsType(document)}\n`;
}

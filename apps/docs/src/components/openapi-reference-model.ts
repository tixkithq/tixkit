export type ApiReferenceOperation = {
  method: string;
  path: string;
  operationId: string;
  tags: readonly string[];
  summary: string;
  description: string;
  security: readonly Record<string, readonly string[]>[];
  requiredPermissions: unknown;
  parameters: readonly unknown[];
  requestBody: unknown;
  responses: Record<string, unknown>;
};

type OpenApiDocument = {
  info?: { version?: unknown };
  security?: unknown;
  paths?: unknown;
};

const methods = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

export const API_CONTRACT_VERSION_QUERY = "api-version";

export function resolveContractVersion(
  search: string,
  versions: readonly string[],
  current: string,
) {
  const requested = new URLSearchParams(search).get(API_CONTRACT_VERSION_QUERY);
  return requested && versions.includes(requested) ? requested : current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function securityRequirements(
  value: unknown,
): readonly Record<string, readonly string[]>[] {
  if (!Array.isArray(value)) return [];
  return value.map((requirement) => {
    if (!isRecord(requirement)) {
      throw new Error("OpenAPI security requirement must be an object.");
    }
    return Object.fromEntries(
      Object.entries(requirement).map(([scheme, scopes]) => {
        if (
          !Array.isArray(scopes) ||
          scopes.some((scope) => typeof scope !== "string")
        ) {
          throw new Error(
            `OpenAPI security scopes for ${scheme} must be strings.`,
          );
        }
        return [scheme, scopes as string[]];
      }),
    );
  });
}

export function normalizeOperations(
  document: OpenApiDocument,
  expectedVersion: string,
) {
  if (document.info?.version !== expectedVersion) {
    throw new Error(
      `Contract declares version ${String(document.info?.version)}, not ${expectedVersion}.`,
    );
  }
  if (!isRecord(document.paths)) {
    throw new Error("Contract does not contain an OpenAPI paths object.");
  }
  const globalSecurity = securityRequirements(document.security);
  const operations: ApiReferenceOperation[] = [];
  for (const [path, pathValue] of Object.entries(document.paths)) {
    if (!isRecord(pathValue))
      throw new Error(`OpenAPI path ${path} must be an object.`);
    const sharedParameters = Array.isArray(pathValue.parameters)
      ? pathValue.parameters
      : [];
    for (const [method, operationValue] of Object.entries(pathValue)) {
      if (!methods.has(method)) continue;
      if (
        !isRecord(operationValue) ||
        typeof operationValue.operationId !== "string"
      ) {
        throw new Error(
          `OpenAPI ${method.toUpperCase()} ${path} requires an operationId.`,
        );
      }
      const tags = Array.isArray(operationValue.tags)
        ? operationValue.tags.filter(
            (tag): tag is string => typeof tag === "string",
          )
        : [];
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: operationValue.operationId,
        tags: tags.length > 0 ? tags : ["Other"],
        summary:
          typeof operationValue.summary === "string"
            ? operationValue.summary
            : operationValue.operationId,
        description:
          typeof operationValue.description === "string"
            ? operationValue.description
            : "",
        security:
          operationValue.security === undefined
            ? globalSecurity
            : securityRequirements(operationValue.security),
        requiredPermissions: operationValue["x-required-permissions"] ?? null,
        parameters: [
          ...sharedParameters,
          ...(Array.isArray(operationValue.parameters)
            ? operationValue.parameters
            : []),
        ],
        requestBody: operationValue.requestBody ?? null,
        responses: isRecord(operationValue.responses)
          ? operationValue.responses
          : {},
      });
    }
  }
  if (operations.length === 0) {
    throw new Error("Contract does not declare any API operations.");
  }
  return operations;
}

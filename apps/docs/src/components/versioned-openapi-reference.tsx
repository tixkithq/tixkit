"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiExplorer } from "./api-explorer";
import { ContractVersionSelector } from "./contract-version-selector";
import { OperationExamples } from "./operation-examples";
import {
  API_CONTRACT_VERSION_QUERY,
  normalizeOperations,
  resolveContractVersion,
  type ApiReferenceOperation,
} from "./openapi-reference-model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function securityLabel(security: readonly Record<string, readonly string[]>[]) {
  if (security.length === 0) return "No credential";
  return security
    .map((requirement) =>
      Object.entries(requirement)
        .map(
          ([scheme, scopes]) =>
            `${scheme}${scopes.length ? ` (${scopes.join(", ")})` : ""}`,
        )
        .join(" + "),
    )
    .join(" or ");
}

function permissionLabel(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (isRecord(value)) {
    const base = Array.isArray(value.base) ? value.base : [];
    const byType = isRecord(value.byType) ? value.byType : {};
    const variants = Object.entries(byType).map(
      ([type, scopes]) =>
        `${type}: ${Array.isArray(scopes) ? scopes.join(", ") : ""}`,
    );
    return [...base, ...variants].join("; ");
  }
  return "None";
}

function tagId(tag: string) {
  return `tag-${tag.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

export function VersionedOpenApiReference({
  versions,
  current,
  initialOperations,
  allowedOrigins,
}: {
  versions: readonly string[];
  current: string;
  initialOperations: readonly ApiReferenceOperation[];
  allowedOrigins: string[];
}) {
  const [selected, setSelected] = useState(current);
  const [operations, setOperations] =
    useState<readonly ApiReferenceOperation[]>(initialOperations);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const cache = useRef(
    new Map<string, readonly ApiReferenceOperation[]>([
      [current, initialOperations],
    ]),
  );

  useEffect(() => {
    const syncFromUrl = () => {
      const next = resolveContractVersion(
        window.location.search,
        versions,
        current,
      );
      setSelected(next);
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [current, versions]);

  useEffect(() => {
    const cached = cache.current.get(selected);
    if (cached) {
      setOperations(cached);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setOperations([]);
    setError(null);
    setLoading(true);
    void fetch(`/contracts/${encodeURIComponent(selected)}/openapi.json`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `Contract request failed with HTTP ${response.status}.`,
          );
        const document = await response.json();
        return normalizeOperations(document, selected);
      })
      .then((nextOperations) => {
        cache.current.set(selected, nextOperations);
        setOperations(nextOperations);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "The contract could not be loaded.",
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [selected, retry]);

  const tags = useMemo(
    () => [...new Set(operations.flatMap((operation) => operation.tags))],
    [operations],
  );

  return (
    <div className="api-reference">
      <p>
        <strong>Endpoint reference version:</strong> {selected}
      </p>
      <ContractVersionSelector
        versions={versions}
        selected={selected}
        onChange={(version) => {
          if (!versions.includes(version) || version === selected) return;
          const url = new URL(window.location.href);
          url.searchParams.set(API_CONTRACT_VERSION_QUERY, version);
          window.history.pushState(window.history.state, "", url);
          setSelected(version);
        }}
      />
      <output aria-live="polite">
        {loading ? `Loading API reference ${selected}…` : null}
        {error ? `API reference ${selected} is unavailable: ${error}` : null}
      </output>
      {error ? (
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          Retry reference load
        </button>
      ) : null}
      {operations.length > 0 ? (
        <>
          <ApiExplorer
            version={selected}
            allowedOrigins={allowedOrigins}
            operations={operations.map((operation) => ({
              operationId: operation.operationId,
              method: operation.method,
              path: operation.path,
              summary: operation.summary,
            }))}
          />
          <nav aria-label="API product areas">
            <ul>
              {tags.map((tag) => (
                <li key={tag}>
                  <a href={`#${tagId(tag)}`}>{tag}</a>
                </li>
              ))}
            </ul>
          </nav>
          {tags.map((tag) => (
            <section key={tag} aria-labelledby={tagId(tag)}>
              <h2 id={tagId(tag)}>{tag}</h2>
              {operations
                .filter((operation) => operation.tags.includes(tag))
                .map((operation) => (
                  <article
                    className="operation"
                    id={`operation-${operation.operationId}`}
                    key={operation.operationId}
                  >
                    <h3>
                      <span data-method={operation.method}>
                        {operation.method}
                      </span>{" "}
                      <code>{operation.path}</code>
                      <a
                        className="heading-anchor"
                        href={`#operation-${operation.operationId}`}
                        aria-label={`Link to ${operation.operationId}`}
                      >
                        #
                      </a>
                    </h3>
                    <p>{operation.summary}</p>
                    {operation.description ? (
                      <p>{operation.description}</p>
                    ) : null}
                    <dl>
                      <div>
                        <dt>Operation ID</dt>
                        <dd>
                          <code>{operation.operationId}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Security</dt>
                        <dd>{securityLabel(operation.security)}</dd>
                      </div>
                      <div>
                        <dt>Required permissions</dt>
                        <dd>
                          {permissionLabel(operation.requiredPermissions)}
                        </dd>
                      </div>
                      <div>
                        <dt>Parameters</dt>
                        <dd>
                          <pre>
                            <code>
                              {JSON.stringify(operation.parameters, null, 2)}
                            </code>
                          </pre>
                        </dd>
                      </div>
                      <div>
                        <dt>Request body</dt>
                        <dd>
                          <pre>
                            <code>
                              {JSON.stringify(operation.requestBody, null, 2)}
                            </code>
                          </pre>
                        </dd>
                      </div>
                      <div>
                        <dt>Responses</dt>
                        <dd>
                          <pre>
                            <code>
                              {JSON.stringify(operation.responses, null, 2)}
                            </code>
                          </pre>
                        </dd>
                      </div>
                    </dl>
                    <p>
                      Mutating requests should use an{" "}
                      <code>Idempotency-Key</code> whenever the operation
                      declares that header. Retry only documented retryable
                      errors.
                    </p>
                    <OperationExamples
                      method={operation.method}
                      path={operation.path}
                      operationId={operation.operationId}
                      version={selected}
                      parameters={operation.parameters}
                      requestBody={operation.requestBody}
                      security={operation.security}
                    />
                  </article>
                ))}
            </section>
          ))}
        </>
      ) : null}
    </div>
  );
}

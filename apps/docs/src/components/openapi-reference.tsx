import {
  apiReferenceOperations,
  apiReferenceSchemas,
  apiReferenceVersion,
} from "@/generated/openapi-reference";
import { apiReleaseVersions } from "@/generated/api-release-index";
import { VersionedOpenApiReference } from "./versioned-openapi-reference";

function sandboxOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value.split(",").map((candidate) => {
        const url = new URL(candidate.trim());
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new Error(
            "NEXT_PUBLIC_TIXKIT_SANDBOX_API_ORIGINS must contain exact HTTPS origins.",
          );
        return url.origin;
      }),
    ),
  ];
}

export function OpenApiReference() {
  const allowedOrigins = sandboxOrigins(
    process.env.NEXT_PUBLIC_TIXKIT_SANDBOX_API_ORIGINS,
  );
  return (
    <VersionedOpenApiReference
      versions={apiReleaseVersions}
      current={apiReferenceVersion}
      initialOperations={apiReferenceOperations}
      allowedOrigins={allowedOrigins}
    />
  );
}

export function OpenApiSchemaReference() {
  return (
    <div className="schema-reference">
      <p>
        {apiReferenceSchemas.length} schemas are generated from OpenAPI version{" "}
        {apiReferenceVersion}. Operation request and response links use these
        canonical names.
      </p>
      <ul>
        {apiReferenceSchemas.map((schema) => (
          <li key={schema.name} id={`schema-${schema.name}`}>
            <h2>
              {schema.name}
              <a
                className="heading-anchor"
                href={`#schema-${schema.name}`}
                aria-label={`Link to schema ${schema.name}`}
              >
                #
              </a>
            </h2>
            {schema.description ? <p>{schema.description}</p> : null}
            <p>
              <strong>Type:</strong> {schema.type}
            </p>
            {schema.properties.length > 0 ? (
              <details>
                <summary>{schema.properties.length} properties</summary>
                <ul>
                  {schema.properties.map((property) => (
                    <li key={property}>
                      <code>{property}</code>
                      {(schema.required as readonly string[]).includes(property)
                        ? " — required"
                        : ""}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

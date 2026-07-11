import type {
  MigrationCredentialReference,
  MigrationCredentialResolver,
} from "@tixkit/migration-core";

const PUBLIC_REFERENCE =
  /^(?:aws-secretsmanager|gcp-secretmanager|secret|vault):\/\/[A-Za-z0-9_./:@-]+$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const REGISTRY_ENV = "TIXKIT_MIGRATION_CREDENTIAL_BINDINGS";
type Binding = {
  tenantId: string;
  organizationId: string;
  sourceSystem: string;
  envName: string;
};

function readBindings(): Record<string, Binding> {
  const serialized = process.env[REGISTRY_ENV];
  if (!serialized) throw new Error("credential binding registry unavailable");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("credential binding registry invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("credential binding registry invalid");
  const bindings: Record<string, Binding> = {};
  for (const [reference, value] of Object.entries(parsed)) {
    if (
      !PUBLIC_REFERENCE.test(reference) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      throw new Error("credential binding registry invalid");
    }
    const keys = Object.keys(value);
    const candidate = value as Record<string, unknown>;
    if (
      keys.length !== 4 ||
      typeof candidate.tenantId !== "string" ||
      typeof candidate.organizationId !== "string" ||
      typeof candidate.sourceSystem !== "string" ||
      typeof candidate.envName !== "string" ||
      !ENV_NAME.test(candidate.envName)
    ) {
      throw new Error("credential binding registry invalid");
    }
    bindings[reference] = {
      tenantId: candidate.tenantId,
      organizationId: candidate.organizationId,
      sourceSystem: candidate.sourceSystem,
      envName: candidate.envName,
    };
  }
  return bindings;
}

/** Worker-only exact-reference binding resolver; secret material is never logged or persisted. */
export class BindingRegistryMigrationCredentialResolver implements MigrationCredentialResolver<string> {
  async resolve(
    reference: MigrationCredentialReference,
    _context: { signal?: AbortSignal },
  ) {
    if (!PUBLIC_REFERENCE.test(reference.secretReference))
      throw new Error("credential reference invalid");
    const binding = readBindings()[reference.secretReference];
    if (
      !binding ||
      binding.tenantId !== reference.tenantId ||
      binding.organizationId !== reference.organizationId ||
      binding.sourceSystem !== reference.sourceSystem
    )
      throw new Error("credential reference scope mismatch");
    const material = process.env[binding.envName];
    if (!material) throw new Error("credential secret unavailable");
    return { material, expiresAt: reference.expiresAt };
  }
}

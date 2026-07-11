export const MIGRATION_SECRET_REFERENCE_PATTERN =
  '^(?:aws-secretsmanager|gcp-secretmanager|secret|vault):\\/\\/[A-Za-z0-9_@:-]+(?:\\/(?!\\.{1,2}(?:\\/|$))[A-Za-z0-9_.@:-]+)*$';

const secretReferencePattern = new RegExp(MIGRATION_SECRET_REFERENCE_PATTERN, 'u');

/** Validates a canonical opaque reference without resolving or exposing secret material. */
export function assertMigrationSecretReference(value: string): void {
  if (value.length < 1 || value.length > 1000 || !secretReferencePattern.test(value))
    throw new TypeError('secretReference must be a canonical supported secret-manager reference');
  const path = value.slice(value.indexOf('://') + 3);
  if (path.split('/').some((segment) => segment === '.' || segment === '..'))
    throw new TypeError('secretReference must be canonical without relative path segments');
}

import { ulid } from 'ulid';
import { ValidationError } from '@tixkit/domain';

import { BaseRepository } from './base.js';

export type TaxRegistrationStatus = 'pending' | 'active' | 'inactive' | 'revoked';
export type WalletCredentialStatus = 'pending' | 'active' | 'inactive' | 'revoked' | 'expired';

function normalizedRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw new ValidationError(`${field} must be a non-empty printable value`, { field });
  }
  return normalized;
}

function normalizedCustodyReference(value: string): string {
  const normalized = normalizedRequired(value, 'custodyReference');
  if (
    !/^(?:(?:aws-secretsmanager|cloud-kms|gcp-secretmanager|hsm|kms|secret|vault):\/\/|arn:)[^\s@?#]+$/iu.test(
      normalized,
    )
  ) {
    throw new ValidationError(
      'custodyReference must be an opaque URI or cloud resource name, never credential material',
      { field: 'custodyReference' },
    );
  }
  return normalized;
}

export class TaxRegistrationRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    provider: string;
    jurisdictionCode: string;
    registrationType: string;
    custodyReference: string;
    status?: TaxRegistrationStatus;
  }) {
    const id = `txr_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'tax_registrations',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        provider: normalizedRequired(input.provider, 'provider'),
        jurisdiction_code: normalizedRequired(input.jurisdictionCode, 'jurisdictionCode'),
        registration_type: normalizedRequired(input.registrationType, 'registrationType'),
        custody_reference: normalizedCustodyReference(input.custodyReference),
        status: input.status ?? 'pending',
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findByOrganization(tenantId: string, organizationId: string) {
    return this.db
      .selectFrom('tax_registrations')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('id')
      .execute();
  }
}

export class WalletCredentialRepository extends BaseRepository {
  async create(input: {
    tenantId: string;
    organizationId: string;
    brandId: string;
    provider: string;
    credentialType: string;
    custodyReference: string;
    status?: WalletCredentialStatus;
    expiresAt?: Date | null;
  }) {
    const id = `wcr_${ulid()}`;
    const now = new Date();
    return this.insertReturning(
      'wallet_credentials',
      {
        id,
        tenant_id: input.tenantId,
        organization_id: input.organizationId,
        brand_id: input.brandId,
        provider: normalizedRequired(input.provider, 'provider'),
        credential_type: normalizedRequired(input.credentialType, 'credentialType'),
        custody_reference: normalizedCustodyReference(input.custodyReference),
        status: input.status ?? 'pending',
        expires_at: input.expiresAt ?? null,
        created_at: now,
        updated_at: now,
      },
      id,
    );
  }

  async findByOrganization(tenantId: string, organizationId: string) {
    return this.db
      .selectFrom('wallet_credentials')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('organization_id', '=', organizationId)
      .orderBy('id')
      .execute();
  }
}

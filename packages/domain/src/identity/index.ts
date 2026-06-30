import type { BaseEntity, ISO8601Date, TenantScopedEntity, Ulid } from '../shared/index.js';

export type Permission =
  | 'events.read'
  | 'events.write'
  | 'tickets.write'
  | 'orders.read'
  | 'orders.write'
  | 'refunds.write'
  | 'attendees.read'
  | 'attendees.write'
  | 'checkins.read'
  | 'checkins.write'
  | 'messages.write'
  | 'reports.read'
  | 'settings.write'
  | 'developers.write'
  | 'billing.write';

export type PrincipalType = 'user' | 'api_key' | 'mobile_device' | 'system';

export type Principal = {
  type: PrincipalType;
  id: string;
  clerkUserId?: string;
  clerkOrganizationId?: string;
  tenantId: Ulid;
  organizationIds: Ulid[];
  scopes: Permission[];
  brandIds?: Ulid[];
  eventIds?: Ulid[];
};

export type UserProfile = TenantScopedEntity & {
  clerkUserId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
  status: 'active' | 'suspended';
  lastSeenAt?: ISO8601Date;
};

export type ClerkIdentityLink = BaseEntity & {
  clerkUserId: string;
  tixkitUserId: Ulid;
  clerkOrganizationId?: string;
  tixkitOrganizationId?: Ulid;
  lastSyncedAt: ISO8601Date;
};

export type OrganizationMember = TenantScopedEntity & {
  organizationId: Ulid;
  userId: Ulid;
  role: string;
  invitedAt: ISO8601Date;
  acceptedAt?: ISO8601Date;
};

export type Role = TenantScopedEntity & {
  name: string;
  permissions: Permission[];
  isSystem: boolean;
};

export type PermissionGrant = TenantScopedEntity & {
  principalType: PrincipalType;
  principalId: string;
  permission: Permission;
  scopeType: 'tenant' | 'organization' | 'brand' | 'event';
  scopeId?: Ulid;
};

export type ApiKey = TenantScopedEntity & {
  organizationId: Ulid;
  name: string;
  keyPrefix: string;
  hashedKey: string;
  scopes: Permission[];
  brandIds?: Ulid[];
  eventIds?: Ulid[];
  lastUsedAt?: ISO8601Date;
  expiresAt?: ISO8601Date;
  revokedAt?: ISO8601Date;
};

export type OAuthApplication = TenantScopedEntity & {
  organizationId: Ulid;
  name: string;
  clientId: string;
  clientSecretHash: string;
  redirectUris: string[];
  scopes: Permission[];
};

export type ScannerDevice = TenantScopedEntity & {
  organizationId: Ulid;
  name: string;
  deviceId: string;
  hashedSecret: string;
  eventIds: Ulid[];
  scopes: Permission[];
  status: 'active' | 'revoked';
  lastSeenAt?: ISO8601Date;
};

export type AuditLogEntry = TenantScopedEntity & {
  actorType: PrincipalType;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  diffSummary?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
};

export type ClerkWebhookEvent = {
  type: string;
  data: Record<string, unknown>;
  object: string;
  timestamp: number;
};

export type CreateApiKeyInput = {
  organizationId: Ulid;
  name: string;
  scopes: Permission[];
  brandIds?: Ulid[];
  eventIds?: Ulid[];
  expiresAt?: ISO8601Date;
};

export type CreateScannerDeviceInput = {
  organizationId: Ulid;
  name: string;
  eventIds: Ulid[];
  scopes: Permission[];
};

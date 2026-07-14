import type { Principal } from '@tixkit/domain';

export type AuthProviderName = 'clerk' | 'dev' | 'oidc';

export type AuthProviderResult = {
  principal: Principal;
  externalUserId?: string;
};

export interface AuthProvider<Request = unknown> {
  readonly name: AuthProviderName;
  isLocalDevMode(): boolean;
  authenticateUser(request: Request): Promise<AuthProviderResult>;
  authenticateApiKey(request: Request): Promise<AuthProviderResult>;
  authenticateOAuthAccessToken(request: Request): Promise<AuthProviderResult>;
  authenticateAgentAccessToken(request: Request): Promise<AuthProviderResult>;
  authenticateScannerDevice(request: Request): Promise<AuthProviderResult>;
  authenticateLocalDev(): Promise<AuthProviderResult>;
}

// @carbon/identity — accounts and API tokens for Carbon Cloud.
//
// Self-hosted v1's whole model: an Organization owns everything (builds,
// billing), and an ApiToken authenticates as one — as either of two scopes:
// "org" (carbon-cli: create a build, read this org's usage) or "worker" (a
// build worker: claim/complete ANY org's queued work, since a worker fleet
// is shared infrastructure). Those legacy exports remain for compatibility.
// Human accounts, browser sessions, MFA, organizations and invitations use the
// separate account use cases and live membership authority exported below.
//
//   domain/               Organization, ApiToken (+ its TokenScope), hashing
//   application/ports/    IdentityRepository
//   application/usecases/ create an org (+ its first org token), issue a
//                         worker token for an org, verify a token
//   infrastructure/       InMemory (tests), Postgres (real — carbon-cloud's
//                         own), Http (every OTHER product/service, verifying
//                         against carbon-cloud's identity over the network
//                         instead of keeping a second copy)

export { Organization, type OrganizationProps } from "./domain/entities/Organization.ts";
export { ApiToken, type ApiTokenProps, type TokenScope } from "./domain/entities/ApiToken.ts";
export { hashToken } from "./domain/value-objects/TokenHash.ts";
export type { IdentityRepository } from "./application/ports/IdentityRepository.ts";
export {
  CreateOrganizationUseCase,
  type CreateOrganizationResult,
} from "./application/usecases/CreateOrganizationUseCase.ts";
export {
  IssueWorkerTokenUseCase,
  type IssueWorkerTokenResult,
} from "./application/usecases/IssueWorkerTokenUseCase.ts";
export { VerifyTokenUseCase, type VerifiedToken } from "./application/usecases/VerifyTokenUseCase.ts";
export { InMemoryIdentityRepository } from "./infrastructure/InMemoryIdentityRepository.ts";
export { PostgresIdentityRepository } from "./infrastructure/PostgresIdentityRepository.ts";
export { HttpIdentityClient } from "./infrastructure/HttpIdentityClient.ts";
export { ServiceAssertionIssuer, ServiceAssertionVerifier, InvalidServiceAssertionError, bodyDigest } from "./infrastructure/ServiceAssertions.ts";
export type { AssertionInput, AssertionKey, AssertionRequest } from "./infrastructure/ServiceAssertions.ts";
export type { AssertionSecurityStore } from "./application/ports/AssertionSecurityStore.ts";
export { PostgresAssertionSecurityStore } from "./infrastructure/PostgresAssertionSecurityStore.ts";
export { accountGrants, hasGrant, sameScope, scopeContains, ROLE_PERMISSIONS } from "./domain/policies/PlatformAuthorization.ts";
export { AccountAuthentication, opaqueToken, tokenDigest, tokenMatches } from "./application/usecases/AccountAuthentication.ts";
export { AccountDeviceAuthorization } from './application/usecases/AccountDeviceAuthorization.ts';
export { DeviceCredentialAuthentication } from './application/usecases/DeviceCredentialAuthentication.ts';
export { AccountServiceAccounts, ServiceAccountAuthentication } from './application/usecases/AccountServiceAccounts.ts';
export { PostgresServiceAccountRepository } from './infrastructure/PostgresServiceAccountRepository.ts';
export { AccountPersonalCredentials, PersonalCredentialAuthentication } from './application/usecases/AccountPersonalCredentials.ts';
export type { PersonalCredentialPrincipal } from './application/usecases/AccountPersonalCredentials.ts';
export { PostgresPersonalCredentialRepository } from './infrastructure/PostgresPersonalCredentialRepository.ts';
export type { PersonalCredentialRepository } from './application/ports/PersonalCredentialRepository.ts';
export { AccountLegacyTokens } from './application/usecases/AccountLegacyTokens.ts';
export { PostgresLegacyTokenRepository } from './infrastructure/PostgresLegacyTokenRepository.ts';
export type { LegacyTokenRepository } from './application/ports/LegacyTokenRepository.ts';
export type { ServiceAccountGrant, ServiceAccountRepository } from './application/ports/ServiceAccountRepository.ts';
export type { DeviceCredentialPrincipal } from './application/usecases/DeviceCredentialAuthentication.ts';
export { PostgresDeviceAuthorizationRepository } from './infrastructure/PostgresDeviceAuthorizationRepository.ts';
export type { DeviceAuthorizationRepository, DeviceDecisionInput, DevicePollInput, DeviceRequestInput, DeviceRevokeInput } from './application/ports/DeviceAuthorizationRepository.ts';
export type { ChallengeRequest } from "./application/usecases/AccountAuthentication.ts";
export { DeliverAccountMail } from "./application/usecases/DeliverAccountMail.ts";
export { PostgresAccountIdentityRepository } from "./infrastructure/PostgresAccountIdentityRepository.ts";
export { PostgresAccountMailQueue } from "./infrastructure/PostgresAccountMailQueue.ts";
export { EnvelopeMessageProtector } from "./infrastructure/EnvelopeMessageProtector.ts";
export type { AccountIdentityRepository } from "./application/ports/AccountIdentityRepository.ts";
export type { AccountEmail, AccountNotification, AccountMailQueue, MessageProtector } from "./application/ports/AccountNotification.ts";
export { AccountSecurity } from "./application/usecases/AccountSecurity.ts";
export { Rfc6238Totp, encodeBase32 } from "./infrastructure/Rfc6238Totp.ts";
export { PostgresMfaVerification } from "./infrastructure/PostgresMfaVerification.ts";
export { PostgresAccountSecurityRepository } from "./infrastructure/PostgresAccountSecurityRepository.ts";
export { AccountProfile } from "./application/usecases/AccountProfile.ts";
export { PostgresAccountProfileRepository } from "./infrastructure/PostgresAccountProfileRepository.ts";
export { OrganizationAccess } from "./application/usecases/OrganizationAccess.ts";
export { PostgresOrganizationRepository } from "./infrastructure/PostgresOrganizationRepository.ts";
export { OrganizationInvitations } from "./application/usecases/OrganizationInvitations.ts";
export { PostgresOrganizationInvitationsRepository } from "./infrastructure/PostgresOrganizationInvitationsRepository.ts";
export { ExternalAccountAuthentication } from "./application/usecases/ExternalAccountAuthentication.ts";
export { PostgresExternalAccountRepository } from "./infrastructure/PostgresExternalAccountRepository.ts";
export type { ExternalAccountIdentity, ExternalAccountProvider } from "./application/ports/ExternalAccountProvider.ts";
export { AccountAuthorization } from "./application/usecases/AccountAuthorization.ts";
export { PostgresPlatformAuthority } from "./infrastructure/PostgresPlatformAuthority.ts";
export type { OrganizationActor } from "./application/ports/OrganizationRepository.ts";
export { assertionTrustFromEnv } from './infrastructure/AssertionTrust.ts';
export type { AssertionTrust } from './infrastructure/AssertionTrust.ts';
export { HttpAssertionAuthority } from './infrastructure/HttpAssertionAuthority.ts';

// @carbon/identity — accounts and API tokens for Carbon Cloud.
//
// Self-hosted v1's whole model: an Organization owns everything (builds,
// billing), and an ApiToken authenticates as one — as either of two scopes:
// "org" (carbon-cli: create a build, read this org's usage) or "worker" (a
// build worker: claim/complete ANY org's queued work, since a worker fleet
// is shared infrastructure). No users, no roles, no OAuth —
// CreateOrganizationUseCase is the entire signup flow.
//
//   domain/               Organization, ApiToken (+ its TokenScope), hashing
//   application/ports/    IdentityRepository
//   application/usecases/ create an org (+ its first org token), issue a
//                         worker token for an org, verify a token
//   infrastructure/       InMemory (tests), Postgres (real)

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

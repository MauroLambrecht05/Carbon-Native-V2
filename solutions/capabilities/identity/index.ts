// @carbon/identity — accounts and API tokens for Carbon Cloud.
//
// Self-hosted v1's whole model: an Organization owns everything (builds,
// eventually billing), and an ApiToken authenticates as one. No users, no
// roles, no OAuth — CreateOrganizationUseCase is the entire signup flow.
//
//   domain/               Organization, ApiToken, token hashing
//   application/ports/    IdentityRepository
//   application/usecases/ create an org (+ its first token), verify a token
//   infrastructure/       InMemory (tests), Postgres (real)

export { Organization, type OrganizationProps } from "./domain/entities/Organization.ts";
export { ApiToken, type ApiTokenProps } from "./domain/entities/ApiToken.ts";
export { hashToken } from "./domain/value-objects/TokenHash.ts";
export type { IdentityRepository } from "./application/ports/IdentityRepository.ts";
export {
  CreateOrganizationUseCase,
  type CreateOrganizationResult,
} from "./application/usecases/CreateOrganizationUseCase.ts";
export { VerifyTokenUseCase } from "./application/usecases/VerifyTokenUseCase.ts";
export { InMemoryIdentityRepository } from "./infrastructure/InMemoryIdentityRepository.ts";
export { PostgresIdentityRepository } from "./infrastructure/PostgresIdentityRepository.ts";

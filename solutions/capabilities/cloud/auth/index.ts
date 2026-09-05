// @carbon/auth — end-user identity for an app's OWN customers, distinct
// from @carbon/identity's Organization (the app DEVELOPER'S account).
//
// v1 scope: magic-link sign-in only. OAuth (Google/GitHub/etc. sign-in)
// is real, separate scope — a provider-specific callback flow and token
// exchange per provider, not a variant of this same code — and is not
// built here; the roadmap groups it with this capability because both
// solve "how does an end user prove who they are," not because either
// implies the other.
//
// No password storage anywhere, by design: a magic link IS the proof of
// email control, and there is nothing else to compromise in a breach of
// this data.
//
//   domain/               EndUser, MagicLinkToken (single-use, 15min TTL),
//                         Session (30-day TTL), hashing
//   application/ports/    AuthRepository
//   application/usecases/ request a magic link, consume one into a session,
//                         verify a session
//   infrastructure/       InMemory (tests), Postgres (real)
//
// Wired into products/carbon-cloud the same way @carbon/identity is —
// see that product's routes.ts's /v1/end-users/* handlers — NOT into a
// separate product, because this capability has no persistence or
// deployment story of its own yet that would justify one.

export { EndUser, type EndUserProps } from "./domain/entities/EndUser.ts";
export { MagicLinkToken, type MagicLinkTokenProps, MAGIC_LINK_TTL_MS } from "./domain/entities/MagicLinkToken.ts";
export { Session, type SessionProps, SESSION_TTL_MS } from "./domain/entities/Session.ts";
export { hashToken } from "./domain/value-objects/TokenHash.ts";
export type { AuthRepository } from "./application/ports/AuthRepository.ts";
export {
  RequestMagicLinkUseCase,
  type RequestMagicLinkResult,
} from "./application/usecases/RequestMagicLinkUseCase.ts";
export {
  ConsumeMagicLinkUseCase,
  type ConsumeMagicLinkResult,
} from "./application/usecases/ConsumeMagicLinkUseCase.ts";
export {
  VerifyEndUserSessionUseCase,
  type VerifiedSession,
} from "./application/usecases/VerifyEndUserSessionUseCase.ts";
export { InMemoryAuthRepository } from "./infrastructure/InMemoryAuthRepository.ts";
export { PostgresAuthRepository } from "./infrastructure/PostgresAuthRepository.ts";

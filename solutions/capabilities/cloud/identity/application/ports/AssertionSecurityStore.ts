import type { InternalAssertion } from "@carbon/contracts/platform";

export interface AssertionSecurityStore {
  /** Check live credential and permission revision. Failure/unavailability must deny. */
  isCurrent(assertion: InternalAssertion, token?: string): Promise<boolean>;
  /** Atomic, durable insert-if-absent. Retain through expiry + clock tolerance. */
  consume(issuer: string, audience: string, jti: string, retainUntil: Date): Promise<boolean>;
}

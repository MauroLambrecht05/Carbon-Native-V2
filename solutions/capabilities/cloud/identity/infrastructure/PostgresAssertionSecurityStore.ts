import type { InternalAssertion } from "@carbon/contracts/platform";
import type { AssertionSecurityStore } from "../application/ports/AssertionSecurityStore.ts";

/** The recipient owns its replay database. Live authority comes from its pinned
 * Cloud authority adapter; the caller cannot substitute a browser credential. */
export class PostgresAssertionSecurityStore implements AssertionSecurityStore {
  constructor(private readonly sql: Bun.SQL, private readonly checkAuthority: (assertion: InternalAssertion, token?: string) => Promise<boolean>) {}

  isCurrent(assertion: InternalAssertion, token?: string): Promise<boolean> { return this.checkAuthority(assertion, token); }

  async consume(issuer: string, audience: string, jti: string, retainUntil: Date): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO internal_assertion_replays (issuer, audience, jti, retain_until)
      VALUES (${issuer}, ${audience}, ${jti}, ${retainUntil})
      ON CONFLICT (issuer, audience, jti) DO NOTHING RETURNING jti
    `;
    return rows.length === 1;
  }

  /** Bounded housekeeping; never delete a token still inside its replay window. */
  async pruneExpired(limit = 1000): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("Invalid replay retention batch size");
    const rows = await this.sql`
      WITH expired AS (
        SELECT issuer, audience, jti FROM internal_assertion_replays
        WHERE retain_until < now() ORDER BY retain_until LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      DELETE FROM internal_assertion_replays AS replay USING expired
      WHERE replay.issuer = expired.issuer AND replay.audience = expired.audience AND replay.jti = expired.jti
      RETURNING replay.jti
    `;
    return rows.length;
  }
}

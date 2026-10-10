import { createHash } from "node:crypto";
import type { MessageProtector } from "../application/ports/AccountNotification.ts";
import type { TotpVerifier } from "../application/ports/TotpVerifier.ts";

export interface StoredMfaFactor { id: string; encrypted_secret_reference: string; last_counter: string | number | null }
export type MfaVerification = "verified" | "invalid" | "locked";

/** Called with the account row already locked. Failed attempts must be committed
 * before the HTTP boundary throws; throwing inside the transaction undoes limits. */
export class PostgresMfaVerification {
  constructor(private readonly protector: MessageProtector, private readonly totp: TotpVerifier, private readonly now = () => new Date()) {}
  async verify(tx: Bun.TransactionSQL, accountId: string, factor: StoredMfaFactor, code: string, allowRecovery: boolean): Promise<MfaVerification> {
    const rows = await tx`SELECT mfa_locked_until > now() AS locked FROM accounts WHERE id = ${accountId}`;
    if (rows[0]?.locked) return "locked";
    let verified = false;
    if (allowRecovery && /^cr_[A-Za-z0-9_-]{22}$/.test(code)) {
      const digest = createHash("sha256").update(code).digest("hex");
      const codes = await tx`UPDATE recovery_codes SET consumed_at = now() WHERE account_id = ${accountId} AND code_hash = ${digest} AND consumed_at IS NULL RETURNING id`;
      verified = codes.length === 1;
    } else if (/^[0-9]{6}$/.test(code)) {
      const secret = await this.protector.open(factor.encrypted_secret_reference, `mfa:${factor.id}`);
      const counter = this.totp.verify(secret, code, this.now());
      if (counter !== null && (factor.last_counter === null || counter > Number(factor.last_counter))) {
        await tx`UPDATE mfa_factors SET last_counter = ${counter} WHERE id = ${factor.id}`;
        verified = true;
      }
    }
    if (verified) {
      await tx`UPDATE accounts SET mfa_failed_attempts = 0, mfa_locked_until = NULL WHERE id = ${accountId}`;
      return "verified";
    }
    await tx`UPDATE accounts SET
      mfa_failed_attempts = CASE WHEN mfa_locked_until <= now() THEN 1 ELSE mfa_failed_attempts + 1 END,
      mfa_locked_until = CASE WHEN mfa_locked_until <= now() THEN NULL WHEN mfa_failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE mfa_locked_until END
      WHERE id = ${accountId}`;
    return "invalid";
  }
}

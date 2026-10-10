import { randomUUID } from "node:crypto";
import type { AccountMailJob, AccountMailQueue } from "../application/ports/AccountNotification.ts";

export class PostgresAccountMailQueue implements AccountMailQueue {
  constructor(private readonly sql: Bun.SQL) {}

  async claim(): Promise<AccountMailJob | null> {
    const leaseId = randomUUID();
    return this.sql.begin(async tx => {
      await tx`
        WITH expired AS (SELECT id FROM account_email_outbox WHERE state IN ('pending', 'sending') AND expires_at <= now() LIMIT 100 FOR UPDATE SKIP LOCKED)
        UPDATE account_email_outbox SET state = 'expired', protected_message = NULL, lease_id = NULL, lease_expires_at = NULL WHERE id IN (SELECT id FROM expired)
      `;
      const rows = await tx`
        WITH candidate AS (
          SELECT id FROM account_email_outbox WHERE expires_at > now()
            AND (state = 'pending' AND ready_at <= now() OR state = 'sending' AND lease_expires_at <= now())
          ORDER BY ready_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
        )
        UPDATE account_email_outbox SET state = 'sending', lease_id = ${leaseId}, lease_expires_at = now() + interval '60 seconds', attempt = attempt + 1
        WHERE id IN (SELECT id FROM candidate) RETURNING id, protected_message
      `;
      const row = rows[0];
      return row ? { id: row.id, leaseId, protectedMessage: row.protected_message } : null;
    });
  }

  async delivered(job: AccountMailJob): Promise<void> {
    await this.sql`UPDATE account_email_outbox SET state = 'delivered', delivered_at = now(), protected_message = NULL, lease_id = NULL, lease_expires_at = NULL
      WHERE id = ${job.id} AND lease_id = ${job.leaseId} AND state = 'sending'`;
  }

  async retry(job: AccountMailJob): Promise<void> {
    await this.sql`UPDATE account_email_outbox SET state = 'pending', ready_at = now() + (LEAST(attempt * 5, 60) * interval '1 second'), lease_id = NULL, lease_expires_at = NULL
      WHERE id = ${job.id} AND lease_id = ${job.leaseId} AND state = 'sending'`;
  }
}

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountEmail, AccountNotification } from "../../../../solutions/capabilities/cloud/identity/application/ports/AccountNotification.ts";

/** Deliberately stores readable development mail. Never composed in production. */
export class DevelopmentInboxNotification implements AccountNotification {
  constructor(private readonly directory: string) {}
  async send(message: AccountEmail, idempotencyKey: string): Promise<void> {
    if (!/^account-challenge-[0-9a-f-]{36}$/.test(idempotencyKey)) throw new Error("Invalid development email ID");
    await mkdir(this.directory, { recursive: true });
    try { await writeFile(join(this.directory, `${idempotencyKey}.json`), JSON.stringify(message, null, 2), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}

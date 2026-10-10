import { accountPlatformConfigFromEnv, composeAccountPlatform } from "./account-platform.ts";
import { openDatabase } from "../infrastructure/persistence/Database.ts";

if (import.meta.main) {
  const config = accountPlatformConfigFromEnv();
  if (!config || !process.env.DATABASE_URL) throw new Error("Account mail worker requires enabled account configuration and DATABASE_URL");
  const sql = openDatabase(process.env.DATABASE_URL);
  const { deliverMail, expireAccountProofs } = composeAccountPlatform(sql, config);
  let nextMaintenance = 0;
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  try {
    while (!stopping) {
      try {
        if (Date.now() >= nextMaintenance) { await expireAccountProofs(); nextMaintenance = Date.now() + 1000; }
        if (await deliverMail.execute()) continue;
      }
      catch { console.error(JSON.stringify({ event: "account.mail.queue_unavailable" })); }
      await Bun.sleep(1000);
    }
  } finally { await sql.close(); }
}

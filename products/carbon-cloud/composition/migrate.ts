import { migrate, openDatabase } from "../infrastructure/persistence/Database.ts";

if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const sql = openDatabase(process.env.DATABASE_URL);
  try {
    await migrate(sql);
    console.log("Cloud migrations applied and verified");
  } finally { await sql.close(); }
}

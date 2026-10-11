import { join } from "node:path";
import { migrationStatus } from "@carbon/operations";
import { migrate, openDatabase } from "../infrastructure/persistence/Database.ts";

// The release step that changes the schema, and the report that says where a
// database stands. Run `migrate` before starting a new version of the service;
// `migrate status` changes nothing and exits non-zero when the database is not
// exactly at the version this code ships.
//
//   bun run migrate            apply what is pending, under an advisory lock
//   bun run migrate status     print applied, pending and drift as JSON
if (import.meta.main) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const sql = openDatabase(process.env.DATABASE_URL);
  try {
    if (process.argv[2] === "status") {
      const status = await migrationStatus(sql, "database_schema_migrations", join(import.meta.dir, "../infrastructure/persistence/migrations"));
      console.log(JSON.stringify(status, null, 2)); if (!status.current) process.exitCode = 1;
    } else { await migrate(sql); console.log("Database migrations applied and verified"); }
  } finally { await sql.close(); }
}

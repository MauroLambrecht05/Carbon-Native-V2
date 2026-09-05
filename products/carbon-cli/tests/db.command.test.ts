import { describe, expect, test } from "bun:test";
import { dbCommand, DbCommand } from "../presentation/commands/database/db.command.ts";

describe("DbCommand (carbon db)", () => {
  test("instantiates and exposes valid meta", () => {
    const cmd = new DbCommand();
    expect(cmd.meta.name).toBe("db");
    expect(cmd.meta.summary).toContain("Carbon Database");
    expect(cmd.meta.usage).toBe("db <status|sql|export> [options]");
  });

  test("prints help and returns 0 when called without arguments", async () => {
    const code = await dbCommand([]);
    expect(code).toBe(0);
  });

  test("prints help and returns 0 when called with --help", async () => {
    const code = await dbCommand(["--help"]);
    expect(code).toBe(0);
  });

  test("reports unknown subcommand with exit code 1", async () => {
    const code = await dbCommand(["invalid_subcommand"]);
    expect(code).toBe(1);
  });

  test("fails gracefully when connecting to offline endpoint", async () => {
    const originalUrl = process.env.CARBON_DB_URL;
    process.env.CARBON_DB_URL = "http://localhost:59999"; // unused port
    const code = await dbCommand(["status"]);
    expect(code).toBe(1);
    if (originalUrl) {
      process.env.CARBON_DB_URL = originalUrl;
    } else {
      delete process.env.CARBON_DB_URL;
    }
  });
});

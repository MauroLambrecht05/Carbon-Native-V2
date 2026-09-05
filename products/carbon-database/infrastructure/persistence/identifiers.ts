// Every engine below builds dynamic SQL against project-, table-, and
// column-NAMES an app developer supplies over the API (POST .../tables,
// column definitions, project ids). Postgres identifiers can't be bound
// as query parameters the way values can — so every raw identifier that
// gets string-interpolated into a query MUST be validated against a
// strict allowlist first, or this is a real SQL-injection surface, not a
// theoretical one (a table name of `x"; DROP TABLE ...; --` would run
// exactly what it says if this file didn't exist).
//
// The allowlist is deliberately stricter than "double-quote it and hope":
// plain ASCII word characters and hyphens only, max 63 bytes (Postgres's
// own identifier length limit) — anything else is refused outright, not
// escaped. Hyphens are allowed because project ids look like
// "proj-1234abcd" (routes.ts's own generator).

const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/;

export class InvalidIdentifierError extends Error {
  constructor(kind: string, value: string) {
    super(`invalid ${kind}: ${JSON.stringify(value)} — must match ${VALID_IDENTIFIER}`);
  }
}

/** Throws InvalidIdentifierError if `name` isn't safe to interpolate raw. */
export function assertValidIdentifier(name: string, kind = "identifier"): string {
  if (!VALID_IDENTIFIER.test(name)) {
    throw new InvalidIdentifierError(kind, name);
  }
  return name;
}

/** Validates, then returns the double-quoted form ready to splice into SQL. */
export function quoteIdent(name: string, kind = "identifier"): string {
  assertValidIdentifier(name, kind);
  return `"${name}"`;
}

/** The dedicated Postgres schema a project's user-defined tables live in. */
export function projectSchema(projectId: string): string {
  assertValidIdentifier(projectId, "project id");
  return `proj_${projectId.replace(/-/g, "_")}`;
}

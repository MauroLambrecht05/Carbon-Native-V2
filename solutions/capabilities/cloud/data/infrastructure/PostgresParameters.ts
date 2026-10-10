/** Bun SQL's unsafe parameter binding does not encode JS arrays as PostgreSQL arrays.
 * Values remain bound parameters; quoted elements preserve commas, braces and escapes. */
export function postgresArray(values: readonly string[]): string {
  return '{' + values.map(value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"').join(',') + '}';
}

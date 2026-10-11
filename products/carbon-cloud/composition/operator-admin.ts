import { OperatorAdministration, PostgresOperators } from '@carbon/identity';
import type { OperatorRole } from '@carbon/contracts/platform';
import { openDatabase } from '../infrastructure/persistence/Database.ts';

// Creates Cloud operators and their credentials. It runs against Cloud's
// database directly, by whoever administers Cloud; no HTTP route does this.
//
//   bun run operator-admin create <email> <name> <role[,role]>     roles: support, security, recovery
//   bun run operator-admin credential <operatorId> [hours]         prints the credential once
//   bun run operator-admin disable <operatorId>
if (import.meta.main) {
  const [action, ...args] = process.argv.slice(2);
  if (!process.env.DATABASE_URL) throw new Error('operator-admin requires DATABASE_URL');
  const sql = openDatabase(process.env.DATABASE_URL);
  try {
    const admin = new OperatorAdministration(new PostgresOperators(sql));
    if (action === 'create' && args.length === 3) console.log(JSON.stringify({ operatorId: await admin.create(args[0]!, args[1]!, args[2]!.split(',') as OperatorRole[]) }));
    else if (action === 'credential' && args[0]) console.log(JSON.stringify({ credential: await admin.issue(args[0], args[1] ? Number(args[1]) : 8) }));
    else if (action === 'disable' && args[0]) { await admin.disable(args[0]); console.log(JSON.stringify({ disabled: args[0] })); }
    else { console.error('usage: operator-admin create <email> <name> <roles> | credential <operatorId> [hours] | disable <operatorId>'); process.exitCode = 2; }
  } finally { await sql.close(); }
}

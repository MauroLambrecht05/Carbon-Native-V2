import { openDatabase } from '../infrastructure/persistence/Database.ts';
import { configFromEnv } from './entrypoint.ts';
import { composeLifecyclePlatform } from './lifecycle-platform.ts';

// The operator's review tool. It runs beside the Registry service with the
// same database, archive bucket and trust settings, and is the only way a
// submitted version becomes published or a published one is revoked. No HTTP
// route leads here, so no customer credential can reach it.
//
//   bun run review pending
//   bun run review history <versionId>
//   bun run review approve|reject|revoke <versionId> --operator <name> --reason <text>
if (import.meta.main) {
  const [action, versionId, ...rest] = process.argv.slice(2);
  const option = (name: string) => { const index = rest.indexOf(`--${name}`); return index >= 0 ? rest[index + 1] ?? '' : ''; };
  const config = configFromEnv();
  if (!config.internalPlatform?.publishing) throw new Error('Review requires CARBON_REGISTRY_PUBLISHING=enabled and its settings');
  const sql = openDatabase(config.databaseUrl);
  try {
    const review = composeLifecyclePlatform(sql, config.internalPlatform).review!;
    if (action === 'pending') console.log(JSON.stringify(await review.pending(100), null, 2));
    else if (action === 'history' && versionId) console.log(JSON.stringify(await review.reviews(versionId), null, 2));
    else if ((action === 'approve' || action === 'reject' || action === 'revoke') && versionId) {
      console.log(JSON.stringify(await review[action]({ versionId, operator: option('operator'), reason: option('reason'), requestId: crypto.randomUUID() }), null, 2));
    } else { console.error('usage: review pending | history <versionId> | approve|reject|revoke <versionId> --operator <name> --reason <text>'); process.exitCode = 2; }
  } finally { await sql.close(); }
}

// Executable CLI entrypoint for carbon-templates

import { getTemplatesApi } from "./composition/entrypoint.ts";

const { registry } = getTemplatesApi();
console.log("\n📦 Carbon Native Curated Templates:\n");
for (const t of registry.list()) {
  console.log(`  • ${t.id.padEnd(18)} — ${t.name} (${t.category})`);
  console.log(`    ${t.description}`);
}
console.log("\nUsage: carbon init <name> --template <id>\n");

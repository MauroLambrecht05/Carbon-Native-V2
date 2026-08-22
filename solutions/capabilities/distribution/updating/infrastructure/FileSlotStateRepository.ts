// Persists slot state as <install-dir>/current.toml.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { SlotState } from "../domain/entities/SlotState.ts";
import type { SlotStateRepository } from "../domain/repositories/SlotStateRepository.ts";

export const STATE_FILENAME = "current.toml";

export class FileSlotStateRepository implements SlotStateRepository {
  load(installDir: string): SlotState {
    const currentPath = join(installDir, STATE_FILENAME);
    if (!existsSync(currentPath)) {
      // A missing file is the first-run case, not an error — which is why the
      // installation id is minted here rather than at install time.
      return SlotState.initial(randomUUID());
    }

    const parsed = parseToml(readFileSync(currentPath, "utf8")) as Record<string, unknown>;
    return new SlotState({
      active_slot: String(parsed.active_slot ?? "1.0.0"),
      previous_slot: (parsed.previous_slot as string | undefined) ?? null,
      in_progress_count: Number(parsed.in_progress_count ?? 0),
      last_successful_version: (parsed.last_successful_version as string | undefined) ?? null,
      installation_id: String(parsed.installation_id ?? randomUUID()),
    });
  }

  save(installDir: string, state: SlotState): void {
    mkdirSync(installDir, { recursive: true });
    // TOML has no null: serde skipped `None` fields, so absent keys are how
    // "no previous slot" round-trips. Emitting `previous_slot = ""` instead
    // would make a rollback to the empty string look available.
    const table: Record<string, unknown> = {
      active_slot: state.active_slot,
      in_progress_count: state.in_progress_count,
      installation_id: state.installation_id,
    };
    if (state.previous_slot !== null) table.previous_slot = state.previous_slot;
    if (state.last_successful_version !== null) {
      table.last_successful_version = state.last_successful_version;
    }

    writeFileSync(join(installDir, STATE_FILENAME), stringifyToml(table));
  }
}

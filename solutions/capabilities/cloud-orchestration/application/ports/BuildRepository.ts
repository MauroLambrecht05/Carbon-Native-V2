// Where builds are stored, and how a worker claims one.
//
// claimNext is the one method that isn't a plain CRUD verb: it has to be
// atomic under concurrent workers polling at once, which is why it is a
// single repository operation ("find the oldest queued build for this
// platform AND mark it claimed, as one step") rather than a find-then-save
// the use case would do — two workers doing find-then-save on the same row
// both succeed; two workers doing "claim it or get null" cannot both win.

import type { Build } from "../../domain/entities/Build.ts";
import type { TargetPlatform } from "@carbon/contracts/distribution";

export interface BuildRepository {
  save(build: Build): Promise<void>;
  findById(id: string): Promise<Build | null>;
  /** Atomically claims the oldest queued build whose targets need `platform`. */
  claimNext(platform: TargetPlatform, workerId: string): Promise<Build | null>;
}

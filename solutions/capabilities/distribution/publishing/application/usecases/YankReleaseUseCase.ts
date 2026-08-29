// Use case: prevent a version from being offered to new installs.
//
// Writes to `<channel>/yanked.json` — the StopList (@carbon/updating) an
// installed app's updater is expected to check before applying an update it
// downloaded. Real on the client side too now: products/carbon/composition/
// mini.rs's background updater thread fetches this and rolls back away from
// a yanked version it's currently running (see mini.rs's read_updater_section
// call site) — this use case and that check share the exact StopList shape
// (domain/value-objects/StopList.ts / rust/domain/stop_list.rs), on purpose.

import type { Logger } from "@carbon/logging";
import { StopList, type YankedEntry } from "@carbon/updating";
import {
  fetchStopList,
  uploadStopList,
  fetchManifest,
  type S3Config,
} from "../../infrastructure/S3ArtifactStore.ts";
import { RollbackReleaseUseCase } from "./RollbackReleaseUseCase.ts";

export interface YankReleaseRequest {
  readonly channel: string;
  readonly version: string;
  readonly reason?: string;
  /** If true AND `version` is the channel's currently-published version,
   *  also roll the channel back — to `rollbackTo`, which must be given
   *  explicitly. There is no "guess the last known-good version" heuristic
   *  here: picking wrong would silently re-offer a bad release, which is a
   *  worse failure mode than refusing to guess. */
  readonly autoRollback: boolean;
  readonly rollbackTo?: string;
  /** Injectable so yanked_at is reproducible under test. */
  readonly now?: Date;
}

export interface YankReleaseResult {
  readonly yankedVersions: readonly string[];
  readonly rolledBackTo?: string;
}

export class YankReleaseUseCase {
  constructor(
    private readonly s3: S3Config,
    private readonly logger?: Logger,
  ) {}

  async execute(request: YankReleaseRequest): Promise<YankReleaseResult> {
    const existing = await fetchStopList(this.s3, request.channel);
    const alreadyYanked = existing.yanked.some((e) => e.version === request.version);
    let yanked = existing.yanked;
    if (!alreadyYanked) {
      const entry: YankedEntry = {
        version: request.version,
        reason: request.reason ?? null,
        yanked_at: (request.now ?? new Date()).toISOString(),
      };
      yanked = [...existing.yanked, entry];
      const updated = new StopList({ yanked, generated_at: (request.now ?? new Date()).toISOString() });
      const upload = await uploadStopList(this.s3, request.channel, updated, this.logger);
      if (!upload.success) {
        throw new Error(`yank failed: ${upload.error ?? "unknown error"}`);
      }
    }

    let rolledBackTo: string | undefined;
    if (request.autoRollback) {
      const current = await fetchManifest(this.s3, request.channel);
      if (current?.manifest.version === request.version) {
        if (!request.rollbackTo) {
          throw new Error(
            `${request.version} is the current published version on "${request.channel}" and ` +
              `--auto-rollback was given, but no --to <version> was supplied — automatic ` +
              `"previous known-good version" detection isn't implemented, pass --to explicitly`,
          );
        }
        await new RollbackReleaseUseCase(this.s3, this.logger).execute({
          channel: request.channel,
          toVersion: request.rollbackTo,
        });
        rolledBackTo = request.rollbackTo;
      }
    }

    return { yankedVersions: yanked.map((e) => e.version), rolledBackTo };
  }
}

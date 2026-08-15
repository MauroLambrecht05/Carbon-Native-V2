import type { UsageRecord } from "../../domain/entities/UsageRecord.ts";

export interface UsageRepository {
  save(record: UsageRecord): Promise<void>;
  /** Total build-minutes an org has used since `since`. */
  sumMinutesForOrg(orgId: string, since: Date): Promise<number>;
}

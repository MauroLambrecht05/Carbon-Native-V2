import { UsageRecord } from "../../domain/entities/UsageRecord.ts";
import type { UsageRepository } from "../ports/UsageRepository.ts";

export class RecordBuildUsageUseCase {
  constructor(private readonly usage: UsageRepository) {}

  async execute(input: { orgId: string; buildId: string; durationMs: number }): Promise<void> {
    await this.usage.save(UsageRecord.record({ id: crypto.randomUUID(), ...input }));
  }
}

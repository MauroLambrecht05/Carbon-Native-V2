export interface UsageRecordProps {
  readonly id: string;
  readonly orgId: string;
  readonly buildId: string;
  readonly durationMs: number;
  readonly recordedAt: Date;
}

export class UsageRecord {
  private constructor(private readonly props: UsageRecordProps) {}

  static record(input: { id: string; orgId: string; buildId: string; durationMs: number }): UsageRecord {
    return new UsageRecord({ ...input, recordedAt: new Date() });
  }

  static fromProps(props: UsageRecordProps): UsageRecord {
    return new UsageRecord(props);
  }

  toProps(): UsageRecordProps {
    return this.props;
  }
}

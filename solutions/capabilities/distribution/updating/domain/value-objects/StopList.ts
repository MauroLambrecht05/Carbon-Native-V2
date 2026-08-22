// The yank list: versions clients must refuse even though a manifest offers them.
//
// Ported from V1 tools/updater/src/stop_list.rs (renamed to kebab-case to match
// the surrounding TypeScript).

export interface YankedEntry {
  version: string;
  reason: string | null;
  yanked_at: string;
}

export interface StopListData {
  yanked: YankedEntry[];
  generated_at: string;
}

export class StopList implements StopListData {
  yanked: YankedEntry[];
  generated_at: string;

  constructor(data: StopListData) {
    this.yanked = data.yanked;
    this.generated_at = data.generated_at;
  }

  static fromJson(json: string): StopList {
    const parsed = JSON.parse(json) as StopListData;
    return new StopList({
      yanked: parsed.yanked ?? [],
      generated_at: parsed.generated_at,
    });
  }

  toJson(): string {
    return JSON.stringify({ yanked: this.yanked, generated_at: this.generated_at }, null, 2);
  }
}

export function isYanked(stopList: StopListData, version: string): YankedEntry | undefined {
  return stopList.yanked.find((entry) => entry.version === version);
}

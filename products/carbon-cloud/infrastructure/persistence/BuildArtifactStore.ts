// Build Artifact & Realtime Log Store for Carbon Cloud.
// Stores compilation logs and downloadable installer binaries.

export interface BuildLogEntry {
  readonly timestamp: string;
  readonly stream: "stdout" | "stderr";
  readonly line: string;
}

export interface BuildArtifact {
  readonly id: string;
  readonly buildId: string;
  readonly name: string;
  readonly target: string;
  readonly sizeBytes: number;
  readonly downloadUrl: string;
  readonly checksumSha256?: string;
  readonly uploadedAt: string;
}

export class BuildArtifactStore {
  private static instance: BuildArtifactStore;

  // Map<buildId, BuildLogEntry[]>
  private readonly logs = new Map<string, BuildLogEntry[]>();
  // Map<buildId, BuildArtifact[]>
  private readonly artifacts = new Map<string, BuildArtifact[]>();

  static getInstance(): BuildArtifactStore {
    if (!BuildArtifactStore.instance) {
      BuildArtifactStore.instance = new BuildArtifactStore();
    }
    return BuildArtifactStore.instance;
  }

  appendLog(buildId: string, line: string, stream: "stdout" | "stderr" = "stdout"): void {
    let entries = this.logs.get(buildId);
    if (!entries) {
      entries = [];
      this.logs.set(buildId, entries);
    }
    entries.push({
      timestamp: new Date().toISOString(),
      stream,
      line,
    });
  }

  getLogs(buildId: string): BuildLogEntry[] {
    return this.logs.get(buildId) || [];
  }

  registerArtifact(buildId: string, artifact: Omit<BuildArtifact, "id" | "uploadedAt">): BuildArtifact {
    let list = this.artifacts.get(buildId);
    if (!list) {
      list = [];
      this.artifacts.set(buildId, list);
    }

    const record: BuildArtifact = {
      ...artifact,
      id: `art_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      uploadedAt: new Date().toISOString(),
    };
    list.push(record);
    return record;
  }

  getArtifacts(buildId: string): BuildArtifact[] {
    return this.artifacts.get(buildId) || [];
  }

  clear(): void {
    this.logs.clear();
    this.artifacts.clear();
  }
}

// UI Widget State Machine for desktop app updater notifications

export type UpdaterUiState =
  | "idle"
  | "checking"
  | "update-available"
  | "downloading"
  | "ready-to-restart"
  | "up-to-date"
  | "error";

export interface UpdaterPromptModel {
  state: UpdaterUiState;
  newVersion?: string;
  progressPercent?: number;
  errorMessage?: string;
}

export class UpdaterPromptStateMachine {
  private model: UpdaterPromptModel = { state: "idle" };

  getState(): Readonly<UpdaterPromptModel> {
    return { ...this.model };
  }

  onStartChecking(): void {
    this.model = { state: "checking" };
  }

  onUpdateFound(newVersion: string): void {
    this.model = { state: "update-available", newVersion };
  }

  onStartDownload(): void {
    this.model = { ...this.model, state: "downloading", progressPercent: 0 };
  }

  onProgress(percent: number): void {
    this.model = { ...this.model, progressPercent: Math.min(100, Math.max(0, percent)) };
  }

  onDownloadComplete(): void {
    this.model = { ...this.model, state: "ready-to-restart", progressPercent: 100 };
  }

  onUpToDate(): void {
    this.model = { state: "up-to-date" };
  }

  onError(message: string): void {
    this.model = { state: "error", errorMessage: message };
  }
}

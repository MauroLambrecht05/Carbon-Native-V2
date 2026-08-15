// A build: a repo + commit, turned into installers for one or more targets.
//
// Deliberately platform-agnostic about WHERE it runs — that's cloud-workers'
// concern. This entity only knows what a build IS and what state it's in.

import type { InstallerTargetId } from "@carbon/contracts/distribution";
import { canTransition, type BuildStatus } from "../value-objects/BuildStatus.ts";

export interface BuildArtifact {
  readonly target: InstallerTargetId;
  readonly path: string;
  readonly sha256: string;
  readonly url: string;
}

export interface BuildProps {
  readonly id: string;
  readonly orgId: string;
  readonly repoUrl: string;
  readonly commitSha: string;
  readonly targets: readonly InstallerTargetId[];
  readonly status: BuildStatus;
  readonly workerId: string | null;
  readonly artifacts: readonly BuildArtifact[];
  readonly error: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export class InvalidTransitionError extends Error {
  constructor(readonly from: BuildStatus, readonly to: BuildStatus) {
    super(`a build cannot move from "${from}" to "${to}"`);
  }
}

export class Build {
  private constructor(private props: BuildProps) {}

  static queue(input: {
    id: string;
    orgId: string;
    repoUrl: string;
    commitSha: string;
    targets: readonly InstallerTargetId[];
  }): Build {
    const now = new Date();
    return new Build({
      ...input,
      status: "queued",
      workerId: null,
      artifacts: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static fromProps(props: BuildProps): Build {
    return new Build(props);
  }

  toProps(): BuildProps {
    return this.props;
  }

  get id(): string {
    return this.props.id;
  }

  get status(): BuildStatus {
    return this.props.status;
  }

  /** @throws InvalidTransitionError */
  private transition(to: BuildStatus, patch: Partial<BuildProps> = {}): void {
    if (!canTransition(this.props.status, to)) {
      throw new InvalidTransitionError(this.props.status, to);
    }
    this.props = { ...this.props, ...patch, status: to, updatedAt: new Date() };
  }

  /** @throws InvalidTransitionError */
  claim(workerId: string): void {
    this.transition("claimed", { workerId });
  }

  /** @throws InvalidTransitionError */
  start(): void {
    this.transition("running");
  }

  /** @throws InvalidTransitionError */
  succeed(artifacts: readonly BuildArtifact[]): void {
    this.transition("succeeded", { artifacts });
  }

  /** @throws InvalidTransitionError */
  fail(error: string): void {
    this.transition("failed", { error });
  }
}

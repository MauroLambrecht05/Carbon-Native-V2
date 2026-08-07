// The ArtifactSource port.
//
// "Fetch the bytes for this platform" is the one thing the update use cases
// need from the outside world. Keeping it an interface is what lets the slot
// state machine be tested end to end — stage, apply, crash, roll back —
// without a network, which is the part that actually has to be right.

import type { PlatformEntry, UpdaterManifest } from "@carbon/contracts/update";

export interface FetchedArtifact {
  readonly path: string;
  readonly size: number;
}

export interface ArtifactSource {
  fetch(
    manifest: UpdaterManifest,
    platform: string,
    entry: PlatformEntry,
    stagingDir: string,
  ): Promise<FetchedArtifact>;
}

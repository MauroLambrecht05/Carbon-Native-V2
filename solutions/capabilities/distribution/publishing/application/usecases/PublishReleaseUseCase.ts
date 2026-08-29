// Use case: publish one platform's built installer as a release.
//
// This is what used to be `carbon publish app` printing "publishing is not
// wired up: no artifacts were uploaded" no matter what it was given. Every
// piece it calls already existed and worked in isolation — S3ArtifactStore's
// upload/fetch functions, @carbon/signing's signBytes/signManifest,
// BuildUpdateManifestUseCase — publishing was a wiring gap, not a missing
// capability.
//
// One call publishes one (version, platform) pair. A multi-platform release
// is one call per platform, each run from the machine/CI runner that actually
// built that platform's installer — cross-building isn't supported (see
// contracts/distribution's isBuildableOn), so there is no single machine that
// could ever hold every platform's artifact at once. Each call fetches
// whatever the channel's manifest currently is and merges its own platform
// entry in, so the platforms accumulate across runs instead of the last one
// clobbering the others.

import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Logger } from "@carbon/logging";
import { signBytes, signManifest, canonicalizeManifest } from "@carbon/signing";
import type { PlatformEntry, UpdaterManifest } from "@carbon/contracts/update";
import { BuildUpdateManifestUseCase } from "./BuildUpdateManifestUseCase.ts";
import {
  uploadToS3,
  uploadManifestTo,
  fetchManifest,
  type S3Config,
} from "../../infrastructure/S3ArtifactStore.ts";

export interface PublishReleaseRequest {
  readonly version: string;
  readonly channel: string;
  /** Percentage of installs offered the update, 0-100. */
  readonly rollout: number;
  /** Manifest key this artifact is published under — a target triple
   *  (e.g. "x86_64-pc-windows-msvc"), matching what the installed app's
   *  updater looks itself up by. Free-form: nothing here validates it
   *  against a fixed list, the same way BuildUpdateManifestUseCase doesn't. */
  readonly platform: string;
  /** Local path to the already-built installer for that platform. Producing
   *  it is `carbon bundle` + the platform's own packaging tool (makensis /
   *  wix / dpkg-deb / appimagetool) — this use case only ever signs and
   *  ships a file that's already there. */
  readonly artifactPath: string;
  readonly keyFile: string;
  readonly password: string;
  /** The app's [updater].pubkey — goes into the manifest's keyring so the
   *  client can verify what this call signs. */
  readonly pubkey: string;
  readonly notes?: string;
  readonly minVersion?: string | null;
  /** Injectable so pub_date is reproducible under test. */
  readonly now?: Date;
}

export interface PublishReleaseResult {
  readonly manifest: UpdaterManifest;
  readonly artifactUrl: string;
  readonly manifestUrl: string;
  readonly sha256: string;
}

export class PublishReleaseUseCase {
  constructor(
    private readonly s3: S3Config,
    private readonly logger?: Logger,
  ) {}

  async execute(request: PublishReleaseRequest): Promise<PublishReleaseResult> {
    const bytes = new Uint8Array(readFileSync(request.artifactPath));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const signature = signBytes(bytes, request.keyFile, request.password);

    const remoteArtifactPath = `releases/${request.version}/${basename(request.artifactPath)}`;
    const artifactUpload = await uploadToS3(this.s3, request.artifactPath, remoteArtifactPath, this.logger);
    if (!artifactUpload.success) {
      throw new Error(`artifact upload failed: ${artifactUpload.error ?? "unknown error"}`);
    }

    // Whatever the channel is currently announcing, so this platform's entry
    // joins the others instead of replacing the whole manifest — a second
    // platform's `carbon publish app` run must not un-publish the first.
    const existing = await fetchManifest(this.s3, request.channel);
    const platformEntry: PlatformEntry = { signature, url: artifactUpload.url, sha256 };
    const platforms: Record<string, PlatformEntry> = {
      ...(existing?.manifest.platforms ?? {}),
      [request.platform]: platformEntry,
    };

    const manifest = new BuildUpdateManifestUseCase().execute({
      version: request.version,
      channel: request.channel,
      rollout: request.rollout,
      pubkey: request.pubkey,
      notes: request.notes,
      minVersion: request.minVersion,
      platforms,
      now: request.now,
    });

    // canonicalizeManifest, not JSON.stringify — the uploaded manifest.json's
    // bytes must be exactly what was signed, or a real client's
    // verifyManifest(fetchedText, sig, pubkey) fails against its own release.
    const manifestJson = canonicalizeManifest(manifest);
    const manifestSig = signManifest(manifest, request.keyFile, request.password);

    const tmpDir = mkdtempSync(join(tmpdir(), "carbon-publish-"));
    try {
      const manifestPath = join(tmpDir, "manifest.json");
      const sigPath = join(tmpDir, "manifest.sig");
      writeFileSync(manifestPath, manifestJson);
      writeFileSync(sigPath, manifestSig);

      // The channel pointer — what an installed app's updater actually
      // polls — and a per-version snapshot at the same two files, kept so
      // `publish rollback` can restore this exact signed state later
      // without needing the signing key a second time.
      const [channelUpload, snapshotUpload] = await Promise.all([
        uploadManifestTo(this.s3, manifestPath, sigPath, request.channel, this.logger),
        uploadManifestTo(this.s3, manifestPath, sigPath, `releases/${request.version}`, this.logger),
      ]);
      if (!channelUpload.manifest.success || !channelUpload.signature.success) {
        throw new Error(
          `manifest upload failed: ${channelUpload.manifest.error ?? channelUpload.signature.error ?? "unknown error"}`,
        );
      }
      if (!snapshotUpload.manifest.success || !snapshotUpload.signature.success) {
        throw new Error(
          `manifest snapshot upload failed: ${snapshotUpload.manifest.error ?? snapshotUpload.signature.error ?? "unknown error"}`,
        );
      }

      return {
        manifest,
        artifactUrl: artifactUpload.url,
        manifestUrl: channelUpload.manifest.url,
        sha256,
      };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

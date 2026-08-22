// Building the manifest a release announces to installed apps.
//
// Lifted out of `carbon publish app`, where it was an object literal in the
// middle of an argv parser. Two things were wrong with it there, and both are
// the kind a contract is supposed to catch:
//
//   1. It omitted `min_version`, which contracts/update declares as required.
//      The manifest `--dry-run` printed would not have satisfied the type the
//      updater reads it with.
//   2. It hardcoded `validity_window_days: 90`, the same number
//      RotateKeypairUseCase had its own copy of. That is the keyring's
//      agreement, and it now comes from contracts/security.
//
// ── STILL A STUB ────────────────────────────────────────────────────────────
// Per-platform entries need a signature, a URL and a digest of the artifact
// that was actually built, and nothing wires those in yet — `carbon publish`
// never uploaded anything. Rather than emit `"signature_placeholder"` and call
// it published, platforms are now supplied BY THE CALLER, and a manifest with
// none is a manifest that announces no downloads. The command says "would
// publish" accordingly.

import {
  KEYRING_DEFAULT_VALIDITY_WINDOW_DAYS,
  type Keyring,
} from "@carbon/contracts/security";
import type { PlatformEntry, UpdaterManifest } from "@carbon/contracts/update";

export interface BuildUpdateManifestRequest {
  readonly version: string;
  readonly channel: string;
  /** Percentage of installs offered the update, 0-100. */
  readonly rollout: number;
  /** Base64 verifying key from the app's [updater] section. */
  readonly pubkey: string;
  readonly notes?: string;
  /** Oldest version that may update straight to this one. */
  readonly minVersion?: string | null;
  /** Artifacts, keyed by target triple. Empty until publishing is wired up. */
  readonly platforms?: Record<string, PlatformEntry>;
  /** Injectable so the manifest is reproducible under test. */
  readonly now?: Date;
}

export class BuildUpdateManifestUseCase {
  execute(request: BuildUpdateManifestRequest): UpdaterManifest {
    const keyring: Keyring = {
      primary: request.pubkey,
      secondary: null,
      secondary_signed_by_primary: null,
      validity_window_days: KEYRING_DEFAULT_VALIDITY_WINDOW_DAYS,
    };

    return {
      version: request.version,
      // Date only, not a timestamp: the updater compares releases by version,
      // and a full timestamp would make two manifests built from the same
      // inputs differ.
      pub_date: (request.now ?? new Date()).toISOString().split("T")[0],
      notes: request.notes ?? "",
      channel: request.channel,
      min_version: request.minVersion ?? null,
      // A rollout outside 0-100 is a typo, and clamping is friendlier than
      // shipping to -20% of users (which reads as 0) or claiming 300%.
      rollout: Math.min(100, Math.max(0, request.rollout)),
      keyring: {
        primary: keyring.primary,
        secondary: keyring.secondary,
        validity_window_days: keyring.validity_window_days,
      },
      platforms: request.platforms ?? {},
    };
  }
}

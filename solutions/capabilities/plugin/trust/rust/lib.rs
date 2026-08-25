// carbon-plugin-trust — what makes a native plugin trustworthy at load time.
//
// ── Layout ──────────────────────────────────────────────────────────────────
// The same three layers the rest of solutions/capabilities uses, because the
// split is real here rather than decorative:
//
//   domain/          what a plugin's identity IS (its SHA-256 content hash),
//                    the detached-signature layout, and the revocation list.
//                    No I/O, no key material, no filesystem.
//   application/     the two operations — sign an artifact, verify one — each
//                    of which is a few lines on top of domain.
//   infrastructure/  the private key on disk. The ONLY module that knows what
//                    a key file looks like, and the only one the loader does
//                    not compile.
//
// `#[path]` keeps the module names flat, matching capabilities/updating.
//
// ── THE ASYMMETRY THAT SHAPES THIS CRATE ────────────────────────────────────
// Signing needs a private key and runs once, on Carbon's own machine.
// Verification needs only the 32-byte public key and runs on every user's
// machine, on every launch, before any plugin code executes. So:
//
//   * `verify_artifact` takes the public key as a plain `&[u8; 32]` argument
//     rather than reading one from anywhere. The caller
//     (solutions/infrastructure/plugin-host/adapters/plugin_loader.rs) hardcodes
//     it, which is the point — a public key that can be replaced by editing a
//     file on the user's disk is not a trust anchor.
//   * nothing on the verification path can even name the private key type; that
//     lives behind `keyfile`, reached only by the `carbon-plugin-sign` binary.
//
// ── WHY THIS IS NOT solutions/capabilities/distribution/signing ─────────────
// That capability (`@carbon/signing`) also does Ed25519, and it is not being
// duplicated here by accident. Three things separate them, and any one of them
// alone would be enough:
//
//   1. It is TypeScript. The thing that must refuse an untrusted plugin is
//      `plugin_loader.rs`, in the runtime, before the JS context exists at all.
//      There is nothing for it to call.
//   2. It signs RELEASES — installers and update manifests — in minisign's
//      frozen, V1-compatible on-disk format, with an Argon2id/XChaCha20
//      encrypted secret-key file. That format is frozen because keys are
//      already in the wild; borrowing it here would freeze it for a second
//      reason and put a KDF and a stream cipher on the plugin load path.
//   3. Different key, deliberately. The release key and the plugin key must be
//      able to be rotated, stored and compromised independently — a build
//      machine that can cut a release should not thereby be able to sign a
//      plugin that every installed app loads in-process.
//
// If the two ever should converge, the direction is `@carbon/signing` growing a
// Rust half beside this one, not this crate learning minisign.
//
// ── WHAT A SIGNATURE COVERS ─────────────────────────────────────────────────
// The SHA-256 of the artifact's bytes, and nothing else. Not the filename, not
// the manifest, not the carbon.toml entry — renaming a signed `.dll` keeps it
// valid, and flipping one byte inside it does not. The digest is what gets
// signed (rather than the whole file streamed through Ed25519) because it is
// also the plugin's IDENTITY for the revocation list, so signer and loader
// compute exactly one thing and use it for both.

#[path = "domain/digest.rs"]
pub mod digest;
#[path = "domain/revocation.rs"]
pub mod revocation;
#[path = "domain/signature.rs"]
pub mod signature;

#[path = "application/signing.rs"]
pub mod signing;
#[path = "application/verification.rs"]
pub mod verification;

#[path = "infrastructure/keyfile.rs"]
pub mod keyfile;

pub use digest::ContentHash;
pub use revocation::ensure_not_revoked;
pub use signature::signature_path;
pub use signing::sign_artifact;
pub use verification::{verify_artifact, verify_bytes, PUBLIC_KEY_LEN};

pub type Result<T> = anyhow::Result<T>;

-- Every published version now carries a real Ed25519 detached signature
-- (see TrustSigner.ts) over the SHA-256 of its tarball bytes — the same
-- scheme solutions/capabilities/plugin/trust/rust already uses for
-- locally-built plugins, wired into this product's publish pipeline.
--
-- NOT NULL with no default: every row from here on is signed at publish
-- time (RegistryEngine.publish always calls TrustSigner.sign), so there is
-- no valid state for this column to be absent in going forward. Existing
-- pre-signing rows (only ever the seeded standard-library plugins in a dev
-- database, never real user-published ones — this product has no
-- production deployment yet) are backfilled with an empty string rather
-- than a fabricated signature, which would verify against nothing and is
-- strictly more honest about "not really signed."
ALTER TABLE plugin_versions ADD COLUMN IF NOT EXISTS signature_base64 text NOT NULL DEFAULT '';
ALTER TABLE plugin_versions ALTER COLUMN signature_base64 DROP DEFAULT;

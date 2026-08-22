# update

What a release announces to an installed app: version, channel, rollout
percentage, keyring and per-platform artifacts.

**Agreement** `types/UpdateManifest.ts`
**Honoured by** `capabilities/distribution/signing` (writes and signs it) and
`capabilities/distribution/updating` (fetches and verifies it)

This subject exists because those two capabilities had the same struct
duplicated, each with its own copy — exactly the drift a contract prevents.

Types only for now. When the wire form is pinned it gains `schema/update.fbs`
and switches to `flatbuffers_subject`; today the manifest is JSON, and the
signature covers its exact bytes, so the canonical serialization in
`SignManifestUseCase` is part of the agreement.

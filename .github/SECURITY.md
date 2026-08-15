# Security policy

## Reporting a vulnerability

Report privately via GitHub's **Report a vulnerability** button under the
Security tab. Please do not open a public issue for a security bug.

Include what you did, what happened, and the platform and carbon version.
Expect an acknowledgement within a few days.

## What is in scope

carbon apps run untrusted-ish JavaScript against native host functions, so the
boundaries below are the ones that matter:

- **Capability escapes.** `[app.capabilities]` in `carbon.toml` is an allow-list
  enforced in `runtime/host/`. Reading a path, opening a socket, or spawning a
  process outside a grant is a vulnerability.
- **Plugin sandbox escapes.** Native plugins load over the C ABI in
  `plugins/sdk/`. A plugin obtaining capabilities it was not granted is in
  scope.
- **Update-channel attacks.** Releases are signed with ed25519 (`shared/signer`)
  and verified by `shared/updater`. Anything that lets an unsigned or
  downgraded artifact install is in scope.
- **Memory safety** in any `unsafe` block, particularly the JS↔native bridge.

## What is not in scope

- Anything requiring the attacker to already control the app bundle or the
  developer's machine.
- Denial of service by an app against itself.
- The example applications.

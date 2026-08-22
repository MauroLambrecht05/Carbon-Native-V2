# distribution

Which installer formats exist, what each is called, and where each can be
built.

**Agreement** `types/InstallerTarget.ts`
**Honoured by** `capabilities/distribution/packaging` (one generator per target) and
`products/carbon-cli` (validates `--target`, expands `--target all`, and
renders its help from the registry)

This subject exists because the list of targets was written out five separate
times inside a single CLI command — the `all` expansion, the validation array,
two help strings and a `switch` — while the capability that owns the generators
declared it nowhere. Adding a format to the switch but missing the validation
array made it unreachable, with no error anywhere.

## Blast radius

Changing this is a **config break**, not a wire break. A removed or renamed
target invalidates release scripts that pass `--target <id>`, which fail loudly
at the next release. Nothing persists a target id, so there is no stored data
to migrate.

Adding one is safe: existing scripts do not name it, and `--target all` only
picks it up on the platform it declares.

## The platform field

`platform` is where the installer can be **built**, not where it runs — the
DMG toolchain only exists on macOS. Cross-building is not supported, so
`isBuildableOn` is the one place that decides whether a requested target is a
refusal or a job.

That check used to be inline and was wrong: `carbon bundle` normalised
`darwin` to `macos` on one line and compared against `"darwin"` twelve lines
later, so `--target dmg` was unreachable on every machine including a Mac.

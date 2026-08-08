// Preloaded into every `bun test` process (see the `-r` flag on the
// test-ts/test-one recipes in the root Justfile).
//
// Keep this minimal — it runs before every suite, so anything expensive here is
// paid on every test file. Its only job is to make test runs deterministic
// regardless of the developer's environment.

// Colour codes in captured output make assertions fragile and diffs unreadable.
process.env.NO_COLOR ??= "1";
process.env.FORCE_COLOR ??= "0";

// Mark the process as a test run so code paths can refuse to touch a real
// user's config directory, publish to a real bucket, or hit the network.
process.env.CARBON_TEST ??= "1";

// A stable timezone and locale: date formatting and collation differ between
// a developer's machine and CI otherwise, and the failures look like logic
// bugs rather than environment differences.
process.env.TZ ??= "UTC";
process.env.LC_ALL ??= "C";

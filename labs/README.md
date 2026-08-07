# labs/

Experimental sandboxes and polyglot spikes.

This tier exists so experiments have somewhere to live that is **not**
`products/` or `solutions/`. Nothing here is shipped, nothing here is depended
on by a product, and anything here may be deleted without notice — that is the
point of it.

Currently empty. The `polyglot_demo` spike (a C++ / Zig / C-ABI
proof-of-concept) was removed once it had served its purpose.

## Rules

- `labs/` may depend on `solutions/`. Nothing may depend on `labs/`.
- An experiment that earns its place graduates to `solutions/` or `products/`;
  it does not grow roots here.
- Broken targets in `labs/` should be deleted rather than carried. The
  `polyglot_demo` target outlived a contracts restructure and spent time
  failing `bazel build //...` for a spike no one was using any more.

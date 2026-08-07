# plugin

What a plugin declares, and the binary interface the host loads it through.
Two agreements about the same subject, which is why they sit together.

**Agreements**
- `schema/manifest.fbs` — how a plugin describes itself
- `schema/permissions.fbs` — the capabilities it requests
- `abi/carbon_abi.h` — handles, the allocator table, the entry-point struct

**Honoured by** the host (C++/Zig/Rust) and every plugin author
**Breaking the ABI** is the worst break in the repository: plugins are shipped
prebuilt, so ones already on disk stop loading. Layout and enum values are
frozen once shipped.

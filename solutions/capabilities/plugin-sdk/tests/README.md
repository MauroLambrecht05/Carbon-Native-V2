# carbon-sdk tests

The Rust ABI compatibility test lives at
`../rust/tests/abi_compat_test.rs` so cargo's standard integration-test
discovery picks it up. Run it with:

```
cd plugins/sdk/rust
cargo test --test abi_compat_test
```

This directory is reserved for cross-language tests that don't fit into a
single language's build system (e.g., a future test that builds a Zig
plugin and loads it from a Rust harness).

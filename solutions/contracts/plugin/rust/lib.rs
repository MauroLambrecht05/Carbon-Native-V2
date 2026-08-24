// carbon-plugin-contract — the extension-point registry, as Rust.
//
// A CONTRACT crate: it depends on nothing, and nothing in it is an
// implementation. `generated.rs` is rendered from
// `../registry/extension-points.zig` by `bun products/carbon-ext/main.ts
// generate`, and `//.tools/validation:workspace_test` fails if this file stops
// agreeing with the Zig.
//
// ── WHY THE HOST DESCRIPTOR IS OPAQUE HERE ──────────────────────────────────
// Every extension point takes a `CarbonApp*` first. The runtime's concrete
// version of that struct — with its window size, its JS context pointer and
// its function-pointer table — lives in `infrastructure/plugin-host`, and a
// contract that named it would be importing an implementation.
//
// So this crate declares `CarbonApp` as an opaque, zero-sized `#[repr(C)]`
// struct and the generated signatures point at that. The host casts its own
// `*mut HostCarbonApp` to `*mut CarbonApp` at the dispatch site. Both are
// `#[repr(C)]` pointers to the same allocation, which is exactly what the C
// header says on the plugin side too: the plugin receives `CarbonApp*` and
// never dereferences it except through the accessors.

#![forbid(unsafe_op_in_unsafe_fn)]

/// The host descriptor a point receives, opaque.
///
/// Zero-sized on purpose: nothing in this crate may know the layout, and a
/// zero-sized `#[repr(C)]` struct is the idiomatic Rust spelling of C's
/// "pointer to an incomplete type".
///
/// # Safety
///
/// A `*mut CarbonApp` is only ever produced by casting the runtime's real
/// descriptor. Constructing one any other way and handing it to a plugin is
/// undefined behaviour — the plugin will pass it straight back to host
/// functions that do know the layout.
#[repr(C)]
pub struct CarbonApp {
    _opaque: [u8; 0],
}

mod generated;

pub use generated::{Arity, PointId, PointSpec, Stability, EXTENSION_POINTS_MINOR, POINTS};

// The per-point function-pointer typedefs. Re-exported as a group rather than
// named one by one: the list changes every time a point is added, and a
// hand-maintained re-export list is one more thing to forget.
pub use generated::*;

/// Every point in the registry, in declaration order.
pub fn all() -> &'static [PointSpec] {
    &POINTS
}

/// The point a manifest id names, if this runtime has it.
///
/// `None` means the plugin was built against a newer registry than this
/// runtime — which is a normal thing to happen and is why the loader reports
/// it as a skipped point rather than a failure to load.
pub fn lookup(id: &str) -> Option<&'static PointSpec> {
    PointId::parse(id).map(PointId::spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_indexing_matches_the_enum() {
        // `PointId::spec` indexes POINTS by `self as usize`. The generator
        // emits the rows in enum order to make that true; this is the check
        // that it did, and it is the one bug in this crate that would be
        // silent — a plugin would simply get another point's capability rule.
        for spec in POINTS.iter() {
            assert_eq!(spec.id.spec().id, spec.id);
        }
    }

    #[test]
    fn every_id_round_trips_through_parse() {
        for spec in POINTS.iter() {
            assert_eq!(PointId::parse(spec.id.as_str()), Some(spec.id));
        }
        assert_eq!(PointId::parse("no.such.point"), None);
    }

    #[test]
    fn symbols_are_nul_terminated_and_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for spec in POINTS.iter() {
            assert_eq!(
                spec.symbol.last(),
                Some(&0),
                "{} symbol is not NUL-terminated",
                spec.id.as_str()
            );
            assert!(
                seen.insert(spec.symbol),
                "two points share the symbol {:?}",
                core::str::from_utf8(spec.symbol).unwrap_or("<non-utf8>")
            );
        }
    }

    #[test]
    fn lookup_agrees_with_the_table() {
        for spec in POINTS.iter() {
            let found = lookup(spec.id.as_str()).expect("declared point is findable");
            assert_eq!(found.symbol, spec.symbol);
        }
    }
}

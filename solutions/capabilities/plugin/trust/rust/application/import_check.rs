// Reading a compiled artifact off disk and handing its import table to the
// policy in domain/import_policy.rs. Mirrors application/verification.rs's
// split: the domain layer judges bytes already in memory, this layer is the
// only place that touches the filesystem.

use crate::import_policy::{Import, ImportScanError};
use std::path::Path;

/// Read a Windows `.dll`/`.exe` and return its import table.
pub fn read_pe_imports(path: &Path) -> Result<Vec<Import>, ImportScanError> {
    let bytes = std::fs::read(path)?;
    crate::import_policy::parse_pe_imports(&bytes)
}

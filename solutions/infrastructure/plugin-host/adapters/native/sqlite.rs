// Embedded SQLite storage via `rusqlite` (bundled SQLite) — backs the
// `sqlite_exec` ABI trampoline in abi/host_exports.rs (ABI 1.9).
//
// SCOPE, v1: one function handles both queries and mutations —
// `exec(db_path, sql, params_json)` returns a JSON array of row objects
// for a SELECT, or `{"changes":N,"lastInsertRowid":N}` for an
// INSERT/UPDATE/DELETE (rusqlite's own `Statement::column_count() == 0`
// check tells these apart, same signal SQLite's own CLI uses). Params are
// a flat JSON array bound positionally (`?1`, `?2`, ...); supported types
// are null, bool, number, and string — no blob param binding yet (no
// existing plugin ABI call in this codebase passes binary blobs either;
// see clipboard's own "v1 is text-only" precedent). A blob COLUMN in a
// result row comes back as a base64 string (matching terminal's own
// base64 convention for binary data), even though nothing can bind one as
// a param yet.
//
// CONNECTIONS: opened lazily, kept open for the process lifetime, keyed by
// the resolved db_path — no explicit close call, matching keychain/
// clipboard's "nothing to release" simplicity. `rusqlite::Connection` is
// `Send` but not `Sync` (a raw sqlite3 handle isn't safe for concurrent
// access without SQLite's serialized-threading mode, not assumed here) —
// the whole map lives behind one `Mutex`, so only one call touches any
// connection at a time. Coarser than a per-connection lock would be, but
// this ABI call is already synchronous/blocking from the JS thread's own
// perspective, same as dialog/keychain, so there's no hot-path concern to
// optimize against.

use anyhow::{anyhow, Result};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Mutex;

static CONNECTIONS: Mutex<Option<HashMap<String, Connection>>> = Mutex::new(None);

fn with_connection<T>(db_path: &str, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let mut guard = CONNECTIONS.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    if !map.contains_key(db_path) {
        let conn = Connection::open(db_path)?;
        map.insert(db_path.to_string(), conn);
    }
    // Safe to re-borrow immediately after the insert above: `map` is a
    // fresh `&mut` from `get_or_insert_with`, not held across a prior
    // borrow that would conflict.
    let conn = map.get(db_path).expect("just inserted or already present");
    f(conn)
}

fn json_to_sql(v: &serde_json::Value) -> SqlValue {
    match v {
        serde_json::Value::Null => SqlValue::Null,
        serde_json::Value::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        serde_json::Value::String(s) => SqlValue::Text(s.clone()),
        // Arrays/objects as params aren't a SQL type — stored as their
        // JSON text rather than silently coerced to null, so a caller who
        // passes one gets a value back, not silent data loss.
        other => SqlValue::Text(other.to_string()),
    }
}

fn sql_to_json(v: ValueRef) -> serde_json::Value {
    match v {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::Value::from(i),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        ValueRef::Text(t) => serde_json::Value::String(String::from_utf8_lossy(t).to_string()),
        ValueRef::Blob(b) => {
            use base64::Engine;
            serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(b))
        }
    }
}

/// `params_json`: a JSON array (or empty string for none). Returns a JSON
/// string: an array of row objects for a SELECT, or
/// `{"changes":N,"lastInsertRowid":N}` for a mutation.
pub fn exec(db_path: &str, sql: &str, params_json: &str) -> Result<String> {
    let params: Vec<serde_json::Value> = if params_json.is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(params_json)?
    };
    let sql_params: Vec<SqlValue> = params.iter().map(json_to_sql).collect();

    with_connection(db_path, |conn| {
        let mut stmt = conn.prepare(sql)?;
        let param_refs: Vec<&dyn rusqlite::ToSql> =
            sql_params.iter().map(|p| p as &dyn rusqlite::ToSql).collect();

        if stmt.column_count() == 0 {
            // No result columns — a mutation, not a query.
            let changes = stmt.execute(param_refs.as_slice())?;
            let last_id = conn.last_insert_rowid();
            Ok(format!(
                "{{\"changes\":{changes},\"lastInsertRowid\":{last_id}}}"
            ))
        } else {
            let col_names: Vec<String> =
                stmt.column_names().iter().map(|s| s.to_string()).collect();
            let mut rows = stmt.query(param_refs.as_slice())?;
            let mut out: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
            while let Some(row) = rows.next()? {
                let mut obj = serde_json::Map::new();
                for (i, name) in col_names.iter().enumerate() {
                    obj.insert(name.clone(), sql_to_json(row.get_ref(i)?));
                }
                out.push(obj);
            }
            serde_json::to_string(&out).map_err(|e| anyhow!(e))
        }
    })
}

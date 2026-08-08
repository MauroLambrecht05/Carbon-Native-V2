// IPC bridge between webview and shell.
//
// Wire format (v0.1 — JSON; v0.2 task: shared memory ring + binary frames):
//   webview → shell:  {"id": <number>, "fn": "<name>", "args": [...]}
//   shell → webview:  {"id": <number>, "ok": <result>} | {"id": <number>, "error": "<msg>"}

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::shell::Shell;

#[derive(Debug, Deserialize)]
pub struct IpcRequest {
    pub id: u64,
    pub r#fn: String,
    pub args: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct IpcResponse {
    pub id: u64,
    #[serde(flatten)]
    pub result: IpcResult,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum IpcResult {
    Ok { ok: serde_json::Value },
    Err { error: String },
}

pub fn dispatch(shell: &Arc<Mutex<Shell>>, body: &str) -> IpcResponse {
    let req: IpcRequest = match serde_json::from_str(body) {
        Ok(r) => r,
        Err(e) => {
            return IpcResponse {
                id: 0,
                result: IpcResult::Err {
                    error: format!("bad ipc envelope: {e}"),
                },
            };
        }
    };

    let s = match shell.lock() {
        Ok(s) => s,
        Err(p) => p.into_inner(),
    };

    let args_json = serde_json::to_string(&req.args).unwrap_or_else(|_| "[]".into());

    match s.invoke(&req.r#fn, &args_json) {
        Ok(json) => match serde_json::from_str::<serde_json::Value>(&json) {
            Ok(v) => {
                if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                    IpcResponse {
                        id: req.id,
                        result: IpcResult::Err {
                            error: err.to_string(),
                        },
                    }
                } else {
                    let ok = v.get("ok").cloned().unwrap_or(serde_json::Value::Null);
                    IpcResponse {
                        id: req.id,
                        result: IpcResult::Ok { ok },
                    }
                }
            }
            Err(_) => IpcResponse {
                id: req.id,
                result: IpcResult::Ok {
                    ok: serde_json::Value::Null,
                },
            },
        },
        Err(e) => IpcResponse {
            id: req.id,
            result: IpcResult::Err {
                error: e.to_string(),
            },
        },
    }
}

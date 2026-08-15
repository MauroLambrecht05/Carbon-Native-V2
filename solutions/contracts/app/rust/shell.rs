// Shell — the JS engine running user @shell-decorated code.
//
// v0.1: rquickjs (Rust binding to QuickJS-NG). Proven 0.77 MB binary in
// our voltframe-qjs work. v0.2 task: replace with direct PrimJS binding
// (Apache-2.0, ~28% faster on reactive workloads, used by Lynx).

use anyhow::{anyhow, Context, Result};
use rquickjs::{Context as JsContext, Function, Runtime as JsRuntime, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::config::Config;

pub struct Shell {
    // Held to keep the Runtime alive for as long as the Context borrows from it;
    // never accessed directly by name (#[allow(dead_code)] silences the warning
    // both backends produced).
    #[allow(dead_code)]
    runtime: JsRuntime,
    ctx: JsContext,
}

impl Shell {
    pub fn new() -> Result<Self> {
        let runtime = JsRuntime::new().map_err(|e| anyhow!("rquickjs runtime: {e}"))?;
        let ctx = JsContext::full(&runtime).map_err(|e| anyhow!("rquickjs context: {e}"))?;
        Ok(Self { runtime, ctx })
    }

    /// Load a JS file. Replaces previously-loaded shell code (hot reload).
    pub fn load_file(&self, path: &Path) -> Result<()> {
        let source =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        self.eval(&source)?;
        Ok(())
    }

    /// Evaluate JS source in the shell context.
    pub fn eval(&self, source: &str) -> Result<()> {
        self.ctx.with(|ctx| -> Result<()> {
            ctx.eval::<(), _>(source.as_bytes())
                .map_err(|e| anyhow!("eval: {e}"))?;
            Ok(())
        })
    }

    /// Invoke a global JS function with a JSON-encoded argument.
    /// Returns the JSON-encoded result.
    pub fn invoke(&self, fn_name: &str, args_json: &str) -> Result<String> {
        // Two ABI shapes the shell can expose:
        //   __carbon_dispatch(fnName, argsJson) — preferred, single dispatcher
        //   global function with the same name as fnName — legacy fallback
        //
        // Bug-fix (ported from runtime-verso): the original form here was
        //   const fn = __carbon_dispatch || (globalThis[name] && (a => globalThis[name](...JSON.parse(a))));
        //   const r = fn(args);                                  // <- BUG
        // which, when __carbon_dispatch was the resolved function, called it
        // as `dispatch("[...]")` — passing the args JSON as the first
        // parameter, with no function name. The notes app's
        // __carbon_dispatch expects (fnName, argsJson). Result: "unknown
        // shell fn: []" for every invoke. Corrected to dispatch both name
        // and args.
        let script = format!(
            r#"(function() {{
                const dispatcher = globalThis.__carbon_dispatch;
                const direct = globalThis['{name}'];
                let fn;
                if (typeof dispatcher === 'function') {{
                    fn = () => dispatcher('{name}', {args});
                }} else if (typeof direct === 'function') {{
                    fn = () => direct(...JSON.parse({args}));
                }} else {{
                    return JSON.stringify({{ error: 'no shell function dispatcher loaded' }});
                }}
                try {{
                    const r = fn();
                    if (r && typeof r.then === 'function') {{
                        return JSON.stringify({{ async: true }});
                    }}
                    return JSON.stringify({{ ok: r === undefined ? null : r }});
                }} catch (e) {{
                    return JSON.stringify({{ error: String(e && e.message || e) }});
                }}
            }})()"#,
            name = fn_name,
            args = serde_json::to_string(args_json).unwrap_or_default()
        );
        self.ctx.with(|ctx| -> Result<String> {
            let val: Value = ctx
                .eval(script.as_bytes())
                .map_err(|e| anyhow!("invoke: {e}"))?;
            Ok(val
                .into_string()
                .and_then(|s| s.to_string().ok())
                .unwrap_or_else(|| "null".into()))
        })
    }
}

/// Register host imports per the app's granted capabilities.
/// In v0.1 we register a minimal set: console.log, fs (capability-checked),
/// system.notify (capability-checked).
pub fn register_capability_imports(shell: &Arc<Mutex<Shell>>, cfg: &Config) -> Result<()> {
    let s = shell.lock().unwrap();
    s.ctx.with(|ctx| -> Result<()> {
        let global = ctx.globals();

        // console.log — always available
        let console_log = Function::new(ctx.clone(), |s: String| {
            tracing::info!(target: "shell", "{}", s);
            println!("[shell] {s}");
        })
        .map_err(|e| anyhow!("console.log: {e}"))?;

        let console = rquickjs::Object::new(ctx.clone()).map_err(|e| anyhow!("console: {e}"))?;
        console
            .set("log", console_log)
            .map_err(|e| anyhow!("console.set: {e}"))?;
        global
            .set("console", console)
            .map_err(|e| anyhow!("global console: {e}"))?;

        // fs.write — capability-bound
        let fs_write_paths: Vec<String> = cfg.app.capabilities.fs_write.clone();
        if !fs_write_paths.is_empty() {
            let allow = build_glob_set(&fs_write_paths)?;
            let allow_for_remove = allow.clone();
            let allow_for_mkdir = allow.clone();
            let fs_write = Function::new(
                ctx.clone(),
                move |path: String, data: String| -> Result<(), rquickjs::Error> {
                    let expanded = expand_path(&path);
                    if !allow.is_match(&expanded) {
                        return Err(rquickjs::Error::Exception);
                    }
                    if let Some(parent) = std::path::Path::new(&expanded).parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    std::fs::write(&expanded, data).map_err(|_| rquickjs::Error::Exception)?;
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("fs_write: {e}"))?;
            global
                .set("__carbon_fs_write", fs_write)
                .map_err(|e| anyhow!("global fs_write: {e}"))?;

            let fs_remove = Function::new(
                ctx.clone(),
                move |path: String| -> Result<(), rquickjs::Error> {
                    let expanded = expand_path(&path);
                    if !allow_for_remove.is_match(&expanded) {
                        return Err(rquickjs::Error::Exception);
                    }
                    let _ = std::fs::remove_file(&expanded);
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("fs_remove: {e}"))?;
            global
                .set("__carbon_fs_remove", fs_remove)
                .map_err(|e| anyhow!("global fs_remove: {e}"))?;

            let fs_mkdir = Function::new(
                ctx.clone(),
                move |path: String| -> Result<(), rquickjs::Error> {
                    let expanded = expand_path(&path);
                    if !allow_for_mkdir.is_match(format!("{}/x", expanded.trim_end_matches('/'))) {
                        return Err(rquickjs::Error::Exception);
                    }
                    std::fs::create_dir_all(&expanded).map_err(|_| rquickjs::Error::Exception)?;
                    Ok(())
                },
            )
            .map_err(|e| anyhow!("fs_mkdir: {e}"))?;
            global
                .set("__carbon_fs_mkdir", fs_mkdir)
                .map_err(|e| anyhow!("global fs_mkdir: {e}"))?;
        }

        // fs.read — capability-bound
        let fs_read_paths: Vec<String> = cfg.app.capabilities.fs_read.clone();
        if !fs_read_paths.is_empty() {
            let allow = build_glob_set(&fs_read_paths)?;
            let allow_for_list = allow.clone();
            let fs_read = Function::new(
                ctx.clone(),
                move |path: String| -> Result<String, rquickjs::Error> {
                    let expanded = expand_path(&path);
                    if !allow.is_match(&expanded) {
                        return Err(rquickjs::Error::Exception);
                    }
                    std::fs::read_to_string(&expanded).map_err(|_| rquickjs::Error::Exception)
                },
            )
            .map_err(|e| anyhow!("fs_read: {e}"))?;
            global
                .set("__carbon_fs_read", fs_read)
                .map_err(|e| anyhow!("global fs_read: {e}"))?;

            // fs.list — list a directory (newline-separated filenames). Bound to fs.read paths.
            let fs_list = Function::new(
                ctx.clone(),
                move |dir: String| -> Result<String, rquickjs::Error> {
                    let expanded = expand_path(&dir);
                    // Match against the directory itself or any path within it.
                    if !allow_for_list.is_match(&expanded)
                        && !allow_for_list.is_match(format!("{}/x", expanded.trim_end_matches('/')))
                    {
                        return Err(rquickjs::Error::Exception);
                    }
                    let entries =
                        std::fs::read_dir(&expanded).map_err(|_| rquickjs::Error::Exception)?;
                    let mut names = Vec::new();
                    for e in entries.flatten() {
                        if let Some(n) = e.file_name().to_str() {
                            names.push(n.to_string());
                        }
                    }
                    names.sort();
                    Ok(names.join("\n"))
                },
            )
            .map_err(|e| anyhow!("fs_list: {e}"))?;
            global
                .set("__carbon_fs_list", fs_list)
                .map_err(|e| anyhow!("global fs_list: {e}"))?;
        }

        // system.appDataDir — always available
        let app_id = format!(
            "{}-{}",
            cfg.app.name.replace([' ', '/'], "_"),
            cfg.app.version
        );
        let app_data = Function::new(ctx.clone(), move || -> String {
            dirs_app_data_dir(&app_id)
        })
        .map_err(|e| anyhow!("app_data: {e}"))?;
        global
            .set("__carbon_app_data_dir", app_data)
            .map_err(|e| anyhow!("global app_data: {e}"))?;

        Ok(())
    })?;
    Ok(())
}

fn build_glob_set(patterns: &[String]) -> Result<globset::GlobSet> {
    let mut b = globset::GlobSetBuilder::new();
    for p in patterns {
        let expanded = expand_path(p);
        let g = globset::Glob::new(&expanded).map_err(|e| anyhow!("bad glob {p}: {e}"))?;
        b.add(g);
    }
    b.build().map_err(|e| anyhow!("globset: {e}"))
}

fn expand_path(p: &str) -> String {
    let mut out = p.to_string();
    if out.starts_with("~/") || out.starts_with("~\\") {
        if let Some(home) = dirs_home() {
            out = format!("{}/{}", home.trim_end_matches('/'), &out[2..]);
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        out = out.replace("${LOCALAPPDATA}", &local);
    }
    if let Ok(home) = std::env::var("HOME") {
        out = out.replace("${HOME}", &home);
    }
    // Windows-specific: USERPROFILE is the canonical home var (HOME isn't set
    // by default on Windows). Without this the notes app's capability
    // glob `${USERPROFILE}/.notes-bench/**` never resolves and every fs.write
    // is denied with [uninitialized].
    if let Ok(profile) = std::env::var("USERPROFILE") {
        out = out.replace("${USERPROFILE}", &profile);
    }
    out
}

fn dirs_home() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
}

fn dirs_app_data_dir(app_id: &str) -> String {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("XDG_DATA_HOME"))
        .or_else(|_| std::env::var("HOME").map(|h| format!("{h}/Library/Application Support")))
        .unwrap_or_else(|_| "/tmp".into());
    let dir = format!("{}/{}", base.trim_end_matches('/'), app_id);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

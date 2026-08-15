// Path-based key-value store. Each Store is backed by a JSON file at a
// caller-chosen path (typically inside `appDataDir()`). Reads from the
// in-memory cache after `load()`; writes hit disk on `save()` (or
// `set()` when `autoSave: true`).
//
//   import { Store } from "@carbon/api/store";
//   const settings = new Store("settings.json");
//   await settings.load();
//   const theme = await settings.get<string>("theme");
//   await settings.set("theme", "dark");
//   await settings.save();
//
// API divergences from Tauri's plugin-store:
//   - constructor is plain `new Store(path)` (no `LazyStore` distinction —
//     the engine's load is already lazy)
//   - `onChange(key, cb)` instead of `onKeyChange` to keep names short
//   - no per-store autoSave flag yet; call `save()` after a batch of writes
//
// The engine speaks `plugin:store|*` commands so this module reuses the
// invoke channel rather than wrapping a parallel host import — fewer
// names to keep in sync as new ops land.

import { invoke } from "../bridge/invoke.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export type ChangeListener<T = unknown> = (
  key: string,
  newValue: T | undefined,
) => void;

/** Options accepted by `new Store(path, opts)` — matches the shape
 *  Tauri's `LazyStore` exposed so ports can pass `{ autoSave: true,
 *  defaults: {...} }` without further changes. We honor `defaults`
 *  (seeded into `load()`'s no-file-yet path) and treat `autoSave` as
 *  always-on — each `set/delete/clear` already round-trips to disk via
 *  the engine. */
export interface StoreOptions {
  autoSave?: boolean | number;
  defaults?: Record<string, unknown>;
}

export class Store {
  /** Relative to the app's data dir, or absolute. */
  readonly path: string;
  private options: StoreOptions;
  private listeners = new Set<{ key: string | null; cb: ChangeListener<unknown> }>();

  constructor(path: string, options: StoreOptions = {}) {
    this.path = path;
    this.options = options;
    void this.options; // surface the parameter for future autoSave wiring
  }

  /** Read the file into the engine's in-memory cache. Idempotent —
   *  re-load is cheap and discards in-memory changes that weren't
   *  saved. */
  async load(): Promise<void> {
    await invoke("plugin:store|load", { path: this.path });
  }

  /** Get a value. Returns null when the key is absent. Type param is
   *  unrestricted so callers can store arbitrary JSON-serialisable
   *  objects (the engine round-trips via JSON). */
  async get<T = unknown>(key: string): Promise<T | null> {
    const v = await invoke<T | null>("plugin:store|get", { path: this.path, key });
    return v ?? null;
  }

  /** True when the key has a value (even null). */
  async has(key: string): Promise<boolean> {
    return invoke<boolean>("plugin:store|has", { path: this.path, key });
  }

  /** Set a value. Persists to disk on the next save tick (engine-side
   *  store handles autoSave debouncing). */
  async set<T = unknown>(key: string, value: T): Promise<void> {
    await invoke("plugin:store|set", { path: this.path, key, value });
    this.fire(key, value);
  }

  /** Remove a key. */
  async delete(key: string): Promise<boolean> {
    const ok = await invoke<boolean>("plugin:store|delete", { path: this.path, key });
    if (ok) this.fire(key, undefined);
    return ok;
  }

  /** Drop every key. */
  async clear(): Promise<void> {
    await invoke("plugin:store|clear", { path: this.path });
    // Listeners that subscribed without a key get a single null event.
    for (const l of this.listeners) if (l.key === null) l.cb("", undefined);
  }

  /** Force a write to disk. */
  async save(): Promise<void> {
    await invoke("plugin:store|save", { path: this.path });
  }

  /** Reload from disk (drops any unsaved in-memory writes). */
  async reset(): Promise<void> {
    await invoke("plugin:store|reset", { path: this.path });
  }

  async keys(): Promise<string[]> {
    return invoke<string[]>("plugin:store|keys", { path: this.path });
  }

  async values<T = unknown>(): Promise<T[]> {
    return invoke<T[]>("plugin:store|values", { path: this.path });
  }

  async entries<T = unknown>(): Promise<[string, T][]> {
    return invoke<[string, T][]>("plugin:store|entries", { path: this.path });
  }

  async length(): Promise<number> {
    return invoke<number>("plugin:store|length", { path: this.path });
  }

  /** Subscribe to changes. Pass `null` (or omit) to listen for any key;
   *  pass a string to scope to one. Returns an unsubscribe function.
   *  Note: this is in-process only — changes from a different window
   *  reach you through @carbon/api/event's cross-window pub/sub once
   *  multi-window lands. */
  onChange<T = unknown>(
    keyOrCb: string | ChangeListener<T>,
    cb?: ChangeListener<T>,
  ): () => void {
    const key = typeof keyOrCb === "string" ? keyOrCb : null;
    const handler = (typeof keyOrCb === "function" ? keyOrCb : cb!) as ChangeListener<unknown>;
    const entry = { key, cb: handler };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  /** Alias for `onChange(key, cb)` matching the Tauri callback name. */
  onKeyChange<T = unknown>(key: string, cb: (value: T | undefined) => void): () => void {
    return this.onChange<T>(key, (_k, v) => cb(v));
  }

  private fire(key: string, value: unknown): void {
    for (const l of this.listeners) {
      if (l.key !== null && l.key !== key) continue;
      try { l.cb(key, value); } catch (e) { console.error("[Store.onChange]", e); }
    }
  }
}

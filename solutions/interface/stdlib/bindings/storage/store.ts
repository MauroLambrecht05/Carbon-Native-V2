// store — a persistent KV file in the app config dir.

declare const __cm_store_get: (file: string, key: string) => string;
declare const __cm_store_set: (file: string, key: string, valueJson: string) => void;
declare const __cm_store_delete: (file: string, key: string) => boolean;
declare const __cm_store_has: (file: string, key: string) => boolean;
declare const __cm_store_keys: (file: string) => string;
declare const __cm_store_entries: (file: string) => string;
declare const __cm_store_clear: (file: string) => void;
declare const __cm_store_save: (file: string) => void;
declare const __cm_store_reload: (file: string) => void;

/** Persistent KV store backed by a JSON file in the app config dir.
 *  Construct one per logical store (file name) — same pattern as
 *  `tauri-plugin-store`. */
export class Store {
  constructor(public readonly file: string) {}

  get<T = unknown>(key: string): T | null {
    const v = __cm_store_get(this.file, key);
    return JSON.parse(v) as T | null;
  }
  set(key: string, value: unknown): void {
    __cm_store_set(this.file, key, JSON.stringify(value));
  }
  delete(key: string): boolean { return __cm_store_delete(this.file, key); }
  has(key: string): boolean { return __cm_store_has(this.file, key); }
  keys(): string[] { return JSON.parse(__cm_store_keys(this.file)); }
  entries<T = unknown>(): Record<string, T> {
    return JSON.parse(__cm_store_entries(this.file));
  }
  clear(): void { __cm_store_clear(this.file); }
  save(): void { __cm_store_save(this.file); }
  reload(): void { __cm_store_reload(this.file); }
}

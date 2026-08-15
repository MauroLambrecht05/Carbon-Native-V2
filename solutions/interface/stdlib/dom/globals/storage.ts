// localStorage / sessionStorage.
//
// Extracted from install.ts: it only ever needed `globalThis`, never the
// document or the window object built around it.

export function installStorage(g: any): void {
  // localStorage / sessionStorage — in-memory shim. React-DOM checks
  // localStorage at module init for the theme-cookie path; libraries
  // like next-themes / zustand-persist read/write these constantly.
  // Persistence across sessions would need wiring to carbon-mini's
  // Store; for now apps that want durable storage should use
  // `new Store(...)` directly.
  const makeStorage = () => {
    const data = new Map<string, string>();
    return {
      getItem(key: string): string | null { return data.has(key) ? data.get(key)! : null; },
      setItem(key: string, value: string): void { data.set(key, String(value)); },
      removeItem(key: string): void { data.delete(key); },
      clear(): void { data.clear(); },
      key(i: number): string | null {
        const keys = Array.from(data.keys());
        return keys[i] ?? null;
      },
      get length(): number { return data.size; },
    };
  };
  if (typeof (g as any).localStorage === "undefined") {
    const ls = makeStorage();
    (g as any).localStorage = ls;
    if (g.window) g.window.localStorage = ls;
  }
  if (typeof (g as any).sessionStorage === "undefined") {
    const ss = makeStorage();
    (g as any).sessionStorage = ss;
    if (g.window) g.window.sessionStorage = ss;
  }
}

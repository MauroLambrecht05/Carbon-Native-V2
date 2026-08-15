// invoke — calling a named command, wherever it happens to be implemented.

declare const __cm_invoke: (name: string, argsJson: string) => string;
declare const __cm_invoke_has: (name: string) => boolean;

// JS-side invoke handler registry. Apps that port from a different
// host (Tauri, Electron, etc.) can wire their command names here
// without editing every call site:
//
//   registerInvoke('fs_read_file', async (args) => native.readFile(args.path));
//
// invoke() checks JS handlers FIRST, then falls back to the Rust
// runtime's __cm_invoke (which holds built-ins like 'window:*' and
// 'app:*'). Both paths share the same Promise-typed return so apps
// don't have to know which side handled their call.
type InvokeHandler = (args: Record<string, unknown>) => unknown;
const jsInvokeHandlers = new Map<string, InvokeHandler>();

export function registerInvoke(name: string, handler: InvokeHandler): void {
  jsInvokeHandlers.set(name, handler);
}

/** Call a registered command. Mirrors Tauri's `invoke()` — accepts an
 *  arbitrary args object and returns a Promise resolving to the result.
 *  Commands are synchronous on the Rust side; the Promise wrapper is
 *  here for API parity so existing Tauri code ports cleanly. */
export function invoke<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const jsHandler = jsInvokeHandlers.get(name);
  if (jsHandler) {
    try {
      const result = jsHandler(args ?? {});
      return Promise.resolve(result as T);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  try {
    const result = __cm_invoke(name, JSON.stringify(args));
    return Promise.resolve(JSON.parse(result) as T);
  } catch (e) {
    return Promise.reject(e);
  }
}

/** True when a command with this name has a handler registered. */
export function hasCommand(name: string): boolean {
  return __cm_invoke_has(name);
}

// @carbon/plugins/fonts — the app-facing font-loading hook, on top of the
// fonts plugin (`carbon plugin add fonts`) and its raw `carbon:fonts`
// bridge.
//
// `useFonts(path, family?, weight?)` loads the font itself — call it
// directly in a component body, no `useEffect` needed:
//
//   const { ready } = useFonts("assets/Poppins-Bold.ttf", "Poppins", 700);
//
// All arguments are optional, so `useFonts()` with none of them is valid
// too — it just reports `ready` for the plugin itself, useful when you
// need that before you know which font to load yet.
//
// ── WHY THIS CAN'T CALL `carbon:fonts`' `loadFont` DIRECTLY, ALWAYS ────────
// `carbon:fonts` exports a bare `loadFont(path, family?, weight?)` function
// (see products/carbon-sdk/plugins/carbon-dev/fonts and @carbon/vite/imports' lazy-wrapper
// codegen for manifest-declared plugin exports). Calling it directly throws
// if the call happens too early: `carbon_plugin_register` (which installs
// `loadFont` onto globalThis) runs strictly AFTER the bundle evaluates —
// see products/carbon/composition/mini.rs — so a call made anywhere in a
// component's first render pass (the component body, or its first effect;
// both run synchronously as part of that same bundle evaluation) throws
// "TypeError: not a function".
//
// ── WHY THIS DOESN'T USE A SECOND useEffect / setState TO WAIT IT OUT ──────
// The obvious fix — bump some state in a mount effect, do the real work in
// a second effect keyed on that state, since a genuinely later render pass
// is safe — was the first version of this hook. Confirmed directly, with
// nothing else on screen and 20+ real seconds of waiting: a bare `setState`
// call with no accompanying native-dispatched event never actually flushes
// a re-render in this runtime. (Reliable ONLY when a real native dispatcher
// — a click, HMR's own remount — is what triggers the update; see flush-
// sync.ts's dispatcher wrapping.) So a hook that depended on React's own
// scheduler to reach "safe" would hang forever on an app that never
// receives user input before wanting its font loaded.
//
// `requestAnimationFrame`, by contrast, IS confirmed reliable with no
// interaction needed at all — run_loop.rs drains the rAF queue every
// redraw frame, and the native paint loop keeps ticking on its own.
// So this hook polls via rAF instead of React state: fully imperative,
// no useEffect, no dependency on whether any render's updates ever get
// scheduled.

import { useRef } from "react";
import { loadFont as rawLoadFont } from "carbon:fonts";

export interface UseFontsResult {
  /**
   * True once the requested font has finished loading. If no font was
   * requested (all arguments omitted), true once the fonts plugin's
   * globals are installed and ready to use.
   */
  ready: boolean;
}

function fontKey(path: string, family: string | undefined, weight: number | undefined): string {
  return `${path} ${family ?? ""} ${weight ?? 0}`;
}

function pluginReady(): boolean {
  return typeof (globalThis as unknown as { loadFont?: unknown }).loadFont === "function";
}

/**
 * `const { ready } = useFonts("assets/Poppins-Bold.ttf", "Poppins", 700);`
 *
 * Call it once per font, directly in a component body — no `useEffect`.
 * Safe to call every render; repeat calls for a font already loaded are a
 * no-op. If called before the plugin's globals exist yet, the request is
 * remembered and replayed automatically (via `requestAnimationFrame`
 * polling, torn down once it fires) the moment the plugin is ready — no
 * action needed from the caller either way.
 */
export function useFonts(path?: string, family?: string, weight?: number): UseFontsResult {
  const loadedRef = useRef<Set<string>>(new Set());
  const pollingRef = useRef(false);
  const pendingRef = useRef<{ key: string; path: string; family?: string; weight?: number } | null>(null);

  const ensurePolling = () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    const tick = () => {
      if (!pluginReady()) {
        requestAnimationFrame(tick);
        return;
      }
      pollingRef.current = false;
      const pending = pendingRef.current;
      if (pending && !loadedRef.current.has(pending.key)) {
        loadedRef.current.add(pending.key);
        rawLoadFont(pending.path, pending.family, pending.weight);
      }
    };
    requestAnimationFrame(tick);
  };

  if (path === undefined) {
    return { ready: pluginReady() };
  }

  const key = fontKey(path, family, weight);
  if (loadedRef.current.has(key)) {
    return { ready: true };
  }
  if (pluginReady()) {
    loadedRef.current.add(key);
    rawLoadFont(path, family, weight);
    return { ready: true };
  }

  pendingRef.current = { key, path, family, weight }; // last request wins if args change mid-poll
  ensurePolling();
  return { ready: false };
}

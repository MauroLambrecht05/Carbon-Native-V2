// The generated App.tsx + main.tsx, in two renderers × two styling variants.
//
// Two files, not one: App.tsx is the component, main.tsx is the entrypoint
// that mounts it — the split Vite's own React/Solid templates use, and
// what the rest of this workspace's own products already do (see e.g.
// products/carbon/presentation and any real app under labs/examples).
// BuildProjectUseCase's entry-candidate list already prefers main.tsx over
// App.tsx for exactly this reason — this template was the one place still
// cramming both into a single file. See its comment: "main.tsx wins over
// App.tsx so React projects... pick the entry that actually calls render()".
//
// A counter in all variants.
//
// Solid uses createPersistentSignal (survives `carbon dev` hot-reloads —
// see solutions/interface/renderer/solid/runtime/state.ts).
//
// React uses plain useState from "react" — exactly like any other React
// app, deliberately. An earlier version of this template used a custom
// usePersistentState hook so the demo would also survive hot-reloads; that
// meant every scaffolded React app opened with a hook nobody outside this
// codebase has ever seen, for a devtool convenience. Correctness beats
// that convenience: this is what a React developer already expects to
// read. Closing the "does it survive a reload" gap without changing what
// App.tsx looks like means React Fast Refresh at the renderer level — see
// solutions/interface/renderer/react/runtime/refresh.ts.
//
// One shared visual design across all four variants — a centered light
// card, one accent color (indigo) for the primary action, an outline
// style for the secondary one. Every style key is a real CSS property
// name (camelCase in the inline variants; the Tailwind utilities below
// resolve to the same properties) — verified against
// solutions/integrations/bundler/vite/domain/tailwind-classes.ts so
// nothing here silently fails to paint. See project-files.ts's
// TSCONFIG_REACT for why the React variants use camelCase + className
// (not the snake_case + class this template used before) rather than a
// Carbon-specific style vocabulary: it's what React's real prop types
// expect, and the Rust scene parser (see scene.rs) accepts camelCase,
// snake_case and kebab-case forms of every property equally, so this is
// a types-and-consistency choice, not a runtime requirement.

import type { Renderer, Styling } from "../../domain/value-objects/Preset.ts";

export interface AppTemplate {
  readonly app: string;
  readonly main: string;
}

// ── Solid ─────────────────────────────────────────────────────────────────

const SOLID_INLINE_APP = `// App.tsx — your component. Edit and save; \`carbon dev\` hot-reloads,
// preserving signal state (see main.tsx).

import { createPersistentSignal } from "@carbon/mini-solid";

function App() {
  // createPersistentSignal: value survives hot-reloads.
  const [count, setCount] = createPersistentSignal("counter.count", 0);

  return (
    <view style={{
      width: "100%",
      height: "100%",
      background: "#f8fafc",
      alignItems: "center",
      justifyContent: "center",
      padding: 40,
    }}>
      <view style={{
        background: "#ffffff",
        borderWidth: 1,
        borderColor: "#e2e8f0",
        borderRadius: 20,
        boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 16px 40px rgba(15,23,42,0.08)",
        padding: 40,
        gap: 20,
        alignItems: "center",
        width: 320,
      }}>
        <view style={{ gap: 4, alignItems: "center" }}>
          <text style={{ color: "#0f172a", fontSize: 20, fontWeight: 600 }}>@@DISPLAY@@</text>
          <text style={{ color: "#64748b", fontSize: 13, textAlign: "center" }}>
            Edit App.tsx and save to hot-reload.
          </text>
        </view>

        <view style={{
          background: "#f8fafc",
          borderWidth: 1,
          borderColor: "#e2e8f0",
          borderRadius: 14,
          padding: 20,
          gap: 4,
          alignItems: "center",
          width: "100%",
        }}>
          <text style={{ color: "#94a3b8", fontSize: 11, fontWeight: 600 }}>COUNT</text>
          <text style={{ color: "#0f172a", fontSize: 36, fontWeight: 700 }}>{count()}</text>
        </view>

        <view style={{ flexDirection: "row", gap: 10, width: "100%" }}>
          <view
            style={{
              background: "#ffffff",
              borderWidth: 1,
              borderColor: "#e2e8f0",
              borderRadius: 10,
              height: 40,
              flexGrow: 1,
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={() => setCount(c => c - 1)}
          >
            <text style={{ color: "#334155", fontSize: 14, fontWeight: 500 }}>Decrement</text>
          </view>
          <view
            style={{
              background: "#4f46e5",
              borderRadius: 10,
              height: 40,
              flexGrow: 1,
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={() => setCount(c => c + 1)}
          >
            <text style={{ color: "#ffffff", fontSize: 14, fontWeight: 500 }}>Increment</text>
          </view>
        </view>
      </view>
    </view>
  );
}

export default App;
`;

const SOLID_TAILWIND_APP = `// App.tsx — your component. Edit and save; \`carbon dev\` hot-reloads,
// preserving signal state (see main.tsx).

import { createPersistentSignal } from "@carbon/mini-solid";

function App() {
  const [count, setCount] = createPersistentSignal("counter.count", 0);

  return (
    <view class="bg-slate-50 items-center justify-center p-10" style={{ width: "100%", height: "100%" }}>
      <view class="bg-white border border-slate-200 rounded-2xl shadow-lg p-10 gap-5 items-center" style={{ width: 320 }}>
        <view class="gap-1 items-center">
          <text class="text-slate-900 text-xl font-semibold">@@DISPLAY@@</text>
          <text class="text-slate-500 text-sm text-center">Edit App.tsx and save to hot-reload.</text>
        </view>

        <view class="bg-slate-50 border border-slate-200 rounded-xl p-5 gap-1 items-center" style={{ width: "100%" }}>
          <text class="text-slate-400 text-xs font-semibold">COUNT</text>
          <text class="text-slate-900 text-4xl font-bold">{count()}</text>
        </view>

        <view class="flex-row gap-2.5" style={{ width: "100%" }}>
          <view
            class="bg-white border border-slate-200 rounded-lg items-center justify-center grow"
            style={{ height: 40 }}
            onClick={() => setCount(c => c - 1)}
          >
            <text class="text-slate-700 text-sm font-medium">Decrement</text>
          </view>
          <view
            class="bg-indigo-600 rounded-lg items-center justify-center grow"
            style={{ height: 40 }}
            onClick={() => setCount(c => c + 1)}
          >
            <text class="text-white text-sm font-medium">Increment</text>
          </view>
        </view>
      </view>
    </view>
  );
}

export default App;
`;

const SOLID_MAIN = `// main.tsx — entrypoint. Wiring only: mounts App. Edit App.tsx, not this
// file, for the counter demo itself.

import { mount } from "@carbon/mini-solid";
import App from "./App";

mount(() => <App />);
`;

// ── React ─────────────────────────────────────────────────────────────────

const REACT_INLINE_APP = `// App.tsx — your component. Edit and save; \`carbon dev\` hot-reloads
// (see main.tsx).

import { useState } from "react";

function App() {
  const [count, setCount] = useState(0);

  return (
    <view style={{
      width: "100%",
      height: "100%",
      background: "#f8fafc",
      alignItems: "center",
      justifyContent: "center",
      padding: 40,
    }}>
      <view style={{
        background: "#ffffff",
        borderWidth: 1,
        borderColor: "#e2e8f0",
        borderRadius: 20,
        boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 16px 40px rgba(15,23,42,0.08)",
        padding: 40,
        gap: 20,
        alignItems: "center",
        width: 320,
      }}>
        <view style={{ gap: 4, alignItems: "center" }}>
          <text style={{ color: "#0f172a", fontSize: 20, fontWeight: 600 }}>@@DISPLAY@@</text>
          <text style={{ color: "#64748b", fontSize: 13, textAlign: "center" }}>
            Edit App.tsx and save to hot-reload.
          </text>
        </view>

        <view style={{
          background: "#f8fafc",
          borderWidth: 1,
          borderColor: "#e2e8f0",
          borderRadius: 14,
          padding: 20,
          gap: 4,
          alignItems: "center",
          width: "100%",
        }}>
          <text style={{ color: "#94a3b8", fontSize: 11, fontWeight: 600 }}>COUNT</text>
          <text style={{ color: "#0f172a", fontSize: 36, fontWeight: 700 }}>{count}</text>
        </view>

        <view style={{ flexDirection: "row", gap: 10, width: "100%" }}>
          <view
            style={{
              background: "#ffffff",
              borderWidth: 1,
              borderColor: "#e2e8f0",
              borderRadius: 10,
              height: 40,
              flexGrow: 1,
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={() => setCount(c => c - 1)}
          >
            <text style={{ color: "#334155", fontSize: 14, fontWeight: 500 }}>Decrement</text>
          </view>
          <view
            style={{
              background: "#4f46e5",
              borderRadius: 10,
              height: 40,
              flexGrow: 1,
              alignItems: "center",
              justifyContent: "center",
            }}
            onClick={() => setCount(c => c + 1)}
          >
            <text style={{ color: "#ffffff", fontSize: 14, fontWeight: 500 }}>Increment</text>
          </view>
        </view>
      </view>
    </view>
  );
}

export default App;
`;

const REACT_TAILWIND_APP = `// App.tsx — your component. Edit and save; \`carbon dev\` hot-reloads
// (see main.tsx).

import { useState } from "react";

function App() {
  const [count, setCount] = useState(0);

  return (
    <view className="bg-slate-50 items-center justify-center p-10" style={{ width: "100%", height: "100%" }}>
      <view className="bg-white border border-slate-200 rounded-2xl shadow-lg p-10 gap-5 items-center" style={{ width: 320 }}>
        <view className="gap-1 items-center">
          <text className="text-slate-900 text-xl font-semibold">@@DISPLAY@@</text>
          <text className="text-slate-500 text-sm text-center">Edit App.tsx and save to hot-reload.</text>
        </view>

        <view className="bg-slate-50 border border-slate-200 rounded-xl p-5 gap-1 items-center" style={{ width: "100%" }}>
          <text className="text-slate-400 text-xs font-semibold">COUNT</text>
          <text className="text-slate-900 text-4xl font-bold">{count}</text>
        </view>

        <view className="flex-row gap-2.5" style={{ width: "100%" }}>
          <view
            className="bg-white border border-slate-200 rounded-lg items-center justify-center grow"
            style={{ height: 40 }}
            onClick={() => setCount(c => c - 1)}
          >
            <text className="text-slate-700 text-sm font-medium">Decrement</text>
          </view>
          <view
            className="bg-indigo-600 rounded-lg items-center justify-center grow"
            style={{ height: 40 }}
            onClick={() => setCount(c => c + 1)}
          >
            <text className="text-white text-sm font-medium">Increment</text>
          </view>
        </view>
      </view>
    </view>
  );
}

export default App;
`;

const REACT_MAIN = `// main.tsx — entrypoint. Wiring only: mounts App. Edit App.tsx, not this
// file, for the counter demo itself.

import { render } from "@carbon/mini-react";
import App from "./App";

render(<App />);
`;

type TemplateKey = `${Renderer}-${Styling}`;

const BY_RENDERER_STYLING: Record<TemplateKey, AppTemplate> = {
  "solid-inline":   { app: SOLID_INLINE_APP,   main: SOLID_MAIN },
  "solid-tailwind": { app: SOLID_TAILWIND_APP, main: SOLID_MAIN },
  "react-inline":   { app: REACT_INLINE_APP,   main: REACT_MAIN },
  "react-tailwind": { app: REACT_TAILWIND_APP, main: REACT_MAIN },
};

export function appTsxTemplate(renderer: Renderer, styling: Styling): AppTemplate {
  return BY_RENDERER_STYLING[`${renderer}-${styling}`] ?? BY_RENDERER_STYLING["solid-inline"];
}

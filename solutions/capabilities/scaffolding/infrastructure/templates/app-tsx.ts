// The generated App.tsx, in two styling variants.
//
// A counter, because it has to demonstrate the one thing that is not obvious
// about the runtime: signals survive `carbon dev` reloads. A static hello-world
// would not show that.
//
// The inline-styles variant works under every preset — the runtime parses style
// props directly, with no plugin involved. The Tailwind variant needs the
// tailwind plugin to compile the class strings, so it is only used by presets
// that install it.

import type { Styling } from "../../domain/value-objects/Preset.ts";

const INLINE = `// App.tsx — your starting point. Edit and \`carbon dev\` will hot-reload
// while preserving Solid signal values.

import { mount, createPersistentSignal } from "@carbon/mini-solid";

function App() {
  // createPersistentSignal: value survives \`carbon dev\` HMR reloads.
  const [count, setCount] = createPersistentSignal("counter.count", 0);

  return (
    <view style={{
      background: "#0f172a",
      padding: 28,
      gap: 16,
      width: "100%",
      height: "100%",
    }}>
      <text style={{ color: "#f1f5f9", font_size: 28 }}>@@DISPLAY@@</text>
      <text style={{ color: "#94a3b8", font_size: 14 }}>
        Edit App.tsx and save to hot-reload.
      </text>

      <view style={{
        background: "#1e293b",
        border_radius: 12,
        padding: 24,
        gap: 12,
        align_items: "center",
        width: 240,
      }}>
        <text style={{ color: "#94a3b8", font_size: 12 }}>COUNT</text>
        <text style={{ color: "#f1f5f9", font_size: 48 }}>{count()}</text>
      </view>

      <view style={{ flex_direction: "row", gap: 10 }}>
        <view
          style={{
            background: "#ef4444",
            border_radius: 8,
            padding: 12,
            width: 110,
            height: 44,
            align_items: "center",
            justify_content: "center",
          }}
          onClick={() => setCount(c => c - 1)}
        >
          <text style={{ color: "#ffffff", font_size: 15 }}>Decrement</text>
        </view>
        <view
          style={{
            background: "#3b82f6",
            border_radius: 8,
            padding: 12,
            width: 110,
            height: 44,
            align_items: "center",
            justify_content: "center",
          }}
          onClick={() => setCount(c => c + 1)}
        >
          <text style={{ color: "#ffffff", font_size: 15 }}>Increment</text>
        </view>
      </view>
    </view>
  );
}

mount(() => <App />);
`;

const TAILWIND = `// App.tsx — your starting point. Edit and \`carbon dev\` will hot-reload
// while preserving Solid signal values.

import { mount, createPersistentSignal } from "@carbon/mini-solid";

function App() {
  const [count, setCount] = createPersistentSignal("counter.count", 0);

  return (
    <view class="p-7 gap-4 flex flex-col bg-slate-900" style={{ width: "100%", height: "100%" }}>
      <text class="text-2xl text-slate-100">@@DISPLAY@@</text>
      <text class="text-sm text-slate-400">Edit App.tsx and save to hot-reload.</text>

      <view class="p-6 gap-3 flex flex-col bg-slate-800 rounded-xl items-center" style={{ width: 240 }}>
        <text class="text-xs text-slate-400">COUNT</text>
        <text class="text-5xl text-slate-100">{count()}</text>
      </view>

      <view class="gap-2 flex flex-row">
        <view
          class="p-3 bg-red-500 rounded-md flex items-center justify-center"
          style={{ width: 110, height: 44 }}
          onClick={() => setCount(c => c - 1)}
        >
          <text class="text-white text-base">Decrement</text>
        </view>
        <view
          class="p-3 bg-blue-500 rounded-md flex items-center justify-center"
          style={{ width: 110, height: 44 }}
          onClick={() => setCount(c => c + 1)}
        >
          <text class="text-white text-base">Increment</text>
        </view>
      </view>
    </view>
  );
}

mount(() => <App />);
`;

const BY_STYLING: Record<Styling, string> = {
  inline: INLINE,
  tailwind: TAILWIND,
};

export function appTsxTemplate(styling: Styling): string {
  return BY_STYLING[styling];
}

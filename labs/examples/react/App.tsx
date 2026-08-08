// App.tsx — your React component on carbon-mini.
//
// This file follows the standard React project layout: App.tsx defines
// the component tree, main.tsx is the entry that mounts it. Edit either
// and `carbon dev` will hot-reload while preserving useState across
// re-evals.
//
// JSX is compiled with `@carbon/mini-react/jsx-runtime` as the JSX
// import source (set automatically by the build pipeline when the
// project depends on react). The host elements are scene tags — `view`,
// `text` — not DOM tags. The shape is the same as a vanilla React
// component otherwise: useState, props, conditional rendering, etc.

import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <view
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 32,
      }}
    >
      <text style={{ fontSize: 28, fontWeight: "bold", color: "#1d2939" }}>
        React on carbon-mini
      </text>
      <text style={{ fontSize: 16, color: "#475569" }}>
        Count: {count}
      </text>
      <view
        style={{
          background: "#3b82f6",
          color: "#ffffff",
          padding: 12,
          borderRadius: 8,
        }}
        onClick={() => setCount((c) => c + 1)}
      >
        <text style={{ color: "#ffffff", fontSize: 16, fontWeight: "bold" }}>
          Increment
        </text>
      </view>
    </view>
  );
}

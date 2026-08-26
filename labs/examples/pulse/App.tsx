// App.tsx — Pulse: a focus/capture timer built around three native
// plugins, each doing something JS alone cannot:
//
//   carbon-hotkey  Ctrl+Alt+Space summons the app even minimized/unfocused.
//   carbon-idle    auto-pauses a running capture once the OS has seen no
//                  input anywhere on the machine for a minute.
//   carbon-pulse   paints a frame-synced coral ring on the real framebuffer
//                  while capturing — immune to JS-thread jank because it
//                  never runs on the JS thread at all.
//
// This file only owns content and layout. Every plugin talks to it two
// ways: `carbon.on(name, cb)` for events pushed from a native thread
// (installed by whichever plugin's lifecycle.register runs first — see
// EVENT_SHIM in each plugin's src/main.zig), and a `carbon:<plugin-name>`
// import for the handful of things safe to call synchronously.

import { mount } from "@carbon/mini-solid";
import { createSignal, onCleanup, onMount } from "solid-js";
import { setActive as setPulseActive } from "carbon:carbon-pulse";

const ACCENT = "#ff5a5f"; // matches carbon-pulse's ACCENT_R/G/B exactly —
// the native ring and the UI are the same color on purpose.

function two(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function clock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${two(h)}:${two(m)}:${two(s)}`;
}

function timestamp(): string {
  const d = new Date();
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

type LogEntry = { time: string; label: string };

function App() {
  const [capturing, setCapturing] = createSignal(false);
  const [away, setAway] = createSignal(false);
  const [elapsed, setElapsed] = createSignal(0);
  const [log, setLog] = createSignal<LogEntry[]>([
    { time: timestamp(), label: "ready — Ctrl+Alt+Space to start, from anywhere" },
  ]);

  const pushLog = (label: string) =>
    setLog((prev) => [{ time: timestamp(), label }, ...prev].slice(0, 8));

  const startCapture = () => {
    if (capturing()) return;
    setCapturing(true);
    setAway(false);
    setPulseActive(true);
    pushLog("capture started");
  };

  const stopCapture = () => {
    if (!capturing()) return;
    setCapturing(false);
    setAway(false);
    setPulseActive(false);
    pushLog("capture stopped");
  };

  const toggleCapture = () => (capturing() ? stopCapture() : startCapture());

  onMount(() => {
    const tick = setInterval(() => {
      if (capturing() && !away()) setElapsed((s) => s + 1);
    }, 1000);

    // carbon-hotkey: fires even while this window is minimized or another
    // app has focus — the whole reason this is a plugin and not a
    // `document.addEventListener("keydown", ...)`.
    globalThis.carbon?.on("hotkey.summon", () => toggleCapture());

    // carbon-idle: system-wide, not "no events reached this window" —
    // fires whether or not Pulse currently has focus.
    globalThis.carbon?.on("idle.changed", (payload: { idle: boolean; seconds: number }) => {
      if (!capturing()) return;
      if (payload.idle) {
        setAway(true);
        setPulseActive(false);
        pushLog(`auto-paused — away ${payload.seconds}s`);
      } else {
        setAway(false);
        setPulseActive(true);
        pushLog("resumed — welcome back");
      }
    });

    onCleanup(() => clearInterval(tick));
  });

  const status = () => (!capturing() ? "READY" : away() ? "PAUSED — AWAY" : "CAPTURING");
  const statusColor = () => (!capturing() ? "#64748b" : away() ? "#f5a524" : ACCENT);

  return (
    <view
      style={{
        background: "#0b0d14",
        padding: 32,
        gap: 20,
        width: "100%",
        height: "100%",
      }}
    >
      <view style={{ flex_direction: "row", justify_content: "space-between", align_items: "center" }}>
        <text style={{ color: "#64748b", font_size: 12, font_weight: 700 }}>PULSE — FOCUS CAPTURE</text>
        <view
          style={{
            background: statusColor(),
            opacity: 0.15,
            border_radius: 999,
            padding_left: 12,
            padding_right: 12,
            padding_top: 5,
            padding_bottom: 5,
          }}
        >
          <text style={{ color: statusColor(), font_size: 11, font_weight: 700 }}>{status()}</text>
        </view>
      </view>

      <view
        style={{
          background: "#11141f",
          border_radius: 16,
          padding: 28,
          gap: 6,
          align_items: "center",
        }}
        onClick={toggleCapture}
      >
        <text
          style={{
            color: capturing() && !away() ? ACCENT : "#e2e8f0",
            font_size: 56,
            font_weight: 700,
          }}
        >
          {clock(elapsed())}
        </text>
        <text style={{ color: "#475569", font_size: 12 }}>
          click to {capturing() ? "stop" : "start"} — or press the hotkey
        </text>
      </view>

      <view
        style={{
          background: "#11141f",
          border_radius: 12,
          padding: 14,
          flex_direction: "row",
          align_items: "center",
          gap: 10,
        }}
      >
        <text style={{ color: ACCENT, font_size: 14, font_weight: 700 }}>Ctrl+Alt+Space</text>
        <text style={{ color: "#64748b", font_size: 12 }}>
          summons Pulse and toggles capture — even minimized, even unfocused
        </text>
      </view>

      <view style={{ gap: 4 }}>
        <text style={{ color: "#334155", font_size: 11, font_weight: 700 }}>ACTIVITY</text>
        {log().map((entry) => (
          <view style={{ flex_direction: "row", gap: 10 }}>
            <text style={{ color: "#334155", font_size: 12 }}>{entry.time}</text>
            <text style={{ color: "#94a3b8", font_size: 12 }}>{entry.label}</text>
          </view>
        ))}
      </view>
    </view>
  );
}

mount(() => <App />);

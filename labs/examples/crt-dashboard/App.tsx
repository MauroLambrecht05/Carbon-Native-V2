// App.tsx — a small system-status readout, styled as a phosphor terminal.
//
// The CRT look (scanlines, corner vignette) is NOT drawn here — it's real,
// computed on the actual framebuffer every frame by the carbon-crt plugin
// in plugins/carbon-crt/. This file only owns the content and the color
// palette; the physical-monitor simulation is native code, not CSS.

import { mount } from "@carbon/mini-solid";
import { createSignal, onCleanup, onMount } from "solid-js";

const BOOT_LINES = [
  "carbon-mini runtime online",
  "native plugin bridge attached",
  "carbon-crt: phosphor simulation active",
];

function two(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function clockString(d: Date): string {
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function uptimeString(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${two(Math.floor(s / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
}

function Stat(props: { label: string; value: string; accent?: boolean }) {
  return (
    <view class="stat-row">
      <text class="stat-label">{props.label}</text>
      <text class={props.accent ? "stat-value stat-value-accent" : "stat-value"}>
        {props.value}
      </text>
    </view>
  );
}

function App() {
  const [now, setNow] = createSignal(new Date());
  const start = Date.now();

  let timer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    timer = setInterval(() => setNow(new Date()), 1000);
  });
  onCleanup(() => {
    if (timer) clearInterval(timer);
  });

  return (
    <view class="app">
      <view class="screen">
        <text class="eyebrow">CARBON SYSTEM MONITOR</text>
        <text class="clock">{clockString(now())}</text>

        <view class="divider" />

        <view class="stats">
          <Stat label="STATUS" value="NOMINAL" accent />
          <Stat label="UPTIME" value={uptimeString(now().getTime() - start)} />
          <Stat label="RUNTIME" value="carbon-mini" />
          <Stat label="RENDER" value="softbuffer + tiny-skia" />
        </view>

        <view class="divider" />

        <view class="boot-log">
          {BOOT_LINES.map((line) => (
            <text class="boot-line">{`> ${line}`}</text>
          ))}
        </view>

        <text class="footer">
          scanlines + vignette are real — computed on the framebuffer by
          plugins/carbon-crt, not drawn here
        </text>
      </view>
    </view>
  );
}

mount(() => <App />);

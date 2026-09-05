// @carbon/plugins/input — modifier/lock-key state, synthetic keyboard/mouse
// input, and active keyboard-layout detection (Windows only for now — see
// the input plugin's own main.zig header comment). Does NOT cover multi-
// touch trackpad gestures, Force Touch, pen/stylus pressure curves, or
// on-screen keyboard control — each is a separate, materially larger piece
// of work, not built here.
//
// import { useInput } from "@carbon/plugins/input";
// const { getModifierState, sendKey, moveMouse, clickMouse, getKeyboardLayout } = useInput();
// const { shift, ctrl, alt, capsLock, numLock } = getModifierState()!;
// sendKey(0x41, true); sendKey(0x41, false); // "A" down, up
// moveMouse(32768, 32768); // screen-absolute, 0..=65535
// clickMouse(0, true); clickMouse(0, false); // left button down, up

import { useCallback } from "react";
import {
  getModifierState as rawGetModifierState,
  sendKey as rawSendKey,
  moveMouse as rawMoveMouse,
  clickMouse as rawClickMouse,
  getKeyboardLayout as rawGetKeyboardLayout,
} from "carbon:input";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface ModifierState {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  capsLock: boolean;
  numLock: boolean;
}

export interface UseInputResult {
  getModifierState: () => ModifierState | null;
  sendKey: (vk: number, keyDown: boolean) => boolean;
  moveMouse: (x: number, y: number) => boolean;
  clickMouse: (button: 0 | 1 | 2, isDown: boolean) => boolean;
  getKeyboardLayout: () => string | null;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("getModifierState");
}

export function useInput(): UseInputResult {
  const getModifierState = useCallback(
    (): ModifierState | null => (pluginReady() ? rawGetModifierState() : null),
    [],
  );
  const sendKey = useCallback(
    (vk: number, keyDown: boolean): boolean => (pluginReady() ? rawSendKey(vk, keyDown) : false),
    [],
  );
  const moveMouse = useCallback(
    (x: number, y: number): boolean => (pluginReady() ? rawMoveMouse(x, y) : false),
    [],
  );
  const clickMouse = useCallback(
    (button: 0 | 1 | 2, isDown: boolean): boolean => (pluginReady() ? rawClickMouse(button, isDown) : false),
    [],
  );
  const getKeyboardLayout = useCallback(
    (): string | null => (pluginReady() ? rawGetKeyboardLayout() : null),
    [],
  );

  return { getModifierState, sendKey, moveMouse, clickMouse, getKeyboardLayout, ready: pluginReady() };
}

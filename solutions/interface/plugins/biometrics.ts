// @carbon/plugins/biometrics — Windows Hello user-consent verification
// (fingerprint/face/PIN, whatever the device and user have configured).
// Windows only for now — see the biometrics plugin's own main.zig header
// comment. Does NOT cover macOS Touch ID/Face ID or a Linux equivalent.
//
// import { useBiometrics } from "@carbon/plugins/biometrics";
// const { verifyIdentity } = useBiometrics();
// verifyIdentity("Unlock your vault");
// carbon.on("biometrics.result", ({ verified, result }) => { ... });
//
// `verifyIdentity()` only dispatches the OS-native verification prompt and
// returns immediately (whether the request was successfully dispatched,
// not the verification's outcome) — the actual verified/not-verified
// answer arrives asynchronously via `carbon.on("biometrics.result", ...)`
// (`result` is one of "verified"|"deviceNotPresent"|"notConfigured"|
// "disabledByPolicy"|"deviceBusy"|"retriesExhausted"|"canceled"|"error").
// This can't be a synchronous return value or a Promise resolved from
// this call — the underlying WinRT call can only be awaited with a
// blocking wait that would deadlock the JS/event-loop thread's own
// apartment; see the plugin's own header for the full reasoning.

import { useCallback } from "react";
import { verifyIdentity as rawVerifyIdentity } from "carbon:biometrics";
import { pluginGlobalReady } from "./_awaitPluginReady.ts";

export interface UseBiometricsResult {
  verifyIdentity: (message?: string) => boolean;
  ready: boolean;
}

function pluginReady(): boolean {
  return pluginGlobalReady("verifyIdentity");
}

export function useBiometrics(): UseBiometricsResult {
  const verifyIdentity = useCallback(
    (message?: string): boolean => (pluginReady() ? rawVerifyIdentity(message ?? "") : false),
    [],
  );

  return { verifyIdentity, ready: pluginReady() };
}

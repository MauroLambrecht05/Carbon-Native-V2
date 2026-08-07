// Types for the three-bridge Vite plugin.
//
// Wraps the Babel plugin of the same name so a Vite-based backend gets the
// dual-renderer handling without configuring Babel itself.

import type { Plugin } from "vite";
import type { ThreeBridgeOptions } from "../babel/three-bridge";

export function carbonThreeBridge(options?: ThreeBridgeOptions): Plugin;

export { default as carbonThreeBridgeBabel } from "../babel/three-bridge";

export default carbonThreeBridge;

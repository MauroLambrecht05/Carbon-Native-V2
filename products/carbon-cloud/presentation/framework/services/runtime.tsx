import { createContext, useContext } from "react";

/** Whether this page talks to the real service or to the local mock. Pages use it only to say true things about where data goes. */
export type Runtime = Readonly<{ live: boolean }>;
/** The slices of the route catalog that are connected to the live service. Every other route says so instead of rendering. */
export const LIVE_SLICES: ReadonlySet<number> = new Set([1, 2]);
export const RuntimeContext = createContext<Runtime>({ live: false });
export const useRuntime = () => useContext(RuntimeContext);

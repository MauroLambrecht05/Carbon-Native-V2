import { createMockServices } from "../infrastructure/browser/mock/create-mock-services";
import { openIndexedDb } from "../infrastructure/browser/mock/store";
import { seedFoundation } from "../infrastructure/browser/mock/scenarios/foundation";
// This composition is deliberately mock-only. A future HTTP composition must
// import neither this module nor mock devtools; there is no fallback mode.
export async function createBrowserServices() {
  const persistence = await openIndexedDb(seedFoundation(Date.now()));
  try {
    await persistence.transact(() => ({ value: undefined, changed: false }));
  } catch (cause) {
    persistence.close();
    throw cause;
  }
  return createMockServices({
    persistence,
    channel:
      typeof BroadcastChannel === "undefined"
        ? undefined
        : new BroadcastChannel("carbon-cloud-mock-v1"),
  });
}

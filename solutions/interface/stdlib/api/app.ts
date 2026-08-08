// App metadata. Sourced from `carbon.toml`'s [app] block at runtime
// startup. Apps that want runtime overrides should ship their own
// metadata layer over this.
//
//   import { getName, getVersion } from "@carbon/api/app";
//   await getName();      // → "terax"
//   await getVersion();   // → "0.6.4"

import "./hosts";

export async function getName(): Promise<string> {
  return __cm_app_name();
}

export async function getVersion(): Promise<string> {
  return __cm_app_version();
}

// main.tsx — entry point. Imports the App component from App.tsx and
// hands it to @carbon/mini-react's `render()`, which routes through
// react-reconciler into carbon-mini's scene-graph host imports. No DOM,
// no react-dom shipped.
//
// The @carbon/compat-dom install runs FIRST so any npm package that touches
// document/window during its module-init code (lodash-es uses globalThis,
// some date libs read navigator.language, etc.) sees the Tier-1+2 shim
// instead of a ReferenceError.
//
// You almost never need to edit this file — keep your component code in
// App.tsx and split out new files from there.

import "@carbon/compat-dom/install";
import { render } from "@carbon/mini-react";
import App from "./App";

render(<App />);

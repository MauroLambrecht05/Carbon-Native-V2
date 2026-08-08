// Entry — installs the DOM shim before any React init code runs, then
// mounts <App /> via @carbon/mini-react.

import "@carbon/compat-dom/install";
import { render } from "@carbon/mini-react";
import App from "./App.tsx";

render(<App />);

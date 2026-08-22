// The entrypoint: mounts the React tree to the DOM. Wiring only — the whole
// point of composition/ per products/README.md.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../presentation/App.tsx";
import "../presentation/styles/global.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

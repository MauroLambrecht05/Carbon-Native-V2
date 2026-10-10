import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../presentation/App";
import { ServicesContext } from "../presentation/framework/services/context";
import { SessionProvider } from "../presentation/framework/session/SessionProvider";
import { MockToolsPanel } from "../presentation/devtools/mock-scenarios/MockToolsPanel";
import { createBrowserServices } from "./create-browser-services";
import { openIndexedDb } from "../infrastructure/browser/mock/store";
import { seedFoundation } from "../infrastructure/browser/mock/scenarios/foundation";

const root = createRoot(document.getElementById("root")!);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 0,
      gcTime: 0,
      refetchOnWindowFocus: false,
      networkMode: "always",
    },
    mutations: { retry: false, networkMode: "always" },
  },
});
async function mount() {
  try {
    const runtime = await createBrowserServices();
    root.render(
      <QueryClientProvider client={queryClient}>
        <ServicesContext.Provider value={runtime.services}>
          <SessionProvider>
            <BrowserRouter>
              <App tools={<MockToolsPanel tools={runtime.tools} />} />
            </BrowserRouter>
          </SessionProvider>
        </ServicesContext.Provider>
      </QueryClientProvider>,
    );
    // A BFCache restore must reopen the disposed IDB connection and subscriptions.
    window.addEventListener("pagehide", () => runtime.dispose(), {
      once: true,
    });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) window.location.reload();
    });
  } catch (cause) {
    root.render(
      <main>
        <h1>Mock persistence unavailable</h1>
        <p role="alert">
          {cause instanceof Error
            ? cause.message
            : "Unable to open the fake workspace."}
        </p>
        <p>
          No in-memory fallback was used. You can retry, or explicitly replace
          incompatible mock data.
        </p>
        <button onClick={() => void mount()}>Retry</button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            if (form.get("confirmation") === "RESET MOCK") void reset();
          }}
        >
          <label>
            Type RESET MOCK to discard the fake workspace{" "}
            <input name="confirmation" required pattern="RESET MOCK" />
          </label>
          <button>Reset mock persistence</button>
        </form>
      </main>,
    );
  }
}
async function reset() {
  try {
    const seed = seedFoundation(Date.now());
    const persistence = await openIndexedDb(seed);
    await persistence.reset(seed);
    persistence.close();
    await mount();
  } catch (cause) {
    root.render(
      <main>
        <h1>Reset failed</h1>
        <p role="alert">{String(cause)}</p>
        <button onClick={() => void mount()}>Retry opening workspace</button>
      </main>,
    );
  }
}
void mount();

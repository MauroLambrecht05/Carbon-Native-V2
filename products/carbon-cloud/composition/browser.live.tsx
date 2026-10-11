import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../presentation/App";
import { ServicesContext } from "../presentation/framework/services/context";
import { RuntimeContext } from "../presentation/framework/services/runtime";
import { SessionProvider } from "../presentation/framework/session/SessionProvider";
import { createLiveServices } from "../infrastructure/browser/http/live-services";

// The production browser composition. It wires the pages to the real Carbon
// Cloud API on the origin that served them. It imports no mock service, no
// mock data and no development tool, and the build fails if one is reached.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 0, gcTime: 0, refetchOnWindowFocus: false, networkMode: "always" },
    mutations: { retry: false, networkMode: "always" },
  },
});
const { services } = createLiveServices();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RuntimeContext.Provider value={{ live: true }}>
      <ServicesContext.Provider value={services}>
        <SessionProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </SessionProvider>
      </ServicesContext.Provider>
    </RuntimeContext.Provider>
  </QueryClientProvider>,
);
// A page restored from the back-forward cache may show another account's data: start again instead.
window.addEventListener("pageshow", (event) => { if (event.persisted) window.location.reload(); });

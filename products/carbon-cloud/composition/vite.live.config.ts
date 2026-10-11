import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
const productRoot = fileURLToPath(new URL("../", import.meta.url));
/** Modules the production browser bundle may never contain. */
export const FORBIDDEN = /carbon-cloud\/(infrastructure\/browser\/mock\/|presentation\/devtools\/|infrastructure\/(http|persistence|notifications)\/|composition\/(entrypoint|worker|create-browser-services|browser\.tsx))|\/solutions\//;
const entry: Plugin = {
  name: "carbon-live-entry",
  enforce: "post",
  generateBundle: {
    order: "post",
    handler(_options, bundle) {
      const html = bundle["presentation/index.live.html"];
      if (html?.type === "asset") {
        delete bundle["presentation/index.live.html"];
        html.fileName = "index.html";
        bundle["index.html"] = html;
      }
      // Not a lint: a mock service, mock data, a development tool or server code in the graph stops the build.
      for (const moduleId of this.getModuleIds()) {
        const path = moduleId.replaceAll("\\", "/");
        if (FORBIDDEN.test(path)) this.error(`A module that must not ship reached the production browser bundle: ${path}`);
      }
    },
  },
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (request.url && !request.url.includes(".") && !request.url.startsWith("/@") && !request.url.startsWith("/platform/")) request.url = "/presentation/index.live.html";
      next();
    });
  },
};
export default defineConfig({
  root: productRoot,
  plugins: [entry],
  // In development the page is served here and the API by a local Carbon Cloud; in production one origin serves both.
  server: { host: "127.0.0.1", port: 5177, strictPort: true, hmr: false, proxy: { "/platform": process.env.CARBON_CLOUD_URL ?? "http://127.0.0.1:8080" } },
  esbuild: { jsx: "automatic" },
  build: { outDir: "dist-live", emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL("../presentation/index.live.html", import.meta.url)) } },
});

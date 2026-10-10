import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
const productRoot = fileURLToPath(new URL("../", import.meta.url));
// Keep all browser inputs inside the product root while presentation owns HTML.
const entry: Plugin = {
  name: "carbon-mock-entry",
  enforce: "post",
  transformIndexHtml: {
    order: "post",
    handler: (html) =>
      html.replace(
        /<script type="module" src="\/@vite\/client"><\/script>/,
        "",
      ),
  },
  generateBundle: {
    order: "post",
    handler(_options, bundle) {
      const html = bundle["presentation/index.html"];
      if (html?.type === "asset") {
        delete bundle["presentation/index.html"];
        html.fileName = "index.html";
        bundle["index.html"] = html;
      }
      for (const moduleId of this.getModuleIds()) {
        const path = moduleId.replaceAll("\\", "/");
        if (
          /carbon-cloud\/(infrastructure\/(http|persistence)|composition\/(entrypoint|worker))/.test(
            path,
          ) ||
          path.includes("/solutions/")
        )
          this.error(`Server/native module reached the mock browser: ${path}`);
      }
    },
  },
  configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      if (
        request.url &&
        !request.url.includes(".") &&
        !request.url.startsWith("/@")
      )
        request.url = "/presentation/index.html";
      next();
    });
  },
};
export default defineConfig({
  root: productRoot,
  plugins: [entry],
  server: { host: "127.0.0.1", port: 5175, strictPort: true, hmr: false },
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "dist-mock",
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(
        new URL("../presentation/index.html", import.meta.url),
      ),
    },
  },
});

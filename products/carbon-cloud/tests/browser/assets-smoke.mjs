// A local asset-server check, separate from the service/React contract tests.
// It performs no browser UI automation and contacts only its own ephemeral server.
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const server = await createServer({
  configFile: fileURLToPath(
    new URL("../../composition/vite.mock.config.ts", import.meta.url),
  ),
  server: { port: 0, strictPort: false, preTransformRequests: false },
});
await server.listen();
try {
  const address = server.httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local asset address");
  const origin = `http://127.0.0.1:${address.port}`;
  const html = await fetch(
    `${origin}/orgs/org_north/projects/project_north_notes/overview`,
  ).then((response) => response.text());
  if (
    !html.includes("composition/browser.tsx") ||
    !html.includes("connect-src 'none'") ||
    html.includes("/@vite/client")
  )
    throw new Error("Invalid mock HTML or hot-reload client leaked into entry");
  const entry = await fetch(`${origin}/composition/browser.tsx`).then(
    (response) => response.text(),
  );
  if (
    !entry.includes("createBrowserServices") ||
    entry.includes("/@vite/client")
  )
    throw new Error("Browser entry missing or hot-reload client imported");
  const css = await fetch(`${origin}/presentation/styles.css`, {
    headers: { Accept: "text/css" },
  });
  const stylesheet = await css.text();
  if (
    !css.ok ||
    !css.headers.get("content-type")?.includes("text/css") ||
    stylesheet.includes("/@vite/client")
  )
    throw new Error("Stylesheet is not a standalone local CSS asset");
  await server.waitForRequestsIdle();
  console.log(
    "Mock dev assets: deep-link HTML, browser entry and CSS served; no hot-reload client; connect-src disabled.",
  );
} finally {
  await server.close();
}

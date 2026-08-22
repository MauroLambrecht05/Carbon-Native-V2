# carbon-website

The public marketing site: `carbon.<domain>` — not a dashboard, not a tool a
developer authenticates into. A visitor lands here to find out what Carbon
is, then leaves for `carbon create` or `products/carbon-cloud`.

```
composition/
  main.tsx        mounts <App/> to #root — wiring only
presentation/
  App.tsx          the router: "/" and "/cloud"
  components/       Nav, Footer, Button, Logo, CodeBlock, SectionHeading,
                     PageTitle, ScrollToTop — shared across both pages
  pages/
    Home/           the landing page's sections, one file each
    Cloud/          the Carbon Cloud product page's sections
  styles/           tokens.css (design system), fonts.css, global.css
assets/
  brand/            the logo (shared with products/carbon-vscode's icon)
  fonts/            Inter, converted to WOFF2 — the same typeface
                     solutions/capabilities/rendering/text bundles into
                     every Carbon app, not a separate web-fonts choice
```

## Run it locally

```sh
cd products/carbon-website
bunx vite          # dev server
bunx vite build    # production build, dist/
bunx vite preview  # serve the production build
```

Ordinary Vite + React, not carbon-mini/carbon-blitz — this page runs in a
browser, so it uses `@vitejs/plugin-react` directly rather than
`solutions/integrations/bundler/vite`, which compiles apps *for* the carbon
runtime. Two different compilation targets; reusing that integration here
would be wiring a browser page through a pipeline built to avoid the DOM.

## Design system

Dark-only, deliberately — not a dark/light pair. `assets/brand/logo.png` is
a graphite-on-transparent glyph drawn for a dark ground, and
`presentation/styles/tokens.css`'s palette is sampled from its own gradient
(`--steel-light` / `--steel-mid` / `--steel-dark`), not invented separately.
One accent color (`--accent`, a cool indigo-blue) against an otherwise
neutral palette.

## What's on it

- **`/`** — the runtime pitch: two rendering backends, native OS
  integration, the plugin system, signed installers, auto-update, the
  product suite, a `carbon-cli` quick start, and a Carbon Cloud teaser.
- **`/cloud`** — Carbon Cloud specifically: how a build actually moves
  through the queue, what the worker fleet and token scoping buy you, and
  the two plans (`free` / `pro`) `solutions/capabilities/cloud/billing`
  actually defines. No invented price on the Pro plan — Carbon Cloud is
  self-hosted, so whoever runs an instance sets that in their own Stripe
  account; the page says so rather than making a number up.

No external links to social accounts, a hosted signup, or a real GitHub
URL — none of those exist yet for this project, and a marketing site
shipping a dead or wrong link is worse than one with no link there at all.
Every CTA points inside the site itself.

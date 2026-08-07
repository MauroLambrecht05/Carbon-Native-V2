// @carbon/vite/transforms — production-mode compile-time transforms.
//
// What runs today (mode-aware: only in `vite build`, never in dev):
//
//   1. Console-strip — removes calls to `console.log`, `console.debug`,
//      `console.info`, `console.trace`. Keeps `console.warn` + `console.error`
//      so production debugging still has a signal channel.
//
//   2. DEBUG-block-strip — removes `if (DEBUG) { ... }` blocks (or
//      `if (CARBON_DEBUG)`). Lets users guard expensive dev-only assertions
//      with zero production cost.
//
// What's planned (none implemented yet — feature-set still under design):
//   - Custom decorators (@persisted, @host, @cap, @gpu)
//   - Namespaced JSX event bindings (`<view onKeybind:save={fn}>`)
//   - `use:` directive registration
//   - Source-location tagging for error overlays
//
// The plugin runs `enforce: "pre"` so it precedes vite-plugin-solid's JSX
// transform — anything we strip never reaches the Solid compiler.

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import type { Plugin } from "vite";

const traverse = (_traverse as any).default ?? _traverse;
const generate = (_generate as any).default ?? _generate;

export interface CarbonTransformsOptions {
  /** Override the auto-detect of dev vs prod. Default: track Vite's command. */
  forceMode?: "dev" | "prod";
  /** Names recognized as the "production-only" guard constant. */
  debugGuards?: string[];
  /** console method names to strip in production. */
  stripConsoleMethods?: string[];
  /** Verbose: log per-file how many calls/blocks were stripped. */
  debug?: boolean;
}

export function carbonTransforms(opts: CarbonTransformsOptions = {}): Plugin {
  const debugGuards = new Set(opts.debugGuards ?? ["DEBUG", "CARBON_DEBUG"]);
  const consoleMethods = new Set(
    opts.stripConsoleMethods ?? ["log", "debug", "info", "trace"],
  );

  let isProd = false;

  return {
    name: "@carbon/vite/transforms",
    enforce: "pre",
    configResolved(cfg) {
      isProd = opts.forceMode
        ? opts.forceMode === "prod"
        : cfg.command === "build";
      if (opts.debug) {
        // eslint-disable-next-line no-console
        console.log(
          `[carbon-transforms] mode=${isProd ? "prod" : "dev"} (transforms ${isProd ? "ACTIVE" : "skipped"})`,
        );
      }
    },
    transform(code, id) {
      if (!isProd) return null;
      if (id.includes("node_modules")) return null;
      if (!/\.(tsx|ts|jsx|js)$/.test(id)) return null;

      // Cheap reject: nothing matching our triggers → skip the AST walk.
      const hasConsole = /\bconsole\s*\.\s*(log|debug|info|trace)\b/.test(code);
      const hasDebugGuard = [...debugGuards].some((g) =>
        new RegExp(`\\bif\\s*\\(\\s*${g}\\b`).test(code),
      );
      if (!hasConsole && !hasDebugGuard) return null;

      let ast;
      try {
        ast = parse(code, {
          sourceType: "module",
          plugins: ["jsx", "typescript"],
        });
      } catch {
        return null;
      }

      let stripped = 0;
      let blocksRemoved = 0;

      traverse(ast, {
        // Strip console.<method>(...) call statements + bare expressions.
        CallExpression(path: any) {
          const callee = path.node.callee;
          if (!t.isMemberExpression(callee)) return;
          if (!t.isIdentifier(callee.object) || callee.object.name !== "console") return;
          if (!t.isIdentifier(callee.property)) return;
          if (!consoleMethods.has(callee.property.name)) return;
          // Replace the entire call expression with `void 0` so it remains
          // valid in expression positions (e.g. `const x = console.log(y)`).
          // For statement-position calls Babel will fold this to nothing.
          path.replaceWith(t.unaryExpression("void", t.numericLiteral(0)));
          stripped++;
        },

        // Strip `if (DEBUG) { ... }` and `if (CARBON_DEBUG) { ... }`. We don't
        // touch `else` branches — but for now require the simple `if (G) {}`
        // shape since that's the convention we want users to follow.
        IfStatement(path: any) {
          const test = path.node.test;
          if (!t.isIdentifier(test)) return;
          if (!debugGuards.has(test.name)) return;
          if (path.node.alternate) {
            // Has an else — replace the whole thing with the else branch.
            path.replaceWith(path.node.alternate);
          } else {
            path.remove();
          }
          blocksRemoved++;
        },
      });

      if (stripped === 0 && blocksRemoved === 0) return null;
      const out = generate(ast, { retainLines: true, sourceMaps: false }, code);
      if (opts.debug) {
        // eslint-disable-next-line no-console
        console.log(
          `[carbon-transforms] ${id}: stripped ${stripped} console call(s), removed ${blocksRemoved} DEBUG block(s)`,
        );
      }
      return { code: out.code, map: null };
    },
  };
}

export default carbonTransforms;

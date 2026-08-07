// @carbon/vite/three-bridge / index.js
//
// Vite plugin wrapper around the Babel transform in ./babel.js. This is the
// shape Vite/Rollup expects (`name`, `enforce`, `transform`); the actual
// JSX-walking work happens in babel.js.
//
// In the Bun.build path we don't use this wrapper — the build-pipeline
// registers the babel plugin directly inside its phase-1 transformSync
// call, BEFORE babel-preset-solid runs. See cli/src/build-pipeline.ts.
//
// The two paths are equivalent: same babel plugin, same options.
//
// Usage in a vite.config.ts:
//   import { carbonThreeBridge } from "@carbon/vite/three-bridge";
//   plugins: [
//     carbonThreeBridge(),                  // BEFORE solid()
//     solid({ solid: { generate: 'universal', moduleName: '...' } }),
//   ]

import babel from "@babel/core";
import threeBridge from "../babel/three-bridge.js";

/**
 * @param {object} [options]
 * @param {string[]} [options.bridgeComponents]
 * @param {boolean}  [options.debug]
 * @returns {import('vite').Plugin}
 */
export function carbonThreeBridge(options = {}) {
  return {
    name: "@carbon/vite/three-bridge",
    enforce: "pre", // run BEFORE vite-plugin-solid
    async transform(code, id) {
      // Skip third-party + non-JS/TS source.
      if (id.includes("node_modules")) return null;
      if (!/\.(tsx|jsx|ts|js|mjs)$/.test(id)) return null;
      // Cheap reject: no `<Canvas` tag → nothing to do.
      if (!/<\s*Canvas[\s/>]/.test(code) && !optsBridges(options).some((c) => new RegExp(`<\\s*${c}[\\s/>]`).test(code))) {
        return null;
      }
      try {
        const result = babel.transformSync(code, {
          filename: id,
          babelrc: false,
          configFile: false,
          plugins: [[threeBridge, options]],
          parserOpts: {
            plugins: ["jsx", "typescript"],
            sourceType: "module",
          },
          generatorOpts: { compact: false },
        });
        if (!result || !result.code) return null;
        return { code: result.code, map: result.map ?? null };
      } catch (err) {
        // Surface a useful build error rather than a cryptic AST crash.
        this.error?.(`carbon-three-bridge: babel transform failed: ${err.message}`);
        return null;
      }
    },
  };
}

function optsBridges(opts) {
  return opts?.bridgeComponents ?? ["Canvas"];
}

export default carbonThreeBridge;
// Re-export the babel plugin for consumers that want to wire it directly.
export { default as carbonThreeBridgeBabel } from "../babel/three-bridge.js";

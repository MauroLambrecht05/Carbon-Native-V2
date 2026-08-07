// carbon-transforms, exported as a `@babel/core` plugin.
//
// Same semantics as ./index.ts (console-strip, DEBUG-block strip) but as a
// proper Babel plugin so we can run it inside bun-build's onLoad hook,
// chained with babel-preset-solid + carbon-tailwind in one transform pass.
//
// state.opts shape mirrors CarbonTransformsOptions but always assumes prod
// mode (the bun-build pipeline only runs in prod — dev uses a different
// path that doesn't need any of these strips).

export interface CarbonTransformsBabelOptions {
  /** Names recognized as the "production-only" guard constant. */
  debugGuards?: string[];
  /** console method names to strip in production. */
  stripConsoleMethods?: string[];
}

export function carbonTransformsBabel({ types: t }: { types: any }) {
  return {
    name: "carbon-transforms",
    visitor: {
      // Strip console.<method>(...) calls.
      CallExpression(path: any, state: any) {
        const opts: CarbonTransformsBabelOptions = state.opts ?? {};
        const consoleMethods = new Set(
          opts.stripConsoleMethods ?? ["log", "debug", "info", "trace"],
        );
        const callee = path.node.callee;
        if (!t.isMemberExpression(callee)) return;
        if (!t.isIdentifier(callee.object) || callee.object.name !== "console")
          return;
        if (!t.isIdentifier(callee.property)) return;
        if (!consoleMethods.has(callee.property.name)) return;
        // Replace with `void 0` so the call is still valid in expression
        // position. In statement position Babel reduces this to nothing on
        // the second pass (or downstream minification removes it).
        path.replaceWith(t.unaryExpression("void", t.numericLiteral(0)));
      },

      // Strip `if (DEBUG) { ... }` and `if (CARBON_DEBUG) { ... }`.
      IfStatement(path: any, state: any) {
        const opts: CarbonTransformsBabelOptions = state.opts ?? {};
        const debugGuards = new Set(opts.debugGuards ?? ["DEBUG", "CARBON_DEBUG"]);
        const test = path.node.test;
        if (!t.isIdentifier(test)) return;
        if (!debugGuards.has(test.name)) return;
        if (path.node.alternate) {
          path.replaceWith(path.node.alternate);
        } else {
          path.remove();
        }
      },
    },
  };
}

export default carbonTransformsBabel;

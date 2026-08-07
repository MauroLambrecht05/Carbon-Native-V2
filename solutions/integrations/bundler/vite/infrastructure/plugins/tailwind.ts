// @carbon/vite/tailwind — class-to-style compiler.
//
// At build time, scans every TSX/JSX file for static `class="..."` attributes,
// resolves each utility class against the carbon Tailwind subset (see
// classes.ts), and rewrites the JSX into an inline style={{...}} object that
// the carbon-mini renderer's setProperty path consumes directly.
//
// Net effect: the runtime never sees class names, never does class-to-style
// resolution, never ships a CSS sheet. Every Tailwind class collapses to
// numeric inline-style at build time.
//
// Limitations (intentional):
//   - Only static class strings are compiled. Dynamic ones (JSX expressions,
//     template literals with variables) are left alone — the runtime stashes
//     them as raw `className` props and currently no-ops them.
//   - Existing inline `style={{...}}` is preserved and merged AFTER the
//     compiled Tailwind, so user-written style overrides class-style.
//   - Unknown utility classes are kept on the element as a leftover `class`
//     attribute so they show up in dev tools or future plugins; they don't
//     crash the build.

import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";
import * as t from "@babel/types";
import type { Plugin } from "vite";
import { resolveTailwindClass, type StyleProps } from "../../domain/tailwind-classes.ts";

// Babel publishes traverse + generator as default-exported function values;
// in ESM they sometimes need .default-unwrapping depending on bundler.
const traverse = (_traverse as any).default ?? _traverse;
const generate = (_generate as any).default ?? _generate;

export interface CarbonTailwindOptions {
  /** Log when classes failed to resolve (helpful while expanding the table). */
  warnUnknown?: boolean;
  /** Verbose: log every transformed file + class count. */
  debug?: boolean;
}

export function carbonTailwind(opts: CarbonTailwindOptions = {}): Plugin {
  return {
    name: "@carbon/vite/tailwind",
    enforce: "pre", // run before vite-plugin-solid's JSX transform
    transform(code, id) {
      // Skip non-source files + node_modules.
      if (id.includes("node_modules")) return null;
      if (!/\.(tsx|ts|jsx|js)$/.test(id)) return null;
      // Cheap reject: no JSX class/className anywhere → no work.
      if (!/\b(class|className)\s*=/.test(code)) return null;

      let ast;
      try {
        ast = parse(code, {
          sourceType: "module",
          plugins: ["jsx", "typescript"],
        });
      } catch {
        return null; // let downstream plugins surface parser errors
      }

      let touched = 0;

      traverse(ast, {
        JSXAttribute(path: any) {
          const nameNode = path.node.name;
          if (!t.isJSXIdentifier(nameNode)) return;
          const attrName = nameNode.name;
          if (attrName !== "class" && attrName !== "className") return;

          // Only handle static string literals. Dynamic expressions pass through.
          let raw: string | null = null;
          if (t.isStringLiteral(path.node.value)) {
            raw = path.node.value.value;
          } else if (
            t.isJSXExpressionContainer(path.node.value) &&
            t.isStringLiteral(path.node.value.expression)
          ) {
            raw = path.node.value.expression.value;
          }
          if (raw == null) return;

          const resolved: StyleProps = {};
          const unresolved: string[] = [];
          for (const cls of raw.split(/\s+/).filter(Boolean)) {
            const props = resolveTailwindClass(cls);
            if (props) {
              Object.assign(resolved, props);
            } else {
              unresolved.push(cls);
            }
          }
          if (Object.keys(resolved).length === 0) return;

          // Build a JSX expression for the resolved style, then merge with any
          // existing style attribute on the same element.
          const styleObjAst = buildStyleObjectAst(resolved);

          const opening = path.parentPath.node;
          if (!t.isJSXOpeningElement(opening)) return;

          const existing = opening.attributes.find(
            (a: any) =>
              t.isJSXAttribute(a) &&
              t.isJSXIdentifier(a.name) &&
              a.name.name === "style"
          ) as t.JSXAttribute | undefined;

          if (existing && t.isJSXExpressionContainer(existing.value)) {
            // Merge: { ...resolvedFromTailwind, ...existingInline }
            // Spread inline AFTER so user inline wins on conflict.
            const inlineExpr = existing.value.expression;
            if (t.isObjectExpression(inlineExpr)) {
              existing.value = t.jsxExpressionContainer(
                t.objectExpression([
                  ...styleObjAst.properties,
                  ...inlineExpr.properties,
                ]),
              );
            } else if (t.isExpression(inlineExpr)) {
              // style={someVar} → wrap in spreads
              existing.value = t.jsxExpressionContainer(
                t.objectExpression([
                  t.spreadElement(styleObjAst),
                  t.spreadElement(inlineExpr),
                ]),
              );
            }
          } else {
            // No existing style attr — add one.
            opening.attributes.push(
              t.jsxAttribute(
                t.jsxIdentifier("style"),
                t.jsxExpressionContainer(styleObjAst),
              ),
            );
          }

          // Replace or remove the original class attribute.
          if (unresolved.length > 0) {
            // Keep the unresolved classes on the original attribute so they
            // remain visible to downstream tooling / future plugins.
            path.node.value = t.stringLiteral(unresolved.join(" "));
          } else {
            path.remove();
          }

          touched++;

          if (opts.warnUnknown && unresolved.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(
              `[carbon-tailwind] unknown classes in ${id}: ${unresolved.join(" ")}`,
            );
          }
        },
      });

      if (touched === 0) return null;
      const out = generate(ast, { retainLines: true, sourceMaps: false }, code);
      if (opts.debug) {
        // eslint-disable-next-line no-console
        console.log(`[carbon-tailwind] ${id}: ${touched} class attributes compiled`);
      }
      return { code: out.code, map: null };
    },
  };
}

/** Convert a StyleProps object into a JSX-friendly AST objectExpression. */
function buildStyleObjectAst(props: StyleProps): t.ObjectExpression {
  return t.objectExpression(
    Object.entries(props).map(([key, value]) => {
      // Property keys with hyphens (e.g. "font-size") need to be string-literals.
      const keyNode = /^[a-zA-Z_$][\w$]*$/.test(key)
        ? t.identifier(key)
        : t.stringLiteral(key);
      const valueNode =
        typeof value === "number" ? t.numericLiteral(value) : t.stringLiteral(value);
      return t.objectProperty(keyNode, valueNode);
    }),
  );
}

export default carbonTailwind;

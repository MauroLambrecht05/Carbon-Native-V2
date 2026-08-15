// carbon-css-babel — Babel plugin that compiles `class="foo"` JSX attrs
// into inline `style={{...}}` based on a project-local `styles.css`.
//
// Why we do this at build time, not runtime:
//   - The carbon-mini scene paint reads `style` props directly. There's
//     no CSS engine in the runtime — adding one is heavyweight.
//   - At build time we already touch every JSX file via Babel, and the
//     CSS file is read once per build. The output is plain inline styles
//     identical to what a user would write by hand.
//
// This file is the Babel half only: find the stylesheet, hand it to the
// parser in ../domain/css-rules.ts, and turn the resulting map into a JSX
// visitor. What each CSS declaration MEANS is that parser's business.
//
// Usage in the build pipeline:
//   const plugin = makeCarbonCssBabel(projectDir);
//   if (plugin) phase1Plugins.push(plugin);

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseCssToClassMap, type StyleProps } from "../domain/css-rules.ts";

// Re-exported so `@carbon/babel/css` keeps its previous surface.
export { parseCssToClassMap };
export type { StyleProps };

/**
 * Build the Babel plugin function. Returns null if no `styles.css` exists
 * in `projectDir` — in that case the plugin is just skipped.
 */
export function makeCarbonCssBabel(
  projectDir: string,
): null | ((api: { types: any }) => any) {
  const cssPath = join(projectDir, "styles.css");
  if (!existsSync(cssPath)) return null;

  let cssText: string;
  try {
    cssText = readFileSync(cssPath, "utf8");
  } catch {
    return null;
  }
  const classMap = parseCssToClassMap(cssText);
  if (Object.keys(classMap).length === 0) return null;

  // The plugin builder closes over `classMap` so each Babel pass uses the
  // same parsed table — no re-reading the CSS per file.
  return function carbonCssBabel({ types: t }: { types: any }) {
    function buildStyleObjectAst(props: StyleProps): any {
      return t.objectExpression(
        Object.entries(props).map(([key, value]) => {
          // Quote keys that contain hyphens (CSS-shape) — Babel's parser
          // rejects unquoted hyphens in object literals.
          const keyNode = /^[a-zA-Z_$][\w$]*$/.test(key)
            ? t.identifier(key)
            : t.stringLiteral(key);
          const valueNode =
            typeof value === "number"
              ? t.numericLiteral(value)
              : t.stringLiteral(value);
          return t.objectProperty(keyNode, valueNode);
        }),
      );
    }

    return {
      name: "carbon-css",
      visitor: {
        JSXAttribute(path: any) {
          const nameNode = path.node.name;
          if (!t.isJSXIdentifier(nameNode)) return;
          const attrName = nameNode.name;
          if (attrName !== "class" && attrName !== "className") return;

          // Only static string class lists — dynamic ones (`class={x}`)
          // can't be resolved at build time.
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
            const props = classMap[cls];
            if (props) Object.assign(resolved, props);
            else unresolved.push(cls);
          }
          if (Object.keys(resolved).length === 0) return;

          // Merge into existing style={{...}} or add a new one. Same merge
          // strategy as the Tailwind plugin (CSS rules first, inline
          // overrides win).
          const styleObjAst = buildStyleObjectAst(resolved);
          const opening = path.parentPath.node;
          if (!t.isJSXOpeningElement(opening)) return;

          const existing = opening.attributes.find(
            (a: any) =>
              t.isJSXAttribute(a) &&
              t.isJSXIdentifier(a.name) &&
              a.name.name === "style",
          );

          if (existing && t.isJSXExpressionContainer(existing.value)) {
            const inlineExpr = existing.value.expression;
            if (t.isObjectExpression(inlineExpr)) {
              existing.value = t.jsxExpressionContainer(
                t.objectExpression([
                  ...styleObjAst.properties,
                  ...inlineExpr.properties,
                ]),
              );
            } else if (t.isExpression(inlineExpr)) {
              existing.value = t.jsxExpressionContainer(
                t.objectExpression([
                  t.spreadElement(styleObjAst),
                  t.spreadElement(inlineExpr),
                ]),
              );
            }
          } else {
            opening.attributes.push(
              t.jsxAttribute(
                t.jsxIdentifier("style"),
                t.jsxExpressionContainer(styleObjAst),
              ),
            );
          }

          // If every class resolved, drop the class attr; otherwise keep
          // the unresolved ones (Tailwind plugin may pick them up later).
          if (unresolved.length > 0) {
            path.node.value = t.stringLiteral(unresolved.join(" "));
          } else {
            path.remove();
          }
        },
      },
    };
  };
}

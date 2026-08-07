// carbon-tailwind, exported as a `@babel/core` plugin (not a Vite plugin).
//
// Same logic as ./index.ts (see that file for the rationale + limits) but
// shaped for `transformSync(code, { plugins: [...] })` instead of Vite's
// transform hook. The CLI's bun-build pipeline uses this form.
//
// Returned plugin function follows the standard Babel plugin signature:
//   ({ types: t }) => ({ name, visitor: { JSXAttribute(path, state) {...} } })
// state.opts is whatever options got passed when registering the plugin.
import { resolveTailwindClass, type StyleProps } from "../../domain/tailwind-classes.ts";

export interface CarbonTailwindBabelOptions {
  /** Log to stderr when classes failed to resolve (helpful while expanding the table). */
  warnUnknown?: boolean;
}

export function carbonTailwindBabel({ types: t }: { types: any }) {
  function buildStyleObjectAst(props: StyleProps): any {
    return t.objectExpression(
      Object.entries(props).map(([key, value]) => {
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
    name: "carbon-tailwind",
    visitor: {
      JSXAttribute(path: any, state: any) {
        const opts: CarbonTailwindBabelOptions = state.opts ?? {};
        const nameNode = path.node.name;
        if (!t.isJSXIdentifier(nameNode)) return;
        const attrName = nameNode.name;
        if (attrName !== "class" && attrName !== "className") return;

        // Collect static class strings from the attribute value. Two
        // shapes are handled:
        //   className="literal"          → one string
        //   className={"literal"}        → one string
        //   className={cn("a", x, "b")}  → strings "a" and "b" extracted;
        //                                  the cn() call stays with the
        //                                  literal args replaced by ""
        //                                  so any class variance still
        //                                  passes through
        //   className={cn("a", cond && "b")}
        //                                → "a" extracted; the cond &&
        //                                  branch keeps "b" since we
        //                                  can't statically prove cond
        // We treat `cn`, `clsx`, `cx`, `tw`, `twMerge`, `classnames` as
        // the dispatcher names — that covers shadcn/clsx/zustand-style
        // usage across the React ecosystem.
        const DISPATCHERS = new Set(["cn", "clsx", "cx", "tw", "twMerge", "classnames"]);
        const literals: string[] = [];
        // We replace extracted string literals in cn() with empty strings
        // so the rewritten cn() call still produces a valid result for
        // the dynamic parts.
        let touchedDynamic = false;
        const collectFromLiteral = (s: string) => {
          if (s) literals.push(s);
        };

        // Helper: pull static class strings out of a template literal,
        // mutating it in-place so the dynamic ${} segments stay valid.
        // Each quasi (the literal piece between expressions) contributes
        // its cooked text to `literals`; we then blank the quasis so the
        // runtime template still produces an output but the static
        // classes are now flowing to the style attribute instead.
        const extractFromTemplate = (tmpl: any) => {
          for (const q of tmpl.quasis) {
            collectFromLiteral(q.value.cooked ?? q.value.raw ?? "");
            q.value = { cooked: "", raw: "" };
          }
          touchedDynamic = true;
        };

        const v = path.node.value;
        if (t.isStringLiteral(v)) {
          collectFromLiteral(v.value);
        } else if (t.isJSXExpressionContainer(v)) {
          const expr = v.expression;
          if (t.isStringLiteral(expr)) {
            collectFromLiteral(expr.value);
          } else if (t.isTemplateLiteral(expr)) {
            if (expr.expressions.length === 0) {
              collectFromLiteral(expr.quasis.map((q: any) => q.value.cooked).join(""));
            } else {
              // Template with embedded ${expr} — extract literal quasis,
              // blank them in-place so the template still evaluates.
              extractFromTemplate(expr);
            }
          } else if (t.isCallExpression(expr)) {
            const callee = expr.callee;
            const calleeName = t.isIdentifier(callee) ? callee.name : null;
            if (calleeName && DISPATCHERS.has(calleeName)) {
              // Pull only the STATICALLY-RESOLVABLE classes out of each
              // arg. Keep the rest in the string so the runtime resolver
              // (which evaluates state-based variants like `data-active:`
              // against the element's other props) sees them at render
              // time. Without this, tab pills / radix dropdowns / any
              // shadcn component with state styling renders unstyled.
              const sortArg = (orig: string): { resolved: string[]; passThrough: string } => {
                const resolvedTokens: string[] = [];
                const pass: string[] = [];
                for (const tok of orig.split(/\s+/).filter(Boolean)) {
                  // We can only safely bake a class to inline style at
                  // build time if it has no variant prefix. Anything
                  // with a `:` (state, media, arbitrary) defers to the
                  // runtime resolver.
                  const hasVariant = /(^|:)([a-z][a-z0-9-]*|\[[^\]]+\]):/.test(tok)
                    || tok.includes(":");
                  if (hasVariant) {
                    pass.push(tok);
                    continue;
                  }
                  const s = resolveTailwindClass(tok);
                  if (s) resolvedTokens.push(tok);
                  else pass.push(tok);
                }
                return { resolved: resolvedTokens, passThrough: pass.join(" ") };
              };
              for (const arg of expr.arguments) {
                if (t.isStringLiteral(arg)) {
                  const { resolved, passThrough } = sortArg(arg.value);
                  for (const c of resolved) collectFromLiteral(c);
                  arg.value = passThrough;
                  touchedDynamic = true;
                } else if (
                  t.isTemplateLiteral(arg) &&
                  arg.expressions.length === 0
                ) {
                  const txt = arg.quasis.map((q: any) => q.value.cooked).join("");
                  const { resolved, passThrough } = sortArg(txt);
                  for (const c of resolved) collectFromLiteral(c);
                  arg.quasis = [t.templateElement({ raw: passThrough, cooked: passThrough }, true)];
                  touchedDynamic = true;
                } else if (t.isTemplateLiteral(arg)) {
                  extractFromTemplate(arg);
                }
                // Conditional / spread / variable args are left alone —
                // they're dynamic and pass through to cn() at runtime.
              }
            }
          }
        }

        if (literals.length === 0) return;
        const raw = literals.join(" ");

        const resolved: StyleProps = {};
        const unresolved: string[] = [];
        for (const cls of raw.split(/\s+/).filter(Boolean)) {
          const props = resolveTailwindClass(cls);
          if (props) Object.assign(resolved, props);
          else unresolved.push(cls);
        }
        if (Object.keys(resolved).length === 0) {
          // Nothing matched — restore (no-op, since we didn't mutate
          // anything when touchedDynamic stayed false above).
          return;
        }

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

        // For the cn()-rewrite path the className attribute itself
        // must STAY (it holds the dynamic args). For the plain string
        // path we either replace with the leftover unresolved classes
        // or drop the attribute entirely.
        if (touchedDynamic) {
          // Keep the cn() call as-is; unresolved literals from the
          // static parts are dropped (they were extracted and lost in
          // the empty-string replacement above — they wouldn't have
          // rendered visually anyway since they're tailwind classes).
          if (opts.warnUnknown && unresolved.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(
              `[carbon-tailwind] unknown classes in cn() at ${state.filename}: ${unresolved.join(" ")}`,
            );
          }
        } else if (unresolved.length > 0) {
          path.node.value = t.stringLiteral(unresolved.join(" "));
          if (opts.warnUnknown) {
            // eslint-disable-next-line no-console
            console.warn(
              `[carbon-tailwind] unknown classes in ${state.filename}: ${unresolved.join(" ")}`,
            );
          }
        } else {
          path.remove();
        }
      },
    },
  };
}

export default carbonTailwindBabel;

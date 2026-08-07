// @carbon/vite/three-bridge / babel.js
//
// A Babel plugin that solves the dual-renderer problem in @carbon/three-fiber:
//
//   babel-preset-solid's `moduleName` config is global per file. When set to
//   "@carbon/mini-solid", every JSX element in the file compiles to calls
//   into mini's universal renderer. That's correct for outer UI like
//   `<view>`, `<text>`, `<canvas>` — but JSX nested inside `<Canvas>` from
//   @carbon/three-fiber needs to land in three.js space (`mesh.position`,
//   `geometry.args`, etc.) instead.
//
// What this plugin does:
//   - Visits every JSX element looking for a `<Canvas>` (or any component
//     named in `bridgeComponents`).
//   - Lifts the JSX inside the Canvas subtree into a builder function:
//
//        <Canvas style={{...}}>
//          <mesh rotation-y={a()}>
//            <boxGeometry args={[1,1,1]} />
//            <meshStandardMaterial color="hotpink" />
//          </mesh>
//        </Canvas>
//
//     becomes
//
//        <Canvas style={{...}} r3fBuild={(h) => [
//          h("mesh", {
//            "rotation-y": () => a(),
//          }, [
//            h("boxGeometry", { args: () => [1,1,1] }, []),
//            h("meshStandardMaterial", { color: () => "hotpink" }, []),
//          ]),
//        ]}>
//        </Canvas>
//
//     The original JSX children are removed (Canvas reads `r3fBuild` instead).
//
//   - Reactive prop values are wrapped in thunks (`() => expr`) so the
//     Canvas-side runtime can re-read them inside Solid effects, preserving
//     reactivity (`<mesh rotation-y={a()}>` updates as `a` changes).
//
//   - JSXText nodes inside Canvas (whitespace/text) are dropped: three.js
//     has no text concept and they were inert anyway.
//
//   - Uppercase JSX tags inside Canvas (custom components) are LEFT AS JSX.
//     We can't tell at compile-time whether a custom component renders
//     three.js intrinsics or @carbon/mini-solid UI; the user is on the
//     hook for that. Practically, three-fiber-style components import from
//     `@carbon/three-fiber` and emit lowercase intrinsics — those calls
//     happen at the Canvas runtime side via `r3fBuild`.
//
//     For now, when an uppercase tag appears INSIDE a Canvas subtree we
//     do NOT lift it into the builder — we leave it as JSX in the outer
//     tree (which compiles to carbon-mini calls). This means custom
//     components inside Canvas don't compose into three.js. That's a
//     documented limitation; user code can still nest `<Canvas>` deeply
//     enough that this rarely bites in practice.
//
// What this plugin does NOT do:
//   - It does not understand react.Suspense, fragments, or arbitrary JS
//     control flow inside the Canvas subtree. JSXExpressionContainer that
//     produces an array (e.g., `<mesh>{items().map(it => <mesh ...>)}</mesh>`)
//     is wrapped as a thunk; the runtime evaluates the function at build-
//     time of each frame and inserts whatever JSX-built ThreeNodes come
//     back.
//   - It does not handle JSX spread attributes (`<mesh {...props}>`). Those
//     are passed through as a `__spread` thunk; the runtime applies each
//     enumerable key to the three.js object after construction.
//
// Cache key contributors (for the build-pipeline cache):
//   - This plugin's source (changes invalidate everything)
//   - bridgeComponents config
//   - Two flags below (DEBUG, CHILD_ARRAY_THUNK)
//
// Tests live in ../test/babel.test.js.

/**
 * @param {object} api - Babel plugin API ({ types, template, ... }).
 * @param {object} [opts]
 * @param {string[]} [opts.bridgeComponents] - JSX tag names whose nested
 *   JSX should be lifted. Default: ["Canvas"]. Add more if you wrap Canvas
 *   in your own component (e.g., "Scene"); the plugin matches by JSX tag
 *   identifier name only (not by import path).
 * @param {boolean} [opts.debug]
 */
export default function carbonThreeBridgeBabel(api, opts = {}) {
  const { types: t } = api;
  const bridgeComponents = new Set(opts.bridgeComponents ?? ["Canvas"]);
  const debug = !!opts.debug;

  // Helper: build the runtime helper-call expression for a JSXElement.
  //
  //   buildElementCall(<mesh foo={x}>{children}</mesh>)
  //     -> h("mesh", { foo: () => x }, [ ...child calls ])
  //
  // `h` is the parameter name of the builder function; we just emit a
  // bare identifier `h` and rely on the surrounding builder fn signature.
  function buildElementCall(jsxEl) {
    const opening = jsxEl.openingElement;
    const tagNode = opening.name;

    // Tag: lowercase intrinsic -> string literal; uppercase identifier ->
    // pass the identifier through (h() will treat it as a component
    // factory and call it).
    let tagExpr;
    let isComponent = false;
    if (t.isJSXIdentifier(tagNode)) {
      const name = tagNode.name;
      if (/^[a-z]/.test(name)) {
        tagExpr = t.stringLiteral(name);
      } else {
        // Uppercase: component factory, passed by reference. The runtime
        // calls it with the merged props and returns whatever it produced.
        tagExpr = t.identifier(name);
        isComponent = true;
      }
    } else if (t.isJSXMemberExpression(tagNode)) {
      tagExpr = jsxMemberToExpr(tagNode);
      isComponent = true;
    } else {
      // JSXNamespacedName — rare; fall back to a string literal.
      tagExpr = t.stringLiteral(toString(tagNode));
    }

    // Props: build an object expression. Each prop value gets wrapped in
    // a thunk so reactive reads happen inside the Canvas runtime's effect,
    // not at build time.
    const propEntries = [];
    let spreadCounter = 0;
    for (const attr of opening.attributes) {
      if (t.isJSXAttribute(attr)) {
        const propName = attr.name.name;
        // Static (no value) → boolean true literal.
        if (attr.value == null) {
          // Boolean literal — no thunk wrapping needed (constant).
          propEntries.push(
            t.objectProperty(
              keyForName(propName),
              t.booleanLiteral(true),
              false,
              false,
            ),
          );
          continue;
        }
        // String literal value: pass-through, no thunk wrap (constant).
        if (t.isStringLiteral(attr.value)) {
          propEntries.push(
            t.objectProperty(
              keyForName(propName),
              attr.value,
              false,
              false,
            ),
          );
          continue;
        }
        // Expression container: wrap in `() => expr` for reactivity.
        if (t.isJSXExpressionContainer(attr.value)) {
          const inner = attr.value.expression;
          if (t.isJSXEmptyExpression(inner)) continue;
          propEntries.push(
            t.objectProperty(
              keyForName(propName),
              t.arrowFunctionExpression([], inner),
              false,
              false,
            ),
          );
          continue;
        }
        // Other shapes (JSXElement as value etc.) — fall through: pass raw.
        propEntries.push(
          t.objectProperty(
            keyForName(propName),
            attr.value,
            false,
            false,
          ),
        );
      } else if (t.isJSXSpreadAttribute(attr)) {
        // Spread {...obj} — we punt on this. Stash under a unique key so
        // repeated spreads don't collide. The runtime, on seeing keys
        // matching /^__spread\d+$/, evaluates the thunk and applies its
        // own enumerable keys onto the target.
        const k = `__spread${spreadCounter++}`;
        propEntries.push(
          t.objectProperty(
            t.stringLiteral(k),
            t.arrowFunctionExpression([], attr.argument),
            false,
            false,
          ),
        );
      }
    }
    const propsExpr =
      propEntries.length === 0
        ? t.objectExpression([])
        : t.objectExpression(propEntries);

    // Children: build an array. Lowercase JSXElement → recurse into builder
    // call. Uppercase → leave the tag identifier; we recurse with
    // buildElementCall too so that nested <Canvas>-style trees keep
    // working. JSXText (just whitespace usually) → drop. Expression
    // container → wrap in thunk so reactive arrays/conditionals re-eval.
    const childExprs = [];
    for (const ch of jsxEl.children) {
      if (t.isJSXElement(ch)) {
        childExprs.push(buildElementCall(ch));
      } else if (t.isJSXFragment(ch)) {
        // Fragment: flatten into a synthetic h("__fragment", {}, [ ... ]).
        // The runtime treats __fragment as "splice my children".
        childExprs.push(buildFragmentCall(ch));
      } else if (t.isJSXExpressionContainer(ch)) {
        const inner = ch.expression;
        if (t.isJSXEmptyExpression(inner)) continue;
        // Wrap in thunk so the runtime can re-evaluate inside an effect
        // and splice the result.
        childExprs.push(t.arrowFunctionExpression([], inner));
      } else if (t.isJSXText(ch)) {
        // Drop JSX text — three.js has no text concept.
        if (ch.value.trim() === "") continue;
        // Non-whitespace text inside Canvas: warn-ish — emit a no-op
        // string literal (runtime ignores strings).
        childExprs.push(t.stringLiteral(ch.value));
      } else if (t.isJSXSpreadChild(ch)) {
        // Rare; treat like an expression child.
        childExprs.push(t.arrowFunctionExpression([], ch.expression));
      }
    }

    return t.callExpression(t.identifier("h"), [
      tagExpr,
      propsExpr,
      t.arrayExpression(childExprs),
    ]);
  }

  function buildFragmentCall(frag) {
    const childExprs = [];
    for (const ch of frag.children) {
      if (t.isJSXElement(ch)) {
        childExprs.push(buildElementCall(ch));
      } else if (t.isJSXFragment(ch)) {
        childExprs.push(buildFragmentCall(ch));
      } else if (t.isJSXExpressionContainer(ch)) {
        const inner = ch.expression;
        if (t.isJSXEmptyExpression(inner)) continue;
        childExprs.push(t.arrowFunctionExpression([], inner));
      } else if (t.isJSXText(ch)) {
        if (ch.value.trim() === "") continue;
        childExprs.push(t.stringLiteral(ch.value));
      } else if (t.isJSXSpreadChild(ch)) {
        childExprs.push(t.arrowFunctionExpression([], ch.expression));
      }
    }
    return t.callExpression(t.identifier("h"), [
      t.stringLiteral("__fragment"),
      t.objectExpression([]),
      t.arrayExpression(childExprs),
    ]);
  }

  function keyForName(name) {
    // Identifier keys when valid (e.g., "color"); otherwise string keys
    // (e.g., "rotation-y").
    if (/^[A-Za-z_$][\w$]*$/.test(name)) {
      return t.identifier(name);
    }
    return t.stringLiteral(name);
  }

  function jsxMemberToExpr(node) {
    if (t.isJSXIdentifier(node)) return t.identifier(node.name);
    return t.memberExpression(
      jsxMemberToExpr(node.object),
      t.identifier(node.property.name),
    );
  }

  function toString(name) {
    if (t.isJSXIdentifier(name)) return name.name;
    if (t.isJSXNamespacedName(name)) {
      return `${name.namespace.name}:${name.name.name}`;
    }
    if (t.isJSXMemberExpression(name)) {
      return `${toString(name.object)}.${name.property.name}`;
    }
    return "";
  }

  // Detect whether a JSXElement matches a bridge component (e.g., Canvas).
  function isBridgeElement(jsxEl) {
    const opening = jsxEl.openingElement;
    const name = opening.name;
    if (!t.isJSXIdentifier(name)) return false;
    return bridgeComponents.has(name.name);
  }

  return {
    name: "carbon-three-bridge",
    visitor: {
      JSXElement(path) {
        const node = path.node;
        if (!isBridgeElement(node)) return;
        // Don't re-process: if r3fBuild is already present, bail out (idempotency
        // when the plugin runs twice for any reason).
        for (const attr of node.openingElement.attributes) {
          if (
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name) &&
            attr.name.name === "r3fBuild"
          ) {
            return;
          }
        }

        // Skip if there are no JSX children to lift (just whitespace).
        const interesting = node.children.some(
          (ch) =>
            t.isJSXElement(ch) ||
            t.isJSXFragment(ch) ||
            t.isJSXExpressionContainer(ch),
        );
        if (!interesting) return;

        // Build the array of child builder-calls.
        const childCalls = [];
        for (const ch of node.children) {
          if (t.isJSXElement(ch)) {
            childCalls.push(buildElementCall(ch));
          } else if (t.isJSXFragment(ch)) {
            childCalls.push(buildFragmentCall(ch));
          } else if (t.isJSXExpressionContainer(ch)) {
            const inner = ch.expression;
            if (t.isJSXEmptyExpression(inner)) continue;
            childCalls.push(t.arrowFunctionExpression([], inner));
          }
          // JSXText / whitespace dropped.
        }

        // Synthesize the builder fn: `(h) => [ ...childCalls ]`.
        const builderFn = t.arrowFunctionExpression(
          [t.identifier("h")],
          t.arrayExpression(childCalls),
        );

        // Inject as `r3fBuild={(h) => [...]}` onto the Canvas opening tag.
        node.openingElement.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier("r3fBuild"),
            t.jsxExpressionContainer(builderFn),
          ),
        );

        // Strip the original JSX children — Canvas is now driven by r3fBuild.
        node.children = [];
        // Self-close: turn `<Canvas></Canvas>` with empty children into the
        // shorter form, which avoids babel-preset-solid emitting an extra
        // `_$insert(canvas, ...)` for an empty children array.
        if (!node.openingElement.selfClosing) {
          node.openingElement.selfClosing = true;
          node.closingElement = null;
        }

        if (debug) {
          // eslint-disable-next-line no-console
          console.log(
            `[carbon-three-bridge] lifted ${childCalls.length} child(ren) under <${node.openingElement.name.name}>`,
          );
        }
      },
    },
  };
}

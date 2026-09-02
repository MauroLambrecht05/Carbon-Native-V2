# Rendering/platform feature gaps — todo

## Bug fixes (not gaps — things that were flat-out broken)

- [x] SVG `fill`/`stroke` (and `background`/`color`/border-color/outline-color/hover/focus variants) silently failed to parse `rgba()`/`hsl()`/named colors — `scene.rs` had its own hand-rolled, hex-only color parser predating `css_parse.rs`'s fuller one (which box-shadow/gradients/scrollbar-color already used). Reported from a real repro: an icon set using literal `fill="rgba(...)"` rendered completely invisible, isolated through ~10 rebuild/screenshot cycles down to this exact parser split. Apps using ONLY Tailwind-derived colors never hit it — Tailwind's own opacity modifiers (`bg-black/50`) compile to 8-digit hex at build time, never emit `rgba()`. Fixed at the root: `scene.rs`'s local `parse_color` now delegates its string case to `css_parse::parse_color_str` instead of re-implementing hex parsing, so every prop that funneled through it is fixed at once, not just the two SVG call sites. Two new regression tests cover both the SVG and non-SVG paths.

Gap analysis against the web platform, found by inspecting the current
scene/layout/paint engine and stdlib. Recommended sequencing: theming
(cascade/specificity + CSS custom properties) first — several other items
here trace back to not having a real computed-style tree — then interaction
& state, which resolves against that cascade. Everything else is
comparatively independent.

## 1. Visual effects

- [ ] Backdrop blur / blur-behind-content (still needs backing-content sampling — `filter: blur()` below only blurs the node's own subtree, not what's behind it)
- [x] Any filter effect — blur, drop-shadow implemented (`filter: blur(px) drop-shadow(...)`, reuses the existing blur.rs kernel via an offscreen-layer composite, same technique as `opacity`). brightness/contrast/saturate/grayscale/invert/sepia/hue-rotate still unsupported (parsed and silently dropped).
- [x] mix-blend-mode — tiny-skia's `BlendMode` already covers every CSS blend-mode keyword 1:1 (it implements the same W3C Compositing spec modes), so this is a name translation plus a third offscreen-layer group effect (outermost of the three: blend → opacity → filter → real content, so it composites the fully-rendered result against the backdrop).
- [x] Conic gradients — tiny-skia has no native sweep/conic shader (only linear/radial), so this samples the stop list per pixel by hand into a temp pixmap (respecting border-radius via the usual DestinationIn clip), same trade-off box-shadow/clip-path already make for effects tiny-skia doesn't offer directly.
- [x] Multiple/layered backgrounds — `background-image: url(a), url(b), ...` (2+ layers), each with its own `background-size` by index, painted back-to-front (first-listed on top, per CSS). Single-layer values are untouched — still go through the original `background_image` field, so `<img src>` etc. are unaffected.
- [x] outline as a separate property from border — `outline-width`/`outline-color`/`outline-offset`, painted outside the border edge, doesn't affect layout. No `outline-style` (matches border, which has no `border-style` either).
- [x] Corner-shape / superellipse ("squircle") corners — `corner-shape: squircle` (fixed n=4) or `superellipse(<n>)`; n=2 is exactly the existing circular corner (verified by test). Applies everywhere `border_radius` already does (background, border, box-shadow, outline, conic-gradient clip).

## 2. Motion

- [x] CSS transitions — turned out to already exist for the Solid renderer (`solid/scene/transitions.ts`); React had none at all. Ported the same tween system to `react/scene/transitions.ts` and wired it into `react/scene/props.ts`'s inline-style path.
- [x] CSS animations / @keyframes — a second, independent engine alongside `transition` in both renderers' `transitions.ts`: `registerKeyframes(name, frames)` + the `animation` shorthand, multi-stop interpolation (not just from/to), and — since `transition`'s own doc comment explicitly flagged this as missing — real `transform` interpolation (parsed into its function calls, lerped arg-by-arg when both keyframe stops use the same function list). Per-keyframe-stop `animation-timing-function` overrides work too (authored as a regular property inside the keyframe block, matching real CSS syntax), which is what let Tailwind's actual `bounce` curve (not a flattened approximation) ship correctly. Tailwind's four `animate-*` classes (spin/ping/pulse/bounce) are pre-registered and wired. Scope cuts, stated plainly: one animation per node (a comma list picks the last), `animation-fill-mode` always behaves as `forwards`, no `animation-play-state`. Verified against hand-computed cubic-bezier values, not just types — the interpolation math was checked to match by direct calculation, not assumed.
- [x] Built-in easing/spring curves — added a real `cubic-bezier(x1,y1,x2,y2)` solver (Newton-Raphson + bisection fallback) to both renderers' `easeFromName`, and redefined the named keywords (ease/ease-in/ease-out/ease-in-out) as their actual CSS cubic-bezier control points instead of quadratic approximations.

## 3. Interaction & state

- [x] Pseudo-classes, the statically-evaluable ones — `disabled`/`checked` (read straight off the prop, same as any boolean attribute), `first`/`last`/`odd`/`even` (position among `node.parent.children` — correct at initial mount since the whole tree is walked top-down once fully built; NOT re-evaluated for existing siblings if a list changes size after mount, same "evaluated once at insertion" limitation `group-data`/`peer-data` already have), and `peer-checked`/`peer-checked/name`. Also fixed a real bug found along the way: `focus:`/`focus-visible:` were being aliased to `hover:` (a keyboard-tabbed button showed nothing, a moused-over-but-unfocused one incorrectly showed the "focus" style) — now routed through real `background-focus`/`color-focus` Rust props driven by `scene.focused`, with focus taking precedence over hover when both apply. `:active`, `:focus-within`, `group-hover`, `group-focus`, `peer-hover` still need real runtime interaction tracking this engine doesn't do. React only (`class-names.ts` doesn't have a Solid counterpart — Solid's reconciler doesn't resolve Tailwind variants at all, a separate, pre-existing gap between the two renderers).
- [ ] Pseudo-elements — no ::before, ::after, ::placeholder, ::selection
- [ ] Structural/attribute selector cascade — variant matching is a fixed, hardcoded set (data-*, aria-*, group/peer), not general CSS selector matching

## 4. Typography

- [x] text-overflow: ellipsis — truncates to the layout box width with a trailing "…"; forces single-line (mirrored in the Taffy measure callback via `NodeCtx.force_nowrap` so the box doesn't grow tall from wrapping paint won't do).
- [x] white-space control — `normal` (default) / `nowrap` / `pre` (literal `\n` breaks, no word-wrap). `pre-line`/`pre-wrap` aren't modeled (fall back to `normal`).
- [x] text-shadow — reuses blur.rs's Gaussian kernel via the same padded-temp-pixmap technique as box-shadow's blur.
- [x] Font fallback chains — this claim didn't check out either: `text/lib.rs`'s `font_for_char_named` already walks a comma-separated `font-family` chain in CSS order, per glyph, among PLUGIN-LOADED named fonts (`__cm_load_font(path, family)`). The real limit is narrower than "no fallback list": there's no OS font enumeration, so a chain like `"Poppins", sans-serif` only resolves if the app actually loaded a font named "Poppins" — generic/system family names fall through to the embedded Inter/Roboto stack, not a real system font.
- [ ] Rich mixed inline styling within one text run beyond a limited fixed spans array — spans (color/weight/background) now also carry `italic` (see `font-style` below), but still share the parent's font-size/line-height/letter-spacing/font-family; no per-span override for those.
- [x] `font-style: italic`/`oblique` — found while working the item above: the Tailwind `italic`/`not-italic` classes already resolved to a `font-style` prop that NOTHING in the engine read (not set_prop, not paint) — a real, silently-dropped feature, not a hypothetical gap. Implemented as a synthetic oblique shear applied per scanline in the glyph blit (same idea as the existing faux-bold double-draw; there are no real italic font files loaded). Own-value only, doesn't inherit down the tree — same existing limitation `text-align`/`text-decoration` already have.

## 5. Layout

- [x] aspect-ratio — parses `<w>/<h>` / bare number / `auto`, sets taffy's native `Style.aspect_ratio`.
- [x] position: sticky — approximated relative to the element's DIRECT `overflow_y` scrollport parent only (no general positioned-ancestor chain — the same simplification `absolute`/`fixed` already made). `top` inset only (`bottom`/`left`/`right` sticky not implemented). Shared by paint, hit-test, drag-region hit-test, and scroll hit-test via one `Scene::sticky_oy` helper so click targets track where the element is actually pinned on screen. Sticky children also get an implicit z-index floor of 1 so they paint above later siblings that scroll under them.
- [x] Logical properties — `margin-inline-start/end`, `padding-inline-start/end`, `margin/padding-block-start/end`, `inset-inline-start/end`, `inset-block-start/end` (+ shorthands), all aliased to their LTR physical equivalent. This is name-aliasing only, not real bidi: there's no `direction` concept anywhere in the engine, so an RTL app gets the LTR-physical edge, not the mirrored one.
- [ ] CSS Grid subgrid, multi-column layout

## 6. Scrolling

- [x] Scrollbar styling/appearance — `scrollbar-color: <thumb> <track>` and `scrollbar-width: none|thin|auto|<px>`, replacing the previously-hardcoded translucent-white 4px bar.
- [x] Scroll-snap — `scroll-snap-type: mandatory|proximity` + `scroll-snap-align: start|center|end`. Honest caveat: real scroll-snap resolves once a gesture SETTLES (needs a momentum/timer model this engine's flat per-wheel-event `set_scroll_y` doesn't have), so this resolves a snap target on every call instead — `mandatory` always jumps to the nearest snap point (reads as "wheel = advance one item", fine for discrete mouse-wheel notches, stepped rather than fluid for a continuous trackpad drag), `proximity` only jumps within a 48px threshold.
- [x] Momentum/inertia scroll physics — this one DID need the event-loop change I avoided for scroll-snap: `run_loop.rs` gained a `scroll_velocity: HashMap<node_id, f32>` on `State`, set from the wheel event's own delta and decayed 0.90×/frame (floor 0.5px/frame) inside `RedrawRequested`, self-perpetuating via `request_redraw` the same way the existing rAF drain does. Applied through the same `set_scroll_y` path a wheel event uses, so it gets clamping and scroll-snap for free. Windows' wheel/touchpad input carries no OS-simulated momentum tail (unlike macOS), so this was a real, visible gap on this platform. Not runtime-tested interactively (no GUI in this environment) — compiles clean and the decay math checks out (a 20px/frame flick coasts ~35 frames / ~580ms), but the feel (friction constant) is worth eyeballing in a real window.
- [x] Scroll shadows/fade indicators — no prior engine-level trick was actually found in this codebase (the claim above didn't check out); built as a new `scroll-shadow` primitive: auto top/bottom edge fade on a scrollport, blending toward its own `background` color, shown only on the side(s) with more content to reveal.

## 7. Media & content types

- [ ] `<video>` playback
- [ ] `<canvas>` / WebGL
- [ ] PDF rendering
- [ ] Rich text editing (only single-line/basic textarea input exists)
- [ ] Emoji / color-font glyph rendering (confirmed — they render as tofu boxes)
- [x] Icon fonts — already worked: `font_for_char`/rasterize operate on any codepoint fontdue can look up, PUA range included, and the fonts plugin's `loadFont(path, family)` + per-glyph fallback (see above) is exactly the mechanism an icon font (Font Awesome, Nerd Fonts PUA glyphs) needs. No engine change required — this was a documentation gap, not a code one.

## 8. Theming system

- [x] CSS custom properties / var() cascade (the RUNTIME half) — found there's already a build-time half (`theme-extractor.ts` parses `:root {}` from globals.css, the Tailwind resolver bakes the resolved value straight into whatever class used it — no `var()` reference survives into the shipped bundle, so that mechanism can't be reused here; it runs in Node.js build tooling, not inside the app). New `css-vars.ts` per renderer: `style={{"--x": val}}` defines a custom property scoped to the node's subtree (real cascade — nearest-ancestor-that-defines-it wins, via `CmNode.parent` walk, a closer override doesn't leak upward to ancestors), `var(--x[, fallback])` resolves anywhere in a style value. Verified with a real 3-node ancestor chain, not just unit-level parsing — override shadowing, multi-var strings, and nested-paren fallbacks all confirmed correct.
- [ ] Media queries (prefers-color-scheme, prefers-reduced-motion, container queries, viewport queries)
- [ ] Cascade/specificity resolution — every prop set is last-write-wins, no inherited computed-style tree

## 9. Accessibility

- [ ] ARIA role/semantics tree exposed to a screen reader
- [ ] Managed keyboard focus order / focus ring
- [ ] High-contrast / forced-colors mode support

## 10. Windowing / OS chrome

- [ ] Window vibrancy / acrylic / mica compositing (backdrop blur of the desktop, not just in-app content)
- [ ] Native context menus
- [ ] Native OS drag-and-drop of arbitrary data (only whole-window drag-region exists)
- [x] Multi-window support — settled definitively (was "unconfirmed"): NO. `WindowOp` enum (`solutions/contracts/runtime/rust/lib.rs:31-41`, shared by run_loop.rs and blitz.rs) only has `Show/Hide/Minimize/Maximize/Unmaximize/Restore/ToggleMaximize/Close/Focus` — every variant operates on the single existing window. This is a single-window architecture.

---

# 2026-09 deep audit — input, JS runtime, layout/paint, platform integration

Four-agent research pass auditing correctness (not just coverage) against real
browser/React-DOM behavior, prompted by "what makes this harder to build on
than a web React project, and what's actually broken vs just missing."
Everything below is unfixed (research only, no code changed). Grouped by
subsystem; the highest-impact items for an app author coming from React DOM
are marked ⚠️.

## 11. Input & interaction (deeper than §3)

**Pointer events**
- [ ] ⚠️ `onPointerEnter/Leave/Over/Out`/`onMouseEnter/Leave` are registered into `eventHandlers` but never dispatched — Rust's hover tracking (`run_loop.rs:206-277`) only updates paint-hover state and cursor icon, never calls into JS. These React props are silently dead.
- [ ] No real pointer-capture API for React nodes (`setPointerCapture`/`releasePointerCapture` exist only as inert stubs in the separate compat-dom shim, `node.ts:1039-1043`).
- [ ] Only `MouseButton::Left`/`Right` are handled; there's no middle-click arm anywhere in `run_loop.rs` — middle-click produces zero events.
- [ ] `event.button` passed to JS is hardcoded `0` on every dispatch call site regardless of which physical button fired (`run_loop.rs:177,511-512,643`); `event.buttons` is a fake bitmask derived from event type, not real held-button state.
- [ ] `onContextMenu` prop is registered into `eventHandlers` for the React path but nothing reads it — the real native right-click path (`__cm_dispatch_context_menu`) is a separate globalThis hook only wired for the Solid renderer.
- [ ] No `dblclick`/`onDoubleClick` for generic (non-text-input) nodes at all — `EVENT_PROP_TO_DOM` has no entry for it; compiles but never fires. (Double/triple-click *does* work correctly for text-field word/all-select, `run_loop.rs:433-498`.)
- [ ] No element-level HTML5 `draggable`/`dragstart`/`dragover`/`drop`/`DataTransfer` — zero occurrences repo-wide. Distinct from (and not covered by) the whole-window OS file-drop that does exist, and distinct from the window-titlebar drag-region. No way to build reorderable lists/kanban-style DnD.
- [ ] No multi-touch/touch events (expected for a desktop-first engine, `navigator.maxTouchPoints: 0` is honest about it).

**Keyboard**
- [x] `key`/`code`/`keyCode`/`which` are populated with real derivation logic (`keyboard.ts`), including a correct punctuation/charCode disambiguation.
- [ ] `event.repeat` is always `false` — no OS-level key-repeat detection anywhere, so held-key auto-repeat is indistinguishable from a fresh press.
- [ ] ⚠️ **`onKeyDown`/`onKeyUp` props on a specific React element never fire.** They're stored in `eventHandlers` but the only consumer of that map is the pointer dispatcher, which only recognizes down/up/move phases. The *only* live keydown path dispatches on `document.activeElement`, which is the separate compat-dom node graph — React elements never become `activeElement`. A component doing `<input onKeyDown={submitOnEnter}>` never sees it called.
- [ ] No IME composition at all — no `WindowEvent::Ime` arm, no `set_ime_allowed` anywhere. CJK/Pinyin/Japanese/Korean input methods cannot function; a user on a CJK IME cannot type non-Latin text into any Carbon app.
- [ ] Ctrl+Arrow / Ctrl+Shift+Arrow word-jump isn't implemented — `CaretMove` only has Left/Right/Home/End; ctrl is never checked, so it silently degrades to single-char movement instead of word-jump (one of the most-used text-editing shortcuts).

**Text input / forms**
- [x] Cursor/selection/caret model, multi-line textarea caret-from-xy, undo/redo (Ctrl+Z/Shift+Z/Y), and OS-clipboard copy/cut/paste for native Input/Textarea are all real, not stubs.
- [ ] No Clipboard API (`navigator.clipboard` is explicitly `undefined`) and no `copy`/`paste`/`cut` DOM events — clipboard interaction is entirely hardcoded to Ctrl+C/X/V on a focused text field; a component can't implement a "Copy" button or intercept/sanitize a paste.
- [ ] `onChange`'s synthetic event is a bare shim: `stopPropagation`/`stopImmediatePropagation` are no-ops, and `name` is hardcoded to `""` — a shared handler keyed on `e.target.name` (a common React pattern for multi-field forms) gets `""` for every field.
- [ ] No `.select()`/`.setSelectionRange()` programmatic API for React nodes (only inert no-op stubs exist on the compat-dom side).

**Event propagation**
- [x] ⚠️ **No capture/bubble model for the React path — fixed 2026-09-02** for click and pointer down/up (pointer *move* intentionally left single-target — high-frequency, lower stakes for the delegation pattern; a follow-up if it matters). Added `Scene::ancestor_chain(id)` (`scene.rs`) — a root-to-target DFS, since `Node` has no parent pointer — used by `run_loop.rs`'s click/pointer-down/pointer-up dispatch sites to send the whole ancestor chain (deepest-first) instead of a single id. `events.ts`'s `__cm_dispatch_click`/`__cm_dispatch_pointer` now walk that chain calling each ancestor's handler in order, real DOM-shaped `target`/`currentTarget`, and honor a real `stopPropagation()`/`stopImmediatePropagation()` (halts the walk) instead of no-ops. Back-compat: both dispatchers still accept a bare number (used by `ref.current.click()`'s direct in-process call, and Rust's still-single-target pointer-move path).
- [x] `stopPropagation()`/`stopImmediatePropagation()` — now real for click/pointer-down/up (see above); still no-ops on the `onChange` synthetic event (input path untouched).
- [ ] `preventDefault()` is mostly cosmetic: native click/pointerdown/keydown behavior (focus change, caret placement, window-drag) runs unconditionally regardless of what the JS handler returns. The one exception done correctly: wheel/scroll explicitly checks the JS handler's return value before applying native scroll.
- [x] Full, spec-correct capture+bubble+stopPropagation *does* exist — but only in the separate compat-dom shim (`node.ts:594-651`), used by Radix portals/xterm/direct-DOM consumers, not by the primary React node tree. The two rendering paths have materially different propagation semantics, which is itself a real inconsistency.

**Focus**
- [ ] ⚠️ Tab/Shift+Tab only cycles through `Input`/`Textarea` nodes — there is no `tabIndex` concept anywhere (zero hits). A `<button>` or `<div tabIndex={0}>` is **permanently unreachable by keyboard**; a keyboard-only user tabbing through a form with fields and a submit button can never reach the button. Sharper/more severe than the existing doc's "no managed focus order" line suggested. (Still open — `tabIndex` generalization not done.)
- [ ] No focus trap for React-tree content (only works for portal-mounted compat-dom content, e.g. Radix dialogs).
- [x] `ref.current.focus()`/`.blur()`/`.click()`/`.scrollIntoView()` — **fixed 2026-09-02.** Added `__cm_set_focus(id)` (id≤0 blurs) and `__cm_scroll_into_view(id)` host imports (`products/carbon/presentation/host/scene.rs`), backed by a new `Scene::ancestor_chain`/`Scene::scroll_into_view` (`solutions/capabilities/rendering/layout/domain/scene.rs`) since `Node` has no parent pointer. `scrollIntoView` finds the nearest scrollable ancestor and adjusts its scroll offset just enough to bring the target into view (no smooth animation/alignment options — own-value only, matching this engine's existing simplifications). `.click()` calls the existing `__cm_dispatch_click` in-process, no new Rust needed. Wired in `dom-facade.ts`. `.animate()` (WAAPI) is unchanged — still jumps to the end keyframe.

**Accessibility**
- [ ] ⚠️ **Zero OS accessibility bridge in the shipping engine** — no UIA/MSAA/IAccessible2, confirmed by full-repo grep (the only `accesskit` reference is a transitive dependency of the unused experimental `blitz.rs` prototype backend, not wired to anything). Every pixel is opaque to Windows Narrator/NVDA/JAWS — this is total, not partial: no semantic tree, no role/name/state, nothing to build on. A blind/low-vision user cannot use any Carbon app at all.
- [ ] `aria-*`/`data-*` attributes are read only as Tailwind-variant CSS selector hooks (`class-names.ts`) — an `aria-label`/`role="dialog"` never reaches anything outside the renderer; it has zero accessibility meaning.

## 12. React/JS runtime & reconciler

**Reconciler authenticity — better than expected**
- [x] Real npm `react` + real `react-reconciler` (^0.29.0, React 18 shape) — not a hand-rolled diff engine. `react-dom`/`react-dom/client` are aliased to a custom shim (`createRoot`/`hydrateRoot`/`flushSync`/`createPortal`) built on the same reconciler. Bundler explicitly vendors React/reconciler/scheduler once to avoid a "two Reacts" split.
- [ ] Pinned to the React-18 reconciler argument shape (single `onRecoverableError`) — React 19-only APIs (`use()`, `useOptimistic`, Actions/`useFormStatus`) aren't available since the bundled React itself is 18.3.
- [x] All standard hooks (useState/useEffect/useLayoutEffect/useRef/useContext/useMemo/useCallback/useReducer/useImperativeHandle/useTransition/useDeferredValue/useSyncExternalStore/useId) are the real, unmodified React implementation. `createContext`/`useContext` propagation is real, not faked.
- [x] Suspense/Offscreen host hooks (hide/unhide instance) are genuinely implemented, not missing — evidently hit and fixed for real (the code notes React throws mid-commit and blanks the window without them). Error boundaries (`componentDidCatch`) work because that's core reconciler unwind behavior, independent of host config.

**Where it diverges from real semantics**
- [ ] `getCurrentEventPriority()` always returns `DefaultEventPriority` — no lane differentiation ever reaches the scheduler, so `useTransition`'s actual "don't block the UI" benefit doesn't materialize (state still toggles correctly, but nothing is deferred).
- [ ] ⚠️ **"ConcurrentRoot" is a label only — every commit is forced through `flushSync`.** Every Rust→JS dispatcher is wrapped to flush synchronously, and `pump.rs`'s `drain_and_flush_react` force-flushes after every JS-touching Rust op. There is no time-slicing or priority preemption; a slow render still blocks the whole native window's event loop, same as legacy sync mode, just with Concurrent-mode ceremony on top. (Architecturally close to unavoidable given there's no browser "natural event boundary" here — but worth knowing it's not delivering what the label implies.)
- [ ] `createPortal` doesn't portal to an arbitrary target — it always renders at the scene root (single-window architecture, no concept of "outside the scene tree"). Usable for the common popover-escaping-clipping case, but multiple distinct portal targets collapse to one.
- [ ] ⚠️ **`ref.current.focus()`/`.click()`/`.scrollIntoView()` are hard no-ops on React host refs** (see §11 Focus — same finding, cross-referenced since it's a runtime/reconciler-layer issue as much as an input one). `getBoundingClientRect()`/`offsetWidth` etc. *are* real (backed by taffy layout), so refs aren't useless, just missing the imperative-action half.
- [x] Key-based list diffing is real (inherited from react-reconciler's own fiber diff, untouched by the host config) — reordering with stable keys correctly preserves state.

**Error handling & DX — a real weak point**
- [ ] ⚠️ **No dev-mode error overlay of any kind.** Every render-time or event-handler exception funnels to a Rust-side `eprintln!` only. An uncaught error during *initial mount* falls back to a hardcoded placeholder screen reading literally "carbon-mini v2 hardcoded scene (no JS)" — no error text, no stack, nothing pointing at the bug. A post-mount uncaught render error (no boundary) blanks the window per React 18's default unmount-on-error behavior. An app author running the packaged app with no terminal attached gets **zero signal** anything failed — materially worse DX than Vite/CRA/Next's built-in overlays.
- [ ] No source-map support anywhere in the pipeline — any stack trace that *were* surfaced would show mangled bundle line numbers, not original TSX positions.
- [ ] `crypto.getRandomValues`/`randomUUID` are `Math.random()`-based, not cryptographically secure — silently insecure if an app assumes the Web Crypto contract.
- [ ] Node core-module compatibility (`fs`, `path`, `os`, `Buffer`) is absent for app code — only browser/Web-ish APIs are polyfilled (fetch/streams/URL/TextEncoder are real). An npm package assuming Node builtins or `Buffer` at runtime won't work; ecosystem compatibility is narrower than "arbitrary npm packages."
- [ ] `setTimeout`/`requestAnimationFrame` fallback polyfill is frame-driven (via rAF poll loop), not wall-clock — timer resolution is bounded by paint cadence and can stall while the event loop sits idle in `ControlFlow::Wait`.

**Solid.js renderer parity**
- [x] Solid is a real independent renderer (genuine `solid-js/universal` custom renderer, fine-grained signals) — not a shim over React's.
- [ ] ⚠️ Solid's renderer does **not** resolve dynamically-computed Tailwind classes at runtime — the className handler literally stashes a raw runtime class string as a prop and stops (its own comment: "won't visually apply"). Only classes the build-time Babel/Tailwind pass could statically bake to inline styles work. Any conditional `cva()`/`clsx()` output or class string built from a signal silently renders unstyled. React's equivalent path is a full runtime variant resolver — this is a genuine, load-bearing feature gap between the two renderers, confirmed independently (cross-references the existing §3 note).

## 13. Layout & paint correctness (deeper than §1/§4/§5/§6)

**Flex/Grid**
- [x] Min/max-content measure protocol, flex-wrap, align-content/items, justify-*, gap, fr units, minmax(), repeat(), grid auto-flow are all real Taffy-backed, not hand-rolled approximations.
- [ ] `grid-template-areas`/named `grid-area` placement is entirely absent (zero hits) — silently does nothing, falls back to auto-placement.
- [ ] `grid-auto-columns`/`grid-auto-rows` absent — implicit tracks get Taffy's bare default size, not an author-specified size.
- [ ] Because word-splitting is ASCII-whitespace-only (see Text below), min-content for CJK/no-space text equals the entire string width — flex-shrink can never shrink such text below full width; it overflows its container instead of wrapping.

**Stacking, z-index, clipping**
- [ ] ⚠️ z-index is a flat, per-sibling-group paint-order sort, not a real stacking-context tree — a deeply-nested `position:absolute` descendant with a huge z-index can only reorder within its own immediate sibling group, never escape past an ancestor's later siblings, unlike real browsers. Symptom: a tooltip/dropdown nested in an early sibling container still renders under a later sibling panel regardless of z-index.
- [x] `opacity`/`filter`/`mix-blend-mode` each get genuine isolated offscreen-layer compositing — real stacking-context-style isolation for exactly these three.
- [x] ⚠️ **No real clip mask — fixed 2026-09-02.** tiny-skia already supported clip masks; the engine just never used one for this. `overflow:hidden` on a node with `border-radius > 0` now renders that node + subtree into an offscreen layer and multiplies it by a rounded-rect alpha mask (`DestinationIn`, the same technique `paint_conic_background` already used for its own radius clip) before compositing back — a 4th group effect alongside blend/opacity/filter in `painting/lib.rs`'s `paint_node`, in the same style (new `ignore_clip` re-entry flag). The cheap AABB-only path is untouched for the (much more common) square-corner case. Known limitation carried over deliberately: doesn't account for the node's own `transform` — same accepted simplification as hit-testing and text-under-transform elsewhere in this file.
- [ ] `overflow-x` isn't a separate property — only `overflow`/`overflow-y` exist; both axes clip together or neither does.

**Transforms**
- [ ] ⚠️ Transformed elements' text does not rotate/scale with the box — a rotated button's background/border rotate but its text label stays horizontal, visually detached (engine's own comment confirms this is a known limitation, not an oversight).
- [ ] Only translate/rotate(Z)/scale are parsed — skew, matrix/matrix3d, perspective, rotate3d/X/Y all silently drop. No 3D transforms exist.
- [ ] `transform-origin` is unimplemented — pivot is hardcoded to the node's center (matches CSS's default, so only non-default origins are affected).
- [ ] ⚠️ Hit-testing under transform only models translate — clicking a rotated or scaled element hits the **pre-transform axis-aligned box**, not the visible rotated/scaled shape. A `rotate(45deg)` icon button's clickable region stays the original rectangle.

**Images & media**
- [ ] `<img src>` isn't a real `<img>` element — `src` is aliased straight onto `background-image`. Local (non-data:/non-http) files decode via a PNG-only path (`Pixmap::load_png`) even though JPEG/WebP/etc. decoding is compiled in via the `image` crate elsewhere — a local `.jpg` silently fails to load. Only `http(s):` URLs get async, threaded decode; local-file and `data:` decode is synchronous/blocking on the paint call, so a large local image stalls the frame.
- [ ] No `onLoad`/`onError` ever dispatched for images (zero hits) — those handlers never fire regardless of success/failure.
- [ ] No animated GIF/WebP playback — decodes to one static frame.
- [x] `object-fit`-equivalent (`background-size: cover/contain/stretch`) is implemented — better than expected.
- [ ] No `object-position` at all — image alignment within its box isn't configurable.

**Resize / DPI**
- [x] Plain window resize correctly marks dirty, updates size, fires JS listeners, forces full relayout — no stale-layout bug found.
- [ ] No `WindowEvent::ScaleFactorChanged` handler anywhere (only `Resized`). Likely works incidentally on Windows since the two normally pair, but a scale-only change with no accompanying resize would leave text/paint rendering at stale (blurry) resolution — unverified without a live multi-monitor test.

**Text**
- [ ] ⚠️ Word-wrapping is ASCII-whitespace-only (`split_ascii_whitespace`) — no Unicode line-break opportunities, no CJK ideograph-boundary breaking. A paragraph of Chinese/Japanese/Korean text with no ASCII spaces is one giant unbreakable "word": it never wraps and overflows its container horizontally regardless of max-width. Worse than the existing doc's emoji-tofu note implies.
- [ ] No `overflow-wrap`/`word-break` — an overlong single "word" is never broken mid-word, just overflows on its own line.
- [ ] No real text-shaping engine (fontdue is bare metrics/rasterization, no GSUB/GPOS) — no kerning-pair lookup, no ligatures. Text reads visibly looser than a browser for any font with a kern table.
- [ ] ⚠️ **No bidi/RTL at the glyph level at all** — characters are placed strictly in string order, left-to-right. Hebrew/Arabic text renders in logical order left-to-right, i.e. backwards, not just "unmirrored layout." No Arabic contextual joining or Devanagari/Indic reordering either — Arabic renders as disconnected isolated letterforms.
- [x] Font-fallback-by-glyph-coverage and gamma-corrected coverage LUT (approximating DirectWrite/Chromium stem darkening) are genuinely well done.

**Hit-testing**
- [ ] Hover hit-testing on mouse-move reads directly off the last computed layout snapshot without recomputing first — if a prop/content change marked the scene dirty but hasn't repainted yet, a same-tick mouse-move hit-tests against stale coordinates.
- [ ] No `pointer-events` property anywhere — an element styled `pointer-events: none` still fully participates in hit-testing and captures clicks.
- [ ] No `visibility` property tracked in hit-testing (only `display:none`, which Taffy naturally excludes).
- [x] `opacity: 0` remaining hit-testable is correct (matches real browser behavior).

**Mutation performance**
- [ ] ⚠️ Every layout-affecting mutation rebuilds the **entire** Taffy tree from scratch (`TaffyTree::new()` + full recursive rebuild) — no incremental/dirty-subtree update. A single prop change anywhere forces an O(n) full-tree rebuild + full layout pass. A fast path exists only for the pure no-op (unchanged-size) case.
- [x] Scroll is deliberately forced to full repaint rather than damage-rect optimization — an explicit, documented, self-aware correctness-over-perf trade (a scoped-damage path previously left visible streaks on transformed children).

## 14. Platform / OS / networking integration

- [ ] ⚠️ **The `image` runtime feature silently never activates through documented config.** `[runtime] image = true` in carbon.toml compiles the feature in, but the actual runtime gate additionally requires `CARBON_IMAGE_PATHS`/`CARBON_IMAGE=1` env vars that nothing in the CLI ever sets (unlike `audio`, which has a carbon.toml-text fallback). Non-PNG/remote images silently never load, no error, no warning — undiscoverable without reading Rust source.
- [x] fetch (streaming response bodies) and WebSocket (binary frames, full open/message/close/error lifecycle) are both real and reasonably complete.
- [ ] No `AbortController`/`AbortSignal`, no `EventSource`/SSE, no cookie/credentials concept found anywhere.
- [ ] ⚠️ No localStorage/sessionStorage/IndexedDB/cookie-equivalent persistence API anywhere — an app needing to persist anything has to hand-roll file I/O.
- [x] carbon-sdk plugins spot-checked (keychain, tray) are real, not stubs; auto-updater (`updater_bg.rs`) is genuinely complete — manifest fetch, signature verification, stop-list/yank rollback, per-platform targeting.
- [ ] Terminal/PTY plugin is Windows-ConPTY-only — no Unix/macOS/Linux backend exists at all despite the plugin directory suggesting general availability.
- [x] Multi-window: settled definitively as NO (moved to §10 above).
- [ ] Context menu dispatch is not a real native OS menu — `__cm_dispatch_context_menu` only forwards hit-test + coordinates to JS; the app must render its own in-scene popup with no native theming, no free keyboard nav, and it can't escape the window bounds.
- [ ] No native drag-*out* of the app (export a list item to the OS file explorer, etc.) — only inbound file-drop exists.
- [ ] ⚠️ Weak evidence of real cross-platform support: only 3 files in the engine contain any `#[cfg(target_os)]` gate at all. Combined with Windows-only PTY and Windows-specific momentum-scroll compensation (§6), this reads as developed/tested primarily on Windows — macOS/Linux app authors should expect to hit untested paint/input code paths.

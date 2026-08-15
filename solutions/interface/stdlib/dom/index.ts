// @carbon/compat-dom — Tier 1+2 DOM compatibility for carbon-mini.
//
// Side-effect-free re-exports plus an explicit install() helper. Most users
// import "@carbon/compat-dom/install" (which has the side effect) at the top
// of their entry bundle; the build pipeline does this automatically for the
// React preset.
//
// Scope:
//   ✓ Document, Element, Text, Comment, DocumentFragment
//   ✓ appendChild / insertBefore / removeChild / replaceChild
//   ✓ setAttribute / getAttribute / removeAttribute / classList
//   ✓ style.* via Proxy
//   ✓ textContent / innerHTML (write — text-only)
//   ✓ Event / MouseEvent / KeyboardEvent + capture/bubble dispatch
//   ✓ querySelector / querySelectorAll (tag, .class, #id, *)
//   ✓ window, navigator, location, history (stubs)
//   ✓ requestAnimationFrame, requestIdleCallback (setTimeout-backed)
//
// Out of scope (the documented limits — see README):
//   ✗ Real layout reads (getBoundingClientRect returns zeros)
//   ✗ Computed style cascade
//   ✗ MutationObserver, IntersectionObserver, ResizeObserver
//   ✗ Selection / Range / IME
//   ✗ Form element behavior (input value, focus, IME)
//   ✗ History API / pushState navigation
//   ✗ fetch / XMLHttpRequest (use carbon-mini host imports instead)
//   ✗ Combinator / pseudo-class CSS selectors

export {
  CarbonNode,
  CarbonElement,
  CarbonText,
  CarbonComment,
  CarbonDocument,
  CarbonDocumentFragment,
  CarbonDOMTokenList,
  CarbonEvent,
  CarbonMouseEvent,
  CarbonKeyboardEvent,
  ELEMENT_NODE,
  TEXT_NODE,
  COMMENT_NODE,
  DOCUMENT_NODE,
  DOCUMENT_FRAGMENT_NODE,
} from "./shims/node.ts";

// To install the DOM globals, side-effect-import the dedicated entry:
//
//   import "@carbon/compat-dom/install";
//
// We don't expose a callable install() here because static side-effect
// imports compose better with Bun's bundler than a function-call form
// would (every entry point would need to remember to call install()
// before any other module-init code that touches globals).

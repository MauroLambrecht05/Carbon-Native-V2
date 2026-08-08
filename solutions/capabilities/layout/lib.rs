// The layout engine: scene graph + Taffy integration, plus the CSS-string
// value parsers that feed node properties (gradients, transforms,
// box-shadow, clip-path). css_parse lives here rather than in the paint
// crate because scene.rs calls it directly to populate node properties
// during scene construction, and css_parse.rs reads scene's types back —
// they're mutually coupled and must be one crate. Paint (canvas2d, svg)
// depends on this crate for both the scene graph and CSS parsing.
// scene.rs's node-measurement code calls `crate::text::TextEngine` — alias
// so that keeps resolving now that text lives in its own crate.
pub use carbon_text_renderer as text;
// ── Layout ──────────────────────────────────────────────────────────────────
// Everything here is domain. There is no infrastructure to separate out: this
// crate computes, and Taffy is a library it computes with, not an outside
// system it talks to.
//
// scene.rs and css_parse.rs stay in one crate — and one layer — because they
// are mutually recursive, as the note above says: scene calls css_parse while
// building nodes, and css_parse reads scene's types back. A boundary between
// them would be a cycle across it.
//
// `#[path]` keeps the module names, so `carbon_layout::scene::Scene` still
// resolves for every downstream crate.
#[path = "domain/scene.rs"]
pub mod scene;
#[path = "domain/css_parse.rs"]
pub mod css_parse;

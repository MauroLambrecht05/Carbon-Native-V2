// Translating the renderer's JSON prop values into CSS stylo can parse.
//
// blitz is a real CSS engine, so props arrive as JavaScript values and have to
// become declarations: camelCase to kebab-case, unitless properties left bare,
// everything else suffixed with px. `is_unsupported_style` filters the props
// mini accepts that stylo has no equivalent for.

use super::*;

/// Tags that are SVG elements (unambiguous subset — excludes text/title/a which
/// also exist in HTML). Their props route to attributes, not styles.
pub(crate) fn is_svg_tag(tag: &str) -> bool {
    matches!(
        tag,
        "svg"
            | "path"
            | "circle"
            | "rect"
            | "line"
            | "polyline"
            | "polygon"
            | "ellipse"
            | "g"
            | "defs"
            | "use"
            | "symbol"
            | "clipPath"
            | "mask"
            | "pattern"
            | "linearGradient"
            | "radialGradient"
            | "stop"
            | "tspan"
            | "foreignObject"
            | "marker"
            | "filter"
    )
}

/// Register an author stylesheet: create a `<style>` node holding the CSS and
/// let stylo parse + cascade it. Used by the `__cm_register_stylesheet` host
/// import AND to auto-load a compiled `app.css` next to the bundle.
pub(crate) fn register_css(css: &str) {
    with_doc(|st| {
        let body = st.body_id;
        let style_id = {
            let mut m = st.doc.mutate();
            let s = m.create_element(html_qual("style"), Vec::<Attribute>::new());
            let t = m.create_text_node(css);
            m.append_children(s, &[t]);
            // Attach the <style> to the tree (UA gives it display:none). An
            // ORPHAN style node never gets a primary style, but the
            // stylesheet-add invalidation still walks to it → stylo panics in
            // is_display_none. Being in the tree, it's styled like any element.
            m.append_children(body, &[s]);
            m.flush();
            s
        };
        st.doc.upsert_stylesheet_for_node(style_id);
        st.dirty = true;
    });
}

/// Build a QualName for an HTML-namespaced element/attribute from a runtime tag.
pub(crate) fn html_qual(name: &str) -> QualName {
    QualName::new(None, ns!(html), LocalName::from(name))
}

/// Attribute keys that are real HTML attributes (routed to `set_attribute`),
/// vs. everything else which is treated as an inline style property. This is
/// the same split a browser makes between `el.setAttribute` and `el.style.*`.
pub(crate) fn is_attribute_key(key: &str) -> bool {
    matches!(
        key,
        "id" | "role"
            | "href"
            | "src"
            | "alt"
            | "type"
            | "value"
            | "name"
            | "title"
            | "placeholder"
            | "tabindex"
            | "for"
            | "checked"
            | "disabled"
            | "selected"
            | "readonly"
            | "multiple"
            | "hidden"
            | "contenteditable"
            | "dir"
            | "lang"
            | "spellcheck"
            | "autocapitalize"
            | "autocorrect"
            | "autocomplete"
            | "autofocus"
            | "inputmode"
            | "enterkeyhint"
            | "maxlength"
            | "minlength"
            | "rows"
            | "cols"
            | "wrap"
            | "accept"
            | "download"
            | "target"
            | "rel"
            | "draggable"
            | "translate"
    ) || key.starts_with("data-")
        || key.starts_with("aria-")
}

/// carbon sends every prop value as `JSON.stringify(value)`. Unwrap it back to
/// the raw string: `"\"foo\""` → `foo`, `"12"` → `12`. Used for attributes.
pub(crate) fn json_to_value(raw: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(serde_json::Value::Number(n)) => n.to_string(),
        Ok(serde_json::Value::Bool(b)) => b.to_string(),
        Ok(serde_json::Value::Null) => String::new(),
        Ok(v) => v.to_string(),
        Err(_) => raw.to_string(),
    }
}

/// react-mini-runtime emits style keys in React's shape — camelCase
/// (`fontSize`, `borderRadius`). stylo needs kebab-case CSS names.
pub(crate) fn camel_to_kebab(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Style properties blitz/stylo doesn't implement, or mini-scene-only props
/// that aren't CSS. Filtered BEFORE `set_style_property` so blitz-dom doesn't
/// `eprintln!("Warning: unsupported property …")` per node (thousands of lines
/// on terax) — and so we skip the wasted parse. None of these affect layout
/// or paint in the Blitz engine today.
pub(crate) fn is_unsupported_style(prop: &str) -> bool {
    // mini-scene state props: background-hover, color-hover, outline-hover, …
    prop.ends_with("-hover")
        || matches!(
            prop,
            "clickable"
                | "user-select"
                | "-webkit-user-select"
                | "-moz-user-select"
                | "-ms-user-select"
                | "touch-action"
                | "font-kerning"
                | "tab-index"
                | "-webkit-font-smoothing"
                | "-moz-osx-font-smoothing"
                | "appearance"
                | "-webkit-appearance"
                | "-webkit-tap-highlight-color"
                | "text-size-adjust"
                | "-webkit-text-size-adjust"
                | "scrollbar-width"
                | "scrollbar-color"
                | "overscroll-behavior"
                | "resize"
                | "-webkit-overflow-scrolling"
                | "-webkit-line-clamp"
                | "-webkit-box-orient"
                | "-webkit-background-clip"
                | "text-rendering"
                | "content-visibility"
                | "contain-intrinsic-size"
                | "will-change"
                | "-webkit-touch-callout"
                | "-webkit-user-drag"
                | "-webkit-app-region"
                | "print-color-adjust"
                | "-webkit-print-color-adjust"
                | "color-adjust"
        )
}

/// CSS properties whose numeric values are unitless (no `px`).
pub(crate) fn is_unitless(prop: &str) -> bool {
    matches!(
        prop,
        "opacity"
            | "z-index"
            | "font-weight"
            | "flex-grow"
            | "flex-shrink"
            | "order"
            | "line-height"
            | "flex"
            | "zoom"
            | "tab-size"
            | "flex-basis"
    )
}

/// Convert a JSON'd style value to a CSS value for property `prop`. React sends
/// bare numbers for lengths (`padding: 16`); CSS needs `16px` (0 stays `0`).
/// Unitless props keep the bare number. Strings pass through.
pub(crate) fn json_to_css_value(raw: &str, prop: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(serde_json::Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(0.0);
            if f == 0.0 || is_unitless(prop) {
                n.to_string()
            } else {
                format!("{n}px")
            }
        }
        Ok(serde_json::Value::Bool(b)) => b.to_string(),
        Ok(serde_json::Value::Null) => String::new(),
        Ok(v) => v.to_string(),
        Err(_) => raw.to_string(),
    }
}

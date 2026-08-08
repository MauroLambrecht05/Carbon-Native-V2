// The DOM blitz renders.
//
// Where mini keeps a scene graph, blitz builds an actual document and hands it
// to stylo and taffy. These are the same seven scene-graph host functions mini
// implements — create/set_text/set_prop/insert/remove/set_root — against a
// different model, which is the whole point of having two backends: the
// boundary in contracts/runtime is what they share.

use super::*;

// The document, one per thread. blitz builds a real DOM rather than a scene
// graph, and every scene-graph host function below mutates it.
thread_local! {
    pub(crate) static DOC: RefCell<Option<DocState>> = const { RefCell::new(None) };
}

pub(crate) struct DocState {
    pub(crate) doc: BaseDocument,
    /// carbon JS node id → blitz slab node id. carbon ids come from the
    /// shared allocator (`globalThis.__cm_node_id_seq`); Blitz assigns its own.
    pub(crate) id_map: HashMap<i64, usize>,
    /// Reverse: blitz element id → carbon id, for mapping a hit-tested node
    /// back to the carbon node the JS reconciler dispatches events to.
    pub(crate) rev_map: HashMap<usize, i64>,
    /// The `<body>` node the carbon root gets attached under on `__cm_set_root`.
    pub(crate) body_id: usize,
    /// carbon "text" node id → its child blitz text node. carbon `<text>` nodes
    /// are STYLED leaves (react-mini-runtime sets font/color on them + text
    /// content), so we model each as a span element wrapping a text node: the
    /// span (in `id_map`) carries styles + tree position, the child text node
    /// (here) receives `set_text`.
    pub(crate) text_child: HashMap<i64, usize>,
    /// carbon ids that are SVG elements (svg/path/circle/…). Their props are
    /// SVG presentation ATTRIBUTES (d, fill, viewBox…), not CSS — blitz renders
    /// the `<svg>` by serializing its outer_html through usvg, so the attributes
    /// must be set verbatim (original casing, no px).
    pub(crate) svg_nodes: HashSet<i64>,
    /// Set on any mutation; the event loop repaints when true.
    pub(crate) dirty: bool,
}

pub(crate) fn with_doc<F: FnOnce(&mut DocState)>(f: F) {
    DOC.with(|d| {
        if let Some(st) = d.borrow_mut().as_mut() {
            f(st);
        }
    });
}

pub(crate) fn cm_create_node(id: i64, tag: &str) {
    with_doc(|st| {
        let (blitz_id, text_child) = {
            let mut m = st.doc.mutate();
            let r = if tag == "text" {
                // Styled text leaf → span element wrapping a text node.
                let el = m.create_element(html_qual("span"), Vec::<Attribute>::new());
                let tx = m.create_text_node("");
                m.append_children(el, &[tx]);
                (el, Some(tx))
            } else {
                (m.create_element(html_qual(tag), Vec::<Attribute>::new()), None)
            };
            m.flush();
            r
        };
        st.id_map.insert(id, blitz_id);
        st.rev_map.insert(blitz_id, id);
        if is_svg_tag(tag) {
            st.svg_nodes.insert(id);
        }
        if let Some(tx) = text_child {
            st.text_child.insert(id, tx);
        }
        st.dirty = true;
    });
}

pub(crate) fn cm_set_text(id: i64, text: &str) {
    with_doc(|st| {
        // "text" nodes route to their child text node; anything else directly.
        let target = st.text_child.get(&id).copied().or_else(|| st.id_map.get(&id).copied());
        if let Some(bid) = target {
            let mut m = st.doc.mutate();
            m.set_node_text(bid, text);
            m.flush();
            st.dirty = true;
        }
    });
}

/// Set an attribute on a node, choosing the right stylo path.
///
/// blitz's `DocumentMutator::set_attribute` always takes a stylo SNAPSHOT and
/// sets a `restyle_subtree` invalidation hint — correct for updating an
/// already-styled element. But react-mini-runtime sets `className` on FRESH,
/// never-styled nodes; a snapshot on such a node makes stylo's next resolve
/// walk an unstyled subtree in `is_display_none` and panic (data.rs:190).
/// HTML parsing avoids this by writing attributes at construction (no
/// snapshot). We mirror that: for an unstyled node (no primary style yet),
/// write the attribute straight to `ElementData` — its initial `ALL_DAMAGE`
/// (from create_element) styles it cleanly. Only styled nodes take the
/// snapshot/invalidation path.
pub(crate) fn set_attr(st: &mut DocState, bid: usize, name: QualName, value: &str) {
    let styled = st
        .doc
        .get_node(bid)
        .map(|n| n.primary_styles().is_some())
        .unwrap_or(false);
    if styled {
        let mut m = st.doc.mutate();
        m.set_attribute(bid, name, value);
        m.flush();
    } else if let Some(node) = st.doc.get_node_mut(bid) {
        if let blitz_dom::NodeData::Element(ref mut el) = node.data {
            el.attrs.set(name, value);
        }
    }
    st.dirty = true;
}

pub(crate) fn cm_set_prop(id: i64, key: &str, value_json: &str) {
    with_doc(|st| {
        let Some(&bid) = st.id_map.get(&id) else { return };
        // SVG elements: every prop is a presentation ATTRIBUTE (d, fill, stroke,
        // viewBox, width…), set verbatim (original casing, no px) so blitz's
        // outer_html→usvg path parses + renders the icon. className stays too.
        if st.svg_nodes.contains(&id) {
            let val = json_to_value(value_json);
            let name = if key == "className" || key == "class" { "class" } else { key };
            set_attr(st, bid, html_qual(name), &val);
            return;
        }
        // set_attribute / set_style_property panic on non-element nodes; guard.
        // (With text→span, every mapped node is an element — this is a safety net.)
        if st.doc.get_node(bid).map(|n| n.element_data().is_none()).unwrap_or(true) {
            return;
        }

        // class → real class attribute so stylo can cascade registered CSS.
        if key == "className" || key == "class" {
            let val = json_to_value(value_json);
            set_attr(st, bid, html_qual("class"), &val);
            return;
        }
        if is_attribute_key(key) {
            let val = json_to_value(value_json);
            set_attr(st, bid, html_qual(key), &val);
            return;
        }

        // Inline style property. Normalize react-mini-runtime's shape → CSS:
        // camelCase → kebab, bare numbers → px. `clickable` (a mini-scene marker
        // for hit-testing, not CSS) is dropped — events land in M4.
        let css_key = camel_to_kebab(key);
        if is_unsupported_style(&css_key) {
            return;
        }
        let val = json_to_css_value(value_json, &css_key);
        if val.is_empty() {
            return;
        }
        let mut m = st.doc.mutate();
        m.set_style_property(bid, &css_key, &val);
        m.flush();
        st.dirty = true;
    });
}

pub(crate) fn cm_insert_node(parent: i64, child: i64, before: i64) {
    with_doc(|st| {
        let (Some(&pb), Some(&cb)) = (st.id_map.get(&parent), st.id_map.get(&child)) else {
            return;
        };
        let mut m = st.doc.mutate();
        if before < 0 {
            m.append_children(pb, &[cb]);
        } else if let Some(&bb) = st.id_map.get(&before) {
            m.insert_nodes_before(bb, &[cb]);
        } else {
            m.append_children(pb, &[cb]);
        }
        m.flush();
        st.dirty = true;
    });
}

pub(crate) fn cm_remove_node(id: i64) {
    with_doc(|st| {
        if let Some(&bid) = st.id_map.get(&id) {
            let mut m = st.doc.mutate();
            m.remove_node(bid);
            m.flush();
            st.id_map.remove(&id);
            st.rev_map.remove(&bid);
            st.text_child.remove(&id);
            st.svg_nodes.remove(&id);
            st.dirty = true;
        }
    });
}

/// Attach the carbon scene root under the document `<body>`.
pub(crate) fn cm_set_root(id: i64) {
    with_doc(|st| {
        if let Some(&bid) = st.id_map.get(&id) {
            let body = st.body_id;
            let mut m = st.doc.mutate();
            m.append_children(body, &[bid]);
            m.flush();
            st.dirty = true;
        }
    });
}

// ─── JS host wiring ──────────────────────────────────────────────────────────


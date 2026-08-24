// Scene graph behavior — the second piece of coverage this crate has ever
// had, after css_parse. scene.rs is 3,200+ lines of tree mutation, hit
// testing, scroll/damage bookkeeping and a small text-input editor, all
// sitting behind `Scene`, a plain struct over `HashMap<u32, Node>` plus a
// Taffy tree. None of that needs a window, a device, or even the font
// engine — geometry here is supplied directly by constructing `taffy::Layout`
// values by hand instead of running a real layout pass, the same "no window,
// device or scene" bias css_parse's tests already established, extended one
// layer further: no font engine either.
//
// Deliberately out of scope: `compute_layout`, `editor_visual_lines`,
// `input_caret_from_xy` and `input_move_caret_vertical` all take a
// `&mut TextEngine` and measure real glyphs — that is font-rendering
// integration, not scene-graph logic, and belongs with carbon-text-renderer's
// own tests rather than faked out here.
//
// The bias, same as css_parse: what an app author's JS bridge actually sends
// through `set_prop`/`create_node`, and what the tree/input-editing code
// actually gets wrong at the edges — UTF-8 character boundaries, selection
// ordering, reparenting instead of duplicating, mutual exclusivity between
// gradient and solid background, "no computed layout yet" — not trivial
// field getters.

use carbon_layout::scene::*;

fn layout(x: f32, y: f32, w: f32, h: f32) -> taffy::Layout {
    taffy::Layout {
        location: taffy::Point { x, y },
        size: taffy::Size {
            width: w,
            height: h,
        },
        ..Default::default()
    }
}

fn len_px(l: Option<Len>) -> Option<f32> {
    match l {
        Some(Len::Length(px)) => Some(px),
        _ => None,
    }
}

fn make_input(scene: &mut Scene, id: u32, text: &str) {
    scene.create_node(id, "input", PaintProps::default());
    scene.set_text(id, text.to_string());
}

// ── Scene lifecycle ─────────────────────────────────────────────────────────

#[test]
fn scene_new_starts_empty_and_dirty() {
    let scene = Scene::new();
    assert!(scene.nodes.is_empty());
    assert_eq!(scene.root, 0);
    assert!(scene.dirty);
    assert!(!scene.layout_valid);
    assert_eq!(scene.hovered, None);
    assert_eq!(scene.focused, None);
    assert_eq!(scene.last_layout_size, None);
    assert_eq!(scene.dirty_rect, None);
}

#[test]
fn create_node_maps_tag_names_to_node_kinds() {
    let mut scene = Scene::new();
    let cases: &[(&str, fn(&NodeKind) -> bool)] = &[
        ("text", |k| matches!(k, NodeKind::Text)),
        ("button", |k| matches!(k, NodeKind::Button)),
        ("canvas", |k| matches!(k, NodeKind::Canvas)),
        ("svg", |k| matches!(k, NodeKind::Svg)),
        ("path", |k| matches!(k, NodeKind::SvgPath)),
        ("line", |k| matches!(k, NodeKind::SvgLine)),
        ("circle", |k| matches!(k, NodeKind::SvgCircle)),
        ("rect", |k| matches!(k, NodeKind::SvgRect)),
        ("polyline", |k| matches!(k, NodeKind::SvgPolyline)),
        ("polygon", |k| matches!(k, NodeKind::SvgPolygon)),
        ("input", |k| matches!(k, NodeKind::Input)),
        ("textarea", |k| matches!(k, NodeKind::Textarea)),
        ("div", |k| matches!(k, NodeKind::View)), // unrecognized tag -> View
    ];
    for (i, (tag, check)) in cases.iter().enumerate() {
        let id = i as u32 + 1;
        scene.create_node(id, tag, PaintProps::default());
        let kind = &scene.nodes.get(&id).unwrap().kind;
        assert!(
            check(kind),
            "tag {tag:?} mapped to unexpected kind {kind:?}"
        );
    }
}

#[test]
fn create_node_defaults_clickable_and_cursor_for_interactive_kinds() {
    let mut scene = Scene::new();
    scene.create_node(1, "button", PaintProps::default());
    assert!(scene.nodes.get(&1).unwrap().props.clickable);

    scene.create_node(2, "input", PaintProps::default());
    assert!(scene.nodes.get(&2).unwrap().props.clickable);
    assert_eq!(
        scene.nodes.get(&2).unwrap().props.cursor.as_deref(),
        Some("text")
    );

    scene.create_node(3, "view", PaintProps::default());
    assert!(!scene.nodes.get(&3).unwrap().props.clickable);
    assert_eq!(scene.nodes.get(&3).unwrap().props.cursor, None);
}

#[test]
fn create_node_does_not_override_an_explicit_cursor_on_an_input() {
    // The default only fills in when the caller left cursor unset — an app
    // that explicitly wants a pointer cursor on its <input> keeps it.
    let mut scene = Scene::new();
    let props = PaintProps {
        cursor: Some("pointer".to_string()),
        ..Default::default()
    };
    scene.create_node(1, "input", props);
    assert_eq!(
        scene.nodes.get(&1).unwrap().props.cursor.as_deref(),
        Some("pointer")
    );
}

#[test]
fn set_text_updates_props_and_marks_dirty() {
    let mut scene = Scene::new();
    scene.create_node(1, "text", PaintProps::default());
    scene.layout_valid = true; // pretend a layout just ran
    scene.set_text(1, "hello".to_string());
    assert_eq!(
        scene.nodes.get(&1).unwrap().props.text.as_deref(),
        Some("hello")
    );
    assert!(scene.dirty);
    assert!(!scene.layout_valid);
}

#[test]
fn set_text_on_a_missing_node_is_a_no_op() {
    let mut scene = Scene::new();
    scene.layout_valid = true;
    scene.dirty = false;
    scene.set_text(999, "hi".to_string());
    assert!(!scene.dirty);
    assert!(scene.layout_valid);
}

#[test]
fn reset_paint_props_preserves_text_and_restores_input_defaults() {
    let mut scene = Scene::new();
    scene.create_node(1, "input", PaintProps::default());
    scene.set_text(1, "typed value".to_string());
    {
        let n = scene.nodes.get_mut(&1).unwrap();
        n.props.background = Some(0xFFFF0000);
        n.props.clickable = false; // simulate a stale style clobbering it
        n.props.cursor = None;
    }
    scene.reset_paint_props(1);
    let n = scene.nodes.get(&1).unwrap();
    assert_eq!(n.props.text.as_deref(), Some("typed value"));
    assert_eq!(n.props.background, None);
    assert!(n.props.clickable);
    assert_eq!(n.props.cursor.as_deref(), Some("text"));
}

#[test]
fn reset_paint_props_keeps_buttons_clickable() {
    let mut scene = Scene::new();
    scene.create_node(1, "button", PaintProps::default());
    scene.nodes.get_mut(&1).unwrap().props.clickable = false;
    scene.reset_paint_props(1);
    assert!(scene.nodes.get(&1).unwrap().props.clickable);
}

// ── Tree mutation ────────────────────────────────────────────────────────────

#[test]
fn insert_node_appends_when_no_before_is_given() {
    let mut scene = Scene::new();
    for id in 1..=3 {
        scene.create_node(id, "view", PaintProps::default());
    }
    scene.insert_node(1, 2, None);
    scene.insert_node(1, 3, None);
    assert_eq!(scene.nodes.get(&1).unwrap().children, vec![2, 3]);
}

#[test]
fn insert_node_inserts_before_a_given_sibling() {
    let mut scene = Scene::new();
    for id in 1..=4 {
        scene.create_node(id, "view", PaintProps::default());
    }
    scene.insert_node(1, 2, None);
    scene.insert_node(1, 3, None);
    scene.insert_node(1, 4, Some(3));
    assert_eq!(scene.nodes.get(&1).unwrap().children, vec![2, 4, 3]);
}

#[test]
fn insert_node_with_an_unknown_before_id_falls_back_to_append() {
    let mut scene = Scene::new();
    for id in 1..=3 {
        scene.create_node(id, "view", PaintProps::default());
    }
    scene.insert_node(1, 2, None);
    scene.insert_node(1, 3, Some(999));
    assert_eq!(scene.nodes.get(&1).unwrap().children, vec![2, 3]);
}

#[test]
fn insert_node_moves_an_already_attached_child_rather_than_duplicating_it() {
    // DOM appendChild/insertBefore semantics: re-inserting an attached node
    // MOVES it. A node dragged between two parent folders in a file
    // explorer should end up listed once, under the new parent only.
    let mut scene = Scene::new();
    for id in 1..=3 {
        scene.create_node(id, "view", PaintProps::default());
    }
    scene.insert_node(1, 3, None);
    assert_eq!(scene.nodes.get(&1).unwrap().children, vec![3]);

    scene.insert_node(2, 3, None);
    assert!(scene.nodes.get(&1).unwrap().children.is_empty());
    assert_eq!(scene.nodes.get(&2).unwrap().children, vec![3]);
}

#[test]
fn remove_node_detaches_from_its_parent_and_clears_interaction_state() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "input", PaintProps::default());
    scene.insert_node(1, 2, None);
    scene.focused = Some(2);
    scene.hovered = Some(2);
    scene.input_state_mut(2).caret = 3;

    scene.remove_node(2);

    assert!(!scene.nodes.contains_key(&2));
    assert!(scene.nodes.get(&1).unwrap().children.is_empty());
    assert_eq!(scene.focused, None);
    assert_eq!(scene.hovered, None);
    assert!(scene.input_state(2).is_none());
}

#[test]
fn set_root_updates_root_and_marks_dirty() {
    let mut scene = Scene::new();
    scene.layout_valid = true;
    scene.set_root(7);
    assert_eq!(scene.root, 7);
    assert!(scene.dirty);
    assert!(!scene.layout_valid);
}

#[test]
fn mutating_operations_on_an_unknown_id_are_no_ops_not_panics() {
    let mut scene = Scene::new();
    scene.remove_node(42);
    scene.insert_node(1, 2, None); // neither parent nor child exists
    scene.set_text(42, "x".to_string());
    scene.input_move_caret(42, CaretMove::Left, false);
    scene.input_select_all(42);
    scene.input_select_word(42, 0);
    scene.input_set_caret(42, 0, false);
    assert!(scene.input_insert_str(42, "x").is_none());
    assert!(scene.input_backspace(42).is_none());
    assert!(scene.input_delete(42).is_none());
    assert!(scene.input_undo(42).is_none());
    assert!(scene.input_redo(42).is_none());
    assert_eq!(scene.input_selected_text(42), "");
}

// ── Damage tracking ──────────────────────────────────────────────────────────

#[test]
fn add_damage_grows_from_none_and_unions_overlapping_rects() {
    let mut scene = Scene::new();
    assert_eq!(scene.dirty_rect, None);
    scene.add_damage(10.0, 10.0, 20.0, 20.0); // (10,10)-(30,30)
    assert_eq!(scene.dirty_rect, Some((10.0, 10.0, 20.0, 20.0)));
    scene.add_damage(20.0, 5.0, 20.0, 10.0); // (20,5)-(40,15)
                                             // Bounding box of both rects: (10,5)-(40,30).
    assert_eq!(scene.dirty_rect, Some((10.0, 5.0, 30.0, 25.0)));
}

#[test]
fn add_damage_ignores_empty_or_negative_rects() {
    let mut scene = Scene::new();
    scene.add_damage(1.0, 1.0, 0.0, 5.0);
    scene.add_damage(1.0, 1.0, 5.0, -1.0);
    assert_eq!(scene.dirty_rect, None);
}

// ── Focus traversal ──────────────────────────────────────────────────────────

#[test]
fn focusable_inputs_returns_input_and_textarea_ids_in_dom_order() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "input", PaintProps::default());
    scene.create_node(3, "view", PaintProps::default());
    scene.create_node(4, "textarea", PaintProps::default());
    scene.create_node(5, "input", PaintProps::default());
    scene.create_node(6, "button", PaintProps::default()); // not focusable

    scene.insert_node(1, 2, None);
    scene.insert_node(1, 3, None);
    scene.insert_node(3, 4, None);
    scene.insert_node(3, 5, None);
    scene.insert_node(1, 6, None);
    scene.set_root(1);

    assert_eq!(scene.focusable_inputs(), vec![2, 4, 5]);
}

// ── Geometry: absolute_box, content_height, scroll ──────────────────────────

#[test]
fn absolute_box_sums_every_ancestors_location() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "view", PaintProps::default());
    scene.create_node(3, "text", PaintProps::default());
    scene.insert_node(1, 2, None);
    scene.insert_node(2, 3, None);
    scene.set_root(1);

    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(layout(10.0, 10.0, 300.0, 300.0));
    scene.nodes.get_mut(&2).unwrap().computed_layout = Some(layout(20.0, 30.0, 200.0, 200.0));
    scene.nodes.get_mut(&3).unwrap().computed_layout = Some(layout(5.0, 5.0, 50.0, 20.0));

    // root(10,10) + mid(20,30) + leaf(5,5) = (35, 45).
    assert_eq!(scene.absolute_box(3), Some((35.0, 45.0, 50.0, 20.0)));
}

#[test]
fn absolute_box_is_none_without_a_computed_layout() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_root(1);
    assert_eq!(scene.absolute_box(1), None);
}

#[test]
fn content_height_is_the_furthest_child_bottom_plus_bottom_padding() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "view", PaintProps::default());
    scene.create_node(3, "view", PaintProps::default());
    scene.insert_node(1, 2, None);
    scene.insert_node(1, 3, None);
    scene.nodes.get_mut(&2).unwrap().computed_layout = Some(layout(0.0, 0.0, 100.0, 40.0));
    scene.nodes.get_mut(&3).unwrap().computed_layout = Some(layout(0.0, 40.0, 100.0, 60.0));
    scene.nodes.get_mut(&1).unwrap().props.padding_y = Some(8.0);

    assert_eq!(scene.content_height(1), 108.0);
}

#[test]
fn set_scroll_y_clamps_to_content_minus_viewport() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "view", PaintProps::default());
    scene.insert_node(1, 2, None);
    scene.nodes.get_mut(&1).unwrap().props.overflow_y = true;
    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(layout(0.0, 0.0, 100.0, 100.0));
    scene.nodes.get_mut(&2).unwrap().computed_layout = Some(layout(0.0, 0.0, 100.0, 300.0));

    assert_eq!(scene.set_scroll_y(1, 1000.0), 200.0);
    assert_eq!(scene.scroll_y(1), 200.0);
    assert_eq!(scene.set_scroll_y(1, -50.0), 0.0);
}

#[test]
fn set_scroll_y_is_a_no_op_without_overflow_y() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(layout(0.0, 0.0, 100.0, 100.0));
    assert_eq!(scene.set_scroll_y(1, 50.0), 0.0);
    assert_eq!(scene.scroll_y(1), 0.0);
}

// ── Hit testing ──────────────────────────────────────────────────────────────

#[test]
fn hit_test_finds_the_clickable_node_under_the_point() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "button", PaintProps::default());
    scene.insert_node(1, 2, None);
    scene.set_root(1);
    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(layout(0.0, 0.0, 200.0, 200.0));
    scene.nodes.get_mut(&2).unwrap().computed_layout = Some(layout(50.0, 50.0, 100.0, 40.0));

    assert_eq!(scene.hit_test(60.0, 60.0), Some(2));
    assert_eq!(scene.hit_test(10.0, 10.0), None); // over root, which isn't clickable
    assert_eq!(scene.hit_test(500.0, 500.0), None); // outside everything
}

#[test]
fn hit_test_prefers_the_topmost_of_overlapping_siblings() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "button", PaintProps::default());
    scene.create_node(3, "button", PaintProps::default());
    scene.insert_node(1, 2, None);
    scene.insert_node(1, 3, None); // 3 paints after 2, i.e. on top
    scene.set_root(1);
    let box_ = layout(0.0, 0.0, 100.0, 100.0);
    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(box_);
    scene.nodes.get_mut(&2).unwrap().computed_layout = Some(box_);
    scene.nodes.get_mut(&3).unwrap().computed_layout = Some(box_);

    assert_eq!(scene.hit_test(50.0, 50.0), Some(3));
}

#[test]
fn hit_test_accounts_for_a_css_translate_transform() {
    // Radix-style overlays position via `transform: translate(...)`. Without
    // applying the same delta the paint path composes, clicks would land on
    // the pre-transform layout box instead of where the overlay is drawn.
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "button", PaintProps::default());
    scene.insert_node(1, 2, None);
    scene.set_root(1);
    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(layout(0.0, 0.0, 500.0, 500.0));
    let n2 = scene.nodes.get_mut(&2).unwrap();
    n2.computed_layout = Some(layout(0.0, 0.0, 50.0, 50.0));
    n2.props.transform = Some(TransformList(vec![TransformOp::Translate {
        x: 100.0,
        y: 0.0,
        x_pct: false,
        y_pct: false,
    }]));

    assert_eq!(scene.hit_test(10.0, 10.0), None); // pre-transform position
    assert_eq!(scene.hit_test(110.0, 10.0), Some(2)); // post-transform position
}

#[test]
fn hit_test_shifts_children_by_the_scrollport_offset() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "button", PaintProps::default());
    scene.insert_node(1, 2, None);
    scene.set_root(1);
    scene.nodes.get_mut(&1).unwrap().props.overflow_y = true;
    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(layout(0.0, 0.0, 100.0, 100.0));
    scene.nodes.get_mut(&2).unwrap().computed_layout = Some(layout(0.0, 400.0, 100.0, 40.0));
    scene.scroll_offsets.insert(1, 380.0);

    // Child sits at content-y 400; scrolled up by 380 it's visible at y=20.
    assert_eq!(scene.hit_test(10.0, 20.0), Some(2));
    assert_eq!(scene.hit_test(10.0, 90.0), None);
}

#[test]
fn hit_test_drag_region_yields_to_a_clickable_descendant() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "button", PaintProps::default());
    scene.insert_node(1, 2, None);
    scene.set_root(1);
    scene.nodes.get_mut(&1).unwrap().props.drag_region = true;
    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(layout(0.0, 0.0, 200.0, 40.0));
    scene.nodes.get_mut(&2).unwrap().computed_layout = Some(layout(150.0, 5.0, 30.0, 30.0));

    assert_eq!(scene.hit_test_drag_region(160.0, 10.0), None); // over the button
    assert_eq!(scene.hit_test_drag_region(10.0, 10.0), Some(1)); // empty header area
}

#[test]
fn hit_test_scrollable_ignores_clickability_and_returns_the_deepest_scrollport() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.create_node(2, "view", PaintProps::default());
    scene.insert_node(1, 2, None);
    scene.set_root(1);
    scene.nodes.get_mut(&1).unwrap().props.overflow_y = true;
    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(layout(0.0, 0.0, 200.0, 200.0));
    scene.nodes.get_mut(&2).unwrap().props.overflow_y = true;
    scene.nodes.get_mut(&2).unwrap().computed_layout = Some(layout(0.0, 0.0, 100.0, 100.0));

    assert_eq!(scene.hit_test_scrollable(50.0, 50.0), Some(2));
    assert_eq!(scene.hit_test_scrollable(150.0, 150.0), Some(1));
}

// ── Input editing ────────────────────────────────────────────────────────────

#[test]
fn input_insert_str_replaces_the_active_selection() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "hello");
    let st = scene.input_state_mut(1);
    st.sel_anchor = 2;
    st.caret = 4; // selects "ll"

    let out = scene.input_insert_str(1, "XYZ").unwrap();
    assert_eq!(out, "heXYZo");
    assert_eq!(scene.input_state(1).unwrap().caret, 5);
    assert_eq!(scene.input_state(1).unwrap().sel_anchor, 5);
}

#[test]
fn input_backspace_deletes_a_whole_multibyte_character() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "café");
    scene.input_set_caret(1, "café".len(), false); // end of string, byte 5
    let out = scene.input_backspace(1).unwrap();
    assert_eq!(out, "caf");
}

#[test]
fn input_delete_removes_a_whole_multibyte_character_forward() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "café");
    scene.input_set_caret(1, 3, false); // just before 'é'
    let out = scene.input_delete(1).unwrap();
    assert_eq!(out, "caf");
}

#[test]
fn input_backspace_at_the_start_of_text_is_a_no_op() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "abc");
    let out = scene.input_backspace(1).unwrap();
    assert_eq!(out, "abc");
}

#[test]
fn input_delete_at_the_end_of_text_is_a_no_op() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "abc");
    scene.input_set_caret(1, 3, false);
    let out = scene.input_delete(1).unwrap();
    assert_eq!(out, "abc");
}

#[test]
fn input_move_caret_left_steps_over_a_whole_multibyte_character() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "café");
    scene.input_set_caret(1, "café".len(), false);
    scene.input_move_caret(1, CaretMove::Left, false);
    assert_eq!(scene.input_state(1).unwrap().caret, 3);
}

#[test]
fn input_move_caret_extend_grows_the_selection_without_moving_the_anchor() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "hello");
    scene.input_set_caret(1, 1, false);
    scene.input_move_caret(1, CaretMove::Right, true);
    scene.input_move_caret(1, CaretMove::Right, true);
    assert_eq!(scene.input_state(1).unwrap().sel_anchor, 1);
    assert_eq!(scene.input_state(1).unwrap().caret, 3);
    assert_eq!(scene.input_selected_text(1), "el");
}

#[test]
fn input_move_caret_home_and_end() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "hello");
    scene.input_set_caret(1, 2, false);
    scene.input_move_caret(1, CaretMove::End, false);
    assert_eq!(scene.input_state(1).unwrap().caret, 5);
    scene.input_move_caret(1, CaretMove::Home, false);
    assert_eq!(scene.input_state(1).unwrap().caret, 0);
}

#[test]
fn input_select_all_selects_the_full_text() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "hello world");
    scene.input_select_all(1);
    assert_eq!(scene.input_selected_text(1), "hello world");
}

#[test]
fn input_select_word_picks_the_word_under_the_click() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "hello world");
    scene.input_select_word(1, 8); // inside "world"
    assert_eq!(scene.input_selected_text(1), "world");
}

#[test]
fn input_select_word_past_a_word_selects_the_word_to_its_left() {
    // Matches OS double-click behavior: clicking just after the last letter
    // of a word, or past the very end of the text, still selects that word.
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "hello world");
    scene.input_select_word(1, 5); // the space right after "hello"
    assert_eq!(scene.input_selected_text(1), "hello");
    scene.input_select_word(1, 11); // past the very end
    assert_eq!(scene.input_selected_text(1), "world");
}

#[test]
fn input_select_word_on_whitespace_only_text_selects_nothing() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "   ");
    scene.input_select_word(1, 1);
    assert_eq!(scene.input_selected_text(1), "");
}

#[test]
fn input_set_caret_clamps_to_the_text_length() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "hi");
    scene.input_set_caret(1, 999, false);
    assert_eq!(scene.input_state(1).unwrap().caret, 2);
}

#[test]
fn input_undo_and_redo_round_trip_text_and_caret() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "a");
    scene.input_set_caret(1, 1, false);
    scene.input_insert_str(1, "b").unwrap(); // "ab", caret 2

    let undone = scene.input_undo(1).unwrap();
    assert_eq!(undone, "a");
    assert_eq!(
        scene.nodes.get(&1).unwrap().props.text.as_deref(),
        Some("a")
    );
    assert_eq!(scene.input_state(1).unwrap().caret, 1);

    let redone = scene.input_redo(1).unwrap();
    assert_eq!(redone, "ab");
    assert_eq!(scene.input_state(1).unwrap().caret, 2);
}

#[test]
fn a_new_edit_after_undo_clears_the_redo_stack() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "a");
    scene.input_set_caret(1, 1, false);
    scene.input_insert_str(1, "b").unwrap(); // "ab"
    scene.input_undo(1).unwrap(); // back to "a"; redo now has one entry

    scene.input_insert_str(1, "c").unwrap(); // new edit — drops the "ab" redo

    assert!(scene.input_redo(1).is_none());
}

#[test]
fn undo_on_an_input_with_no_history_returns_none() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "a");
    assert!(scene.input_undo(1).is_none());
}

#[test]
fn undo_stack_is_capped_so_memory_stays_bounded() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "");
    for i in 0..250 {
        scene.input_set_caret(1, 0, false);
        scene.input_insert_str(1, &i.to_string()).unwrap();
    }
    assert_eq!(scene.input_state(1).unwrap().undo.len(), 200);
}

// ── Caret <-> line/column conversion ─────────────────────────────────────────

#[test]
fn caret_to_line_col_and_back_round_trip_across_newlines() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "ab\ncd\nef");
    assert_eq!(scene.caret_to_line_col(1, 4), (1, 1)); // the 'd' on line 1
    assert_eq!(scene.line_col_to_caret(1, 1, 1), 4);
}

#[test]
fn line_col_to_caret_clamps_out_of_range_line_and_column() {
    let mut scene = Scene::new();
    make_input(&mut scene, 1, "ab\ncd");
    assert_eq!(scene.line_col_to_caret(1, 99, 0), 5); // past the last line -> end of text
    assert_eq!(scene.line_col_to_caret(1, 1, 99), 5); // past the line's own end -> clamped
}

#[test]
fn caret_to_visual_line_col_resolves_a_boundary_caret_to_the_earlier_line() {
    // A caret exactly at a visual-line boundary is ambiguous — this resolves
    // it to the end of the line ABOVE, not the start of the line below.
    // Caret rendering and up/down arrow movement both depend on that being
    // consistent.
    let visual_lines = [(0usize, 5usize), (5, 10), (10, 10)];
    assert_eq!(Scene::caret_to_visual_line_col(&visual_lines, 5), (0, 5));
    assert_eq!(Scene::caret_to_visual_line_col(&visual_lines, 7), (1, 2));
}

#[test]
fn caret_to_visual_line_col_past_the_end_clamps_to_the_last_line() {
    let visual_lines = [(0usize, 5usize), (5, 10)];
    assert_eq!(Scene::caret_to_visual_line_col(&visual_lines, 999), (1, 5));
}

#[test]
fn visual_line_col_to_caret_clamps_line_and_column() {
    let visual_lines = [(0usize, 5usize), (5, 10)];
    assert_eq!(Scene::visual_line_col_to_caret(&visual_lines, 5, 2), 7); // line clamps to the last one
    assert_eq!(Scene::visual_line_col_to_caret(&visual_lines, 0, 99), 5); // column clamps to the line's end
}

#[test]
fn visual_line_col_to_caret_on_no_lines_is_zero() {
    assert_eq!(Scene::visual_line_col_to_caret(&[], 0, 0), 0);
}

// ── editor_inner_width ───────────────────────────────────────────────────────

#[test]
fn editor_inner_width_subtracts_left_and_right_padding() {
    let mut scene = Scene::new();
    scene.create_node(1, "textarea", PaintProps::default());
    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(layout(0.0, 0.0, 100.0, 40.0));
    scene.nodes.get_mut(&1).unwrap().props.padding = Some(10.0);
    assert_eq!(scene.editor_inner_width(1), 80.0);
}

#[test]
fn editor_inner_width_per_side_padding_overrides_the_shorthand() {
    let mut scene = Scene::new();
    scene.create_node(1, "textarea", PaintProps::default());
    scene.nodes.get_mut(&1).unwrap().computed_layout = Some(layout(0.0, 0.0, 100.0, 40.0));
    scene.nodes.get_mut(&1).unwrap().props.padding = Some(10.0);
    scene.nodes.get_mut(&1).unwrap().props.padding_left = Some(2.0);
    assert_eq!(scene.editor_inner_width(1), 88.0);
}

#[test]
fn editor_inner_width_without_a_computed_layout_is_zero() {
    let mut scene = Scene::new();
    scene.create_node(1, "textarea", PaintProps::default());
    assert_eq!(scene.editor_inner_width(1), 0.0);
}

// ── set_prop: the CSS-ish string/JSON prop bag ──────────────────────────────
//
// set_prop takes a JSON-encoded value, falling back to treating the raw
// string as a JSON string when it fails to parse — which is exactly what
// makes an unquoted CSS-flavoured value like `translateX(10px)` or `red`
// work as an input alongside real JSON like `true`, `12`, or a spans array.

#[test]
fn set_prop_background_gradient_and_solid_color_are_mutually_exclusive() {
    // Note: the plain "background" branch resolves solid color through
    // scene.rs's own hex-only `parse_color`, not css_parse's richer
    // `parse_color_str` (which also handles named colors like "red") — that
    // richer parser is reserved for gradients/shadows. So the solid-color
    // side of this test has to use hex, not named colors.
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());

    scene.set_prop(1, "background", "#ff0000");
    assert!(scene.nodes.get(&1).unwrap().props.background.is_some());
    assert!(scene
        .nodes
        .get(&1)
        .unwrap()
        .props
        .background_gradient
        .is_none());

    scene.set_prop(1, "background", "linear-gradient(to right, red, blue)");
    assert!(scene.nodes.get(&1).unwrap().props.background.is_none());
    assert!(scene
        .nodes
        .get(&1)
        .unwrap()
        .props
        .background_gradient
        .is_some());

    scene.set_prop(1, "background", "#0000ff");
    assert!(scene.nodes.get(&1).unwrap().props.background.is_some());
    assert!(scene
        .nodes
        .get(&1)
        .unwrap()
        .props
        .background_gradient
        .is_none());
}

#[test]
fn set_prop_box_shadow_none_clears_existing_shadows() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_prop(1, "box-shadow", "0 1px 2px #000");
    assert_eq!(scene.nodes.get(&1).unwrap().props.box_shadow.len(), 1);
    scene.set_prop(1, "box-shadow", "none");
    assert!(scene.nodes.get(&1).unwrap().props.box_shadow.is_empty());
}

#[test]
fn set_prop_opacity_treats_fully_opaque_as_none_and_clamps_out_of_range() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());

    scene.set_prop(1, "opacity", "1");
    assert_eq!(scene.nodes.get(&1).unwrap().props.opacity, None);

    scene.set_prop(1, "opacity", "0.5");
    assert_eq!(scene.nodes.get(&1).unwrap().props.opacity, Some(0.5));

    scene.set_prop(1, "opacity", "5"); // out of range -> clamps to 1.0 -> None
    assert_eq!(scene.nodes.get(&1).unwrap().props.opacity, None);

    scene.set_prop(1, "opacity", "-1"); // out of range -> clamps to 0.0
    assert_eq!(scene.nodes.get(&1).unwrap().props.opacity, Some(0.0));
}

#[test]
fn set_prop_z_index_rounds_fractional_values() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_prop(1, "z-index", "3.6");
    assert_eq!(scene.nodes.get(&1).unwrap().props.z_index, Some(4));
}

#[test]
fn set_prop_translate_distinguishes_percent_from_pixels() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_prop(1, "translateX", "-50%");
    assert_eq!(
        scene.nodes.get(&1).unwrap().props.translate_x,
        Some((-50.0, true))
    );
    scene.set_prop(1, "translateY", "12px");
    assert_eq!(
        scene.nodes.get(&1).unwrap().props.translate_y,
        Some((12.0, false))
    );
}

#[test]
fn set_prop_margin_shorthand_sets_all_sides_marginx_touches_only_two() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_prop(1, "margin", "10");
    assert_eq!(
        len_px(scene.nodes.get(&1).unwrap().props.margin_left),
        Some(10.0)
    );
    assert_eq!(
        len_px(scene.nodes.get(&1).unwrap().props.margin_top),
        Some(10.0)
    );

    scene.set_prop(1, "marginX", "4");
    assert_eq!(
        len_px(scene.nodes.get(&1).unwrap().props.margin_left),
        Some(4.0)
    );
    assert_eq!(
        len_px(scene.nodes.get(&1).unwrap().props.margin_right),
        Some(4.0)
    );
    assert_eq!(
        len_px(scene.nodes.get(&1).unwrap().props.margin_top),
        Some(10.0)
    ); // untouched
}

#[test]
fn set_prop_font_weight_accepts_keywords_and_both_json_number_and_string_forms() {
    let mut scene = Scene::new();
    scene.create_node(1, "text", PaintProps::default());
    scene.set_prop(1, "fontWeight", "bold");
    assert_eq!(scene.nodes.get(&1).unwrap().props.font_weight, Some(700));
    scene.set_prop(1, "fontWeight", "normal");
    assert_eq!(scene.nodes.get(&1).unwrap().props.font_weight, Some(400));
    scene.set_prop(1, "fontWeight", "lighter");
    assert_eq!(scene.nodes.get(&1).unwrap().props.font_weight, Some(300));
    scene.set_prop(1, "fontWeight", "600"); // bare digits parse as a JSON number
    assert_eq!(scene.nodes.get(&1).unwrap().props.font_weight, Some(600));
    scene.set_prop(1, "fontWeight", "\"550\""); // a JSON-string-encoded number must work too
    assert_eq!(scene.nodes.get(&1).unwrap().props.font_weight, Some(550));
}

#[test]
fn set_prop_spans_defaults_missing_fields_and_null_clears_them() {
    let mut scene = Scene::new();
    scene.create_node(1, "text", PaintProps::default());
    let spans_json =
        "[{\"text\":\"ok\",\"color\":\"#ff0000\",\"weight\":700},{\"background\":\"#00ff00\"}]";
    scene.set_prop(1, "spans", spans_json);
    let spans = scene.nodes.get(&1).unwrap().props.spans.clone().unwrap();
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[0].text, "ok");
    assert_eq!(spans[0].color, Some(0xFFFF0000));
    assert_eq!(spans[0].weight, Some(700));
    assert_eq!(spans[1].text, ""); // missing "text" defaults to empty
    assert_eq!(spans[1].color, None);
    assert_eq!(spans[1].background, Some(0xFF00FF00));

    scene.set_prop(1, "spans", "null");
    assert!(scene.nodes.get(&1).unwrap().props.spans.is_none());
}

#[test]
fn set_prop_drag_region_accepts_several_truthy_encodings() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_prop(1, "drag-region", "true");
    assert!(scene.nodes.get(&1).unwrap().props.drag_region);
    scene.set_prop(1, "drag-region", "false");
    assert!(!scene.nodes.get(&1).unwrap().props.drag_region);
    scene.set_prop(1, "data-tauri-drag-region", ""); // present-but-empty == truthy
    assert!(scene.nodes.get(&1).unwrap().props.drag_region);
    scene.set_prop(1, "drag-region", "null");
    assert!(!scene.nodes.get(&1).unwrap().props.drag_region);
}

#[test]
fn set_prop_background_image_unwraps_url_and_quotes() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_prop(1, "background-image", "url(assets/bg.png)");
    assert_eq!(
        scene
            .nodes
            .get(&1)
            .unwrap()
            .props
            .background_image
            .as_deref(),
        Some("assets/bg.png")
    );
    scene.set_prop(1, "background-image", "url(\"assets/other.png\")");
    assert_eq!(
        scene
            .nodes
            .get(&1)
            .unwrap()
            .props
            .background_image
            .as_deref(),
        Some("assets/other.png")
    );
}

#[test]
fn set_prop_src_defaults_background_size_to_contain_only_when_unset() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_prop(1, "src", "assets/icon.png");
    assert_eq!(
        scene
            .nodes
            .get(&1)
            .unwrap()
            .props
            .background_size
            .as_deref(),
        Some("contain")
    );

    scene.set_prop(1, "background-size", "cover");
    scene.set_prop(1, "src", "assets/other.png");
    assert_eq!(
        scene
            .nodes
            .get(&1)
            .unwrap()
            .props
            .background_size
            .as_deref(),
        Some("cover")
    );
}

#[test]
fn set_prop_svg_stroke_and_fill_handle_current_color_and_none() {
    let mut scene = Scene::new();
    scene.create_node(1, "path", PaintProps::default());

    scene.set_prop(1, "stroke", "currentColor");
    assert!(scene.nodes.get(&1).unwrap().props.svg_stroke_inherit);
    assert_eq!(scene.nodes.get(&1).unwrap().props.svg_stroke, None);

    scene.set_prop(1, "stroke", "none");
    assert!(!scene.nodes.get(&1).unwrap().props.svg_stroke_inherit);
    assert_eq!(scene.nodes.get(&1).unwrap().props.svg_stroke, None);

    scene.set_prop(1, "fill", "none");
    assert!(scene.nodes.get(&1).unwrap().props.svg_fill_none);
    assert_eq!(scene.nodes.get(&1).unwrap().props.svg_fill, None);

    scene.set_prop(1, "fill", "#00ff00");
    assert!(!scene.nodes.get(&1).unwrap().props.svg_fill_none);
    assert_eq!(
        scene.nodes.get(&1).unwrap().props.svg_fill,
        Some(0xFF00FF00)
    );
}

#[test]
fn set_prop_view_box_accepts_space_or_comma_separated_numbers_and_rejects_bad_counts() {
    let mut scene = Scene::new();
    scene.create_node(1, "svg", PaintProps::default());
    scene.set_prop(1, "viewBox", "0 0 24 24");
    assert_eq!(
        scene.nodes.get(&1).unwrap().props.svg_view_box,
        Some([0.0, 0.0, 24.0, 24.0])
    );

    scene.create_node(2, "svg", PaintProps::default());
    scene.set_prop(2, "viewBox", "0,0,16,16");
    assert_eq!(
        scene.nodes.get(&2).unwrap().props.svg_view_box,
        Some([0.0, 0.0, 16.0, 16.0])
    );

    scene.create_node(3, "svg", PaintProps::default());
    scene.set_prop(3, "viewBox", "0 0 24"); // wrong count -> ignored
    assert_eq!(scene.nodes.get(&3).unwrap().props.svg_view_box, None);
}

#[test]
fn set_prop_overflow_y_variants() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    for (val, want) in [
        ("scroll", true),
        ("auto", true),
        ("hidden", false),
        ("visible", false),
    ] {
        scene.set_prop(1, "overflow-y", val);
        assert_eq!(
            scene.nodes.get(&1).unwrap().props.overflow_y,
            want,
            "overflow-y: {val}"
        );
    }
    scene.set_prop(1, "overflow", "true"); // JSON bool form, via the "overflow" alias
    assert!(scene.nodes.get(&1).unwrap().props.overflow_y);
}

#[test]
fn set_prop_place_items_shorthand_splits_into_align_and_justify() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_prop(1, "place-items", "center stretch");
    assert_eq!(
        scene
            .nodes
            .get(&1)
            .unwrap()
            .props
            .align_items_grid
            .as_deref(),
        Some("center")
    );
    assert_eq!(
        scene.nodes.get(&1).unwrap().props.justify_items.as_deref(),
        Some("stretch")
    );
}

#[test]
fn set_prop_place_items_single_value_applies_to_both_axes() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_prop(1, "place-items", "end");
    assert_eq!(
        scene
            .nodes
            .get(&1)
            .unwrap()
            .props
            .align_items_grid
            .as_deref(),
        Some("end")
    );
    assert_eq!(
        scene.nodes.get(&1).unwrap().props.justify_items.as_deref(),
        Some("end")
    );
}

#[test]
fn set_prop_clickable_and_on_click_both_flip_the_flag() {
    let mut scene = Scene::new();
    scene.create_node(1, "view", PaintProps::default());
    scene.set_prop(1, "onClick", "anything");
    assert!(scene.nodes.get(&1).unwrap().props.clickable);
}

#[test]
fn set_prop_value_sets_text_like_an_input_change_event() {
    let mut scene = Scene::new();
    scene.create_node(1, "input", PaintProps::default());
    scene.set_prop(1, "value", "typed");
    assert_eq!(
        scene.nodes.get(&1).unwrap().props.text.as_deref(),
        Some("typed")
    );
}

#[test]
fn set_prop_gracefully_ignores_unparseable_values_and_unknown_keys() {
    let mut scene = Scene::new();
    scene.create_node(1, "text", PaintProps::default());
    scene.set_prop(1, "font_size", "not-a-number");
    assert_eq!(scene.nodes.get(&1).unwrap().props.font_size, None);
    scene.set_prop(1, "totally-not-a-real-prop", "whatever");
    assert_eq!(scene.nodes.get(&1).unwrap().props.background, None);
}

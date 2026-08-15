// Scene-graph helpers used by the event loop.
//
// `absolute_x`/`absolute_y` walk a node's parents to accumulate an absolute
// position, which hit-testing needs and the Taffy layout does not store.
//
// `install_hardcoded_scene` is the fallback when no bundle loads — it paints
// something rather than an empty window, so a broken build looks different from
// a crashed one.

use super::*;

/// Walk from root to find a node and return its accumulated x offset
/// (useful for hit-test math where we have a screen coordinate and need
/// it in box-local space). Scene doesn't track parent ids, so we walk
/// down. Returns 0.0 if the node has no computed layout yet.
pub(crate) fn absolute_x(s: &Scene, target: u32) -> f32 {
    fn walk(s: &Scene, id: u32, target: u32, acc: f32) -> Option<f32> {
        let n = s.nodes.get(&id)?;
        let layout = n.computed_layout?;
        let x = acc + layout.location.x;
        if id == target {
            return Some(x);
        }
        for &c in &n.children {
            if let Some(found) = walk(s, c, target, x) {
                return Some(found);
            }
        }
        None
    }
    walk(s, s.root, target, 0.0).unwrap_or(0.0)
}

/// Companion to [`absolute_x`] for the y axis.
pub(crate) fn absolute_y(s: &Scene, target: u32) -> f32 {
    fn walk(s: &Scene, id: u32, target: u32, acc: f32) -> Option<f32> {
        let n = s.nodes.get(&id)?;
        let layout = n.computed_layout?;
        let y = acc + layout.location.y;
        if id == target {
            return Some(y);
        }
        for &c in &n.children {
            if let Some(found) = walk(s, c, target, y) {
                return Some(found);
            }
        }
        None
    }
    walk(s, s.root, target, 0.0).unwrap_or(0.0)
}

// debug_color_for_id / hsv_to_rgb moved into the paint crate (its only
// caller); main.rs no longer needs them.

pub(crate) fn install_hardcoded_scene(scene: &Arc<Mutex<Scene>>) {
    let mut s = scene.lock().unwrap_or_else(|e| e.into_inner());
    s.create_node(
        1,
        "view",
        PaintProps {
            background: Some(0xFFE5_E7EB),
            ..PaintProps::default()
        },
    );
    s.set_root(1);
    s.create_node(
        2,
        "text",
        PaintProps {
            text: Some("carbon-mini v2 hardcoded scene (no JS)".to_string()),
            font_size: Some(20.0),
            color: Some(0xFF11_1827),
            ..PaintProps::default()
        },
    );
    s.insert_node(1, 2, None);
    s.create_node(
        3,
        "view",
        PaintProps {
            background: Some(0xFF3B_82F6),
            border_radius: 6.0,
            ..PaintProps::default()
        },
    );
    s.insert_node(1, 3, None);
    s.create_node(
        4,
        "text",
        PaintProps {
            text: Some("Click me".to_string()),
            color: Some(0xFFFF_FFFF),
            font_size: Some(16.0),
            ..PaintProps::default()
        },
    );
    s.insert_node(3, 4, None);
    s.dirty = true;
}

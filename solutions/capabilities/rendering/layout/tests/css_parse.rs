// CSS value parsing — the first tests this crate has ever had.
//
// carbon-layout arrived from V1 with 3,700 lines and zero coverage, and it is
// the crate that decides where everything on screen ends up. These cover
// css_parse, which is where the app author's strings become typed values: the
// layer most exposed to malformed input, and the one that can be tested
// against literals with no window, no device and no scene.
//
// The bias here is towards what an app actually writes and what a parser
// actually gets wrong — case, whitespace, alpha handling, and the difference
// between "unsupported" and "invalid". A parser that returns Some(garbage) for
// a typo is worse than one that returns None, because the garbage reaches the
// screen.

use carbon_layout::css_parse::*;
use carbon_layout::scene::{FilterOp, GradientShape};

// 0xAARRGGBB throughout. Spelling the alpha out in each expectation is
// deliberate: the byte order is the single easiest thing to get wrong here,
// and a test written as `0xFF0000` would pass for the wrong reason.
const OPAQUE: u32 = 0xFF00_0000;

#[test]
fn hex_colors_in_every_accepted_length() {
    assert_eq!(parse_color_str("#f00"), Some(OPAQUE | 0xFF0000));
    assert_eq!(parse_color_str("#ff0000"), Some(OPAQUE | 0xFF0000));
    assert_eq!(parse_color_str("#ff0000ff"), Some(OPAQUE | 0xFF0000));
}

#[test]
fn hex_shorthand_expands_by_duplicating_nibbles() {
    // #abc is #aabbcc, not #a0b0c0 — the classic off-by-a-nibble.
    assert_eq!(parse_color_str("#abc"), Some(OPAQUE | 0xAABBCC));
}

#[test]
fn hex_is_case_insensitive() {
    assert_eq!(parse_color_str("#AABBCC"), parse_color_str("#aabbcc"));
}

#[test]
fn surrounding_whitespace_is_ignored() {
    // Style values arrive from JS template literals; leading newlines are
    // normal, not exotic.
    assert_eq!(parse_color_str("  #ff0000  "), Some(OPAQUE | 0xFF0000));
}

#[test]
fn rgb_and_rgba_functions() {
    assert_eq!(parse_color_str("rgb(255, 0, 0)"), Some(OPAQUE | 0xFF0000));
    assert_eq!(
        parse_color_str("rgba(255, 0, 0, 1)"),
        Some(OPAQUE | 0xFF0000)
    );
}

#[test]
fn rgba_alpha_is_a_fraction_scaled_to_a_byte() {
    // 0.5 -> 127 or 128 depending on rounding; assert the channel, not the
    // exact rounding, so this does not become a test of one implementation.
    let parsed = parse_color_str("rgba(0, 0, 0, 0.5)").expect("should parse");
    let alpha = (parsed >> 24) & 0xFF;
    assert!(
        (126..=129).contains(&alpha),
        "alpha 0.5 should land near mid-range, got {alpha}"
    );
}

#[test]
fn zero_alpha_is_fully_transparent() {
    assert_eq!(
        parse_color_str("rgba(255, 0, 0, 0)").map(|c| c >> 24),
        Some(0)
    );
}

#[test]
fn transparent_keyword_is_all_zeroes() {
    // Not just alpha 0 — the whole value, which is what the paint path checks
    // to skip a fill entirely.
    assert_eq!(parse_color_str("transparent"), Some(0x0000_0000));
}

#[test]
fn currentcolor_is_none_not_black() {
    // `currentcolor` means "inherit", which this layer cannot resolve — it has
    // no cascade. None makes the caller fall back; a colour here would silently
    // paint the wrong thing.
    assert_eq!(parse_color_str("currentcolor"), None);
    assert_eq!(parse_color_str("currentColor"), None);
}

#[test]
fn named_colors_resolve_and_are_case_insensitive() {
    assert_eq!(parse_color_str("red"), Some(OPAQUE | 0xFF0000));
    assert_eq!(parse_color_str("white"), Some(OPAQUE | 0xFFFFFF));
    assert_eq!(parse_color_str("BLACK"), Some(OPAQUE));
}

#[test]
fn unknown_names_and_malformed_input_are_none() {
    // Each of these is a plausible typo. None of them may produce a colour.
    for input in [
        "notacolour",
        "#",
        "#ff",
        "#gggggg",
        "rgb(",
        "rgb()",
        "",
        "   ",
    ] {
        assert_eq!(
            parse_color_str(input),
            None,
            "input {input:?} should not parse"
        );
    }
}

#[test]
fn hsl_maps_the_primaries() {
    // Red, green, blue at the three 120-degree marks. Full saturation, half
    // lightness is exactly the primary in each case.
    assert_eq!(
        parse_color_str("hsl(0, 100%, 50%)"),
        Some(OPAQUE | 0xFF0000)
    );
    assert_eq!(
        parse_color_str("hsl(120, 100%, 50%)"),
        Some(OPAQUE | 0x00FF00)
    );
    assert_eq!(
        parse_color_str("hsl(240, 100%, 50%)"),
        Some(OPAQUE | 0x0000FF)
    );
}

#[test]
fn hsl_lightness_extremes_are_black_and_white() {
    assert_eq!(parse_color_str("hsl(0, 100%, 0%)"), Some(OPAQUE));
    assert_eq!(
        parse_color_str("hsl(0, 100%, 100%)"),
        Some(OPAQUE | 0xFFFFFF)
    );
}

// ── Gradients ───────────────────────────────────────────────────────────────

#[test]
fn linear_gradient_keeps_its_stops_in_order() {
    let g =
        parse_linear_gradient("linear-gradient(to right, #ff0000, #0000ff)").expect("should parse");
    assert_eq!(g.stops.len(), 2);
    // Order is load-bearing: reversing it reverses the gradient on screen.
    assert_eq!(g.stops[0].color, OPAQUE | 0xFF0000);
    assert_eq!(g.stops[1].color, OPAQUE | 0x0000FF);
}

#[test]
fn linear_gradient_accepts_more_than_two_stops() {
    let g =
        parse_linear_gradient("linear-gradient(to right, red, white, blue)").expect("should parse");
    assert_eq!(g.stops.len(), 3);
}

#[test]
fn radial_gradient_parses() {
    let g =
        parse_radial_gradient("radial-gradient(circle, #ffffff, #000000)").expect("should parse");
    assert_eq!(g.stops.len(), 2);
}

#[test]
fn a_gradient_that_is_not_one_is_none() {
    assert!(parse_linear_gradient("#ff0000").is_none());
    assert!(parse_linear_gradient("linear-gradient(").is_none());
}

#[test]
fn conic_gradient_defaults_to_zero_degrees_and_centered() {
    let g = parse_conic_gradient("conic-gradient(#ff0000, #0000ff)").expect("should parse");
    assert_eq!(g.stops.len(), 2);
    match g.shape {
        GradientShape::Conic { angle_deg, cx, cy } => {
            assert_eq!(angle_deg, 0.0);
            assert_eq!(cx, 0.5);
            assert_eq!(cy, 0.5);
        }
        other => panic!("expected Conic, got {other:?}"),
    }
}

#[test]
fn conic_gradient_reads_from_angle_and_at_position() {
    let g = parse_conic_gradient("conic-gradient(from 90deg at 25% 75%, red, blue)")
        .expect("should parse");
    match g.shape {
        GradientShape::Conic { angle_deg, cx, cy } => {
            assert_eq!(angle_deg, 90.0);
            assert_eq!(cx, 0.25);
            assert_eq!(cy, 0.75);
        }
        other => panic!("expected Conic, got {other:?}"),
    }
}

#[test]
fn conic_gradient_from_only_no_at_clause() {
    let g = parse_conic_gradient("conic-gradient(from 45deg, red, blue)").expect("should parse");
    match g.shape {
        GradientShape::Conic { angle_deg, cx, cy } => {
            assert_eq!(angle_deg, 45.0);
            assert_eq!(cx, 0.5);
            assert_eq!(cy, 0.5);
        }
        other => panic!("expected Conic, got {other:?}"),
    }
}

// ── Box shadow ──────────────────────────────────────────────────────────────

#[test]
fn box_shadow_reads_offsets_blur_and_colour() {
    let shadows = parse_box_shadow("2px 4px 6px rgba(0,0,0,0.5)");
    assert_eq!(shadows.len(), 1);
    assert_eq!(shadows[0].offset_x, 2.0);
    assert_eq!(shadows[0].offset_y, 4.0);
    assert_eq!(shadows[0].blur, 6.0);
    assert!(!shadows[0].inset);
}

#[test]
fn box_shadow_negative_offsets() {
    let shadows = parse_box_shadow("-2px -4px 0 #000");
    assert_eq!(shadows.len(), 1);
    assert_eq!(shadows[0].offset_x, -2.0);
    assert_eq!(shadows[0].offset_y, -4.0);
}

#[test]
fn inset_shadows_are_flagged() {
    // inset changes paint ORDER — inside the box, after the background fill,
    // rather than behind it. Losing the flag silently moves the shadow.
    let shadows = parse_box_shadow("inset 0 2px 4px #000");
    assert_eq!(shadows.len(), 1);
    assert!(shadows[0].inset);
}

#[test]
fn multiple_comma_separated_shadows() {
    let shadows = parse_box_shadow("0 1px 2px #000, 0 4px 8px #333");
    assert_eq!(shadows.len(), 2);
}

#[test]
fn an_unparseable_shadow_yields_no_shadows() {
    // Returns a Vec, so the failure mode is emptiness rather than None.
    assert!(parse_box_shadow("").is_empty());
    assert!(parse_box_shadow("garbage").is_empty());
}

// ── Transform and clip-path ─────────────────────────────────────────────────

#[test]
fn transforms_parse() {
    assert!(parse_transform("translateX(10px)").is_some());
    assert!(parse_transform("scale(2)").is_some());
    assert!(parse_transform("rotate(45deg)").is_some());
}

#[test]
fn a_transform_list_parses_as_one_value() {
    assert!(parse_transform("translateX(10px) rotate(45deg) scale(2)").is_some());
}

#[test]
fn an_unknown_transform_is_none() {
    assert!(parse_transform("wobble(3)").is_none());
    assert!(parse_transform("").is_none());
}

#[test]
fn clip_paths_parse() {
    assert!(parse_clip_path("circle(50%)").is_some());
    assert!(parse_clip_path("inset(10px)").is_some());
}

#[test]
fn an_unknown_clip_path_is_none() {
    assert!(parse_clip_path("squircle(4)").is_none());
    assert!(parse_clip_path("").is_none());
}

// ── Text shadow ───────────────────────────────────────────────────────────

#[test]
fn text_shadow_reads_offsets_blur_and_colour() {
    let shadows = parse_text_shadow("1px 2px 3px rgba(0,0,0,0.5)");
    assert_eq!(shadows.len(), 1);
    assert_eq!(shadows[0].offset_x, 1.0);
    assert_eq!(shadows[0].offset_y, 2.0);
    assert_eq!(shadows[0].blur, 3.0);
}

#[test]
fn text_shadow_multiple_comma_separated() {
    let shadows = parse_text_shadow("0 1px 0 #000, 0 0 4px #f00");
    assert_eq!(shadows.len(), 2);
}

#[test]
fn text_shadow_without_a_colour_is_dropped() {
    // Fewer than 3 tokens (no colour found among them) can't build a
    // shadow — matches box-shadow's "garbage yields emptiness" contract.
    assert!(parse_text_shadow("1px 2px").is_empty());
}

// ── filter ───────────────────────────────────────────────────────────────

#[test]
fn filter_blur_reads_the_length() {
    let f = parse_filter("blur(4px)").expect("should parse");
    match &f.0[0] {
        FilterOp::Blur(px) => assert_eq!(*px, 4.0),
        other => panic!("expected Blur, got {other:?}"),
    }
}

#[test]
fn filter_drop_shadow_reads_offsets_blur_and_colour() {
    let f = parse_filter("drop-shadow(2px 4px 6px rgba(0,0,0,0.4))").expect("should parse");
    match &f.0[0] {
        FilterOp::DropShadow {
            offset_x,
            offset_y,
            blur,
            ..
        } => {
            assert_eq!(*offset_x, 2.0);
            assert_eq!(*offset_y, 4.0);
            assert_eq!(*blur, 6.0);
        }
        other => panic!("expected DropShadow, got {other:?}"),
    }
}

#[test]
fn filter_chains_multiple_functions() {
    let f = parse_filter("blur(2px) drop-shadow(0 1px 2px #000)").expect("should parse");
    assert_eq!(f.0.len(), 2);
}

#[test]
fn filter_none_and_empty_and_unknown_are_none() {
    assert!(parse_filter("none").is_none());
    assert!(parse_filter("").is_none());
    assert!(parse_filter("brightness(1.2)").is_none());
}

// ── aspect-ratio ─────────────────────────────────────────────────────────

#[test]
fn aspect_ratio_reads_a_fraction() {
    let r = parse_aspect_ratio("16/9").expect("should parse");
    assert!((r - 16.0 / 9.0).abs() < 1e-6);
}

#[test]
fn aspect_ratio_reads_a_fraction_with_spaces() {
    let r = parse_aspect_ratio("16 / 9").expect("should parse");
    assert!((r - 16.0 / 9.0).abs() < 1e-6);
}

#[test]
fn aspect_ratio_reads_a_bare_number() {
    assert_eq!(parse_aspect_ratio("1.5"), Some(1.5));
}

#[test]
fn aspect_ratio_auto_and_garbage_are_none() {
    assert!(parse_aspect_ratio("auto").is_none());
    assert!(parse_aspect_ratio("").is_none());
    assert!(parse_aspect_ratio("banana").is_none());
    // A zero denominator has no ratio to give back.
    assert!(parse_aspect_ratio("16/0").is_none());
}

// ── corner-shape ─────────────────────────────────────────────────────────

#[test]
fn corner_shape_squircle_is_a_fixed_exponent() {
    assert_eq!(parse_corner_shape("squircle"), Some(4.0));
    assert_eq!(parse_corner_shape("Squircle"), Some(4.0)); // case-insensitive
}

#[test]
fn corner_shape_superellipse_reads_the_exponent() {
    assert_eq!(parse_corner_shape("superellipse(6)"), Some(6.0));
    assert_eq!(parse_corner_shape("superellipse(2.5)"), Some(2.5));
}

#[test]
fn corner_shape_round_and_garbage_are_none() {
    assert!(parse_corner_shape("round").is_none());
    assert!(parse_corner_shape("").is_none());
    assert!(parse_corner_shape("bevel").is_none());
    // A non-positive exponent has no valid curve to give back.
    assert!(parse_corner_shape("superellipse(0)").is_none());
    assert!(parse_corner_shape("superellipse(-2)").is_none());
}

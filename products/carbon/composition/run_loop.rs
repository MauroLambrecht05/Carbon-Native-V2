// The winit/tao event loop's match arms: every WindowEvent and UserEvent
// carbon-mini reacts to once the window is up. Moved out of mini.rs as a
// single unit — same match, same arm order, same everything, except bare
// captures (`window`, `scene`, `mouse_pos`, ...) are now `self.<field>`
// because they're struct fields instead of closure captures. No arm was
// reordered, split, or merged.

use super::*;

/// Everything the old `event_loop.run(move |event, ...| { ... })` closure
/// captured by `move`. Built once in `main()` right before the loop starts,
/// then driven one event at a time by `handle_event`.
pub(crate) struct State {
    pub(crate) window: Rc<tao::window::Window>,
    pub(crate) surface: softbuffer::Surface<Rc<tao::window::Window>, Rc<tao::window::Window>>,
    pub(crate) scene: Arc<Mutex<Scene>>,
    pub(crate) text_engine: Rc<RefCell<text::TextEngine>>,
    pub(crate) js_ctx: JsContext,
    pub(crate) js_rt: JsRuntime,
    pub(crate) host_app: Box<host_exports::HostCarbonAppStorage>,
    pub(crate) plugin_registry: plugin_loader::PluginRegistry,
    pub(crate) paint_canvas: Option<paint::Canvas>,
    pub(crate) first_paint_done: bool,
    pub(crate) mouse_pos: (f32, f32),
    pub(crate) modifiers_state: ModifiersState,
    pub(crate) clipboard: Option<arboard::Clipboard>,
    pub(crate) dragging_input: Option<u32>,
    pub(crate) pointer_down: Option<u32>,
    pub(crate) last_click: Option<(Instant, (f32, f32), u32)>,
    pub(crate) click_streak: u32,
    pub(crate) reload_path: Option<PathBuf>,
    pub(crate) reload_scene: Arc<Mutex<Scene>>,
    pub(crate) t0: Instant,
}

impl State {
    /// One event, handled exactly as the inline closure handled it.
    pub(crate) fn handle_event(&mut self, event: Event<UserEvent>, control_flow: &mut ControlFlow) {
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                // Run plugin shutdown hooks BEFORE we exit. Bypassed if the
                // OS hard-kills the process, but normal close goes through
                // here so plugins can flush state cleanly.
                self.plugin_registry.dispatch_on_shutdown();
                *control_flow = ControlFlow::Exit;
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(size),
                ..
            } => {
                let w = size.width.max(1);
                let h = size.height.max(1);
                self.host_app.set_window_size(w, h);
                // HOST_WINDOW_SIZE is the LOGICAL (CSS-px) viewport used by
                // off-thread compute_layout; divide physical by scale. The
                // paint loop reads scale_factor() itself and scales up.
                let sf = (self.window.scale_factor() as f32).max(0.1);
                if let Ok(mut g) = HOST_WINDOW_SIZE.lock() {
                    *g = (w as f32 / sf, h as f32 / sf);
                }
                // Carbon-native window state mirror — JS callers query
                // __cm_window_is_maximized() / .is_minimized() and
                // expect post-resize truth here.
                crate::native::window::set_is_maximized(self.window.is_maximized());
                crate::native::window::set_is_minimized(self.window.is_minimized());
                crate::native::window::set_inner_size(w, h);
                crate::native::window::set_scale_factor(self.window.scale_factor());
                crate::native::window::bump_resize_tick();
                // Fire any registered JS resize listeners. The dispatcher
                // is installed by the @/native/window TS wrapper.
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(
                    b"globalThis.__cm_window_dispatch_resize && globalThis.__cm_window_dispatch_resize();" as &[u8],
                ));
                self.plugin_registry.dispatch_on_resize(w, h);
                // Mark scene dirty so the paint loop actually recomputes
                // layout for the new dimensions (otherwise the redraw
                // request is short-circuited by the dirty-flag check).
                {
                    let mut s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.dirty = true;
                }
                self.window.request_redraw();
            }
            Event::WindowEvent {
                event: WindowEvent::Focused(focused),
                ..
            } => {
                crate::native::window::set_is_focused(focused);
            }
            Event::WindowEvent {
                event: WindowEvent::CursorMoved { position, .. },
                ..
            } => {
                // DPI-aware: pointer positions arrive in PHYSICAL px but the
                // scene/layout is in LOGICAL px, so convert here — every
                // hit_test downstream then matches the boxes it tests.
                let sf = (self.window.scale_factor() as f32).max(0.1);
                self.mouse_pos = (position.x as f32 / sf, position.y as f32 / sf);
                if std::env::var_os("CARBON_MINI_CLICK_DEBUG").is_some() {
                    eprintln!("[carbon-mini-move] ({:.1}, {:.1})", self.mouse_pos.0, self.mouse_pos.1);
                }
                // While any pointer-down is in flight, route pointer-move
                // events back to the original target (implicit capture).
                // Fires alongside the input-drag selection logic below
                // because they target different listeners.
                if let Some(pd_id) = self.pointer_down {
                    let script = format!(
                        "globalThis.__cm_dispatch_pointer && globalThis.__cm_dispatch_pointer({}, \"move\", {}, {}, 0);",
                        pd_id, self.mouse_pos.0, self.mouse_pos.1
                    );
                    let _ = self.js_ctx.with(|ctx| -> Result<()> {
                        ctx.eval::<(), _>(script.as_bytes())
                            .map_err(|e| anyhow!("dispatch pointer move: {e}"))?;
                        Ok(())
                    });
                }
                // While the mouse button is held inside an input we
                // extend the selection to the dragged-to character.
                if let Some(drag_id) = self.dragging_input {
                    let mut s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                    let abs_x = absolute_x(&s, drag_id);
                    let abs_y = absolute_y(&s, drag_id);
                    let local_x = self.mouse_pos.0 - abs_x;
                    let local_y = self.mouse_pos.1 - abs_y;
                    let off = s.input_caret_from_xy(
                        drag_id,
                        local_x,
                        local_y,
                        &mut self.text_engine.borrow_mut(),
                    );
                    s.input_set_caret(drag_id, off, true);
                    s.dirty = true;
                    self.window.request_redraw();
                }
                // Hover tracking: hit-test the cursor against clickable
                // nodes; if the hovered node changed, mark the scene
                // dirty so paint can swap in *_hover props. Also pick
                // the right OS cursor — pointer over clickable, default
                // elsewhere — so the UI matches what users expect from
                // a real desktop app.
                {
                    let mut s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                    let hit = s.hit_test(self.mouse_pos.0, self.mouse_pos.1);
                    if hit != s.hovered {
                        let prev = s.hovered;
                        s.hovered = hit;
                        if std::env::var_os("CARBON_MINI_HOVER_DEBUG").is_some() {
                            let bg_hov = hit.and_then(|i| s.nodes.get(&i)).and_then(|n| n.props.background_hover);
                            let col_hov = hit.and_then(|i| s.nodes.get(&i)).and_then(|n| n.props.color_hover);
                            eprintln!(
                                "[carbon-mini-hover] prev={:?} -> hit={:?} bg_hover={:?} color_hover={:?}",
                                prev, hit, bg_hov.map(|c| format!("#{:08x}", c)), col_hov.map(|c| format!("#{:08x}", c))
                            );
                        }
                        // Hover only flips paint-only props (backgroundHover,
                        // colorHover) — it never changes any node's box. So
                        // it's a `repaint_dirty` event, not a full structural
                        // dirty. Damage rect = bounding box of (old hovered,
                        // new hovered) so we only repaint those two regions.
                        if let Some(id) = prev {
                            if let Some(b) = s.absolute_box(id) {
                                s.add_damage(b.0, b.1, b.2, b.3);
                            }
                        }
                        if let Some(id) = hit {
                            if let Some(b) = s.absolute_box(id) {
                                s.add_damage(b.0, b.1, b.2, b.3);
                            }
                        }
                        s.repaint_dirty = true;
                        self.window.request_redraw();
                        // Translate the hovered node's `cursor` prop into a
                        // tao CursorIcon. Default: clickable → pointer,
                        // anything else → default arrow.
                        let icon = match hit {
                            Some(id) => match s.nodes.get(&id) {
                                Some(n) => match n.props.cursor.as_deref() {
                                    Some("default") | Some("auto") | Some("inherit") => {
                                        tao::window::CursorIcon::Default
                                    }
                                    Some("pointer") | Some("hand") => {
                                        tao::window::CursorIcon::Hand
                                    }
                                    Some("text") | Some("ibeam") => {
                                        tao::window::CursorIcon::Text
                                    }
                                    Some("crosshair") => tao::window::CursorIcon::Crosshair,
                                    Some("not-allowed") | Some("notallowed") => {
                                        tao::window::CursorIcon::NotAllowed
                                    }
                                    Some("wait") | Some("progress") => {
                                        tao::window::CursorIcon::Progress
                                    }
                                    Some("grab") => tao::window::CursorIcon::Grab,
                                    Some("grabbing") => tao::window::CursorIcon::Grabbing,
                                    Some("col-resize") | Some("colresize") => {
                                        tao::window::CursorIcon::ColResize
                                    }
                                    Some("row-resize") | Some("rowresize") => {
                                        tao::window::CursorIcon::RowResize
                                    }
                                    // No explicit cursor — clickable nodes
                                    // get the pointer hand by default.
                                    _ if n.props.clickable => {
                                        tao::window::CursorIcon::Hand
                                    }
                                    _ => tao::window::CursorIcon::Default,
                                },
                                None => tao::window::CursorIcon::Default,
                            },
                            None => tao::window::CursorIcon::Default,
                        };
                        self.window.set_cursor_icon(icon);
                    }
                }
            }
            Event::WindowEvent {
                event:
                    WindowEvent::MouseInput {
                        state: ElementState::Pressed,
                        button: MouseButton::Left,
                        ..
                    },
                ..
            } => {
                let (hit, drag_region) = {
                    let s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                    (
                        s.hit_test(self.mouse_pos.0, self.mouse_pos.1),
                        s.hit_test_drag_region(self.mouse_pos.0, self.mouse_pos.1),
                    )
                };
                if std::env::var_os("CARBON_MINI_CLICK_DEBUG").is_some() {
                    eprintln!(
                        "[carbon-mini-click] mouse=({:.1}, {:.1}) hit={:?} drag_region={:?}",
                        self.mouse_pos.0, self.mouse_pos.1, hit, drag_region
                    );
                    // ALWAYS dump the node-stack under the cursor (not just on misses)
                    // so we can correlate "hit=Some(X)" with which clickables existed at
                    // that point. Helps catch buttons-without-onClick bugs.
                    {
                        let s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                        let (mx, my) = self.mouse_pos;
                        let mut hits: Vec<(u32, String, f32, f32, f32, f32, bool, bool)> = Vec::new();
                        fn collect(
                            s: &crate::scene::Scene,
                            id: u32,
                            ox: f32, oy: f32,
                            mx: f32, my: f32,
                            out: &mut Vec<(u32, String, f32, f32, f32, f32, bool, bool)>,
                        ) {
                            let Some(n) = s.nodes.get(&id) else { return; };
                            let Some(layout) = n.computed_layout else { return; };
                            let nx = ox + layout.location.x;
                            let ny = oy + layout.location.y;
                            let nw = layout.size.width;
                            let nh = layout.size.height;
                            if mx >= nx && my >= ny && mx <= nx + nw && my <= ny + nh {
                                out.push((id, n.tag.clone(), nx, ny, nw, nh, n.props.clickable, n.props.drag_region));
                                for &c in &n.children {
                                    collect(s, c, nx, ny, mx, my, out);
                                }
                            }
                        }
                        collect(&s, s.root, 0.0, 0.0, mx, my, &mut hits);
                        eprintln!("[carbon-mini-click]   stack ({:.0},{:.0}):", mx, my);
                        for (id, tag, nx, ny, nw, nh, cl, dr) in hits.iter().rev().take(8) {
                            eprintln!("    id={} tag={} box=({:.0},{:.0}) {:.0}x{:.0} clickable={} drag={}", id, tag, nx, ny, nw, nh, cl, dr);
                        }
                    }
                    if false {
                        let s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                        let (mx, my) = self.mouse_pos;
                        let mut hits: Vec<(u32, &str, f32, f32, f32, f32, bool, bool)> = Vec::new();
                        fn collect<'a>(
                            s: &'a crate::scene::Scene,
                            id: u32,
                            ox: f32, oy: f32,
                            mx: f32, my: f32,
                            out: &mut Vec<(u32, &'a str, f32, f32, f32, f32, bool, bool)>,
                        ) {
                            let Some(n) = s.nodes.get(&id) else { return; };
                            let Some(layout) = n.computed_layout else { return; };
                            let nx = ox + layout.location.x;
                            let ny = oy + layout.location.y;
                            let nw = layout.size.width;
                            let nh = layout.size.height;
                            if mx >= nx && my >= ny && mx <= nx + nw && my <= ny + nh {
                                out.push((id, n.tag.as_str(), nx, ny, nw, nh, n.props.clickable, n.props.drag_region));
                                for &c in &n.children {
                                    collect(s, c, nx, ny, mx, my, out);
                                }
                            }
                        }
                        collect(&s, s.root, 0.0, 0.0, mx, my, &mut hits);
                        eprintln!("[carbon-mini-click]   nodes containing point ({:.0},{:.0}):", mx, my);
                        for (id, tag, nx, ny, nw, nh, cl, dr) in hits.iter().rev().take(15) {
                            eprintln!("    id={} tag={} box=({:.0},{:.0}) {:.0}x{:.0} clickable={} drag={}", id, tag, nx, ny, nw, nh, cl, dr);
                        }
                    }
                }
                // Drag region wins ONLY when nothing clickable was hit.
                // `hit_test_drag_region` already guards against this, but
                // we double-check to be explicit. Calling drag_window()
                // here starts an OS-level move loop; this thread returns
                // to the event loop immediately while the OS drives the
                // drag until the user releases the mouse.
                if hit.is_none() && drag_region.is_some() {
                    let _ = self.window.drag_window();
                    // Don't fall through to the click-handler path —
                    // drag-region presses don't fire JS click events.
                    // Return from this closure call; the next OS event
                    // will dispatch a fresh invocation.
                    return;
                }
                if let Some(node_id) = hit {
                    // Update focus + position caret if the clicked node is
                    // an input. We compute box-local x by subtracting the
                    // cumulative parent offset and padding before handing
                    // to the caret hit-test.
                    let (is_input, box_x_local) = {
                        let s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                        let n = s.nodes.get(&node_id).cloned();
                        match n.as_ref().map(|n| n.kind.clone()) {
                            Some(scene::NodeKind::Input)
                            | Some(scene::NodeKind::Textarea) => {
                                // Walk up the tree to compute the node's
                                // absolute screen x-position from layout
                                // locations.
                                let abs_x = absolute_x(&s, node_id);
                                (true, self.mouse_pos.0 - abs_x)
                            }
                            _ => (false, 0.0),
                        }
                    };
                    if is_input {
                        // Multi-click: count this press as part of a streak
                        // when it lands on the same input fast enough and
                        // close enough to the previous one.
                        let now = Instant::now();
                        let same_target = self.last_click
                            .as_ref()
                            .map(|(t, p, n)| {
                                *n == node_id
                                    && now.duration_since(*t).as_millis() < 500
                                    && (self.mouse_pos.0 - p.0).abs() < 5.0
                                    && (self.mouse_pos.1 - p.1).abs() < 5.0
                            })
                            .unwrap_or(false);
                        self.click_streak = if same_target { self.click_streak + 1 } else { 1 };
                        if self.click_streak > 3 {
                            self.click_streak = 1;
                        }
                        self.last_click = Some((now, self.mouse_pos, node_id));

                        let mut s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                        s.focused = Some(node_id);
                        let extend = self.modifiers_state.shift_key();
                        // Pass mouse Y too so multi-line textareas know
                        // which line was clicked.
                        let abs_y = absolute_y(&s, node_id);
                        let local_y = self.mouse_pos.1 - abs_y;
                        let off = s.input_caret_from_xy(
                            node_id,
                            box_x_local,
                            local_y,
                            &mut self.text_engine.borrow_mut(),
                        );
                        match self.click_streak {
                            2 => {
                                // Double click: select the word at the
                                // hit-tested offset.
                                s.input_select_word(node_id, off);
                                // Drag from a double-click extends by
                                // word — disable for now and just leave
                                // the word selected.
                                self.dragging_input = None;
                            }
                            3 => {
                                // Triple click: select everything in this
                                // input. Matches what most OS text inputs
                                // do for `<input>`; for `<textarea>`,
                                // selecting the line is common too, but
                                // "all" is the simplest and most
                                // predictable here.
                                s.input_select_all(node_id);
                                self.dragging_input = None;
                            }
                            _ => {
                                s.input_set_caret(node_id, off, extend);
                                // Mark this input as "currently being
                                // drag-selected" so subsequent
                                // CursorMoved events extend the
                                // selection until mouse up.
                                self.dragging_input = Some(node_id);
                            }
                        }
                        s.dirty = true;
                        self.window.request_redraw();
                    } else {
                        // Clicking outside any input clears focus.
                        let mut s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                        if s.focused.is_some() {
                            s.focused = None;
                            s.dirty = true;
                            self.window.request_redraw();
                        }
                    }
                    let script = format!(
                        "globalThis.__cm_dispatch_click && globalThis.__cm_dispatch_click({});\nglobalThis.__cm_dispatch_pointer && globalThis.__cm_dispatch_pointer({}, \"down\", {}, {}, 0);",
                        node_id, node_id, self.mouse_pos.0, self.mouse_pos.1
                    );
                    let _ = self.js_ctx.with(|ctx| -> Result<()> {
                        ctx.eval::<(), _>(script.as_bytes())
                            .map_err(|e| anyhow!("dispatch click: {e}"))?;
                        Ok(())
                    });
                    // Click handlers commonly setState → schedule a render.
                    // Drain queued microtasks now so the render commits
                    // (and useEffects fire) before next user input.
                    drain_and_flush_react(&self.js_rt, &self.js_ctx);
                    self.pointer_down = Some(node_id);
                } else {
                    // Clicked into empty space — drop focus.
                    let mut s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                    if s.focused.is_some() {
                        s.focused = None;
                        s.dirty = true;
                        self.window.request_redraw();
                    }
                }
            }
            Event::WindowEvent {
                event: WindowEvent::ModifiersChanged(mods),
                ..
            } => {
                self.modifiers_state = mods;
            }
            Event::WindowEvent {
                event: WindowEvent::ThemeChanged(theme),
                ..
            } => {
                use tao::window::Theme;
                let name = match theme {
                    Theme::Dark => "dark",
                    _ => "light",
                };
                os_theme::set(name);
                let script = format!(
                    "globalThis.__cm_dispatch_theme_changed && globalThis.__cm_dispatch_theme_changed(\"{}\");",
                    name
                );
                let _ = self.js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
                // `window.theme_changed` — for plugins that draw something
                // themselves and therefore have their own colours to swap. A
                // plugin that only renders through JS is already covered by the
                // dispatch above.
                self.plugin_registry.dispatch_theme_changed(matches!(theme, Theme::Dark));
            }
            Event::WindowEvent {
                event: WindowEvent::Focused(focused),
                ..
            } => {
                let script = format!(
                    "globalThis.__cm_dispatch_window_focus && globalThis.__cm_dispatch_window_focus({});",
                    focused
                );
                let _ = self.js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event: WindowEvent::HoveredFile(path),
                ..
            } => {
                // OS drag-hover: file is being dragged across the window
                // (one event per file). Forwarded as a single 'enter'
                // dispatch — JS-side handlers can aggregate.
                let path_str = path.to_string_lossy().to_string();
                let path_json = serde_json::to_string(&path_str)
                    .unwrap_or_else(|_| "\"\"".into());
                let script = format!(
                    "globalThis.__cm_dispatch_file_drag && globalThis.__cm_dispatch_file_drag('enter', {});",
                    path_json
                );
                let _ = self.js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event: WindowEvent::HoveredFileCancelled,
                ..
            } => {
                // Drag exited the window without dropping — fire 'leave'
                // with no path so JS handlers can reset visual state.
                let script = "globalThis.__cm_dispatch_file_drag && globalThis.__cm_dispatch_file_drag('leave', null);";
                let _ = self.js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event: WindowEvent::DroppedFile(path),
                ..
            } => {
                // File dropped onto the window. tao fires one event per
                // file — JS sees one 'drop' dispatch per file. Apps that
                // want a "drop session complete" signal can debounce in
                // JS (the events arrive in the same event-loop tick).
                let path_str = path.to_string_lossy().to_string();
                let path_json = serde_json::to_string(&path_str)
                    .unwrap_or_else(|_| "\"\"".into());
                let script = format!(
                    "globalThis.__cm_dispatch_file_drag && globalThis.__cm_dispatch_file_drag('drop', {});",
                    path_json
                );
                let _ = self.js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event:
                    WindowEvent::MouseInput {
                        state: ElementState::Pressed,
                        button: MouseButton::Right,
                        ..
                    },
                ..
            } => {
                // Right-click → hit-test → dispatch context-menu event
                // to JS at the cursor position. App handlers can show a
                // floating menu via createPortal + absolute positioning.
                let hit = {
                    let s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                    s.hit_test(self.mouse_pos.0, self.mouse_pos.1)
                };
                let hit_arg = match hit {
                    Some(id) => id.to_string(),
                    None => "null".to_string(),
                };
                let script = format!(
                    "globalThis.__cm_dispatch_context_menu && globalThis.__cm_dispatch_context_menu({}, {}, {});",
                    hit_arg, self.mouse_pos.0, self.mouse_pos.1
                );
                let _ = self.js_ctx.with(|ctx| -> Result<()> {
                    let _ = ctx.eval::<(), _>(script.as_bytes());
                    Ok(())
                });
            }
            Event::WindowEvent {
                event:
                    WindowEvent::MouseInput {
                        state: ElementState::Released,
                        button: MouseButton::Left,
                        ..
                    },
                ..
            } => {
                // Drag-select complete — anchor stays where it was,
                // caret stays at last hit-test position.
                self.dragging_input = None;
                if let Some(pd_id) = self.pointer_down.take() {
                    let script = format!(
                        "globalThis.__cm_dispatch_pointer && globalThis.__cm_dispatch_pointer({}, \"up\", {}, {}, 0);",
                        pd_id, self.mouse_pos.0, self.mouse_pos.1
                    );
                    let _ = self.js_ctx.with(|ctx| -> Result<()> {
                        ctx.eval::<(), _>(script.as_bytes())
                            .map_err(|e| anyhow!("dispatch pointer up: {e}"))?;
                        Ok(())
                    });
                }
            }
            Event::WindowEvent {
                event: WindowEvent::KeyboardInput { event: key_event, .. },
                ..
            } => {
                if key_event.state != ElementState::Pressed {
                    return;
                }
                // App-level keyboard dispatch: forward the event to a
                // JS listener so apps can implement shortcuts without
                // hijacking the focused-input dispatch below. Listeners
                // see every keydown; modifier-key state is encoded in
                // the args. The dispatcher is a no-op if no app code
                // registered a handler.
                {
                    let key_label = match &key_event.logical_key {
                        Key::Character(s) => s.to_string(),
                        Key::Enter => "Enter".to_string(),
                        Key::Escape => "Escape".to_string(),
                        Key::Tab => "Tab".to_string(),
                        Key::Backspace => "Backspace".to_string(),
                        Key::Delete => "Delete".to_string(),
                        Key::ArrowUp => "ArrowUp".to_string(),
                        Key::ArrowDown => "ArrowDown".to_string(),
                        Key::ArrowLeft => "ArrowLeft".to_string(),
                        Key::ArrowRight => "ArrowRight".to_string(),
                        Key::Space => " ".to_string(),
                        Key::Home => "Home".to_string(),
                        Key::End => "End".to_string(),
                        Key::PageUp => "PageUp".to_string(),
                        Key::PageDown => "PageDown".to_string(),
                        Key::F1 => "F1".to_string(),
                        Key::F2 => "F2".to_string(),
                        Key::F3 => "F3".to_string(),
                        Key::F4 => "F4".to_string(),
                        Key::F5 => "F5".to_string(),
                        Key::F6 => "F6".to_string(),
                        Key::F7 => "F7".to_string(),
                        Key::F8 => "F8".to_string(),
                        Key::F9 => "F9".to_string(),
                        Key::F10 => "F10".to_string(),
                        Key::F11 => "F11".to_string(),
                        Key::F12 => "F12".to_string(),
                        other => format!("{:?}", other),
                    };
                    if std::env::var_os("CARBON_PERF").is_some() {
                        eprintln!("[perf] keydown key={:?} ctrl={}", key_label, self.modifiers_state.control_key());
                    }
                    let key_json = serde_json::to_string(&key_label)
                        .unwrap_or_else(|_| "\"\"".into());
                    let script = format!(
                        "globalThis.__cm_dispatch_keydown && globalThis.__cm_dispatch_keydown({},{},{},{},{});",
                        key_json,
                        self.modifiers_state.control_key(),
                        self.modifiers_state.shift_key(),
                        self.modifiers_state.alt_key(),
                        self.modifiers_state.super_key(),
                    );
                    let _ = self.js_ctx.with(|ctx| -> Result<()> {
                        let _ = ctx.eval::<(), _>(script.as_bytes());
                        Ok(())
                    });
                }
                // Global keybinds — checked BEFORE the focused-input
                // dispatch so they trigger no matter what's focused.
                if self.modifiers_state.control_key() {
                    let is_space = matches!(&key_event.logical_key, Key::Space)
                        || matches!(
                            &key_event.logical_key,
                            Key::Character(s) if &**s == " "
                        );
                    if is_space {
                        let mut s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                        s.debug_layout = !s.debug_layout;
                        s.dirty = true;
                        eprintln!(
                            "[carbon-mini] layout debug overlay: {}",
                            if s.debug_layout { "ON" } else { "OFF" }
                        );
                        self.window.request_redraw();
                        return;
                    }
                }
                let focused = self.scene.lock().unwrap_or_else(|e| e.into_inner()).focused;
                let fid = match focused {
                    Some(f) => f,
                    None => return,
                };
                let kind = self.scene
                    .lock()
                    .unwrap()
                    .nodes
                    .get(&fid)
                    .map(|n| n.kind.clone());
                if !matches!(
                    kind,
                    Some(scene::NodeKind::Input) | Some(scene::NodeKind::Textarea)
                ) {
                    return;
                }
                let is_textarea = matches!(kind, Some(scene::NodeKind::Textarea));
                let ctrl = self.modifiers_state.control_key();
                let shift = self.modifiers_state.shift_key();
                let mut value_changed: Option<String> = None;
                let mut s = self.scene.lock().unwrap_or_else(|e| e.into_inner());

                match &key_event.logical_key {
                    Key::Backspace => {
                        value_changed = s.input_backspace(fid);
                    }
                    Key::Delete => {
                        value_changed = s.input_delete(fid);
                    }
                    Key::ArrowLeft => {
                        s.input_move_caret(fid, scene::CaretMove::Left, shift);
                    }
                    Key::ArrowRight => {
                        s.input_move_caret(fid, scene::CaretMove::Right, shift);
                    }
                    Key::ArrowUp => {
                        if is_textarea {
                            let mw = s.editor_inner_width(fid);
                            s.input_move_caret_vertical(
                                fid,
                                true,
                                shift,
                                mw,
                                &mut self.text_engine.borrow_mut(),
                            );
                        }
                    }
                    Key::ArrowDown => {
                        if is_textarea {
                            let mw = s.editor_inner_width(fid);
                            s.input_move_caret_vertical(
                                fid,
                                false,
                                shift,
                                mw,
                                &mut self.text_engine.borrow_mut(),
                            );
                        }
                    }
                    Key::Home => {
                        s.input_move_caret(fid, scene::CaretMove::Home, shift);
                    }
                    Key::End => {
                        s.input_move_caret(fid, scene::CaretMove::End, shift);
                    }
                    Key::Enter if is_textarea => {
                        value_changed = s.input_insert_str(fid, "\n");
                    }
                    Key::Tab => {
                        // Tab / Shift+Tab traverses focus between Input /
                        // Textarea nodes in DOM order — same as a browser.
                        // Wraps at both ends. Caret jumps to start of the
                        // newly-focused input; selection cleared.
                        let focusables = s.focusable_inputs();
                        if !focusables.is_empty() {
                            let cur_idx =
                                focusables.iter().position(|id| *id == fid).unwrap_or(0);
                            let next_idx = if shift {
                                if cur_idx == 0 { focusables.len() - 1 } else { cur_idx - 1 }
                            } else {
                                (cur_idx + 1) % focusables.len()
                            };
                            let next_id = focusables[next_idx];
                            s.focused = Some(next_id);
                            // Caret to start, anchor too (no selection).
                            s.input_set_caret(next_id, 0, false);
                            s.dirty = true;
                        }
                    }
                    Key::Character(ch) if ctrl => {
                        // Ctrl+letter — clipboard / select-all / undo /
                        // redo shortcuts.
                        let ch_lower = ch.to_ascii_lowercase();
                        match ch_lower.as_str() {
                            "z" => {
                                value_changed = if shift {
                                    s.input_redo(fid)
                                } else {
                                    s.input_undo(fid)
                                };
                            }
                            "y" => {
                                value_changed = s.input_redo(fid);
                            }
                            "a" => s.input_select_all(fid),
                            "c" => {
                                if let Some(cb) = self.clipboard.as_mut() {
                                    let sel = s.input_selected_text(fid);
                                    if !sel.is_empty() {
                                        let _ = cb.set_text(sel);
                                    }
                                }
                            }
                            "x" => {
                                if let Some(cb) = self.clipboard.as_mut() {
                                    let sel = s.input_selected_text(fid);
                                    if !sel.is_empty() {
                                        let _ = cb.set_text(sel);
                                        value_changed = s.input_backspace(fid);
                                    }
                                }
                            }
                            "v" => {
                                if let Some(cb) = self.clipboard.as_mut() {
                                    if let Ok(t) = cb.get_text() {
                                        // Single-line input: strip newlines.
                                        let to_paste: String = if is_textarea {
                                            t
                                        } else {
                                            t.replace(['\n', '\r'], " ")
                                        };
                                        value_changed =
                                            s.input_insert_str(fid, &to_paste);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    Key::Character(ch) if !ctrl => {
                        // Plain typed character (already accounts for Shift
                        // via the OS keyboard layout — `ch` is already "A"
                        // when shift is held).
                        value_changed = s.input_insert_str(fid, ch);
                    }
                    _ => {
                        // Fall back to KeyEvent.text — covers OEM keys,
                        // dead-key composition output, etc.
                        if !ctrl {
                            if let Some(t) = &key_event.text {
                                if !t.is_empty()
                                    && !t.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
                                {
                                    value_changed = s.input_insert_str(fid, t);
                                }
                            }
                        }
                    }
                }
                drop(s);

                // Notify React/Solid via __cm_dispatch_input(id, value).
                if let Some(v) = value_changed {
                    let escaped = js_string_literal(&v);
                    let script = format!(
                        "globalThis.__cm_dispatch_input && globalThis.__cm_dispatch_input({},{});",
                        fid, escaped
                    );
                    let _ = self.js_ctx.with(|ctx| -> Result<()> {
                        ctx.eval::<(), _>(script.as_bytes())
                            .map_err(|e| anyhow!("dispatch input: {e}"))?;
                        Ok(())
                    });
                    drain_js_jobs(&self.js_rt);
                }
                self.window.request_redraw();
            }
            Event::WindowEvent {
                event: WindowEvent::MouseWheel { delta, .. },
                ..
            } => {
                // Pixel delta works for trackpads; LineDelta needs
                // multiplying by a per-line height. We use 32 logical
                // pixels per line as a sensible UI default (matches the
                // tiny-skia text line-heights we emit).
                // PixelDelta is PHYSICAL px on a DPI-aware window; scroll math
                // and the DOM wheel event work in LOGICAL px, so scale down.
                let sf = (self.window.scale_factor() as f32).max(0.1);
                let (dx, dy) = match delta {
                    tao::event::MouseScrollDelta::PixelDelta(p) => (p.x as f32 / sf, p.y as f32 / sf),
                    tao::event::MouseScrollDelta::LineDelta(cols, lines) => (cols * 32.0, lines * 32.0),
                    _ => (0.0, 0.0),
                };
                // For the DOM `wheel` event we keep the OS-native delta kind:
                // mouse wheels report whole lines (deltaMode=1, ~3 rows/notch
                // is the conventional terminal feel), trackpads report pixels
                // (deltaMode=0). xterm's wheel normalizer divides pixel deltas
                // heavily, so sending line deltas as pixels scrolls <1 row.
                let (wheel_dx, wheel_dy, wheel_mode): (f32, f32, i32) = match delta {
                    tao::event::MouseScrollDelta::PixelDelta(p) => (-(p.x as f32) / sf, -(p.y as f32) / sf, 0),
                    tao::event::MouseScrollDelta::LineDelta(cols, lines) => {
                        (-cols * 3.0, -lines * 3.0, 1)
                    }
                    _ => (0.0, 0.0, 0),
                };
                if std::env::var_os("CARBON_MINI_SCROLL_DEBUG").is_some() {
                    eprintln!(
                        "[carbon-mini-wheel] delta={:?} dx={:.1} dy={:.1} mouse=({:.1},{:.1})",
                        delta, dx, dy, self.mouse_pos.0, self.mouse_pos.1
                    );
                }
                if dy.abs() > 0.0 || dx.abs() > 0.0 {
                    // First give JS a real DOM `wheel` event at the element
                    // under the cursor. Anything that scrolls its own content
                    // (xterm's buffer, a custom virtual list) consumes it via
                    // preventDefault — in that case we must NOT also move a
                    // carbon scrollport, or the two fight (the symptom: the
                    // terminal "scrolls" but never reaches its real top/bottom
                    // because the canvas is being slid instead of its rows
                    // re-rendered). DOM delta sign is the negative of tao's.
                    let hit = self.scene.lock().unwrap_or_else(|e| e.into_inner()).hit_test(self.mouse_pos.0, self.mouse_pos.1);
                    let mut handled = false;
                    if let Some(node_id) = hit {
                        let script = format!(
                            "(globalThis.__cm_dispatch_wheel && globalThis.__cm_dispatch_wheel({},{},{},{},{},{}))||false",
                            node_id, wheel_dx, wheel_dy, wheel_mode, self.mouse_pos.0, self.mouse_pos.1
                        );
                        handled = self.js_ctx
                            .with(|ctx| ctx.eval::<bool, _>(script.as_bytes()).unwrap_or(false));
                    }
                    if std::env::var_os("CARBON_MINI_SCROLL_DEBUG").is_some() {
                        eprintln!("[carbon-mini-wheel] hit={:?} js_handled={}", hit, handled);
                    }
                    if handled {
                        // xterm re-renders the scrolled rows on a rAF tick;
                        // the redraw handler drains the rAF queue before
                        // painting, so a redraw request is all we need.
                        self.window.request_redraw();
                    } else {
                        // Native scrollport fallback (file tree, chat, etc.).
                        let mut s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                        let target = s.hit_test_scrollable(self.mouse_pos.0, self.mouse_pos.1);
                        if std::env::var_os("CARBON_MINI_SCROLL_DEBUG").is_some() {
                            eprintln!("[carbon-mini-wheel] scrollport target={:?}", target);
                        }
                        if let Some(node_id) = target {
                            let cur = s.scroll_y(node_id);
                            // Wheel-down (toward user, dy<0) increases scroll_y
                            // so content moves up; wheel-up decreases it.
                            let new_y = s.set_scroll_y(node_id, cur - dy);
                            if std::env::var_os("CARBON_MINI_SCROLL_DEBUG").is_some() {
                                eprintln!(
                                    "[carbon-mini-wheel] node={} {:.1} -> {:.1}",
                                    node_id, cur, new_y
                                );
                            }
                            self.window.request_redraw();
                        }
                    }
                }
            }
            Event::UserEvent(UserEvent::RequestPaint) => {
                self.window.request_redraw();
            }
            Event::UserEvent(UserEvent::FetchHeaders { id, status, headers_json }) => {
                // headers_json is already a valid JSON array literal, so
                // it's a legal JS expression — splice it directly into
                // the dispatch call instead of double-stringifying.
                let script = format!(
                    "globalThis.__cm_fetch_dispatch_headers && globalThis.__cm_fetch_dispatch_headers({},{},{});",
                    id, status, headers_json,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::FetchChunk { id, data }) => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                let script = format!(
                    "globalThis.__cm_fetch_dispatch_chunk && globalThis.__cm_fetch_dispatch_chunk({},\"{}\");",
                    id, b64,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::FetchEnd { id }) => {
                let script = format!(
                    "globalThis.__cm_fetch_dispatch_end && globalThis.__cm_fetch_dispatch_end({});",
                    id,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::FetchError { id, message }) => {
                let msg = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".to_string());
                let script = format!(
                    "globalThis.__cm_fetch_dispatch_error && globalThis.__cm_fetch_dispatch_error({},{});",
                    id, msg,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::ChannelMessage { channel_id, json }) => {
                // `json` is already a valid JSON object literal (built via
                // serde_json::json! on the sending side), so splice it
                // directly rather than re-stringifying it into a JS string.
                let script = format!(
                    "globalThis.__cm_channel_dispatch && globalThis.__cm_channel_dispatch({},{});",
                    channel_id, json,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::WsOpen { id }) => {
                let script = format!(
                    "globalThis.__cm_ws_dispatch_open && globalThis.__cm_ws_dispatch_open({});",
                    id,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::WsMessage { id, data, is_text }) => {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
                let script = format!(
                    "globalThis.__cm_ws_dispatch_message && globalThis.__cm_ws_dispatch_message({},\"{}\",{});",
                    id, b64, is_text,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::WsClose { id, code, reason }) => {
                let reason_json = serde_json::to_string(&reason).unwrap_or_else(|_| "\"\"".to_string());
                let script = format!(
                    "globalThis.__cm_ws_dispatch_close && globalThis.__cm_ws_dispatch_close({},{},{});",
                    id, code, reason_json,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::WsError { id, message }) => {
                let msg = serde_json::to_string(&message).unwrap_or_else(|_| "\"\"".to_string());
                let script = format!(
                    "globalThis.__cm_ws_dispatch_error && globalThis.__cm_ws_dispatch_error({},{});",
                    id, msg,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
            }
            Event::UserEvent(UserEvent::PtyOutput { id }) => {
                let script = format!(
                    "globalThis.__cm_pty_dispatch_output && globalThis.__cm_pty_dispatch_output({});",
                    id,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
                drain_and_flush_react(&self.js_rt, &self.js_ctx);
                self.window.request_redraw();
            }
            Event::UserEvent(UserEvent::PtyExit { id }) => {
                let script = format!(
                    "globalThis.__cm_pty_dispatch_exit && globalThis.__cm_pty_dispatch_exit({});",
                    id,
                );
                let _ = self.js_ctx.with(|ctx| ctx.eval::<(), _>(script.as_bytes()));
                drain_and_flush_react(&self.js_rt, &self.js_ctx);
                self.window.request_redraw();
            }
            Event::UserEvent(UserEvent::WindowOp(op)) => {
                use crate::WindowOp::*;
                match op {
                    Show => self.window.set_visible(true),
                    Hide => self.window.set_visible(false),
                    Minimize => self.window.set_minimized(true),
                    Maximize => self.window.set_maximized(true),
                    Unmaximize => self.window.set_maximized(false),
                    ToggleMaximize => self.window.set_maximized(!self.window.is_maximized()),
                    Restore => {
                        self.window.set_minimized(false);
                        self.window.set_visible(true);
                    }
                    Focus => self.window.set_focus(),
                    Close => *control_flow = ControlFlow::Exit,
                }
            }
            Event::UserEvent(UserEvent::WindowSetTitle(title)) => {
                self.window.set_title(&title);
            }
            Event::UserEvent(UserEvent::WindowSetFullscreen(on)) => {
                if on {
                    self.window.set_fullscreen(Some(tao::window::Fullscreen::Borderless(None)));
                } else {
                    self.window.set_fullscreen(None);
                }
            }
            Event::UserEvent(UserEvent::WindowStartDrag) => {
                // Begins an OS-level move loop. Returns immediately;
                // movement is driven by the OS until the user releases
                // the mouse. Errors silently if the window is in a
                // state that doesn't allow drag (e.g. maximized).
                let _ = self.window.drag_window();
            }
            Event::UserEvent(UserEvent::PluginEvent { name, payload }) => {
                // Dispatch the event into JS. The dispatcher (installed at
                // startup) routes it to all `globalThis.carbon.on(name, …)`
                // subscribers. We keep this on the JS thread (event loop's
                // closure runs there).
                let escaped_name = json_escape(&name);
                let payload_for_eval = if payload.is_empty() {
                    "null".to_string()
                } else {
                    json_escape(&payload)
                };
                let script = format!(
                    "globalThis.__carbon_on_event && globalThis.__carbon_on_event(\"{escaped_name}\", \"{payload_for_eval}\");"
                );
                let _ = self.js_ctx.with(|ctx| -> Result<()> {
                    if let Err(e) = ctx.eval::<(), _>(script.as_bytes()) {
                        eprintln!("[carbon-mini-plugin] dispatch `{name}` failed: {e}");
                    }
                    Ok(())
                });
            }
            Event::UserEvent(UserEvent::ReloadBundle) => {
                let t_reload = Instant::now();
                if let Some(path) = &self.reload_path {
                    // 0. Notify plugins that an HMR reload is about to start
                    //    so they can pause workers and drop JS-owned values.
                    self.plugin_registry.dispatch_before_reload();

                    // 1. Tell the JS side to harvest signals + drop its
                    //    renderer state. The user's bundle exports a
                    //    __cm_hmr_reset hook on globalThis the first time
                    //    it loads (see carbon/runtime/engine/paint/renderers/solid/src/index.ts);
                    //    this clears rootNode, click handlers, nextId etc.
                    //    so the next mount() builds a fresh tree.
                    let _ = self.js_ctx.with(|ctx| -> Result<()> {
                        ctx.eval::<(), _>(
                            "globalThis.__cm_hmr_reset && globalThis.__cm_hmr_reset();"
                                .as_bytes(),
                        )
                        .ok();
                        Ok(())
                    });

                    // 2. Reset the Rust-side scene graph: drop every node
                    //    and the Taffy tree. The next bundle's mount() call
                    //    will recreate root + children with fresh IDs.
                    {
                        let mut s = self.reload_scene.lock().unwrap_or_else(|e| e.into_inner());
                        s.reset_for_hmr();
                    }

                    // 3. Re-eval the bundle in the SAME context. The
                    //    __hmr_state Map on globalThis survives because
                    //    we don't drop the runtime — createPersistentSignal
                    //    reads its previous values back during construction.
                    //
                    //    `lifecycle.before_bundle_eval` fires here too: the
                    //    point is defined as "before EACH evaluation", and a
                    //    plugin whose global must precede the bundle needs it
                    //    to precede the reloaded one as well.
                    self.plugin_registry.dispatch_before_bundle_eval();
                    match load_and_eval_bundle(&self.js_ctx, path) {
                        Ok(()) => {
                            let ms = t_reload.elapsed().as_secs_f64() * 1000.0;
                            eprintln!("[carbon-mini-hmr] reloaded in {ms:.1} ms");
                        }
                        Err(e) => {
                            eprintln!("[carbon-mini-hmr] reload FAILED: {e:#}");
                        }
                    }

                    // 4. Plugins re-install whatever globals the bundle's
                    //    re-eval clobbered. We do NOT call register again;
                    //    plugins manage their own re-init via after_reload.
                    self.plugin_registry.dispatch_after_reload();

                    // 5. Repaint with the new tree.
                    self.window.request_redraw();
                }
            }
            Event::RedrawRequested(_) => {
                prof_zone!("frame_redraw_event");

                // Drain any pending requestAnimationFrame callbacks before
                // we paint. They may issue draw commands that change the
                // wgpu surface contents; we want those committed *before*
                // the readback path picks them up below.
                // Also drain JS microtasks so any Promises / passive
                // effects scheduled inside the raf callback run before
                // paint instead of next frame.
                // On the very first paint, SKIP this drain — paint the initial
                // tree first (the deferred effect drain runs after we present,
                // below). Every later frame drains rAF + microtasks before paint.
                let drained = if self.first_paint_done {
                    let _js_t = Instant::now();
                    drain_js_jobs(&self.js_rt);
                    let d = self.js_ctx.with(|ctx| -> bool {
                        let now_ms = (Instant::now().elapsed().as_secs_f64() * 1000.0) as f64;
                        let script = format!(
                            "globalThis.__cm_drain_raf && globalThis.__cm_drain_raf({});",
                            now_ms
                        );
                        let _ = ctx.eval::<(), _>(script.as_bytes());
                        // Whether anything was drained — if so, request another paint
                        // so the rAF loop continues.
                        let q_size: i64 = ctx
                            .eval::<i64, _>(
                                "globalThis.__cm_raf_queue ? globalThis.__cm_raf_queue.size : 0".as_bytes(),
                            )
                            .unwrap_or(0);
                        q_size > 0
                    });
                    // Pump JS microtasks again so passive effects scheduled
                    // inside raf / setTimeout callbacks fire this frame.
                    drain_js_jobs(&self.js_rt);
                    if std::env::var_os("CARBON_PERF").is_some() {
                        let ms = _js_t.elapsed().as_secs_f64() * 1000.0;
                        if ms > 3.0 {
                            eprintln!("[perf]   js raf+microtasks: {ms:.1}ms (drained={d})");
                        }
                    }
                    d
                } else {
                    false
                };

                // ─── Damage Tracking ───────────────────────────────────────────
                // Two damage flags: `dirty` forces a layout pass + paint;
                // `repaint_dirty` forces only paint (cached layout reused).
                // Scroll, hover, focus blink — anything that changes pixels
                // without changing any node's box — sets `repaint_dirty`.
                // Idle frames where neither is set short-circuit out.
                let (scene_dirty, repaint_dirty) = {
                    let s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                    (s.dirty, s.repaint_dirty)
                };

                if !scene_dirty && !repaint_dirty && self.first_paint_done {
                    // Nothing VISUAL changed this frame. Draining rAF is NOT by
                    // itself a reason to repaint: an idle app with a live timer
                    // (xterm cursor blink, a stray setInterval, a settled motion
                    // animation) keeps the rAF queue non-empty every frame, and
                    // the old `!drained` guard meant we ran a full
                    // layout+paint+readback ~80×/sec while completely idle. Scene
                    // mutations performed during the drain set `dirty` /
                    // `repaint_dirty` synchronously (see scene.rs set_prop /
                    // insert_node / set_text), so genuine changes still paint.
                    // Keep the rAF loop ticking (so timers/animations fire next
                    // frame) but skip the paint pass entirely.
                    if drained { self.window.request_redraw(); }
                    return;
                }

                let size = self.window.inner_size();
                let (w, h) = (size.width.max(1), size.height.max(1));
                if let (Some(nw), Some(nh)) = (NonZeroU32::new(w), NonZeroU32::new(h)) {
                    if let Err(_e) = self.surface.resize(nw, nh) {
                        return;
                    }
                    // Lazy-allocate / resize the caller-owned pixmap.
                    let canvas_ok = match &mut self.paint_canvas {
                        Some(c) => c.ensure_size(w, h),
                        None => {
                            self.paint_canvas = paint::Canvas::new(w, h);
                            self.paint_canvas.is_some()
                        }
                    };
                    if !canvas_ok { return; }
                    let canvas = self.paint_canvas.as_mut().unwrap();
                    if let Ok(mut buffer) = self.surface.buffer_mut() {
                        // HiDPI: the buffer/pixmap are PHYSICAL px (w,h), but
                        // layout runs in LOGICAL (CSS) px — physical / scale.
                        // paint() then scales geometry (root transform) and
                        // text (TextEngine::scale) up to physical. This keeps
                        // the scene graph + JS geometry in CSS px (matching a
                        // browser) while rendering crisp at native resolution.
                        let scale_f = (self.window.scale_factor() as f32).max(0.1);
                        {
                            prof_zone!("frame_layout");
                            let mut scene_g = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                            scene_g.compute_layout(
                                w as f32 / scale_f,
                                h as f32 / scale_f,
                                &mut self.text_engine.borrow_mut(),
                            );
                        }
                        // Two paint modes:
                        //   * Scoped: !dirty && dirty_rect.is_some()
                        //     Fast path. Skip whole-pixmap clear; instead
                        //     erase ONLY the damage rect (so old text /
                        //     stale pixels inside it are guaranteed gone)
                        //     and let paint_node's cull skip everything
                        //     outside it.
                        //   * Full: dirty=true (or no scoped damage)
                        //     Slow path. clear_white the whole pixmap and
                        //     paint everything. Must NULL the dirty_rect
                        //     before paint, otherwise the paint_node cull
                        //     would treat a stale rect from a prior
                        //     scroll as the current damage and skip nodes
                        //     that need to repaint.
                        let scoped_damage = {
                            let s = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                            !s.dirty && s.dirty_rect.is_some()
                        };
                        if scoped_damage {
                            // Erase only the damage rect to white. This
                            // hard-resets pixels in the rect before paint
                            // so any text / chip / glyph from the previous
                            // frame is guaranteed gone, killing the
                            // alpha-stacking artifact that "skip clear +
                            // rely on bg fills" left at edges where the
                            // bg fill didn't fully cover.
                            if let Some((dx, dy, dw, dh)) = self.scene.lock().unwrap_or_else(|e| e.into_inner()).dirty_rect {
                                // dirty_rect is in LOGICAL px (scene coords);
                                // the pixmap is physical, so scale the erase.
                                if let Some(rect) = Rect::from_xywh(dx, dy, dw.max(0.001), dh.max(0.001)) {
                                    let mut p = Paint::default();
                                    p.set_color_rgba8(255, 255, 255, 255);
                                    p.anti_alias = false;
                                    canvas.pixmap.fill_rect(
                                        rect,
                                        &p,
                                        Transform::from_scale(scale_f, scale_f),
                                        None,
                                    );
                                }
                            }
                        } else {
                            canvas.clear_white();
                            // Throw away any stale damage rect so the
                            // paint_node cull doesn't apply during a
                            // full-window paint.
                            self.scene.lock().unwrap_or_else(|e| e.into_inner()).dirty_rect = None;
                        }
                        // before_paint now hands plugins a real RGBA8 buffer
                        // they can blit into. Canvas plugins read their
                        // wgpu offscreen render target and blit to their
                        // layout box; FPS / telemetry plugins just observe.
                        let stride = canvas.stride_bytes();
                        self.plugin_registry.dispatch_before_paint(
                            canvas.as_bytes_mut(),
                            w,
                            h,
                            stride,
                        );
                        let _perf_paint = std::time::Instant::now();
                        paint::paint(
                            &self.scene.lock().unwrap_or_else(|e| e.into_inner()),
                            &mut canvas.pixmap,
                            &mut buffer,
                            w,
                            h,
                            scale_f,
                            &mut self.text_engine.borrow_mut(),
                        );
                        if std::env::var_os("CARBON_PERF").is_some() {
                            let ms = _perf_paint.elapsed().as_secs_f64() * 1000.0;
                            if ms > 2.0 { eprintln!("[perf] paint: {ms:.1}ms"); }
                        }

                        // Clear all damage flags after successful paint.
                        // Next RedrawRequested will short-circuit unless
                        // something else marks the scene damaged again.
                        {
                            let mut scene_g = self.scene.lock().unwrap_or_else(|e| e.into_inner());
                            scene_g.dirty = false;
                            scene_g.repaint_dirty = false;
                            scene_g.dirty_rect = None;
                        }

                        // Mark first frame success for updater crash-counter reset.
                        // Only fires once per session — subsequent paints don't re-execute.
                        #[cfg(feature = "updater")]
                        {
                            static FIRST_FRAME_MARKED: std::sync::atomic::AtomicBool =
                                std::sync::atomic::AtomicBool::new(false);
                            if !FIRST_FRAME_MARKED.swap(true, std::sync::atomic::Ordering::SeqCst) {
                                if let Ok(install_dir) = std::env::var("CARBON_INSTALL_DIR") {
                                    let _ = carbon_updater::SlotState::load(std::path::Path::new(&install_dir))
                                        .and_then(|mut state| {
                                            state.mark_first_frame(std::path::Path::new(&install_dir))
                                        })
                                        .map_err(|e| eprintln!("[updater] first-frame mark failed: {e}"));
                                }
                            }
                        }

                        let _ = buffer.present();
                        self.plugin_registry.dispatch_after_paint();

                        // ─── First paint just hit the screen ───────────────
                        if !self.first_paint_done {
                            self.first_paint_done = true;
                            timing_log("first_paint_visible", self.t0);
                            timing_done("startup → first paint", self.t0);
                            // Now run the deferred React effect drain (useEffect,
                            // async data loads, terminal spawn, …). The shell is
                            // already visible; this fills in the content and then
                            // we repaint with it.
                            drain_and_flush_react(&self.js_rt, &self.js_ctx);
                            timing_log("effects_drained", self.t0);
                            timing_done("startup → content ready", self.t0);
                            self.window.request_redraw();
                        }
                    }
                }

                // Schedule the next frame if rAF callbacks scheduled new ones
                // (which is the typical pattern: a callback re-arms itself).
                if drained {
                    self.window.request_redraw();
                }
            }
            _ => {}
        }

    }
}

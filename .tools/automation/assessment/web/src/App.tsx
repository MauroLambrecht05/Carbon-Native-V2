import { useReducer, useEffect } from "react";
import { Routes, Route, NavLink, useLocation } from "react-router-dom";
import { AppContext, reducer, initialState } from "./lib/store";
import { fetchModel, fetchOverrides } from "./lib/api";
import { buildIndexes } from "./lib/types";
import ExplorerView     from "./components/views/ExplorerView";
import LogicView        from "./components/views/LogicView";
import FlowView         from "./components/views/FlowView";
import SearchView       from "./components/views/SearchView";
import GraphView        from "./components/views/GraphView";
import ReviewView       from "./components/views/ReviewView";
import CoverageView     from "./components/views/CoverageView";

const NAV = [
  { to: "/",        icon: "⬡", label: "Explorer",  badge: "entities" },
  { to: "/logic",   icon: "⎇", label: "Logic",      badge: "rules" },
  { to: "/flows",   icon: "↓", label: "Flows",      badge: "flows" },
  { to: "/search",  icon: "⌕", label: "Search",     badge: null },
  { to: "/graph",   icon: "◈", label: "Graph",      badge: null },
  { to: "/review",  icon: "✱", label: "Review",     badge: "queue" },
  { to: "/coverage",icon: "⊞", label: "Coverage",   badge: null },
];

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const location = useLocation();

  useEffect(() => {
    Promise.all([fetchModel(), fetchOverrides()])
      .then(([model, overrides]) => {
        const indexes = buildIndexes(model);
        dispatch({ type: "SET_MODEL", model, indexes });
        dispatch({ type: "SET_OVERRIDES", overrides });
      })
      .catch((e: Error) => {
        dispatch({ type: "SET_ERROR", error: e.message });
      });
  }, []);

  const model   = state.model;
  const pending = state.overrides.overrides.filter(o => o.reviewStatus === "pending").length;

  function badgeCount(key: string | null): number | null {
    if (!model || !key) return null;
    switch (key) {
      case "entities": return model.entities.length;
      case "rules":    return model.rules.length;
      case "flows":    return model.flows.length;
      case "queue":    return model.potentialIssues.length + model.contradictions.length + pending;
      default:         return null;
    }
  }

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      <div className="app">

        {/* Top bar */}
        <header className="topbar">
          <div className="topbar-logo">Carbon <span>Native</span> — Semantic Explorer</div>
          <div className="topbar-sep" />
          {model && (
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {model.entities.length} entities · {model.rules.length} rules · {model.flows.length} flows
              {" · "}generated {new Date(model.meta.generatedAt).toLocaleString()}
            </span>
          )}
        </header>

        <div className="main-layout">

          {/* Sidebar navigation */}
          <nav className="sidebar">
            <div className="nav-section">
              <div className="nav-section-label">Navigation</div>
              {NAV.map(item => {
                const count = badgeCount(item.badge);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === "/"}
                    className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
                  >
                    <span className="nav-icon">{item.icon}</span>
                    {item.label}
                    {count !== null && count > 0 && (
                      <span className="nav-badge">{count}</span>
                    )}
                  </NavLink>
                );
              })}
            </div>

            {/* Model info */}
            {model && (
              <div style={{ marginTop: "auto", padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.8 }}>
                  <div>v{model.meta.version}</div>
                  <div>{model.relationships.length} relationships</div>
                  <div>{model.contradictions.length} contradictions</div>
                </div>
              </div>
            )}
          </nav>

          {/* Main content */}
          <main className="content-area">
            {state.loading && (
              <div className="center-message">
                <div style={{ fontSize: 32 }}>⬡</div>
                <h2>Loading semantic model…</h2>
                <p>Run <code>bun run assess</code> first if this takes too long.</p>
              </div>
            )}
            {state.error && (
              <div className="center-message">
                <div style={{ fontSize: 32, color: "var(--red)" }}>✕</div>
                <h2>Failed to load model</h2>
                <p style={{ color: "var(--red)" }}>{state.error}</p>
                <p>Run <code>bun run assess</code> from <code>.tools/automation/assessment/</code></p>
              </div>
            )}
            {!state.loading && !state.error && (
              <Routes>
                <Route path="/"         element={<ExplorerView />} />
                <Route path="/logic"    element={<LogicView />} />
                <Route path="/flows"    element={<FlowView />} />
                <Route path="/search"   element={<SearchView />} />
                <Route path="/graph"    element={<GraphView />} />
                <Route path="/review"   element={<ReviewView />} />
                <Route path="/coverage" element={<CoverageView />} />
              </Routes>
            )}
          </main>

        </div>
      </div>
    </AppContext.Provider>
  );
}

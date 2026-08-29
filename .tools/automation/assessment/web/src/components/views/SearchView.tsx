import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "@/lib/store";
import { searchModel, tracePath } from "@/lib/types";
import { EntityChip, ConfidenceBadge } from "@/components/ui/EntityChip";

const QUICK_SEARCHES = [
  "authentication",
  "production deployment",
  "how does carbon-cli build",
  "what happens when token expires",
  "host boundary",
  "plugin",
  "signing",
  "startup",
  "CI pipeline",
  "contracts",
];

export default function SearchView() {
  const { state, dispatch } = useApp();
  const { model, indexes } = state;
  const navigate = useNavigate();

  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    if (!model || !indexes || !query.trim()) return null;
    return searchModel(model, indexes, query);
  }, [model, indexes, query]);

  function selectEntity(id: string) {
    dispatch({ type: "SELECT_ENTITY", id });
    navigate("/");
  }
  function selectRule(id: string) {
    dispatch({ type: "SELECT_RULE", id });
    navigate("/logic");
  }
  function selectFlow(id: string) {
    dispatch({ type: "SELECT_FLOW", id });
    navigate("/flows");
  }

  if (!model) return null;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Search input */}
      <div style={{ padding: "20px 24px 0" }}>
        <div className="search-bar" style={{ maxWidth: 680, marginBottom: 12 }}>
          <span className="search-icon">⌕</span>
          <input
            placeholder="Search the semantic model — try 'authentication', 'how does carbon-cli build', 'production deployment'…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
            style={{ fontSize: 15 }}
          />
          {query && (
            <button className="btn" style={{ padding: "2px 8px", fontSize: 12 }} onClick={() => setQuery("")}>
              ✕
            </button>
          )}
        </div>

        {/* Quick searches */}
        {!query && (
          <div style={{ marginBottom: 12 }}>
            <div className="detail-section-title" style={{ marginBottom: 8 }}>Quick searches</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {QUICK_SEARCHES.map(q => (
                <button
                  key={q}
                  className="btn"
                  onClick={() => setQuery(q)}
                  style={{ fontSize: 12, color: "var(--accent)" }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="scrollable" style={{ flex: 1, padding: "0 24px 24px" }}>

        {results && (
          <>
            {results.entities.length + results.rules.length + results.flows.length === 0 && (
              <div className="center-message" style={{ padding: 40 }}>
                <p className="text-muted">No results for "{query}"</p>
                <p className="text-small text-muted">Try broader terms: "auth", "build", "deploy", "plugin"</p>
              </div>
            )}

            {/* Entity results */}
            {results.entities.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="detail-section-title" style={{ marginBottom: 8 }}>
                  Entities ({results.entities.length})
                </div>
                {results.entities.map(e => (
                  <div
                    key={e.id}
                    className="entity-row card"
                    style={{ marginBottom: 6, maxWidth: 680 }}
                    onClick={() => selectEntity(e.id)}
                  >
                    <EntityChip type={e.type} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>{e.name}</div>
                      <div className="text-dim text-small">{e.description.slice(0, 120)}</div>
                    </div>
                    <ConfidenceBadge confidence={e.confidence} />
                  </div>
                ))}
              </div>
            )}

            {/* Rule results */}
            {results.rules.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="detail-section-title" style={{ marginBottom: 8 }}>
                  Rules & Checks ({results.rules.length})
                </div>
                {results.rules.map(r => (
                  <div
                    key={r.id}
                    className="rule-card"
                    style={{ maxWidth: 680, marginBottom: 6 }}
                    onClick={() => selectRule(r.id)}
                  >
                    <div style={{ display: "flex", gap: 8, marginBottom: 4, alignItems: "center" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: "var(--text-muted)" }}>
                        {r.kind}
                      </span>
                      <span className="text-small text-muted">in {r.context}</span>
                    </div>
                    <div className="rule-condition">IF {r.condition.slice(0, 100)}</div>
                    <div className="rule-action">→ {r.action.slice(0, 100)}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Flow results */}
            {results.flows.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="detail-section-title" style={{ marginBottom: 8 }}>
                  Flows ({results.flows.length})
                </div>
                {results.flows.map(f => (
                  <div
                    key={f.id}
                    className="entity-row card"
                    style={{ marginBottom: 6, maxWidth: 680 }}
                    onClick={() => selectFlow(f.id)}
                  >
                    <span style={{ color: "var(--accent)", fontSize: 18 }}>↓</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>{f.name}</div>
                      <div className="text-dim text-small">{f.description.slice(0, 120)}</div>
                      {f.trigger && (
                        <div className="text-mono" style={{ fontSize: 11, color: "var(--cyan)", marginTop: 2 }}>
                          Trigger: {f.trigger}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Trace section */}
        {(state.traceFrom || state.traceTo) && indexes && (
          <div style={{ marginTop: 24, maxWidth: 680 }}>
            <div className="detail-section-title" style={{ marginBottom: 8 }}>Trace Path</div>
            <div className="card">
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                <span className="text-muted text-small">From:</span>
                <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  {state.traceFrom ?? "(not set)"}
                </span>
                <span className="text-muted">→</span>
                <span className="text-muted text-small">To:</span>
                <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  {state.traceTo ?? "(not set)"}
                </span>
              </div>
              {state.traceFrom && state.traceTo && (() => {
                const path = tracePath(state.traceFrom, state.traceTo, indexes);
                return path ? (
                  <div>
                    <div className="text-small text-dim" style={{ marginBottom: 6 }}>
                      Path found ({path.length} hops):
                    </div>
                    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                      {path.map((id, i) => {
                        const e = indexes.byId.get(id);
                        return (
                          <span key={id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <button
                              className="btn text-small"
                              style={{ color: "var(--accent)" }}
                              onClick={() => selectEntity(id)}
                            >
                              {e?.shortName ?? e?.name ?? id}
                            </button>
                            {i < path.length - 1 && <span className="text-muted">→</span>}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="text-small text-muted">No path found between these entities.</div>
                );
              })()}
              <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
                <button className="btn" onClick={() => dispatch({ type: "SET_TRACE", from: null, to: null })}>
                  Clear trace
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

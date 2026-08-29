import { useState, useMemo } from "react";
import { useApp } from "@/lib/store";
import { ConfidenceBadge } from "@/components/ui/EntityChip";
import { EvidenceList } from "@/components/ui/EvidenceList";
import type { SemanticRule } from "@/lib/types";

const KIND_COLORS: Record<string, string> = {
  guard:      "var(--red)",
  check:      "var(--cyan)",
  validation: "var(--yellow)",
  rule:       "var(--green)",
  policy:     "var(--purple)",
};

export default function LogicView() {
  const { state, dispatch } = useApp();
  const { model, selectedRuleId } = state;

  const [search,      setSearch]     = useState("");
  const [kindFilter,  setKindFilter] = useState("ALL");
  const [ctxFilter,   setCtxFilter]  = useState("ALL");
  const [sortBy,      setSortBy]     = useState<"context" | "kind" | "name">("context");

  const rules = model?.rules ?? [];

  const contexts = useMemo(() =>
    [...new Set(rules.map(r => r.context))].sort(),
    [rules]
  );

  const filtered = useMemo(() => {
    let list = rules;
    if (kindFilter !== "ALL") list = list.filter(r => r.kind === kindFilter);
    if (ctxFilter  !== "ALL") list = list.filter(r => r.context === ctxFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.condition.toLowerCase().includes(q) ||
        r.action.toLowerCase().includes(q) ||
        r.context.toLowerCase().includes(q)
      );
    }
    return list;
  }, [rules, kindFilter, ctxFilter, search]);

  const grouped = useMemo(() => {
    if (sortBy === "context") {
      const m = new Map<string, SemanticRule[]>();
      for (const r of filtered) {
        const list = m.get(r.context) ?? [];
        list.push(r);
        m.set(r.context, list);
      }
      return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
    }
    if (sortBy === "kind") {
      const m = new Map<string, SemanticRule[]>();
      for (const r of filtered) {
        const list = m.get(r.kind) ?? [];
        list.push(r);
        m.set(r.kind, list);
      }
      return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
    }
    return [["All rules", filtered] as [string, SemanticRule[]]];
  }, [filtered, sortBy]);

  const selected = selectedRuleId ? rules.find(r => r.id === selectedRuleId) : null;

  if (!model) return null;

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

      {/* Rule list */}
      <div style={{ width: 420, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 6 }}>
          <input
            placeholder="Search rules and conditions…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <select value={kindFilter} onChange={e => setKindFilter(e.target.value)} style={{ flex: 1, fontSize: 12 }}>
              <option value="ALL">All kinds</option>
              <option value="guard">Guard</option>
              <option value="check">Check</option>
              <option value="validation">Validation</option>
              <option value="rule">Rule</option>
              <option value="policy">Policy</option>
            </select>
            <select value={ctxFilter} onChange={e => setCtxFilter(e.target.value)} style={{ flex: 1, fontSize: 12 }}>
              <option value="ALL">All contexts</option>
              {contexts.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} style={{ flex: 1, fontSize: 12 }}>
              <option value="context">By context</option>
              <option value="kind">By kind</option>
              <option value="name">Flat list</option>
            </select>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{filtered.length} rules</div>
        </div>

        <div className="scrollable">
          {grouped.map(([label, items]) => (
            <div key={label}>
              <div style={{
                padding: "6px 12px 2px",
                fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
                color: "var(--text-muted)", position: "sticky", top: 0,
                background: "var(--bg-panel)", borderBottom: "1px solid var(--border)",
              }}>
                {label} ({items.length})
              </div>
              {items.map(rule => (
                <div
                  key={rule.id}
                  className={`rule-card${selectedRuleId === rule.id ? " selected" : ""}`}
                  style={{ margin: "6px 10px", borderLeft: `3px solid ${KIND_COLORS[rule.kind] ?? "var(--border)"}` }}
                  onClick={() => dispatch({ type: "SELECT_RULE", id: rule.id })}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: KIND_COLORS[rule.kind] ?? "var(--text-muted)" }}>
                      {rule.kind}
                    </span>
                    <ConfidenceBadge confidence={rule.confidence} />
                  </div>
                  <div className="rule-condition">IF {rule.condition.slice(0, 80)}</div>
                  <div className="rule-action">→ {rule.action.slice(0, 80)}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Rule detail */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {!selected ? (
          <div className="center-message">
            <div style={{ fontSize: 28, color: "var(--text-muted)" }}>⎇</div>
            <p className="text-muted">Select a rule to see its full detail</p>
          </div>
        ) : (
          <div className="scrollable" style={{ flex: 1 }}>
            <div style={{ padding: "20px 24px", maxWidth: 680 }}>

              {/* Kind + confidence */}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
                <span style={{
                  padding: "3px 10px", borderRadius: 4, fontSize: 11, fontWeight: 700,
                  textTransform: "uppercase", letterSpacing: "0.06em",
                  background: "var(--bg-card)",
                  color: KIND_COLORS[selected.kind] ?? "var(--text-dim)",
                }}>
                  {selected.kind}
                </span>
                <ConfidenceBadge confidence={selected.confidence} />
                <span className="text-muted text-small">in {selected.context}</span>
              </div>

              <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>{selected.name}</h2>

              {/* Logic tree */}
              <div className="card" style={{ marginBottom: 16, fontFamily: "var(--font-mono)", fontSize: 13 }}>
                <div style={{ color: "var(--cyan)", marginBottom: 8 }}>
                  IF {selected.condition}
                </div>
                <div style={{ paddingLeft: 16, borderLeft: "2px solid var(--border)" }}>
                  <div style={{ color: "var(--green)", marginBottom: 6 }}>
                    → {selected.action}
                  </div>
                  {selected.alternatives?.map((alt, i) => (
                    <div key={i} style={{ marginTop: 8 }}>
                      <div style={{ color: "var(--yellow)" }}>ELSE IF {alt.condition}</div>
                      <div style={{ paddingLeft: 16, color: "var(--text-dim)" }}>→ {alt.action}</div>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12, color: "var(--text-muted)", fontSize: 12 }}>
                  OUTCOME: {selected.outcome}
                </div>
              </div>

              {/* Nested rules */}
              {selected.nestedRules && selected.nestedRules.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div className="detail-section-title">Nested Logic</div>
                  {selected.nestedRules.map(nested => (
                    <div key={nested.id} className="card" style={{ marginBottom: 8, fontSize: 12, fontFamily: "var(--font-mono)", borderLeft: "3px solid var(--border-focus)" }}>
                      <div style={{ color: "var(--cyan)" }}>IF {nested.condition}</div>
                      <div style={{ paddingLeft: 12, color: "var(--green)" }}>→ {nested.action}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Evidence */}
              <div className="detail-section-title" style={{ marginBottom: 8 }}>Source Evidence</div>
              <EvidenceList evidence={selected.evidence} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

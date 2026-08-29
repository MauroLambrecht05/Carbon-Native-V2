import { useState, useMemo } from "react";
import { useApp } from "@/lib/store";
import { EntityChip, ConfidenceBadge } from "@/components/ui/EntityChip";
import { EntityDetail } from "@/components/explorer/EntityDetail";
import type { EntityType, SemanticEntity } from "@/lib/types";

const TYPE_ORDER: EntityType[] = [
  "SYSTEM", "PRODUCT", "SOLUTION", "CAPABILITY", "CONTRACT",
  "INFRASTRUCTURE", "INTEGRATION", "INTERFACE", "EXTERNAL_SYSTEM",
  "BUILD", "CI_PIPELINE", "TECHNOLOGY", "TOOLCHAIN", "FEATURE_FLAG",
  "CONFIGURATION", "BOUNDARY", "MODULE", "DATA", "ENVIRONMENT",
  "DEPLOYMENT", "FLOW", "PROCESS", "RULE", "CHECK", "VALIDATION", "ERROR",
];

export default function ExplorerView() {
  const { state, dispatch } = useApp();
  const { model, indexes, selectedEntityId } = state;

  const [search,      setSearch]      = useState("");
  const [typeFilter,  setTypeFilter]  = useState<EntityType | "ALL">("ALL");
  const [tierFilter,  setTierFilter]  = useState<string>("ALL");
  const [showConf,    setShowConf]    = useState<string>("ALL");

  const allEntities = model?.entities ?? [];

  // Available type filters
  const availableTypes = useMemo(() => {
    const types = new Set(allEntities.map(e => e.type));
    return TYPE_ORDER.filter(t => types.has(t));
  }, [allEntities]);

  // Available tier/tag filters
  const availableTiers = useMemo(() => {
    const tags = new Set<string>();
    allEntities.forEach(e => (e.tags ?? []).forEach(t => {
      if (["product","contracts","capabilities","infrastructure","integrations","interface","tooling","ci","technology","build","configuration"].includes(t)) {
        tags.add(t);
      }
    }));
    return [...tags].sort();
  }, [allEntities]);

  // Filtered entities
  const filtered = useMemo(() => {
    let list = allEntities;

    if (typeFilter !== "ALL") {
      list = list.filter(e => e.type === typeFilter);
    }
    if (tierFilter !== "ALL") {
      list = list.filter(e => (e.tags ?? []).includes(tierFilter));
    }
    if (showConf !== "ALL") {
      list = list.filter(e => e.confidence === showConf);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(e =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.shortName ?? "").toLowerCase().includes(q) ||
        (e.tags ?? []).some(t => t.includes(q))
      );
    }

    return list;
  }, [allEntities, typeFilter, tierFilter, showConf, search]);

  // Group by parent for tree-like display when no filter
  const grouped = useMemo(() => {
    if (typeFilter !== "ALL" || tierFilter !== "ALL" || search.trim()) {
      return [{ label: `${filtered.length} entities`, items: filtered }];
    }
    // Group by type
    const groups = new Map<string, SemanticEntity[]>();
    for (const e of filtered) {
      const g = groups.get(e.type) ?? [];
      g.push(e);
      groups.set(e.type, g);
    }
    return TYPE_ORDER
      .filter(t => groups.has(t))
      .map(t => ({ label: t.replace(/_/g, " "), items: groups.get(t)! }));
  }, [filtered, typeFilter, tierFilter, search]);

  if (!model) return null;

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

      {/* Entity list */}
      <div style={{ width: 380, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)" }}>

        {/* Filters bar */}
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            placeholder="Filter entities…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)} style={{ flex: 1, fontSize: 12 }}>
              <option value="ALL">All Types</option>
              {availableTypes.map(t => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
            </select>
            <select value={tierFilter} onChange={e => setTierFilter(e.target.value)} style={{ flex: 1, fontSize: 12 }}>
              <option value="ALL">All Tiers</option>
              {availableTiers.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={showConf} onChange={e => setShowConf(e.target.value)} style={{ flex: 1, fontSize: 12 }}>
              <option value="ALL">All Confidence</option>
              <option value="confirmed">Confirmed</option>
              <option value="inferred">Inferred</option>
              <option value="uncertain">Uncertain</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
        </div>

        {/* Entity list */}
        <div className="scrollable">
          {grouped.map(group => (
            <div key={group.label}>
              <div style={{
                padding: "6px 12px 2px",
                fontSize: 10, fontWeight: 700, letterSpacing: "0.08em",
                textTransform: "uppercase", color: "var(--text-muted)",
                position: "sticky", top: 0,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}>
                {group.label} <span style={{ fontWeight: 400 }}>({group.items.length})</span>
              </div>
              {group.items.map(entity => (
                <div
                  key={entity.id}
                  className={`entity-row${selectedEntityId === entity.id ? " selected" : ""}`}
                  onClick={() => dispatch({ type: "SELECT_ENTITY", id: entity.id })}
                >
                  <EntityChip type={entity.type} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="entity-row-name truncate">{entity.name}</div>
                    <div className="entity-row-desc truncate">{entity.description.slice(0, 70)}</div>
                  </div>
                  {entity.confidence !== "confirmed" && (
                    <ConfidenceBadge confidence={entity.confidence} />
                  )}
                </div>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="center-message" style={{ padding: 32 }}>
              <p className="text-muted">No entities match the filters.</p>
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      <EntityDetail />
    </div>
  );
}

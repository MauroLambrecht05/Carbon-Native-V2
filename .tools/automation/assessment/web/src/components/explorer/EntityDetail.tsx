import { useApp } from "@/lib/store";
import { EntityChip, ConfidenceBadge } from "@/components/ui/EntityChip";
import { EvidenceList } from "@/components/ui/EvidenceList";
import type { SemanticEntity, SemanticRelationship } from "@/lib/types";

export function EntityDetail() {
  const { state, dispatch } = useApp();
  const { model, indexes, selectedEntityId } = state;

  if (!model || !indexes || !selectedEntityId) {
    return (
      <div className="detail-panel">
        <div className="center-message" style={{ padding: 32 }}>
          <div style={{ fontSize: 28, color: "var(--text-muted)" }}>⬡</div>
          <p className="text-muted text-small">Select an entity to see details</p>
        </div>
      </div>
    );
  }

  const entity = indexes.byId.get(selectedEntityId);
  if (!entity) return null;

  const children     = indexes.children.get(entity.id) ?? [];
  const parent       = indexes.parents.get(entity.id);
  const outRels      = (indexes.relsByFrom.get(entity.id) ?? []).filter(r => r.relationship !== "CONTAINS");
  const inRels       = (indexes.relsByTo.get(entity.id) ?? []).filter(r => r.relationship !== "CONTAINS");
  const rules        = indexes.rulesByContext.get(entity.id) ?? [];
  const flows        = indexes.flowsByContext.get(entity.id) ?? [];

  function navigate(id: string) {
    dispatch({ type: "SELECT_ENTITY", id });
  }

  return (
    <div className="detail-panel scrollable">
      {/* Header */}
      <div className="detail-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <EntityChip type={entity.type} />
          <ConfidenceBadge confidence={entity.confidence} />
        </div>
        <div className="detail-title">{entity.name}</div>
        {entity.shortName && entity.shortName !== entity.name && (
          <div className="text-small text-muted text-mono">{entity.shortName}</div>
        )}
      </div>

      {/* Description */}
      <div className="detail-section">
        <div className="detail-section-title">Description</div>
        <div className="detail-prose">{entity.description}</div>
        {entity.purpose && (
          <div className="detail-prose" style={{ marginTop: 8, color: "var(--text-muted)" }}>
            <strong>Purpose:</strong> {entity.purpose}
          </div>
        )}
      </div>

      {/* How it works */}
      {entity.howItWorks && (
        <div className="detail-section">
          <div className="detail-section-title">How it works</div>
          <div className="detail-prose" style={{ whiteSpace: "pre-wrap" }}>{entity.howItWorks}</div>
        </div>
      )}

      {/* Parent */}
      {parent && (
        <div className="detail-section">
          <div className="detail-section-title">Part of</div>
          <div
            className="entity-row"
            style={{ padding: "6px 0" }}
            onClick={() => navigate(parent.id)}
          >
            <EntityChip type={parent.type} />
            <span className="text-small">{parent.name}</span>
          </div>
        </div>
      )}

      {/* Children */}
      {children.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Contains ({children.length})</div>
          <div className="scrollable" style={{ maxHeight: 200 }}>
            {children.map(child => (
              <div
                key={child.id}
                className="entity-row"
                onClick={() => navigate(child.id)}
              >
                <EntityChip type={child.type} />
                <div>
                  <div className="entity-row-name">{child.name}</div>
                  <div className="entity-row-desc truncate">{child.description.slice(0, 80)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outgoing relationships */}
      {outRels.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Relationships ({outRels.length})</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {outRels.slice(0, 20).map(rel => {
              const target = indexes.byId.get(rel.to);
              return (
                <div
                  key={rel.id}
                  className="rel-pill"
                  onClick={() => navigate(rel.to)}
                  title={rel.label ?? rel.condition ?? ""}
                >
                  <span className="rel-type">{rel.relationship}</span>
                  <span className="text-small">{target?.shortName ?? target?.name ?? rel.to}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Incoming relationships */}
      {inRels.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Used by ({inRels.length})</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {inRels.slice(0, 20).map(rel => {
              const source = indexes.byId.get(rel.from);
              return (
                <div
                  key={rel.id}
                  className="rel-pill"
                  onClick={() => navigate(rel.from)}
                  title={rel.label ?? ""}
                >
                  <span className="rel-type">{rel.relationship}</span>
                  <span className="text-small">{source?.shortName ?? source?.name ?? rel.from}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Rules */}
      {rules.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Rules & Checks ({rules.length})</div>
          {rules.slice(0, 8).map(rule => (
            <div
              key={rule.id}
              className="rule-card"
              onClick={() => dispatch({ type: "SELECT_RULE", id: rule.id })}
            >
              <div className="rule-condition">IF {rule.condition.slice(0, 80)}</div>
              <div className="rule-action">→ {rule.action.slice(0, 80)}</div>
              <div className="rule-outcome text-small">{rule.outcome.slice(0, 60)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Flows */}
      {flows.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Flows ({flows.length})</div>
          {flows.map(flow => (
            <div
              key={flow.id}
              className="entity-row"
              onClick={() => dispatch({ type: "SELECT_FLOW", id: flow.id })}
            >
              <span style={{ color: "var(--accent)" }}>↓</span>
              <div>
                <div className="entity-row-name">{flow.name}</div>
                <div className="entity-row-desc truncate">{flow.description.slice(0, 70)}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Technologies */}
      {(entity.technologies ?? []).length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Technologies</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {entity.technologies!.map(t => (
              <span key={t} className="chip chip-TECHNOLOGY">{t}</span>
            ))}
          </div>
        </div>
      )}

      {/* Configuration */}
      {(entity.configuration ?? []).length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Configuration</div>
          {entity.configuration!.map((cfg, i) => (
            <div key={i} style={{ padding: "4px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="text-mono text-small" style={{ color: "var(--cyan)" }}>{cfg.key}</span>
                {cfg.defaultValue && (
                  <span className="text-muted text-small">= {cfg.defaultValue}</span>
                )}
                {cfg.affectsBehavior && (
                  <span style={{ fontSize: 10, color: "var(--yellow)" }}>affects behavior</span>
                )}
              </div>
              {cfg.description && <div className="text-small text-dim">{cfg.description}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Potential issues */}
      {(entity.potentialIssues ?? []).length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title" style={{ color: "var(--yellow)" }}>⚠ Potential Issues</div>
          {entity.potentialIssues!.map((issue, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 2 }}>
                <span className={`sev-${issue.severity}`}>●</span>
                <span className="text-small bold">{issue.kind.replace(/-/g, " ")}</span>
              </div>
              <div className="text-small text-dim">{issue.description}</div>
            </div>
          ))}
        </div>
      )}

      {/* Notes */}
      {entity.notes && (
        <div className="detail-section">
          <div className="detail-section-title">Notes</div>
          <div className="detail-prose" style={{ fontStyle: "italic" }}>{entity.notes}</div>
        </div>
      )}

      {/* Evidence */}
      {entity.evidence.length > 0 && (
        <div className="detail-section">
          <div className="detail-section-title">Source Evidence</div>
          <EvidenceList evidence={entity.evidence} />
        </div>
      )}

      {/* Focus and trace buttons */}
      <div className="detail-section">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn btn-accent"
            onClick={() => dispatch({ type: "SET_FOCUS", id: entity.id })}
          >
            Focus in Graph
          </button>
          <button
            className="btn"
            onClick={() => dispatch({ type: "SET_TRACE", from: entity.id, to: null })}
          >
            Trace from here
          </button>
          {state.traceFrom && state.traceFrom !== entity.id && (
            <button
              className="btn btn-green"
              onClick={() => dispatch({ type: "SET_TRACE", from: state.traceFrom, to: entity.id })}
            >
              Trace to here
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

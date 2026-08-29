import { useState } from "react";
import { useApp } from "@/lib/store";
import { ConfidenceBadge } from "@/components/ui/EntityChip";
import { EvidenceList } from "@/components/ui/EvidenceList";
import type { FlowStep } from "@/lib/types";

const STEP_COLORS: Record<string, string> = {
  action:   "var(--accent)",
  decision: "var(--yellow)",
  check:    "var(--cyan)",
  wait:     "var(--text-muted)",
  error:    "var(--red)",
  end:      "var(--green)",
};

export default function FlowView() {
  const { state, dispatch } = useApp();
  const { model, selectedFlowId } = state;

  const [search,   setSearch]   = useState("");
  const [selected, setSelected] = useState<string | null>(selectedFlowId);
  const [stepId,   setStepId]   = useState<string | null>(null);

  const flows = model?.flows ?? [];

  const filtered = search.trim()
    ? flows.filter(f =>
        f.name.toLowerCase().includes(search.toLowerCase()) ||
        f.description.toLowerCase().includes(search.toLowerCase()) ||
        (f.trigger ?? "").toLowerCase().includes(search.toLowerCase())
      )
    : flows;

  const flow = selected ? flows.find(f => f.id === selected) : null;
  const step = stepId ? flow?.steps.find(s => s.id === stepId) : null;

  if (!model) return null;

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

      {/* Flow list */}
      <div style={{ width: 280, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)" }}>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <input
            placeholder="Filter flows…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="scrollable">
          {filtered.map(f => (
            <div
              key={f.id}
              className={`entity-row${selected === f.id ? " selected" : ""}`}
              onClick={() => { setSelected(f.id); setStepId(null); dispatch({ type: "SELECT_FLOW", id: f.id }); }}
            >
              <span style={{ color: "var(--accent)", fontSize: 16 }}>↓</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="entity-row-name truncate">{f.name}</div>
                <div className="entity-row-desc truncate">{f.steps.length} steps</div>
              </div>
              <ConfidenceBadge confidence={f.confidence} />
            </div>
          ))}
        </div>
      </div>

      {/* Flow diagram */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {!flow ? (
          <div className="center-message">
            <div style={{ fontSize: 28, color: "var(--text-muted)" }}>↓</div>
            <p className="text-muted">Select a flow to see its steps</p>
          </div>
        ) : (
          <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

            {/* Diagram */}
            <div className="scrollable" style={{ flex: 1, padding: "20px 24px" }}>
              <div style={{ maxWidth: 540 }}>
                <div style={{ marginBottom: 16 }}>
                  <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{flow.name}</h2>
                  <div className="text-dim text-small" style={{ marginBottom: 6 }}>{flow.description}</div>
                  {flow.trigger && (
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="text-muted text-small">Trigger:</span>
                      <span className="text-mono text-small" style={{ color: "var(--cyan)" }}>{flow.trigger}</span>
                    </div>
                  )}
                  <div style={{ marginTop: 4 }}>
                    <ConfidenceBadge confidence={flow.confidence} />
                  </div>
                </div>

                {/* START node */}
                <FlowNode kind="action" name="START" desc={flow.trigger ?? "Flow begins"} active={false} onClick={() => setStepId(null)} />
                <FlowConnector />

                {flow.steps
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map((s, idx) => (
                    <div key={s.id}>
                      <FlowNode
                        kind={s.kind}
                        name={s.name}
                        desc={s.description}
                        condition={s.condition}
                        active={stepId === s.id}
                        onClick={() => setStepId(stepId === s.id ? null : s.id)}
                      />
                      {s.kind === "decision" && s.outcomes && s.outcomes.length > 1 && (
                        <div style={{ paddingLeft: 44, marginBottom: 8 }}>
                          {s.outcomes.map((out, oi) => (
                            <div key={oi} style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
                              <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12, marginTop: 1 }}>
                                {oi === 0 ? "├─" : "└─"}
                              </span>
                              <div>
                                {out.condition && (
                                  <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--yellow)", marginRight: 6 }}>
                                    {out.condition}
                                  </span>
                                )}
                                <span className="text-small text-dim">{out.description}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      {idx < flow.steps.length - 1 && <FlowConnector />}
                    </div>
                  ))}

                {flow.evidence.length > 0 && (
                  <div style={{ marginTop: 20 }}>
                    <div className="detail-section-title" style={{ marginBottom: 6 }}>Source Evidence</div>
                    <EvidenceList evidence={flow.evidence} />
                  </div>
                )}
              </div>
            </div>

            {/* Step detail sidebar */}
            {step && (
              <div style={{ width: 300, borderLeft: "1px solid var(--border)", padding: 16, overflowY: "auto" }}>
                <span style={{
                  padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700,
                  textTransform: "uppercase", background: "var(--bg-card)",
                  color: STEP_COLORS[step.kind] ?? "var(--text-dim)",
                  marginBottom: 8, display: "inline-block",
                }}>
                  {step.kind}
                </span>
                <h3 style={{ fontSize: 15, fontWeight: 700, margin: "8px 0" }}>{step.name}</h3>
                <p className="text-dim text-small" style={{ lineHeight: 1.6, marginBottom: 12 }}>{step.description}</p>

                {step.condition && (
                  <div style={{ marginBottom: 12 }}>
                    <div className="detail-section-title">Condition</div>
                    <div className="text-mono text-small" style={{ color: "var(--cyan)" }}>{step.condition}</div>
                  </div>
                )}

                {step.outcomes && step.outcomes.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <div className="detail-section-title">Outcomes</div>
                    {step.outcomes.map((out, i) => (
                      <div key={i} style={{ marginBottom: 6 }}>
                        {out.condition && <div className="text-small" style={{ color: "var(--yellow)" }}>{out.condition}</div>}
                        <div className="text-small text-dim">→ {out.description}</div>
                      </div>
                    ))}
                  </div>
                )}

                {step.entityRef && (
                  <div style={{ marginBottom: 12 }}>
                    <div className="detail-section-title">Referenced entity</div>
                    <button
                      className="btn text-small"
                      onClick={() => dispatch({ type: "SELECT_ENTITY", id: step.entityRef! })}
                    >
                      {step.entityRef}
                    </button>
                  </div>
                )}

                {step.evidence && step.evidence.length > 0 && (
                  <div>
                    <div className="detail-section-title">Evidence</div>
                    <EvidenceList evidence={step.evidence} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FlowNode({
  kind, name, desc, condition, active, onClick,
}: {
  kind: string; name: string; desc: string;
  condition?: string; active: boolean; onClick: () => void;
}) {
  return (
    <div className="flow-step" style={{ cursor: "pointer" }} onClick={onClick}>
      <div className="flow-step-connector">
        <div className={`flow-step-dot ${kind}`} style={{ background: STEP_COLORS[kind] ?? "var(--accent)" }} />
      </div>
      <div
        className="flow-step-body"
        style={{
          background: active ? "var(--bg-selected)" : undefined,
          border: active ? "1px solid var(--border-focus)" : "1px solid transparent",
          borderRadius: "var(--radius)",
        }}
      >
        {condition && (
          <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--yellow)", marginBottom: 2 }}>
            {condition}
          </div>
        )}
        <div className="flow-step-name">{name}</div>
        <div className="flow-step-desc">{desc}</div>
      </div>
    </div>
  );
}

function FlowConnector() {
  return (
    <div style={{ display: "flex", paddingLeft: 10, marginBottom: 4 }}>
      <div style={{ width: 2, height: 16, background: "var(--border)", marginLeft: 4 }} />
    </div>
  );
}

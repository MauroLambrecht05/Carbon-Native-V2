import { useState, useMemo } from "react";
import { useApp } from "@/lib/store";
import { saveOverrides, addOverride } from "@/lib/api";
import { ConfidenceBadge } from "@/components/ui/EntityChip";
import { EvidenceList } from "@/components/ui/EvidenceList";
import type { SemanticEntity, SemanticRule, SemanticFlow, PotentialIssue, Contradiction, ReviewStatus } from "@/lib/types";

type ReviewKind = "potential-issues" | "contradictions" | "inferences" | "unknowns" | "all";

export default function ReviewView() {
  const { state, dispatch } = useApp();
  const { model, indexes, overrides } = state;

  const [tab,      setTab]      = useState<ReviewKind>("potential-issues");
  const [note,     setNote]     = useState<Record<string, string>>({});
  const [saving,   setSaving]   = useState(false);

  async function doSave(updated: typeof overrides) {
    setSaving(true);
    dispatch({ type: "SET_OVERRIDES", overrides: updated });
    try { await saveOverrides(updated); } catch { /* best effort */ }
    setSaving(false);
  }

  function review(
    targetId: string,
    targetKind: "entity" | "rule" | "flow" | "relationship" | "potential-issue",
    status: ReviewStatus,
  ) {
    const updated = addOverride(overrides, {
      targetId,
      targetKind,
      reviewStatus: status,
      reviewedAt:   new Date().toISOString(),
      note:         note[targetId],
    });
    doSave(updated);
  }

  const issues         = model?.potentialIssues ?? [];
  const contradictions = model?.contradictions   ?? [];

  const inferredEntities = useMemo(() =>
    (model?.entities ?? []).filter(e => e.confidence === "inferred"),
    [model]
  );
  const unknownEntities = useMemo(() =>
    (model?.entities ?? []).filter(e => e.confidence === "unknown"),
    [model]
  );

  function isReviewed(id: string): boolean {
    return overrides.overrides.some(o => o.targetId === id && o.reviewStatus !== "pending");
  }

  if (!model) return null;

  const tabCounts: Record<ReviewKind, number> = {
    "potential-issues": issues.filter(i => !isReviewed(`issue-${issues.indexOf(i)}`)).length,
    "contradictions":   contradictions.filter(c => !isReviewed(c.id)).length,
    "inferences":       inferredEntities.filter(e => !isReviewed(e.id)).length,
    "unknowns":         unknownEntities.filter(e => !isReviewed(e.id)).length,
    "all":              overrides.overrides.length,
  };

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

      {/* Tabs */}
      <div className="tabs">
        {([
          ["potential-issues", "Potential Issues"],
          ["contradictions",   "Contradictions"],
          ["inferences",       "Inferences"],
          ["unknowns",         "Unknowns"],
          ["all",              "Reviewed"],
        ] as [ReviewKind, string][]).map(([k, label]) => (
          <button
            key={k}
            className={`tab${tab === k ? " active" : ""}`}
            onClick={() => setTab(k)}
          >
            {label}
            {tabCounts[k] > 0 && (
              <span className="nav-badge" style={{ marginLeft: 6 }}>{tabCounts[k]}</span>
            )}
          </button>
        ))}
        {saving && <span className="text-muted text-small" style={{ marginLeft: "auto", padding: "10px 0" }}>Saving…</span>}
      </div>

      <div className="scrollable">

        {/* Potential Issues */}
        {tab === "potential-issues" && (
          <div>
            {issues.length === 0 && (
              <div className="center-message">No potential issues found.</div>
            )}
            {issues.map((issue, i) => {
              const id       = `issue-${i}`;
              const reviewed = isReviewed(id);
              const existingNote = overrides.overrides.find(o => o.targetId === id)?.note;

              return (
                <div
                  key={id}
                  className="review-item"
                  style={{ opacity: reviewed ? 0.5 : 1 }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span className={`sev-${issue.severity}`} style={{ marginTop: 2 }}>●</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 3 }}>
                        {issue.kind.replace(/-/g, " ")}
                        <span className="text-muted text-small" style={{ marginLeft: 8 }}>{issue.severity}</span>
                      </div>
                      <div className="text-small text-dim">{issue.description}</div>
                      {issue.evidence && <EvidenceList evidence={issue.evidence} />}
                    </div>
                  </div>
                  {existingNote && (
                    <div className="text-small" style={{ color: "var(--yellow)", fontStyle: "italic" }}>
                      Note: {existingNote}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      placeholder="Add a note…"
                      value={note[id] ?? ""}
                      onChange={e => setNote(n => ({ ...n, [id]: e.target.value }))}
                      style={{ flex: 1, fontSize: 12 }}
                    />
                    <button className="btn btn-green"  onClick={() => review(id, "potential-issue", "accepted")}>Accept</button>
                    <button className="btn btn-red"    onClick={() => review(id, "potential-issue", "rejected")}>Reject</button>
                    <button className="btn btn-yellow" onClick={() => review(id, "potential-issue", "ignored")}>Ignore</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Contradictions */}
        {tab === "contradictions" && (
          <div>
            {contradictions.length === 0 && (
              <div className="center-message">No contradictions detected.</div>
            )}
            {contradictions.map(c => {
              const reviewed = isReviewed(c.id);
              const existingNote = overrides.overrides.find(o => o.targetId === c.id)?.note;

              return (
                <div
                  key={c.id}
                  className="review-item"
                  style={{ opacity: reviewed ? 0.5 : 1 }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 4, display: "flex", gap: 8 }}>
                    <span style={{ color: "var(--red)" }}>⚡</span>
                    {c.description}
                  </div>
                  <div className="text-small text-dim">
                    <strong style={{ color: "var(--text)" }}>A:</strong> {c.sourceA.location} — {c.sourceA.claim.slice(0, 100)}
                  </div>
                  <div className="text-small text-dim">
                    <strong style={{ color: "var(--text)" }}>B:</strong> {c.sourceB.location} — {c.sourceB.claim.slice(0, 100)}
                  </div>
                  {c.resolution && (
                    <div className="text-small" style={{ color: "var(--green)" }}>Resolution: {c.resolution}</div>
                  )}
                  {existingNote && (
                    <div className="text-small" style={{ color: "var(--yellow)", fontStyle: "italic" }}>Note: {existingNote}</div>
                  )}
                  <EvidenceList evidence={c.evidence} />
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      placeholder="Add resolution note…"
                      value={note[c.id] ?? ""}
                      onChange={e => setNote(n => ({ ...n, [c.id]: e.target.value }))}
                      style={{ flex: 1, fontSize: 12 }}
                    />
                    <button className="btn btn-green"  onClick={() => review(c.id, "entity", "accepted")}>Resolved</button>
                    <button className="btn btn-yellow" onClick={() => review(c.id, "entity", "ignored")}>Ignore</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Inferences */}
        {tab === "inferences" && (
          <div>
            <div className="review-item" style={{ background: "var(--bg-card)", marginBottom: 0 }}>
              <div className="text-small text-dim">
                These items were inferred from evidence rather than directly confirmed in source code.
                Review each one to confirm or correct the interpretation.
              </div>
            </div>
            {inferredEntities.map(entity => {
              const reviewed = isReviewed(entity.id);
              return (
                <div
                  key={entity.id}
                  className="review-item"
                  style={{ opacity: reviewed ? 0.5 : 1 }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <ConfidenceBadge confidence="inferred" />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>{entity.name}</div>
                      <div className="text-small text-dim">{entity.description.slice(0, 150)}</div>
                      <EvidenceList evidence={entity.evidence.slice(0, 2)} />
                    </div>
                  </div>
                  <div className="review-actions">
                    <button className="btn btn-green" onClick={() => review(entity.id, "entity", "accepted")}>
                      ✓ Confirmed
                    </button>
                    <button className="btn btn-red" onClick={() => review(entity.id, "entity", "rejected")}>
                      ✕ Incorrect
                    </button>
                    <button className="btn" onClick={() => review(entity.id, "entity", "ignored")}>
                      Skip
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Unknowns */}
        {tab === "unknowns" && (
          <div>
            {unknownEntities.map(entity => {
              const reviewed = isReviewed(entity.id);
              return (
                <div
                  key={entity.id}
                  className="review-item"
                  style={{ opacity: reviewed ? 0.5 : 1 }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <ConfidenceBadge confidence="unknown" />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>{entity.name}</div>
                      <div className="text-small text-dim">{entity.description.slice(0, 150)}</div>
                    </div>
                  </div>
                  <div className="review-actions">
                    <button className="btn btn-green" onClick={() => review(entity.id, "entity", "accepted")}>
                      ✓ Confirmed
                    </button>
                    <button className="btn btn-red" onClick={() => review(entity.id, "entity", "rejected")}>
                      ✕ Remove
                    </button>
                    <button className="btn" onClick={() => review(entity.id, "entity", "ignored")}>Skip</button>
                  </div>
                </div>
              );
            })}
            {unknownEntities.length === 0 && (
              <div className="center-message">No unknown-confidence items.</div>
            )}
          </div>
        )}

        {/* All reviewed */}
        {tab === "all" && (
          <div>
            {overrides.overrides.length === 0 && (
              <div className="center-message">No items reviewed yet.</div>
            )}
            {overrides.overrides.map(o => (
              <div key={o.id} className="review-item">
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span className={
                    o.reviewStatus === "accepted" ? "conf conf-confirmed" :
                    o.reviewStatus === "rejected" ? "conf conf-unknown" :
                    o.reviewStatus === "ignored"  ? "conf conf-uncertain" :
                    "conf conf-inferred"
                  }>
                    {o.reviewStatus === "accepted" ? "✓" : o.reviewStatus === "rejected" ? "✕" : "○"}
                  </span>
                  <span className="text-small text-mono" style={{ color: "var(--text-dim)" }}>{o.targetId}</span>
                  <span className="text-muted text-small">{o.reviewStatus}</span>
                </div>
                {o.note && <div className="text-small" style={{ fontStyle: "italic", color: "var(--yellow)" }}>{o.note}</div>}
                {o.reviewedAt && (
                  <div className="text-small text-muted">{new Date(o.reviewedAt).toLocaleString()}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

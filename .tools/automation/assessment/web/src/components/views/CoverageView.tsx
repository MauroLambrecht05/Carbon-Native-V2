import { useEffect, useState } from "react";
import { fetchCoverage } from "@/lib/api";
import { useApp } from "@/lib/store";

interface CoverageReport {
  version: string;
  generatedAt: string;
  summary: { totalFiles: number; analyzedFiles: number; skippedFiles: number; ignoredFiles: number; coveragePercent: number };
  byLanguage: Record<string, { files: number; analyzed: number }>;
  entities: Record<string, number>;
  confidence: Record<string, number>;
  reviewQueue: Record<string, number>;
  analysisGaps: Array<{ file: string; reason: string; language?: string; impact: string }>;
  skippedFiles: Array<{ file: string; reason: string }>;
}

export default function CoverageView() {
  const { state } = useApp();
  const { model } = state;
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);

  useEffect(() => {
    fetchCoverage().then(c => { if (c) setCoverage(c as CoverageReport); });
  }, []);

  const contradictions = model?.contradictions ?? [];
  const issues         = model?.potentialIssues ?? [];

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 16 }}>Coverage Report</h2>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, marginBottom: 24 }}>

        {/* File coverage */}
        <div className="card">
          <div className="detail-section-title" style={{ marginBottom: 8 }}>File Coverage</div>
          {coverage ? (
            <>
              <div style={{ fontSize: 28, fontWeight: 700, color: "var(--accent)" }}>{coverage.summary.coveragePercent}%</div>
              <div className="text-small text-dim">{coverage.summary.analyzedFiles} / {coverage.summary.totalFiles} files analyzed</div>
              <div className="text-small text-muted">{coverage.summary.ignoredFiles} ignored · {coverage.summary.skippedFiles} skipped</div>
            </>
          ) : (
            <div className="text-muted text-small">Run bun run assess to generate</div>
          )}
        </div>

        {/* Semantic entities */}
        {model && (
          <div className="card">
            <div className="detail-section-title" style={{ marginBottom: 8 }}>Semantic Entities</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "var(--green)" }}>{model.entities.length}</div>
            <div className="text-small text-dim">{model.relationships.length} relationships</div>
            <div className="text-small text-muted">{model.rules.length} rules · {model.flows.length} flows</div>
          </div>
        )}

        {/* Review queue */}
        {model && (
          <div className="card">
            <div className="detail-section-title" style={{ marginBottom: 8 }}>Review Queue</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "var(--yellow)" }}>
              {(coverage?.reviewQueue.total) ?? (model.potentialIssues.length + model.contradictions.length)}
            </div>
            <div className="text-small text-dim">{model.potentialIssues.length} potential issues</div>
            <div className="text-small text-muted">{model.contradictions.length} contradictions</div>
          </div>
        )}

        {/* Confidence distribution */}
        {coverage && (
          <div className="card">
            <div className="detail-section-title" style={{ marginBottom: 8 }}>Confidence</div>
            {Object.entries(coverage.confidence).map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <span className={`conf conf-${k}`}>●</span>
                <span className="text-small" style={{ width: 80 }}>{k}</span>
                <span className="text-small bold">{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* By language */}
      {coverage && (
        <div style={{ marginBottom: 24 }}>
          <div className="detail-section-title" style={{ marginBottom: 8 }}>By Language</div>
          <div className="card">
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ textAlign: "left", padding: "4px 8px", color: "var(--text-muted)", fontWeight: 600 }}>Language</th>
                  <th style={{ textAlign: "right", padding: "4px 8px", color: "var(--text-muted)", fontWeight: 600 }}>Files</th>
                  <th style={{ textAlign: "right", padding: "4px 8px", color: "var(--text-muted)", fontWeight: 600 }}>Analyzed</th>
                  <th style={{ textAlign: "right", padding: "4px 8px", color: "var(--text-muted)", fontWeight: 600 }}>Coverage</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(coverage.byLanguage)
                  .filter(([, v]) => v.files > 0)
                  .sort(([, a], [, b]) => b.files - a.files)
                  .map(([lang, { files, analyzed }]) => (
                    <tr key={lang} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "4px 8px", fontFamily: "var(--font-mono)" }}>{lang}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right", color: "var(--text-dim)" }}>{files}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right", color: "var(--text-dim)" }}>{analyzed}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right" }}>
                        <span style={{ color: analyzed === files ? "var(--green)" : "var(--yellow)" }}>
                          {Math.round((analyzed / files) * 100)}%
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Contradictions */}
      {contradictions.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="detail-section-title" style={{ marginBottom: 8 }}>Contradictions ({contradictions.length})</div>
          {contradictions.map(c => (
            <div key={c.id} className="card" style={{ marginBottom: 8, borderLeft: "3px solid var(--red)" }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>{c.description}</div>
              <div className="text-small text-dim">
                <strong style={{ color: "var(--text)" }}>Source A:</strong> {c.sourceA.location} — {c.sourceA.claim.slice(0, 100)}
              </div>
              <div className="text-small text-dim" style={{ marginTop: 4 }}>
                <strong style={{ color: "var(--text)" }}>Source B:</strong> {c.sourceB.location} — {c.sourceB.claim.slice(0, 100)}
              </div>
              {c.resolution && (
                <div className="text-small" style={{ marginTop: 6, color: "var(--green)" }}>
                  ✓ Resolution: {c.resolution}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Potential issues */}
      {issues.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="detail-section-title" style={{ marginBottom: 8 }}>Potential Issues ({issues.length})</div>
          {issues.map((issue, i) => (
            <div key={i} className="card" style={{ marginBottom: 8, borderLeft: `3px solid var(--${issue.severity === "high" ? "red" : issue.severity === "medium" ? "yellow" : "border"})` }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                <span className={`sev-${issue.severity}`}>●</span>
                <span style={{ fontWeight: 600, fontSize: 13 }}>{issue.kind.replace(/-/g, " ")}</span>
                <span className="text-muted text-small">{issue.severity}</span>
              </div>
              <div className="text-small text-dim">{issue.description}</div>
            </div>
          ))}
        </div>
      )}

      {/* Analysis gaps */}
      {coverage && coverage.analysisGaps.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div className="detail-section-title" style={{ marginBottom: 8 }}>Analysis Gaps ({coverage.analysisGaps.length})</div>
          <div className="card">
            {coverage.analysisGaps.slice(0, 30).map((gap, i) => (
              <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)", display: "flex", gap: 10 }}>
                <span className={`sev-${gap.impact}`} style={{ flexShrink: 0 }}>●</span>
                <div>
                  <div className="text-mono text-small" style={{ color: "var(--text-dim)" }}>{gap.file}</div>
                  <div className="text-small text-muted">{gap.reason}</div>
                </div>
              </div>
            ))}
            {coverage.analysisGaps.length > 30 && (
              <div className="text-muted text-small" style={{ padding: "8px 0" }}>
                … and {coverage.analysisGaps.length - 30} more. See coverage.json for the full list.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

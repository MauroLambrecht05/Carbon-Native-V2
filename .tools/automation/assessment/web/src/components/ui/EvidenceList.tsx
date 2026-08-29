import type { SourceEvidence } from "@/lib/types";

export function EvidenceList({ evidence }: { evidence: SourceEvidence[] }) {
  if (!evidence || evidence.length === 0) return null;
  const unique = [...new Map(evidence.map(e => [`${e.file}:${e.lineStart ?? ""}`, e])).values()];
  return (
    <div>
      {unique.slice(0, 6).map((ev, i) => (
        <div key={i} className="evidence-item">
          <span style={{ color: "var(--text-muted)" }}>⌁</span>
          <span className="evidence-file" style={{ color: "var(--text-dim)" }}>
            {ev.file}
            {ev.lineStart && <span style={{ color: "var(--text-muted)" }}>:{ev.lineStart}</span>}
            {ev.lineEnd && ev.lineEnd !== ev.lineStart && (
              <span style={{ color: "var(--text-muted)" }}>–{ev.lineEnd}</span>
            )}
          </span>
        </div>
      ))}
      {unique.length > 6 && (
        <div className="evidence-item" style={{ color: "var(--text-muted)" }}>
          … {unique.length - 6} more
        </div>
      )}
    </div>
  );
}

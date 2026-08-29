import type { EntityType } from "@/lib/types";

export function EntityChip({ type }: { type: EntityType }) {
  return (
    <span className={`chip chip-${type} chip-default`}>{type.replace(/_/g, " ")}</span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const icons: Record<string, string> = {
    confirmed: "●", inferred: "◐", uncertain: "○", unknown: "?",
  };
  return (
    <span className={`conf conf-${confidence}`}>
      {icons[confidence] ?? "?"} {confidence}
    </span>
  );
}

export function SeverityDot({ severity }: { severity: string }) {
  return <span className={`sev-${severity}`}>●</span>;
}

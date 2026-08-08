// components.tsx — primitives. Now using lucide-react directly for icons,
// the same way you would in any React desktop or web app: each icon is
// imported as a component and rendered as JSX. Carbon-mini's runtime
// renders the underlying <svg>/<path>/etc. via tiny-skia.

import { memo } from "react";
import clsx from "clsx";
import { format, formatDistanceToNow } from "date-fns";
import { FileText } from "lucide-react";
import type { Note } from "./notes.ts";
import { useTheme } from "./theme.tsx";

// ─── Button ───────────────────────────────────────────────────────────────

export interface ButtonProps {
  label: string;
  onPress: () => void;
  tone?: "primary" | "ghost" | "danger" | "subtle";
  size?: "sm" | "md";
  leadingIcon?: any;
}

export function Button({
  label,
  onPress,
  tone = "ghost",
  size = "md",
  leadingIcon,
}: ButtonProps) {
  const { colors } = useTheme();
  const isFilled = tone === "primary" || tone === "danger";
  const bg =
    tone === "primary" ? colors.accent
    : tone === "danger" ? colors.danger
    : "transparent";
  const fg = isFilled ? "#ffffff" : tone === "subtle" ? colors.textMuted : colors.text;
  const hoverBg = isFilled ? bg : colors.hover;
  const py = size === "sm" ? 4 : 7;
  const px = size === "sm" ? 8 : 12;
  const _classNameSmokeTest = clsx("btn", `btn-${tone}`, `btn-${size}`, { active: false });
  return (
    <view
      style={{
        background: bg,
        backgroundHover: hoverBg,
        paddingTop: py,
        paddingBottom: py,
        paddingLeft: px,
        paddingRight: px,
        borderRadius: 6,
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        cursor: "pointer",
        color: fg,
      }}
      onClick={onPress}
    >
      {leadingIcon}
      <text
        style={{
          color: fg,
          fontSize: 13,
          fontWeight: isFilled ? 600 : 500,
        }}
      >
        {label}
      </text>
    </view>
  );
}

// ─── NoteCard (sidebar row) ───────────────────────────────────────────────

export interface NoteCardProps {
  note: Note;
  selected: boolean;
  onSelect: (id: string) => void;
}

export const NoteCard = memo(
  function NoteCard({ note, selected, onSelect }: NoteCardProps) {
    const { colors } = useTheme();
    const updated = formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true });
    return (
      <view
        style={{
          background: selected ? colors.selected : "transparent",
          backgroundHover: selected ? colors.selected : colors.hover,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: 4,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
        }}
        onClick={() => onSelect(note.id)}
      >
        <FileText
          size={15}
          color={selected ? colors.text : colors.textMuted}
          strokeWidth={1.75}
        />
        <view style={{ flexGrow: 1, gap: 1 }}>
          <text
            style={{
              color: colors.text,
              fontSize: 14,
              fontWeight: selected ? 600 : 500,
            }}
          >
            {note.title}
          </text>
          <text style={{ color: colors.textFaint, fontSize: 11 }}>{updated}</text>
        </view>
      </view>
    );
  },
  (prev, next) =>
    prev.note.title === next.note.title &&
    prev.note.body === next.note.body &&
    prev.note.tags.length === next.note.tags.length &&
    prev.note.updatedAt === next.note.updatedAt &&
    prev.selected === next.selected &&
    prev.onSelect === next.onSelect,
);

// ─── TagChip ──────────────────────────────────────────────────────────────

export function TagChip({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  const { colors } = useTheme();
  return (
    <view
      style={{
        background: colors.surfaceAlt,
        backgroundHover: colors.hover,
        paddingTop: 3,
        paddingBottom: 3,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 12,
        cursor: "pointer",
      }}
      onClick={onRemove}
    >
      <text style={{ color: colors.textMuted, fontSize: 12, fontWeight: 500 }}>
        #{tag}
      </text>
    </view>
  );
}

// ─── SectionLabel (small CAPS heading inside sidebar) ─────────────────────

export function SectionLabel({ children }: { children: any }) {
  const { colors } = useTheme();
  return (
    <view style={{ paddingTop: 16, paddingBottom: 4, paddingLeft: 12 }}>
      <text style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600 }}>
        {children}
      </text>
    </view>
  );
}

// ─── Divider (1 px hairline) ──────────────────────────────────────────────

export function Divider({ vertical = false }: { vertical?: boolean }) {
  const { colors } = useTheme();
  return (
    <view
      style={{
        background: colors.divider,
        width: vertical ? 1 : "100%",
        height: vertical ? "100%" : 1,
      }}
    />
  );
}

// ─── PropertyRow (key/value pair like Notion's properties block) ──────────

export function PropertyRow({ label, children }: { label: string; children: any }) {
  const { colors } = useTheme();
  return (
    <view
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 16,
        paddingTop: 5,
        paddingBottom: 5,
        paddingLeft: 4,
        paddingRight: 4,
        borderRadius: 4,
        backgroundHover: colors.hover,
      }}
    >
      <view style={{ width: 130 }}>
        <text style={{ color: colors.textMuted, fontSize: 13 }}>{label}</text>
      </view>
      <view
        style={{
          flexGrow: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
        }}
      >
        {children}
      </view>
    </view>
  );
}

export function PropertyText({ children }: { children: any }) {
  const { colors } = useTheme();
  return <text style={{ color: colors.text, fontSize: 13 }}>{children}</text>;
}

export { format };

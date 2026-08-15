// Sidebar — Notion-style nav. Icons come straight from lucide-react,
// the same way you'd use them in a Vite/CRA web app.

import { useMemo, useState } from "react";
import {
  Plus,
  Search,
  Briefcase,
  FileText,
} from "lucide-react";
import {
  Button,
  NoteCard,
  SectionLabel,
} from "./components.tsx";
import { useTheme } from "./theme.tsx";
import type { NotesApi } from "./notes.ts";

interface SidebarProps {
  api: NotesApi;
}

export function Sidebar({ api }: SidebarProps) {
  const { colors, name, toggle } = useTheme();

  const FILTERS = ["", "welcome", "todo", "draft", "ref"];
  const [filterIdx, setFilterIdx] = useState(0);
  const filter = FILTERS[filterIdx];

  const filtered = useMemo(() => {
    if (!filter) return api.notes;
    return api.notes.filter(
      (n) =>
        n.title.toLowerCase().includes(filter) ||
        n.tags.some((t) => t.toLowerCase().includes(filter)),
    );
  }, [api.notes, filter]);

  return (
    <view
      style={{
        width: 260,
        background: colors.sidebar,
        flexDirection: "column",
        paddingTop: 6,
        paddingBottom: 6,
      }}
    >
      {/* Workspace selector */}
      <SidebarRow
        leading={<Briefcase size={16} color={colors.textMuted} strokeWidth={2} />}
        trailing={
          <text style={{ color: colors.textFaint, fontSize: 11, fontWeight: 500 }}>
            {name === "light" ? "Dark" : "Light"}
          </text>
        }
        bold
        onPress={toggle}
      >
        My workspace
      </SidebarRow>

      {/* Quick actions */}
      <view style={{ paddingTop: 6, paddingLeft: 6, paddingRight: 6, gap: 1 }}>
        <SidebarRow
          leading={<Plus size={16} color={colors.accent} strokeWidth={2} />}
          onPress={api.addNote}
          tone="accent"
        >
          New page
        </SidebarRow>
        <SidebarRow
          leading={<Search size={16} color={colors.textMuted} strokeWidth={2} />}
          trailing={
            filter ? (
              <text style={{ color: colors.textFaint, fontSize: 11 }}>
                #{filter}
              </text>
            ) : null
          }
          onPress={() => setFilterIdx((i) => (i + 1) % FILTERS.length)}
        >
          {filter ? `Filtered: ${filter}` : "Search"}
        </SidebarRow>
      </view>

      {/* Pages section */}
      <SectionLabel>PAGES</SectionLabel>
      <view style={{ paddingLeft: 6, paddingRight: 6, gap: 1 }}>
        {filtered.length === 0 ? (
          <view style={{ paddingTop: 6, paddingLeft: 8 }}>
            <text style={{ color: colors.textFaint, fontSize: 12 }}>
              No pages match "{filter}"
            </text>
          </view>
        ) : (
          filtered.map((n) => (
            <NoteCard
              key={n.id}
              note={n}
              selected={n.id === api.selectedId}
              onSelect={api.select}
            />
          ))
        )}
      </view>

      {/* Spacer pushes footer to bottom */}
      <view style={{ flexGrow: 1 }} />

      {/* Footer */}
      <view
        style={{
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 14,
          paddingRight: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        <view style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <FileText size={11} color={colors.textFaint} strokeWidth={2} />
          <text style={{ color: colors.textFaint, fontSize: 11 }}>
            {api.notes.length} {api.notes.length === 1 ? "page" : "pages"}
          </text>
        </view>
        <view style={{ flexGrow: 1 }} />
        <text style={{ color: colors.textFaint, fontSize: 11 }}>
          react · carbon-mini
        </text>
      </view>
    </view>
  );
}

// ─── SidebarRow ───────────────────────────────────────────────────────────

interface SidebarRowProps {
  children: any;
  onPress: () => void;
  leading?: any;
  trailing?: any;
  bold?: boolean;
  tone?: "default" | "accent";
}

function SidebarRow({
  children,
  onPress,
  leading,
  trailing,
  bold = false,
  tone = "default",
}: SidebarRowProps) {
  const { colors } = useTheme();
  const fg = tone === "accent" ? colors.accent : colors.text;
  return (
    <view
      style={{
        backgroundHover: colors.hover,
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
      onClick={onPress}
    >
      {leading}
      <view style={{ flexGrow: 1 }}>
        <text
          style={{
            color: fg,
            fontSize: 14,
            fontWeight: bold ? 600 : 400,
          }}
        >
          {children}
        </text>
      </view>
      {trailing}
    </view>
  );
}

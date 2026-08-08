// ChannelSidebar — 240 px column to the right of the server rail. Top:
// server header banner with chevron (clickable for menu — not implemented
// yet). Middle: collapsible channel categories. Bottom: user info bar
// with avatar, name, and three control buttons (mic / headphones / settings).

import {
  ChevronDown,
  ChevronRight,
  Hash,
  Volume2,
  Megaphone,
  Mic,
  Headphones,
  Settings,
  Plus,
  Radio,
} from "lucide-react";
import { useTheme } from "../theme.tsx";
import { AvatarWithStatus } from "./StatusDot.tsx";
import { ME, type ChannelCategory, type Channel, type Server } from "../data/mock.ts";

interface ChannelSidebarProps {
  server: Server;
  categories: ChannelCategory[];
  activeChannelId: string;
  onSelectChannel: (id: string) => void;
  isCategoryCollapsed: (id: string) => boolean;
  onToggleCategory: (id: string) => void;
}

export function ChannelSidebar({
  server,
  categories,
  activeChannelId,
  onSelectChannel,
  isCategoryCollapsed,
  onToggleCategory,
}: ChannelSidebarProps) {
  const { colors } = useTheme();
  return (
    <view
      style={{
        width: 240,
        background: colors.sidebarBg,
        flexDirection: "column",
      }}
    >
      {/* Server header */}
      <view
        style={{
          height: 48,
          paddingLeft: 16,
          paddingRight: 12,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundHover: colors.surfaceHover,
          cursor: "pointer",
          borderWidth: 1,
          borderColor: colors.separator,
        }}
      >
        <text
          style={{ color: colors.textBright, fontSize: 15, fontWeight: 600 }}
        >
          {server.name}
        </text>
        <ChevronDown size={18} color={colors.textMuted} strokeWidth={2.5} />
      </view>

      {/* Channel list — scrollable */}
      <view
        style={{
          flexGrow: 1,
          flexDirection: "column",
          overflowY: "scroll",
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 8,
          paddingRight: 8,
          gap: 1,
        }}
      >
        {categories.map((cat) => (
          <Category
            key={cat.id}
            category={cat}
            collapsed={isCategoryCollapsed(cat.id)}
            onToggle={() => onToggleCategory(cat.id)}
            activeChannelId={activeChannelId}
            onSelectChannel={onSelectChannel}
          />
        ))}
      </view>

      {/* User info bar — kept narrow (240 px sidebar) by giving the
          name column a fixed width and letting any longer custom-status
          string truncate via wrap-to-width on the inner <text>. The
          three control buttons (mic / headphones / settings) sit
          flush on the right with no gap, mirroring the design. */}
      <view
        style={{
          height: 52,
          background: colors.surfaceElevated,
          paddingLeft: 0,
          paddingRight: 4,
          flexDirection: "row",
          alignItems: "center",
          flexShrink: 0,
        }}
      >
        <view
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingLeft: 8,
            paddingRight: 4,
            paddingTop: 4,
            paddingBottom: 4,
            borderRadius: 4,
            cursor: "pointer",
            backgroundHover: colors.surfaceHover,
            flexGrow: 1,
            marginLeft: 2,
            marginRight: 2,
          }}
        >
          <AvatarWithStatus
            name={ME.name}
            status={ME.status}
            size={32}
            outline={colors.surfaceElevated}
          />
          <view
            style={{
              flexDirection: "column",
              width: 92,
              paddingLeft: 4,
            }}
          >
            <text
              style={{
                color: colors.textBright,
                fontSize: 13,
                fontWeight: 600,
                width: "100%",
              }}
            >
              {ME.name}
            </text>
            <text
              style={{
                color: colors.textFaint,
                fontSize: 11,
                width: "100%",
              }}
            >
              {ME.customStatus ?? `#${ME.tag}`}
            </text>
          </view>
        </view>
        <SidebarIconButton><Mic        size={18} color={colors.textMuted} strokeWidth={2} /></SidebarIconButton>
        <SidebarIconButton><Headphones size={18} color={colors.textMuted} strokeWidth={2} /></SidebarIconButton>
        <SidebarIconButton><Settings   size={18} color={colors.textMuted} strokeWidth={2} /></SidebarIconButton>
      </view>
    </view>
  );
}

// ─── Category ─────────────────────────────────────────────────────────────

interface CategoryProps {
  category: ChannelCategory;
  collapsed: boolean;
  onToggle: () => void;
  activeChannelId: string;
  onSelectChannel: (id: string) => void;
}

function Category({ category, collapsed, onToggle, activeChannelId, onSelectChannel }: CategoryProps) {
  const { colors } = useTheme();
  return (
    <view style={{ flexDirection: "column" }}>
      <view
        onClick={onToggle}
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingTop: 16,
          paddingBottom: 4,
          paddingLeft: 4,
          paddingRight: 8,
          gap: 2,
          cursor: "pointer",
        }}
      >
        {collapsed
          ? <ChevronRight size={12} color={colors.textFaint} strokeWidth={2.5} />
          : <ChevronDown  size={12} color={colors.textFaint} strokeWidth={2.5} />}
        <text
          style={{
            color: colors.textFaint,
            fontSize: 11,
            fontWeight: 600,
            paddingLeft: 4,
          }}
        >
          {category.name.toUpperCase()}
        </text>
        <view style={{ flexGrow: 1 }} />
        <Plus size={14} color={colors.textFaint} strokeWidth={2} />
      </view>
      {!collapsed && category.channels.map((c) => (
        <ChannelRow
          key={c.id}
          channel={c}
          active={c.id === activeChannelId}
          onSelect={() => onSelectChannel(c.id)}
        />
      ))}
    </view>
  );
}

// ─── ChannelRow ───────────────────────────────────────────────────────────

interface ChannelRowProps {
  channel: Channel;
  active: boolean;
  onSelect: () => void;
}

function ChannelRow({ channel, active, onSelect }: ChannelRowProps) {
  const { colors } = useTheme();
  const fg = active ? colors.textBright : channel.unread ? colors.textBright : colors.textMuted;
  const Icon =
    channel.kind === "voice"        ? Volume2 :
    channel.kind === "announcement" ? Megaphone :
    channel.kind === "stage"        ? Radio :
                                      Hash;
  return (
    <view
      onClick={onSelect}
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 8,
        paddingRight: 8,
        gap: 6,
        borderRadius: 4,
        background: active ? colors.surfaceActive : "transparent",
        backgroundHover: active ? colors.surfaceActive : colors.surfaceHover,
        cursor: "pointer",
      }}
    >
      <Icon size={20} color={colors.textFaint} strokeWidth={2} />
      <text
        style={{
          color: fg,
          fontSize: 14,
          fontWeight: active ? 500 : channel.unread ? 500 : 400,
          flexGrow: 1,
        }}
      >
        {channel.name}
      </text>
      {channel.pings !== undefined && channel.pings > 0 && (
        <view
          style={{
            background: colors.dnd,
            paddingTop: 1,
            paddingBottom: 1,
            paddingLeft: 6,
            paddingRight: 6,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <text style={{ color: "#ffffff", fontSize: 11, fontWeight: 700 }}>
            {channel.pings}
          </text>
        </view>
      )}
    </view>
  );
}

// ─── SidebarIconButton ────────────────────────────────────────────────────

function SidebarIconButton({ children }: { children: any }) {
  const { colors } = useTheme();
  return (
    <view
      style={{
        width: 32,
        height: 32,
        borderRadius: 4,
        alignItems: "center",
        justifyContent: "center",
        backgroundHover: colors.surfaceHover,
        cursor: "pointer",
      }}
    >
      {children}
    </view>
  );
}

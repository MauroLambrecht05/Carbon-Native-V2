// ServerRail — left-most 72 px column. Vertical list of "server" buttons,
// each a 48×48 monogram tile. Active server: full 40×4 pill flush at the
// rail's left edge + tile in squircle (16 radius) shape. Unread: small
// 8×4 pill. Notification badges sit at the bottom-right of the tile.
//
// Layout per row: pill (4 wide, flush left) + 8 gap + tile (48×48, centered)
// + 12 right pad → total 72. Pill width is reserved even when invisible so
// every tile lines up at the same x.

import {
  Compass,
  Plus,
  Home,
  Download,
} from "lucide-react";
import { useTheme } from "../theme.tsx";
import type { Server } from "../data/mock.ts";

interface ServerRailProps {
  servers: Server[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function ServerRail({ servers, activeId, onSelect }: ServerRailProps) {
  const { colors } = useTheme();
  return (
    <view
      style={{
        width: 72,
        background: colors.serverRailBg,
        flexDirection: "column",
        alignItems: "stretch",
        paddingTop: 12,
        paddingBottom: 12,
        gap: 8,
        overflowY: "scroll",
        flexShrink: 0,
      }}
    >
      {/* Home pseudo-server — single round icon at the top */}
      <ServerIcon
        active={activeId === "home"}
        onPress={() => onSelect("home")}
        round
        background={activeId === "home" ? colors.accent : colors.surfaceElevated}
      >
        <Home size={22} color="#ffffff" strokeWidth={2.25} />
      </ServerIcon>

      {/* Divider line */}
      <view
        style={{
          width: 32,
          height: 2,
          borderRadius: 1,
          background: colors.separator,
          marginLeft: 20,
          marginRight: 20,
          marginTop: 0,
          marginBottom: 0,
        }}
      />

      {/* The actual server list */}
      {servers
        .filter((s) => s.id !== "home")
        .map((s) => (
          <ServerIcon
            key={s.id}
            active={activeId === s.id}
            unread={s.unread}
            pings={s.pings}
            onPress={() => onSelect(s.id)}
            background={s.color}
          >
            <text style={{ color: "#ffffff", fontSize: 14, fontWeight: 600 }}>
              {s.monogram}
            </text>
          </ServerIcon>
        ))}

      {/* Add-server + Discover + Download (round + green-on-hover). */}
      <ServerIcon
        round
        onPress={() => {}}
        background={colors.surfaceElevated}
      >
        <Plus size={22} color={colors.online} strokeWidth={2.5} />
      </ServerIcon>
      <ServerIcon
        round
        onPress={() => {}}
        background={colors.surfaceElevated}
      >
        <Compass size={22} color={colors.online} strokeWidth={2.25} />
      </ServerIcon>
      <ServerIcon
        round
        onPress={() => {}}
        background={colors.surfaceElevated}
      >
        <Download size={22} color={colors.online} strokeWidth={2.25} />
      </ServerIcon>
    </view>
  );
}

// ─── ServerIcon ───────────────────────────────────────────────────────────

interface ServerIconProps {
  children: any;
  active?: boolean;
  unread?: boolean;
  pings?: number;
  round?: boolean;
  background: string;
  onPress: () => void;
}

function ServerIcon({
  children,
  active = false,
  unread = false,
  pings,
  round = false,
  background,
  onPress,
}: ServerIconProps) {
  const { colors } = useTheme();
  // Active = full pill (40 high). Unread = small pill (8 high). Default = none.
  const pillH = active ? 40 : unread ? 8 : 0;
  return (
    <view
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: 48,
      }}
    >
      {/* Left-edge pill — width always 4, height varies. Reserved space
          (margin-right 8) keeps every tile at the same x regardless of
          whether the pill is visible. */}
      <view
        style={{
          width: 4,
          height: pillH > 0 ? pillH : 0,
          background: pillH > 0 ? colors.textBright : "transparent",
          borderRadius: 2,
          marginRight: 8,
          flexShrink: 0,
        }}
      />
      <view
        onClick={onPress}
        style={{
          width: 48,
          height: 48,
          borderRadius: round || active ? 16 : 24,
          background,
          // Round utility tiles (Add/Discover/Download) tint to the
          // accent green on hover; branded server tiles keep their own
          // color (Discord uses a shape morph for those, which we can't
          // animate today).
          backgroundHover: round ? colors.online : background,
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          flexDirection: "row",
          flexShrink: 0,
        }}
      >
        {children}
      </view>
      {/* Ping badge — rendered as a sibling so it can hang off the bottom-
          right of the tile via negative margins. (No absolute positioning
          in the runtime yet.) */}
      {pings !== undefined && pings > 0 && (
        <view
          style={{
            width: 18,
            height: 18,
            borderRadius: 9,
            background: colors.dnd,
            borderWidth: 3,
            borderColor: colors.serverRailBg,
            marginLeft: -16,
            marginTop: 28,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <text style={{ color: "#ffffff", fontSize: 10, fontWeight: 700 }}>
            {pings > 9 ? "9+" : String(pings)}
          </text>
        </view>
      )}
    </view>
  );
}

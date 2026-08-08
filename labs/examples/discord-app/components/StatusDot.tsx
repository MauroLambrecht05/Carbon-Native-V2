// StatusDot — small colored dot drawn over the bottom-right of an avatar.
// online = solid green, idle = yellow with a moon-ish carve, dnd = red
// with a horizontal cut, offline = ring. Position is achieved by a
// negative margin on a wrapper around it; see `AvatarWithStatus` below.

import { useTheme } from "../theme.tsx";

interface StatusDotProps {
  status: "online" | "idle" | "dnd" | "offline";
  /** Diameter in pixels. */
  size?: number;
  /** Background color the dot is rendered ON (drawn as a ring around the
   *  status circle so the 2-3 px gap reads correctly against any surface). */
  outline: string;
}

export function StatusDot({ status, size = 12, outline }: StatusDotProps) {
  const { colors } = useTheme();
  const fill =
    status === "online"  ? colors.online  :
    status === "idle"    ? colors.idle    :
    status === "dnd"     ? colors.dnd     :
                           colors.offline;
  const ring = 4; // outline thickness, total wrapper = size + ring
  return (
    <view
      style={{
        width: size + ring,
        height: size + ring,
        borderRadius: (size + ring) / 2,
        background: outline,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <view
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          background: status === "offline" ? "transparent" : fill,
          borderWidth: status === "offline" ? 3 : 0,
          borderColor: colors.offline,
        }}
      />
    </view>
  );
}

// ─── AvatarWithStatus ─────────────────────────────────────────────────────
//
// Co-positions an Avatar and StatusDot so the dot sits at the bottom-right
// corner of the avatar (Discord-style). Math:
//   wrapper_size = avatar_size  → outer flex-row has avatar_size width
//   dot wrapper width = dot_size + ring
//   dot is shifted left by (dot wrapper width) so it overlaps the avatar's
//   right edge from outside, with 0 px of dot ABOVE the avatar's bottom
//
// Result: the dot ring sits flush at the bottom-right corner with the
// dot itself centered on the corner.

import { Avatar } from "./Avatar.tsx";

interface AvatarWithStatusProps {
  name: string;
  status: "online" | "idle" | "dnd" | "offline";
  /** Outer avatar diameter. Default 32. */
  size?: number;
  /** Dot diameter (NOT including ring). Default scales with avatar. */
  dotSize?: number;
  /** Background of the surface the avatar sits on — drawn as the ring
   *  around the dot so the negative space against any panel is correct. */
  outline: string;
  /** Override avatar background color (server icons etc.). */
  backgroundOverride?: string;
  isDark?: boolean;
}

export function AvatarWithStatus({
  name,
  status,
  size = 32,
  dotSize,
  outline,
  backgroundOverride,
  isDark = true,
}: AvatarWithStatusProps) {
  const ds = dotSize ?? Math.max(10, Math.round(size * 0.35));
  const ring = 4;
  const dotWrapper = ds + ring;
  return (
    <view
      style={{
        flexDirection: "row",
        alignItems: "flex-end",
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <Avatar
        name={name}
        size={size}
        isDark={isDark}
        backgroundOverride={backgroundOverride}
      />
      <view
        style={{
          marginLeft: -dotWrapper,
          marginBottom: 0,
        }}
      >
        <StatusDot status={status} size={ds} outline={outline} />
      </view>
    </view>
  );
}

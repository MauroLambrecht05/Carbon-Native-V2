// Avatar — circular monogram (initials on a deterministic color). Looks
// the same every time for the same user, no image fetch, no decoded
// asset. We don't have <img> in the runtime today; this also keeps the
// stress-test free of network/decoding work so we can profile pure
// layout + paint.

import { avatarColor } from "../theme.tsx";

interface AvatarProps {
  name: string;
  /** Outer pixel size of the circle. Default 40 (Discord-message size). */
  size?: number;
  /** Border-radius. Default = round. Pass < size/2 for the squircle look
   *  Discord uses on the server rail. */
  radius?: number;
  /** When true, use the dark-mode HSL palette for the background hue. */
  isDark?: boolean;
  /** Override the background paint (server icons, bot avatars). */
  backgroundOverride?: string;
  /** Foreground text color. Default white. */
  fg?: string;
}

export function Avatar({
  name,
  size = 40,
  radius,
  isDark = true,
  backgroundOverride,
  fg = "#ffffff",
}: AvatarProps) {
  const bg = backgroundOverride ?? avatarColor(name);
  // Initials: two chars from a one- or two-word name. "alice" → "AL",
  // "Carbon Builders" → "CB". Skip spaces, take first letter of first
  // two non-empty tokens.
  const tokens = name.split(/\s+/).filter(Boolean);
  const initials =
    tokens.length >= 2
      ? (tokens[0][0] + tokens[1][0]).toUpperCase()
      : name.slice(0, 2).toUpperCase();
  const r = radius ?? size / 2;
  // Font size scales with avatar so initials read at any size.
  const fs = Math.max(10, Math.round(size * 0.4));
  return (
    <view
      style={{
        width: size,
        height: size,
        borderRadius: r,
        background: bg,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <text style={{ color: fg, fontSize: fs, fontWeight: 600 }}>{initials}</text>
    </view>
  );
}

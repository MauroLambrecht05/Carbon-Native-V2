// MemberList — right-most 240 px column. Members grouped by role/status:
//   ROLE NAME — N
//   ── (online users in that role)
//   OFFLINE — N
//   ── (offline users, dimmed)

import { useMemo } from "react";
import { useTheme, userColor } from "../theme.tsx";
import { AvatarWithStatus } from "./StatusDot.tsx";
import type { User } from "../data/mock.ts";

interface MemberListProps {
  users: User[];
  themeName: "light" | "dark";
}

export function MemberList({ users, themeName }: MemberListProps) {
  const { colors } = useTheme();

  const groups = useMemo(() => {
    // Online users: group by role. Offline users: one bucket at the bottom.
    const online: Record<string, User[]> = {};
    const offline: User[] = [];
    for (const u of users) {
      if (u.status === "offline") {
        offline.push(u);
      } else {
        const r = u.bot ? "Bots" : (u.role ?? "Member");
        if (!online[r]) online[r] = [];
        online[r].push(u);
      }
    }
    // Stable role ordering — Maintainer first, Bot last, alphabetic between.
    const order = (r: string) =>
      r === "Maintainer" ? 0 :
      r === "Contributor" ? 1 :
      r === "Bots" ? 99 :
      2;
    const onlineGroups = Object.entries(online)
      .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b));
    return { onlineGroups, offline };
  }, [users]);

  return (
    <view
      style={{
        width: 240,
        background: colors.memberListBg,
        flexDirection: "column",
        overflowY: "scroll",
        paddingTop: 16,
        paddingBottom: 16,
      }}
    >
      {groups.onlineGroups.map(([role, members]) => (
        <Group
          key={role}
          label={role.toUpperCase()}
          count={members.length}
          users={members}
          dim={false}
          themeName={themeName}
        />
      ))}
      {groups.offline.length > 0 && (
        <Group
          label="OFFLINE"
          count={groups.offline.length}
          users={groups.offline}
          dim
          themeName={themeName}
        />
      )}
    </view>
  );
}

// ─── Group ────────────────────────────────────────────────────────────────

interface GroupProps {
  label: string;
  count: number;
  users: User[];
  dim: boolean;
  themeName: "light" | "dark";
}

function Group({ label, count, users, dim, themeName }: GroupProps) {
  const { colors } = useTheme();
  return (
    <view style={{ flexDirection: "column", paddingTop: 16 }}>
      <view style={{ paddingLeft: 16, paddingRight: 16, paddingBottom: 4 }}>
        <text
          style={{
            color: colors.textFaint,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {label} — {count}
        </text>
      </view>
      <view style={{ flexDirection: "column", paddingLeft: 8, paddingRight: 8, gap: 1 }}>
        {users.map((u) => (
          <MemberRow key={u.id} user={u} dim={dim} themeName={themeName} />
        ))}
      </view>
    </view>
  );
}

// ─── MemberRow ────────────────────────────────────────────────────────────

interface MemberRowProps {
  user: User;
  dim: boolean;
  themeName: "light" | "dark";
}

function MemberRow({ user, dim, themeName }: MemberRowProps) {
  const { colors } = useTheme();
  const nameColor = user.bot
    ? colors.textBright
    : userColor(user.name, themeName === "dark");
  return (
    <view
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingTop: 4,
        paddingBottom: 4,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 4,
        backgroundHover: colors.surfaceHover,
        cursor: "pointer",
        opacity: dim ? 0.4 : 1,
      }}
    >
      <AvatarWithStatus
        name={user.name}
        status={user.status}
        size={32}
        outline={colors.memberListBg}
        isDark={themeName === "dark"}
      />
      <view style={{ flexDirection: "column", flexGrow: 1 }}>
        <view style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <text
            style={{
              color: nameColor,
              fontSize: 15,
              fontWeight: 500,
            }}
          >
            {user.name}
          </text>
          {user.bot && (
            <view
              style={{
                background: colors.accent,
                paddingTop: 1,
                paddingBottom: 1,
                paddingLeft: 4,
                paddingRight: 4,
                borderRadius: 3,
              }}
            >
              <text style={{ color: "#ffffff", fontSize: 9, fontWeight: 700 }}>
                BOT
              </text>
            </view>
          )}
        </view>
        {user.customStatus && (
          <text style={{ color: colors.textFaint, fontSize: 12 }}>
            {user.customStatus}
          </text>
        )}
      </view>
    </view>
  );
}

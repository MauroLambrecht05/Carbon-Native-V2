// MessageStream — main pane content. Header bar + scrollable message list.
// Messages from the same author within 5 minutes collapse into a "run" —
// first message in the run shows avatar + name + timestamp, subsequent
// messages just show the body indented to where the avatar sits.

import { Fragment, useMemo } from "react";
import { format, isToday, isYesterday } from "date-fns";
import {
  Hash,
  Volume2,
  Megaphone,
  Radio,
  Bell,
  Pin,
  Users,
  Search,
  Inbox,
  HelpCircle,
  SmilePlus,
  CornerUpLeft,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Rocket,
  ThumbsUp,
  Heart,
  Flame,
  PartyPopper,
} from "lucide-react";
import { useTheme, userColor } from "../theme.tsx";
import { Avatar } from "./Avatar.tsx";
import { Markdown } from "./Markdown.tsx";
import {
  groupMessages,
  USERS_BY_ID,
  type Channel,
  type Message,
} from "../data/mock.ts";

// Map mock-data reaction `emoji` strings to lucide icons. Our fontdue
// subset doesn't ship emoji glyphs, so rendering "🎉" produces a missing-
// glyph box; lucide gives us a clean vector alternative until we add an
// emoji-capable font fallback.
const REACTION_ICONS: Record<string, any> = {
  "🎉": PartyPopper,
  "🚀": Rocket,
  "👍": ThumbsUp,
  "❤️": Heart,
  "🔥": Flame,
  "🦀": Sparkles, // we don't have a crab icon, sparkle is a friendly fallback
  "✨": Sparkles,
};

interface MessageStreamProps {
  channel: Channel;
  messages: Message[];
  memberListOpen: boolean;
  onToggleMemberList: () => void;
}

export function MessageStream({
  channel,
  messages,
  memberListOpen,
  onToggleMemberList,
}: MessageStreamProps) {
  const { colors, name: themeName } = useTheme();
  const Icon =
    channel.kind === "voice"        ? Volume2 :
    channel.kind === "announcement" ? Megaphone :
    channel.kind === "stage"        ? Radio :
                                      Hash;

  const groups = useMemo(() => groupMessages(messages), [messages]);

  return (
    <view
      style={{
        flexGrow: 1,
        flexDirection: "column",
        background: colors.mainBg,
        minHeight: 0,
      }}
    >
      {/* Header bar */}
      <view
        style={{
          height: 48,
          flexShrink: 0,
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: 16,
          paddingRight: 16,
          gap: 12,
        }}
      >
        <Icon size={24} color={colors.textFaint} strokeWidth={2} />
        <text style={{ color: colors.textBright, fontSize: 16, fontWeight: 600 }}>
          {channel.name}
        </text>
        {channel.topic && (
          <Fragment>
            <view
              style={{
                width: 1,
                height: 24,
                background: colors.divider,
                marginLeft: 8,
                marginRight: 8,
              }}
            />
            <text style={{ color: colors.textMuted, fontSize: 14 }}>
              {channel.topic}
            </text>
          </Fragment>
        )}
        <view style={{ flexGrow: 1 }} />
        <HeaderIconButton><Bell  size={20} color={colors.textMuted} strokeWidth={2} /></HeaderIconButton>
        <HeaderIconButton><Pin   size={20} color={colors.textMuted} strokeWidth={2} /></HeaderIconButton>
        <HeaderIconButton onPress={onToggleMemberList}>
          <Users size={20} color={memberListOpen ? colors.textBright : colors.textMuted} strokeWidth={2} />
        </HeaderIconButton>
        <view
          style={{
            width: 144,
            height: 24,
            background: colors.surfaceElevated,
            backgroundHover: colors.surfaceHover,
            borderRadius: 4,
            paddingLeft: 6,
            paddingRight: 6,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            cursor: "pointer",
          }}
        >
          <text style={{ color: colors.textFaint, fontSize: 12 }}>Search</text>
          <Search size={14} color={colors.textFaint} strokeWidth={2} />
        </view>
        <HeaderIconButton><Inbox       size={20} color={colors.textMuted} strokeWidth={2} /></HeaderIconButton>
        <HeaderIconButton><HelpCircle  size={20} color={colors.textMuted} strokeWidth={2} /></HeaderIconButton>
      </view>

      {/* 1px divider line below the header (rendered as a flat view, not a
          border, so it shows on the bottom edge only). */}
      <view
        style={{
          height: 1,
          background: colors.separator,
          flexShrink: 0,
        }}
      />

      {/* Message list — flex-grow:1 + min-height:0 + overflow-y:scroll is the
          canonical recipe for "scrollable region inside a flex column". */}
      <view
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
          flexDirection: "column",
          overflowY: "scroll",
          paddingTop: 16,
          paddingBottom: 16,
        }}
      >
        {/* Channel-start banner */}
        <view
          style={{
            paddingTop: 16,
            paddingBottom: 16,
            paddingLeft: 16,
            paddingRight: 16,
            flexDirection: "column",
            gap: 6,
          }}
        >
          <view
            style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              background: colors.surfaceElevated,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon size={40} color={colors.textBright} strokeWidth={2} />
          </view>
          <text style={{ color: colors.textBright, fontSize: 32, fontWeight: 800, paddingTop: 12 }}>
            Welcome to #{channel.name}!
          </text>
          <text style={{ color: colors.textMuted, fontSize: 16 }}>
            This is the start of the #{channel.name} channel. {channel.topic ?? ""}
          </text>
        </view>

        {groups.map((group) => (
          <MessageGroup key={group[0].id} group={group} themeName={themeName} />
        ))}
      </view>
    </view>
  );
}

// ─── MessageGroup ─────────────────────────────────────────────────────────

interface MessageGroupProps {
  group: Message[];
  themeName: "light" | "dark";
}

function MessageGroup({ group, themeName }: MessageGroupProps) {
  const { colors } = useTheme();
  const head = group[0];
  const author = USERS_BY_ID[head.authorId];
  if (!author) return null;
  const nameColor = userColor(author.name, themeName === "dark");
  return (
    <view
      style={{
        paddingTop: 20,
        paddingBottom: 4,
        paddingLeft: 16,
        paddingRight: 64,
        flexDirection: "row",
        gap: 16,
        backgroundHover: colors.surfaceSubtle,
      }}
    >
      <view style={{ width: 40, flexShrink: 0 }}>
        <Avatar name={author.name} size={40} isDark={themeName === "dark"} />
      </view>
      <view style={{ flexGrow: 1, flexDirection: "column", gap: 4 }}>
        <view style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <text
            style={{
              color: author.bot ? colors.textBright : nameColor,
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            {author.name}
          </text>
          {author.bot && (
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
              <text style={{ color: "#ffffff", fontSize: 10, fontWeight: 700 }}>
                BOT
              </text>
            </view>
          )}
          <text style={{ color: colors.textFaint, fontSize: 12 }}>
            {formatTimestamp(head.ts)}
          </text>
        </view>
        {group.map((m) => (
          <MessageBody key={m.id} message={m} />
        ))}
      </view>
    </view>
  );
}

// ─── MessageBody ──────────────────────────────────────────────────────────

function MessageBody({ message }: { message: Message }) {
  const { colors } = useTheme();
  return (
    <view style={{ flexDirection: "column", gap: 6, paddingTop: 2 }}>
      <Markdown body={message.body} edited={message.edited} />
      {message.reactions && message.reactions.length > 0 && (
        <view
          style={{
            flexDirection: "row",
            gap: 4,
            paddingTop: 4,
            flexWrap: "wrap",
          }}
        >
          {message.reactions.map((r) => {
            const Icon = REACTION_ICONS[r.emoji] ?? Sparkles;
            return (
              <view
                key={r.emoji}
                style={{
                  paddingTop: 3,
                  paddingBottom: 3,
                  paddingLeft: 6,
                  paddingRight: 8,
                  borderRadius: 8,
                  background: r.mine ? colors.mentionBg : colors.surfaceElevated,
                  backgroundHover: r.mine ? colors.mentionBg : colors.surfaceHover,
                  borderWidth: 1,
                  borderColor: r.mine ? colors.mentionBar : "transparent",
                  flexDirection: "row",
                  gap: 6,
                  alignItems: "center",
                  cursor: "pointer",
                }}
              >
                <Icon
                  size={16}
                  color={r.mine ? colors.mentionBar : colors.textMuted}
                  strokeWidth={2}
                />
                <text
                  style={{
                    color: r.mine ? colors.mentionBar : colors.textMuted,
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {r.count}
                </text>
              </view>
            );
          })}
          {/* "Add reaction" affordance — appears next to existing reactions,
              dim by default, brightens on hover. */}
          <ReactionAddButton colors={colors} />
        </view>
      )}
    </view>
  );
}

// ─── HeaderIconButton ─────────────────────────────────────────────────────

function HeaderIconButton({ children, onPress }: { children: any; onPress?: () => void }) {
  const { colors } = useTheme();
  return (
    <view
      onClick={onPress}
      style={{
        width: 32,
        height: 32,
        borderRadius: 4,
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        backgroundHover: colors.surfaceHover,
      }}
    >
      {children}
    </view>
  );
}

function ReactionAddButton({ colors }: { colors: ReturnType<typeof useTheme>["colors"] }) {
  return (
    <view
      style={{
        paddingTop: 3,
        paddingBottom: 3,
        paddingLeft: 6,
        paddingRight: 6,
        borderRadius: 8,
        background: colors.surfaceElevated,
        backgroundHover: colors.surfaceHover,
        borderWidth: 1,
        borderColor: "transparent",
        flexDirection: "row",
        alignItems: "center",
        cursor: "pointer",
      }}
    >
      <SmilePlus size={16} color={colors.textFaint} strokeWidth={2} />
    </view>
  );
}

// ─── helpers ──────────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  if (isToday(d)) return `Today at ${format(d, "p")}`;
  if (isYesterday(d)) return `Yesterday at ${format(d, "p")}`;
  return format(d, "MMM d, yyyy 'at' p");
}

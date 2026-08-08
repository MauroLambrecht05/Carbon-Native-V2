// MessageInput — bottom composer. Rounded box with attachment + emoji
// buttons, multi-line textarea, send-on-Enter (Shift+Enter for newline
// remains a TODO until the runtime exposes onKeyDown).

import {
  CirclePlus,
  Gift,
  Smile,
  AtSign,
  Sticker,
} from "lucide-react";
import { useTheme } from "../theme.tsx";
import type { Channel } from "../data/mock.ts";

interface MessageInputProps {
  channel: Channel;
  draft: string;
  onChange: (body: string) => void;
  onSend: (body: string) => void;
}

export function MessageInput({ channel, draft, onChange, onSend }: MessageInputProps) {
  const { colors } = useTheme();

  // Send-on-Enter, inline. The runtime inserts a literal "\n" into the
  // textarea on Enter (no onKeyDown yet), so we detect that here in
  // onChange — synchronously, no useEffect — and route a trailing newline
  // to onSend instead of letting it land in the draft. Whitespace-only
  // values clear the draft without sending.
  const handleChange = (value: string) => {
    if (value.endsWith("\n")) {
      const body = value.slice(0, -1);
      if (body.trim()) onSend(body);
      else onChange("");
      return;
    }
    onChange(value);
  };

  return (
    <view
      style={{
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 0,
        paddingBottom: 24,
        flexDirection: "column",
        background: colors.mainBg,
        flexShrink: 0,
      }}
    >
      <view
        style={{
          background: colors.composerBg,
          borderRadius: 8,
          flexDirection: "row",
          alignItems: "flex-start",
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 0,
          paddingRight: 8,
        }}
      >
        {/* Plus / attachment button. Owns its own hover circle so it
            reads as a distinct click target. */}
        <view
          style={{
            width: 40,
            height: 40,
            marginLeft: 4,
            marginTop: 4,
            marginBottom: 4,
            borderRadius: 20,
            alignItems: "center",
            justifyContent: "center",
            backgroundHover: colors.surfaceHover,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <CirclePlus size={22} color={colors.textMuted} strokeWidth={2} />
        </view>

        {/* Textarea — auto-grows. Slightly thicker line height than the
            default to give the composer real visual presence. */}
        <textarea
          value={draft}
          placeholder={`Message #${channel.name}`}
          onChange={(e: any) => handleChange(e.target.value)}
          style={{
            width: 0,
            flexGrow: 1,
            paddingTop: 12,
            paddingBottom: 12,
            paddingLeft: 0,
            paddingRight: 0,
            fontSize: 15,
            color: colors.textBright,
            background: "transparent",
            minHeight: 24,
          }}
        />

        {/* Right-side icon strip */}
        <view
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingTop: 8,
            paddingBottom: 8,
          }}
        >
          <ComposerIcon><Gift    size={20} color={colors.textMuted} strokeWidth={2} /></ComposerIcon>
          <ComposerIcon><Sticker size={20} color={colors.textMuted} strokeWidth={2} /></ComposerIcon>
          <ComposerIcon><AtSign  size={20} color={colors.textMuted} strokeWidth={2} /></ComposerIcon>
          <ComposerIcon><Smile   size={20} color={colors.textMuted} strokeWidth={2} /></ComposerIcon>
        </view>
      </view>
    </view>
  );
}

function ComposerIcon({ children }: { children: any }) {
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

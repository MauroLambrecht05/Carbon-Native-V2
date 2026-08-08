// Markdown — minimal inline + block parser sized for chat messages.
// Supports:
//   - Triple-backtick code blocks (multi-line)
//   - "> " line-prefix blockquotes
//   - "- " or "• " bullet lists
//   - **bold** / __bold__
//   - *italic* / _italic_
//   - `inline code`
//   - @mention (renders with mention background)
//
// Not supported: headings, links, tables, images. Not the goal — chat
// messages don't usually need them, and our renderer doesn't have <a>
// or image elements anyway.
//
// Each token becomes a `<text>` node so style cascades correctly. Blocks
// (codeblock, quote) get their own `<view>` wrapper.

import { Fragment } from "react";
import { useTheme } from "../theme.tsx";

interface MarkdownProps {
  body: string;
  /** Append "(edited)" inline at the end of the last line. */
  edited?: boolean;
}

type InlineToken =
  | { kind: "plain"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "mention"; text: string };

type Block =
  | { kind: "para"; lines: string[] }
  | { kind: "code"; lines: string[]; lang?: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; items: string[] };

export function Markdown({ body, edited }: MarkdownProps) {
  const { colors } = useTheme();
  const blocks = parseBlocks(body);

  return (
    <view style={{ flexDirection: "column", gap: 4 }}>
      {blocks.map((b, bi) => {
        const isLast = bi === blocks.length - 1;
        return (
          <BlockView
            key={bi}
            block={b}
            appendEdited={isLast ? edited : false}
            colors={colors}
          />
        );
      })}
    </view>
  );
}

// ─── Block layout ─────────────────────────────────────────────────────────

interface BlockViewProps {
  block: Block;
  appendEdited: boolean;
  colors: ReturnType<typeof useTheme>["colors"];
}

function BlockView({ block, appendEdited, colors }: BlockViewProps) {
  if (block.kind === "code") {
    return (
      <view
        style={{
          background: colors.surfaceElevated,
          borderRadius: 4,
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 8,
          paddingRight: 8,
          flexDirection: "column",
        }}
      >
        {block.lines.map((l, i) => (
          <text
            key={i}
            style={{
              color: colors.textBright,
              fontSize: 13,
              fontWeight: 400,
            }}
          >
            {l || " "}
          </text>
        ))}
        {appendEdited && <EditedTag colors={colors} />}
      </view>
    );
  }
  if (block.kind === "quote") {
    return (
      <view style={{ flexDirection: "row", gap: 8, paddingLeft: 0 }}>
        <view
          style={{
            width: 4,
            background: colors.divider,
            borderRadius: 2,
            flexShrink: 0,
          }}
        />
        <view style={{ flexDirection: "column", flexGrow: 1, gap: 2, paddingTop: 2, paddingBottom: 2 }}>
          {block.lines.map((l, i) => (
            <Inline
              key={i}
              line={l}
              colors={colors}
              tail={appendEdited && i === block.lines.length - 1 ? "edited" : "none"}
            />
          ))}
        </view>
      </view>
    );
  }
  if (block.kind === "list") {
    return (
      <view style={{ flexDirection: "column", gap: 4 }}>
        {block.items.map((item, i) => (
          <view key={i} style={{ flexDirection: "row", gap: 8, paddingLeft: 4 }}>
            <text style={{ color: colors.textMuted, fontSize: 15 }}>•</text>
            <view style={{ flexGrow: 1 }}>
              <Inline
                line={item}
                colors={colors}
                tail={appendEdited && i === block.items.length - 1 ? "edited" : "none"}
              />
            </view>
          </view>
        ))}
      </view>
    );
  }
  // para
  return (
    <view style={{ flexDirection: "column", gap: 2 }}>
      {block.lines.map((l, i) => (
        <Inline
          key={i}
          line={l}
          colors={colors}
          tail={appendEdited && i === block.lines.length - 1 ? "edited" : "none"}
        />
      ))}
    </view>
  );
}

// ─── Inline rendering ─────────────────────────────────────────────────────

interface InlineProps {
  line: string;
  colors: ReturnType<typeof useTheme>["colors"];
  tail: "edited" | "none";
}

function Inline({ line, colors, tail }: InlineProps) {
  const tokens = tokenizeInline(line);
  return (
    <view style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 0 }}>
      {tokens.map((t, i) => (
        <Fragment key={i}>
          <TokenView token={t} colors={colors} />
        </Fragment>
      ))}
      {tail === "edited" && (
        <text style={{ color: colors.textFaint, fontSize: 10, paddingLeft: 6 }}>
          (edited)
        </text>
      )}
    </view>
  );
}

function TokenView({
  token,
  colors,
}: {
  token: InlineToken;
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  if (token.kind === "code") {
    return (
      <text
        style={{
          background: colors.surfaceElevated,
          color: colors.textBright,
          fontSize: 14,
          paddingTop: 1,
          paddingBottom: 1,
          paddingLeft: 4,
          paddingRight: 4,
          borderRadius: 3,
        }}
      >
        {token.text}
      </text>
    );
  }
  if (token.kind === "mention") {
    return (
      <text
        style={{
          background: colors.mentionBg,
          color: colors.mentionBar,
          fontSize: 15,
          fontWeight: 500,
          paddingTop: 1,
          paddingBottom: 1,
          paddingLeft: 3,
          paddingRight: 3,
          borderRadius: 3,
        }}
      >
        {token.text}
      </text>
    );
  }
  if (token.kind === "bold") {
    return (
      <text style={{ color: colors.text, fontSize: 15, fontWeight: 700 }}>
        {token.text}
      </text>
    );
  }
  if (token.kind === "italic") {
    // Our font subset doesn't have a real italic face — we can't fake
    // slanting at paint time, so italic markers render as plain text but
    // slightly brighter. (Better than swallowing the syntax.)
    return (
      <text style={{ color: colors.textBright, fontSize: 15 }}>
        {token.text}
      </text>
    );
  }
  return (
    <text style={{ color: colors.text, fontSize: 15 }}>
      {token.text}
    </text>
  );
}

function EditedTag({ colors }: { colors: ReturnType<typeof useTheme>["colors"] }) {
  return (
    <text style={{ color: colors.textFaint, fontSize: 10, paddingTop: 4 }}>
      (edited)
    </text>
  );
}

// ─── Parsers ──────────────────────────────────────────────────────────────

function parseBlocks(body: string): Block[] {
  const lines = body.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Code fence
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      out.push({ kind: "code", lines: codeLines, lang });
      continue;
    }
    // Quote (one or more consecutive "> " lines)
    if (line.startsWith("> ") || line === ">") {
      const qLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        qLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      out.push({ kind: "quote", lines: qLines });
      continue;
    }
    // List (consecutive "- " or "• " lines)
    if (/^[-•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^[-•]\s+/, ""));
        i++;
      }
      out.push({ kind: "list", items });
      continue;
    }
    // Paragraph: gather contiguous non-block lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("> ") &&
      lines[i] !== ">" &&
      !/^[-•]\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      out.push({ kind: "para", lines: paraLines });
    }
  }
  return out.length === 0 ? [{ kind: "para", lines: [""] }] : out;
}

function tokenizeInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  // Inline grammar: ` (code) > ** (bold) > * (italic) > @ (mention) > plain.
  // Non-greedy, single-line.
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|@[A-Za-z0-9_-]+)/;
  let rest = text;
  while (rest.length > 0) {
    const match = rest.match(pattern);
    if (!match || match.index === undefined) {
      out.push({ kind: "plain", text: rest });
      break;
    }
    if (match.index > 0) {
      out.push({ kind: "plain", text: rest.slice(0, match.index) });
    }
    const tok = match[0];
    if (tok.startsWith("`")) {
      out.push({ kind: "code", text: tok.slice(1, -1) });
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push({ kind: "bold", text: tok.slice(2, -2) });
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      out.push({ kind: "italic", text: tok.slice(1, -1) });
    } else if (tok.startsWith("@")) {
      out.push({ kind: "mention", text: tok });
    } else {
      out.push({ kind: "plain", text: tok });
    }
    rest = rest.slice(match.index + tok.length);
  }
  return out;
}

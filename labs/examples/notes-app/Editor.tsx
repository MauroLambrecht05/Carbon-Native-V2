// Editor — Notion-style page. Icons via lucide-react.

import { Fragment, useEffect, useMemo, useRef } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  ChevronRight,
  Trash2,
  Pencil,
  PlusSquare,
  Tag,
} from "lucide-react";
import {
  Button,
  Divider,
  PropertyRow,
  PropertyText,
  TagChip,
} from "./components.tsx";
import { useTheme } from "./theme.tsx";
import type { NotesApi } from "./notes.ts";

interface EditorProps {
  api: NotesApi;
}

export function Editor({ api }: EditorProps) {
  const { colors } = useTheme();
  const note = api.selected;

  const lastActionRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!note) return;
    // eslint-disable-next-line no-console
    console.log("[editor] selected", note.id, note.title);
    return () => {
      // eslint-disable-next-line no-console
      console.log("[editor] cleanup", note.id);
    };
  }, [note?.id]);

  const stats = useMemo(() => {
    if (!note) return { words: 0, chars: 0, lines: 0 };
    const text = note.body;
    return {
      words: text.split(/\s+/).filter(Boolean).length,
      chars: text.length,
      lines: text.split("\n").length,
    };
  }, [note?.body]);

  if (!note) {
    return (
      <view
        style={{
          flexGrow: 1,
          background: colors.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <text style={{ color: colors.textFaint, fontSize: 14 }}>
          Select a page from the sidebar
        </text>
      </view>
    );
  }

  const cycleTitle = () => {
    lastActionRef.current = Date.now();
    const tail = note.title.match(/\((\d+)\)$/);
    const next = tail
      ? note.title.replace(/\(\d+\)$/, `(${Number(tail[1]) + 1})`)
      : `${note.title} (1)`;
    api.rename(note.id, next);
  };
  const appendChunk = () => {
    lastActionRef.current = Date.now();
    api.appendBody(note.id, ` Appended at ${format(new Date(), "p")}.`);
  };
  const addRandomTag = () => {
    lastActionRef.current = Date.now();
    api.addTag(note.id, api.randomTag());
  };
  const onDelete = () => {
    lastActionRef.current = Date.now();
    api.deleteNote(note.id);
  };

  return (
    <view
      style={{
        flexGrow: 1,
        flexDirection: "column",
        background: colors.bg,
        overflowY: "scroll",
      }}
    >
      {/* Top bar */}
      <view
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: 12,
          paddingBottom: 12,
          paddingLeft: 24,
          paddingRight: 16,
        }}
      >
        <view style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <text style={{ color: colors.textMuted, fontSize: 13 }}>
            My workspace
          </text>
          <ChevronRight size={14} color={colors.textFaint} strokeWidth={2} />
          <text style={{ color: colors.text, fontSize: 13, fontWeight: 500 }}>
            {note.title}
          </text>
        </view>
        <view style={{ flexDirection: "row", gap: 4 }}>
          <Button
            label="Rename"
            onPress={cycleTitle}
            size="sm"
            leadingIcon={<Pencil size={13} color={colors.textMuted} strokeWidth={2} />}
          />
          <Button
            label="Append"
            onPress={appendChunk}
            size="sm"
            leadingIcon={<PlusSquare size={13} color={colors.textMuted} strokeWidth={2} />}
          />
          <Button
            label="Add tag"
            onPress={addRandomTag}
            size="sm"
            leadingIcon={<Tag size={13} color={colors.textMuted} strokeWidth={2} />}
          />
          <Button
            label="Delete"
            onPress={onDelete}
            tone="danger"
            size="sm"
            leadingIcon={<Trash2 size={13} color="#ffffff" strokeWidth={2} />}
          />
        </view>
      </view>

      <Divider />

      {/* Page area */}
      <view
        style={{
          paddingTop: 64,
          paddingBottom: 96,
          paddingLeft: 96,
          paddingRight: 96,
          flexDirection: "column",
          gap: 24,
        }}
      >
        {/* Title — real <input>. Click to position caret, drag to select,
            Ctrl+A/C/V/X all wired. No hover box: the I-beam cursor is
            the hint, not a giant gray rectangle. */}
        <input
          value={note.title}
          placeholder="Untitled"
          onChange={(e: any) => api.rename(note.id, e.target.value)}
          style={{
            width: 720,
            fontSize: 40,
            fontWeight: 700,
            color: colors.text,
            background: "transparent",
            paddingTop: 4,
            paddingBottom: 4,
            paddingLeft: 0,
            paddingRight: 0,
            borderRadius: 4,
          }}
        />

        <view style={{ flexDirection: "column", gap: 0, paddingTop: 4 }}>
          <PropertyRow label="Created">
            <PropertyText>
              {format(new Date(note.createdAt), "MMM d, yyyy 'at' p")}
            </PropertyText>
          </PropertyRow>
          <PropertyRow label="Last edited">
            <PropertyText>
              {formatDistanceToNow(new Date(note.updatedAt), { addSuffix: true })}
            </PropertyText>
          </PropertyRow>
          <PropertyRow label="Stats">
            <PropertyText>
              {stats.words} words · {stats.chars} chars · {stats.lines} lines
            </PropertyText>
          </PropertyRow>
          <PropertyRow label="Tags">
            {note.tags.length === 0 ? (
              <text style={{ color: colors.textFaint, fontSize: 13 }}>
                Empty
              </text>
            ) : (
              <Fragment>
                {note.tags.map((t) => (
                  <TagChip
                    key={t}
                    tag={t}
                    onRemove={() => api.removeTag(note.id, t)}
                  />
                ))}
              </Fragment>
            )}
          </PropertyRow>
        </view>

        <Divider />

        {/* Body — real multi-line <textarea>. Click anywhere to position
            caret, drag-select across lines, type to insert, Enter for
            new line, arrow keys (incl. up/down across lines), Ctrl+A/C/V/X. */}
        <textarea
          value={note.body}
          placeholder="Start writing…"
          onChange={(e: any) => {
            // Replace the whole body — no incremental "appendBody" on
            // every keystroke. The reducer's rename-style update is
            // missing for body; the simplest path is a custom action
            // that sets body wholesale.
            api.setBody(note.id, e.target.value);
          }}
          style={{
            width: 720,
            // No fixed height — the runtime auto-grows the textarea to fit
            // the wrapped content (1 line min). Page-level scroll handles
            // overflow, Notion-style.
            minHeight: 240,
            fontSize: 16,
            color: colors.text,
            background: "transparent",
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 0,
            paddingRight: 0,
            borderRadius: 4,
          }}
        />
      </view>
    </view>
  );
}

// Mock data — completely original. Servers, channels, users, and messages
// are made up for the purpose of stress-testing the layout. No real
// communities, brands, or persons are referenced.

export interface Server {
  id: string;
  name: string;
  /** Two-letter monogram shown in the rail when no icon image. */
  monogram: string;
  /** Server-icon background color (HSL hex). */
  color: string;
  unread?: boolean;
  /** Notification badge count (rendered as a small red pill). */
  pings?: number;
}

export interface ChannelCategory {
  id: string;
  name: string;
  channels: Channel[];
}

export interface Channel {
  id: string;
  name: string;
  kind: "text" | "voice" | "announcement" | "stage";
  topic?: string;
  unread?: boolean;
  pings?: number;
}

export interface User {
  id: string;
  name: string;
  /** "tag" = the 4-digit suffix many chat apps use; we keep it for layout. */
  tag: string;
  status: "online" | "idle" | "dnd" | "offline";
  /** Free-text status message — shown below the username. */
  customStatus?: string;
  bot?: boolean;
  role?: string;
  /** Color from theme.userColor(name); cached so re-renders are stable. */
  roleColor?: string;
}

export interface Message {
  id: string;
  authorId: string;
  channelId: string;
  body: string;
  /** Epoch ms. */
  ts: number;
  /** Optional reply-to message id. */
  replyTo?: string;
  /** Reactions: emoji → count. */
  reactions?: { emoji: string; count: number; mine?: boolean }[];
  /** Edited flag (renders "(edited)" inline). */
  edited?: boolean;
}

// ─── Servers ──────────────────────────────────────────────────────────────

export const SERVERS: Server[] = [
  { id: "home", name: "Direct Messages", monogram: "DM", color: "#5865f2" },
  { id: "rust",      name: "Rustaceans",      monogram: "RS", color: "#b7410e", unread: true },
  { id: "carbon",    name: "Carbon Builders", monogram: "CB", color: "#5865f2", pings: 3 },
  { id: "design",    name: "Design Lounge",   monogram: "DL", color: "#eb459e" },
  { id: "music",     name: "Late Night Mix",  monogram: "LN", color: "#9b59b6", unread: true },
  { id: "gamedev",   name: "Indie Gamedev",   monogram: "GD", color: "#23a559" },
  { id: "ml",        name: "ML Practitioners", monogram: "ML", color: "#f0b232" },
  { id: "homelab",   name: "Homelab",         monogram: "HL", color: "#3498db" },
];

export const ACTIVE_SERVER_ID = "carbon";

// ─── Channels (per server — only "carbon" is fleshed out) ─────────────────

export const CHANNELS_BY_SERVER: Record<string, ChannelCategory[]> = {
  carbon: [
    {
      id: "info",
      name: "Information",
      channels: [
        { id: "welcome",     name: "welcome",     kind: "announcement", topic: "Read this first." },
        { id: "rules",       name: "rules",       kind: "text" },
        { id: "announcements", name: "announcements", kind: "announcement", pings: 1 },
      ],
    },
    {
      id: "general",
      name: "General",
      channels: [
        { id: "general",     name: "general",     kind: "text",  topic: "General chat — anything goes." },
        { id: "introductions", name: "introductions", kind: "text" },
        { id: "showcase",    name: "showcase",    kind: "text",  unread: true, topic: "Show off what you're building." },
        { id: "off-topic",   name: "off-topic",   kind: "text" },
      ],
    },
    {
      id: "build",
      name: "Build & Help",
      channels: [
        { id: "help-react",   name: "help-react",   kind: "text", pings: 2 },
        { id: "help-rust",    name: "help-rust",    kind: "text" },
        { id: "perf",         name: "perf-and-bench", kind: "text" },
        { id: "bugs",         name: "bug-reports",  kind: "text", unread: true },
      ],
    },
    {
      id: "voice",
      name: "Voice Channels",
      channels: [
        { id: "lounge",      name: "lounge",      kind: "voice" },
        { id: "pair",        name: "pair-program", kind: "voice" },
        { id: "music-room",  name: "music",       kind: "voice" },
        { id: "stage-1",     name: "stage",       kind: "stage" },
      ],
    },
  ],
  rust: [
    {
      id: "rust-info",
      name: "Information",
      channels: [
        { id: "rust-welcome", name: "welcome", kind: "announcement" },
        { id: "rust-rules",   name: "rules",   kind: "text" },
      ],
    },
    {
      id: "rust-chat",
      name: "Discussion",
      channels: [
        { id: "rust-general", name: "general", kind: "text", unread: true },
        { id: "rust-async",   name: "async",   kind: "text" },
        { id: "rust-help",    name: "help",    kind: "text" },
      ],
    },
  ],
};

export const ACTIVE_CHANNEL_ID = "general";

// ─── Users ────────────────────────────────────────────────────────────────

export const ME: User = {
  id: "u-me",
  name: "you",
  tag: "0001",
  status: "online",
  customStatus: "shipping carbon-mini",
};

export const USERS: User[] = [
  ME,
  { id: "u-1", name: "marlowe",      tag: "1342", status: "online",  role: "Maintainer", customStatus: "fixing wraps" },
  { id: "u-2", name: "haru",         tag: "0044", status: "online",  role: "Maintainer" },
  { id: "u-3", name: "pixel",        tag: "9920", status: "idle",    role: "Contributor" },
  { id: "u-4", name: "sable",        tag: "8810", status: "dnd",     role: "Contributor", customStatus: "🎧 deep focus" },
  { id: "u-5", name: "indigo",       tag: "0007", status: "online",  role: "Contributor" },
  { id: "u-6", name: "wren",         tag: "5512", status: "online",  role: "Member" },
  { id: "u-7", name: "tessa",        tag: "0420", status: "idle",    role: "Member" },
  { id: "u-8", name: "kestrel",      tag: "1101", status: "online",  role: "Member" },
  { id: "u-9", name: "moss",         tag: "0202", status: "offline", role: "Member" },
  { id: "u-10", name: "juniper",     tag: "8888", status: "offline", role: "Member" },
  { id: "u-11", name: "coral",       tag: "3344", status: "online",  role: "Member" },
  { id: "u-12", name: "fern",        tag: "5566", status: "offline", role: "Member" },
  { id: "u-13", name: "bramble",     tag: "7799", status: "dnd",     role: "Member" },
  { id: "u-14", name: "atlas",       tag: "0123", status: "online",  role: "Member" },
  { id: "u-15", name: "monorepo-bot", tag: "0000", status: "online", bot: true, role: "Bot" },
  { id: "u-16", name: "carbon-helper", tag: "0000", status: "online", bot: true, role: "Bot" },
];

export const USERS_BY_ID: Record<string, User> = Object.fromEntries(
  USERS.map((u) => [u.id, u]),
);

// ─── Messages ─────────────────────────────────────────────────────────────
//
// Multiple channels populated so channel-switching is meaningful. Times are
// relative to "now" so formatDistanceToNow renders sensible values.

const NOW = Date.now();
const m = (mins: number) => NOW - mins * 60 * 1000;

export const MESSAGES_BY_CHANNEL: Record<string, Message[]> = {
  general: [
    {
      id: "g1", authorId: "u-1", channelId: "general", ts: m(620),
      body: "morning everyone! pushed the layout-debug overlay last night, ctrl+space toggles it",
    },
    {
      id: "g2", authorId: "u-1", channelId: "general", ts: m(619),
      body: "every node gets a tinted box + colored border, hue is hashed from the node id",
    },
    {
      id: "g3", authorId: "u-2", channelId: "general", ts: m(540),
      body: "@marlowe love it. saved me 20 minutes of wrap debugging this morning",
    },
    {
      id: "g4", authorId: "u-3", channelId: "general", ts: m(480),
      body: "is the rendering pipeline still **tiny-skia + fontdue**? what's the roadmap on text shaping for non-Latin scripts",
    },
    {
      id: "g5", authorId: "u-1", channelId: "general", ts: m(478),
      body: "still tiny-skia + fontdue, yeah. text-shaping is the next big rock — probably **swash** for that",
    },
    {
      id: "g6", authorId: "u-1", channelId: "general", ts: m(477),
      body: "users who need CJK can already drop a `.ttf` in `assets/font.ttf` and the runtime picks it up at boot",
    },
    {
      id: "g7", authorId: "u-15", channelId: "general", ts: m(420), edited: true,
      body: "[bot] PR #142 merged into main: feat: undo/redo with snapshot stacks (ctrl+z, ctrl+shift+z, ctrl+y)",
      reactions: [{ emoji: "🎉", count: 6, mine: true }, { emoji: "🚀", count: 3 }],
    },
    {
      id: "g8", authorId: "u-4", channelId: "general", ts: m(360),
      body: "did anyone benchmark the cold start with bytecode on vs off? curious how much it actually buys",
    },
    {
      id: "g9", authorId: "u-2", channelId: "general", ts: m(355),
      body: "from memory: bytecode shaves about 80–110ms off the parse phase on cold disk. measured number is in `docs/all-benchmarks/RESULTS.md`",
    },
    {
      id: "g10", authorId: "u-2", channelId: "general", ts: m(354),
      body: "the trade-off is the artifact is bigger (.qbc.zst is ~1.7× the .js size pre-compress) so initial download cost goes up",
    },
    {
      id: "g11", authorId: "u-5", channelId: "general", ts: m(310),
      body: "i hit a weird thing where workspace edits didn't propagate to the bundle. ended up needing `bun install --force` AND `--no-cache`. should that be one knob?",
    },
    {
      id: "g12", authorId: "u-1", channelId: "general", ts: m(308),
      body: "@indigo we just patched both: `file:`/`workspace:` deps are now folded into the cache key, and the in-tree examples switched to `workspace:*` so bun creates real symlinks",
    },
    {
      id: "g12b", authorId: "u-1", channelId: "general", ts: m(308),
      body: "the iteration loop is now:\n```\n# edit any packages/<pkg>/src/...\ncarbon run\n# cache invalidates, bundle rebuilds, app launches\n```",
    },
    {
      id: "g13", authorId: "u-1", channelId: "general", ts: m(308),
      body: "should be invisible going forward. let me know if it's not",
    },
    {
      id: "g14", authorId: "u-6", channelId: "general", ts: m(265),
      body: "loving the auto-grow textarea btw, makes the notes example feel like a real editor",
    },
    {
      id: "g15", authorId: "u-7", channelId: "general", ts: m(220),
      body: "agreed. tab traversal is great too. one nit: tabbing past the last input wraps to first — would expect a focus ring on the body in between?",
    },
    {
      id: "g16", authorId: "u-1", channelId: "general", ts: m(218),
      body: "fair. the runtime doesn't have a focus-ring concept yet. open issue.",
    },
    {
      id: "g17", authorId: "u-8", channelId: "general", ts: m(180),
      body: "ok the ctrl+space layout overlay is genuinely the most useful debug toy i've used in a long time",
    },
    {
      id: "g18", authorId: "u-11", channelId: "general", ts: m(120),
      body: "hot take: every desktop framework should ship one by default. zero-cost when off, instantly answers \"why is this 4px off\"",
    },
    {
      id: "g19", authorId: "u-2", channelId: "general", ts: m(95),
      body: "agreed. it's chrome's element inspector compressed into one keybind",
    },
    {
      id: "g20", authorId: "u-14", channelId: "general", ts: m(60),
      body: "is there a recommended way to bundle assets (icons, fonts) with a release build? or do we just stuff them in `assets/`?",
    },
    {
      id: "g21", authorId: "u-1", channelId: "general", ts: m(58),
      body: "today: drop them in `assets/`, they're copied into the dist folder verbatim. proper bundling/codegen is on the roadmap",
    },
    {
      id: "g22", authorId: "u-16", channelId: "general", ts: m(20),
      body: "[bot] new release v0.2.0 is now available — see #announcements for the full changelog",
      reactions: [{ emoji: "🎉", count: 12 }, { emoji: "🦀", count: 4 }],
    },
    {
      id: "g23", authorId: "u-3", channelId: "general", ts: m(8),
      body: "skimming the changelog now — `<input>` and `<textarea>` finally landing is the unlock i was waiting for",
    },
    {
      id: "g24", authorId: "u-3", channelId: "general", ts: m(7),
      body: "going to port my side project off electron this weekend",
    },
    {
      id: "g25", authorId: "u-1", channelId: "general", ts: m(2),
      body: "@pixel keep us posted. happy to help if you hit anything",
      reactions: [{ emoji: "❤️", count: 2 }],
    },
  ],

  showcase: [
    {
      id: "s1", authorId: "u-5", channelId: "showcase", ts: m(720),
      body: "built a tiny markdown previewer this weekend. 8MB binary, boots in 180ms. screenshots later when i'm at my desk",
    },
    {
      id: "s2", authorId: "u-2", channelId: "showcase", ts: m(640),
      body: "lfg. drop it when you can",
    },
    {
      id: "s3", authorId: "u-11", channelId: "showcase", ts: m(180),
      body: "i've been porting a small TUI status dashboard to carbon-mini. pretty big improvement in legibility once you have actual color depth",
    },
  ],

  "help-react": [
    {
      id: "h1", authorId: "u-7", channelId: "help-react", ts: m(40),
      body: "is `useDeferredValue` supposed to work with the react-mini reconciler? mine never actually defers",
    },
    {
      id: "h2", authorId: "u-2", channelId: "help-react", ts: m(35),
      body: "we're on react-reconciler 0.29 with ConcurrentRoot, so it SHOULD. but the runtime doesn't drain microtasks the way the browser does — try wrapping the source state in flushSync to compare",
    },
    {
      id: "h3", authorId: "u-7", channelId: "help-react", ts: m(2),
      body: "ah, that helps. actually digging into it now. thx",
    },
  ],

  "bug-reports": [
    {
      id: "b1", authorId: "u-13", channelId: "bug-reports", ts: m(800),
      body: "found a regression — clicking a sidebar item right at the very edge of its hover region sometimes routes the click to the parent container instead. small box, narrow case",
    },
    {
      id: "b2", authorId: "u-1", channelId: "bug-reports", ts: m(740),
      body: "thanks, repro pls? i can probably trace it to the hit_test recursion if you have a screen rec",
    },
    {
      id: "b3", authorId: "u-13", channelId: "bug-reports", ts: m(60),
      body: "writing one up — back in a bit",
    },
  ],

  announcements: [
    {
      id: "a1", authorId: "u-1", channelId: "announcements", ts: m(20),
      body: "**v0.2.0 is out** — highlights:",
    },
    {
      id: "a2", authorId: "u-1", channelId: "announcements", ts: m(20),
      body: "• `<input>` and `<textarea>` with caret, selection, clipboard, undo/redo\n• Native SVG (lucide-react renders out of the box)\n• Auto-grow textarea\n• Ctrl+Space layout debug overlay\n• Build cache now follows `file:`/`workspace:` deps",
    },
    {
      id: "a3", authorId: "u-1", channelId: "announcements", ts: m(19),
      body: "thanks to everyone who reported wrap / focus / state-loss bugs in the last week. shipping these wouldn't have been possible without the loop",
    },
    {
      id: "a4", authorId: "u-1", channelId: "announcements", ts: m(18),
      body: "> the layout-debug overlay alone has cut my UI iteration time in half\n\n— from one of last week's threads. agreed; it's the most useful debug tool we've shipped in a while",
      reactions: [{ emoji: "👍", count: 8 }, { emoji: "🔥", count: 3 }],
    },
  ],

  introductions: [
    {
      id: "i1", authorId: "u-14", channelId: "introductions", ts: m(2880),
      body: "hi all 👋 i'm atlas, joined a few weeks ago, mostly working on rust tooling and the occasional native UI prototype",
    },
    {
      id: "i2", authorId: "u-11", channelId: "introductions", ts: m(2400),
      body: "welcome! same boat over here. if you have a slack/threads-style discord lurker bingo i can probably fill it in",
    },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Group consecutive messages by the same author within `gapMs` (default
 *  5 min) into a single visual run. Mirrors how Discord/Slack collapse
 *  back-to-back messages. */
export function groupMessages(msgs: Message[], gapMs = 5 * 60 * 1000): Message[][] {
  const out: Message[][] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    const lastMsg = last?.[last.length - 1];
    if (
      lastMsg &&
      lastMsg.authorId === m.authorId &&
      m.ts - lastMsg.ts <= gapMs &&
      !m.replyTo
    ) {
      last.push(m);
    } else {
      out.push([m]);
    }
  }
  return out;
}

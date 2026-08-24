# carbon-discord

The bot surface for the Carbon Native community server. Follows the common
product template, see `products/README.md`: this product composes and
presents, it holds no `domain/` or `application/` layer, and any real logic
it eventually needs (build status, release lookups, plugin-registry queries)
lives in `solutions/` behind a use case, called the same way `carbon-cli`
calls `carbon-cloud`'s HTTP API.

```
composition/
  entrypoint.ts        builds the discord.js Client, attaches every event, wires the command router, logs in
  commands.ts            every slash command the bot has
  events.ts               every gateway-event handler the bot has
  deploy-commands.ts      one-off script: registers commands.ts's commands with Discord
presentation/
  framework/
    command.ts                the Command contract a slash command implements
    command-registry.ts       lazy descriptors, unique by name: Discord allows exactly one handler per command
    command-router.ts          a chat-input interaction in, the matching command dispatched
    event.ts                   the BotEvent contract a gateway-event handler implements
    event-registry.ts          lazy descriptors, NOT unique by name: many handlers may share one event
  commands/
    diagnostics/     help.command.ts · ping.command.ts · status.command.ts
    community/         github.command.ts
    release/            download.command.ts
  events/
    diagnostics/      ready.event.ts: logs on login, announces to STARTUP_CHANNEL_ID if set
tests/
  commands.test.ts             command registry coherence, mirrors carbon-cli's tests/registry.test.ts
  events.test.ts                 same, for the event registry
  command-router.test.ts          routing + the unregistered-command fallback, against the real registry
  commands/<category>/*.test.ts   one unit test per command, mirroring presentation/commands/'s categories
  events/<category>/*.test.ts      same, for events
```

## Why commands and events are separate concerns, not one "interactions" layer

Both ultimately reach the bot through discord.js's `Client`, so it's tempting
to model them as one thing. They don't share an invariant, though: Discord
enforces that a command name maps to *exactly one* handler (two commands
named `ping` is a registration error), but nothing stops two unrelated
features from both listening for `guildMemberAdd`, and both should fire.
`CommandRegistry` rejects a duplicate name; `EventRegistry` is a plain list.
Forcing them through one generic registry would have meant picking one of
those behaviors and getting the other wrong. `command.ts`/`command-router.ts`
and `event.ts`/`event-registry.ts` are parallel in shape (lazy descriptors,
`defineX` builders) precisely so the difference reads as intentional, not
missed.

## What's not built yet, on purpose

discord.js interactions aren't only chat-input commands. Context-menu
commands, autocomplete, message components (buttons/selects), and modals
each need their own contract and router: a button's `customId` isn't a
command name, so `CommandRegistry` doesn't fit it. None of those have a
folder here yet: `products/README.md` calls out that this repo's own
`products/` directory once held empty placeholder folders for products that
didn't exist, and states the rule that was written to prevent it:
**unused slots are omitted, not created empty**. The same applies one level
down. When a first button or modal actually ships, it gets
`presentation/framework/component.ts` the same way events got
`event.ts` here: real code first, folder because of it.

## Gateway, not HTTP Interactions

This bot holds a persistent WebSocket connection to Discord (`discord.js`'s
`Client`) rather than exposing an HTTPS endpoint Discord posts to. That means
`bun run start` connects outbound and just works: no public URL, no tunnel,
no Interactions Endpoint URL to configure in the Developer Portal.

## Configure it

```sh
cp .env.example .env
# fill in DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN from the Developer
# Portal's General Information / Bot tabs. Bun loads .env from the cwd
# automatically.
```

`.env` is gitignored at the repo root (`.gitignore` matches `.env` in any
directory), never commit it.

## Register commands with Discord

```sh
cd products/carbon-discord
bun run deploy-commands
```

Needs `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN`. Without
`DISCORD_GUILD_ID` set, this registers commands globally, which can take up
to an hour to show up in a client. Set `DISCORD_GUILD_ID` to a server ID
during development for near-instant, server-scoped registration. Re-run
whenever `composition/commands.ts` changes: logging in does not register
anything by itself.

## Run it

```sh
cd products/carbon-discord
bun run start
```

Logs `carbon-discord logged in as <bot tag>` once connected. That line now
comes from `presentation/events/diagnostics/ready.event.ts`, dispatched
through the event registry, not an inline handler. If `STARTUP_CHANNEL_ID`
is set, the same handler also posts an online announcement to that channel;
unset, it's a silent no-op rather than an error.

## Test it

```sh
bun test products/carbon-discord
```

`command-router.test.ts` routes a fake interaction through the *real*
command registry, so a break in the composition wiring fails it, not just
a hand-wavy unit test of a command in isolation. `events.test.ts` does the
same coherence check for event handlers.

## Current state

Five commands (`/help`, `/ping`, `/status`, `/github`, `/download`) and one
event (`ready`) work end to end. `/help` reads composition/commands.ts's own
registry rather than a hand-maintained list, so it can't drift from what's
actually wired up. `/download` and `/github` are deliberately honest about
what doesn't exist yet rather than linking somewhere dead: see their own
file comments. No message-content or presence intents are requested (only
`GatewayIntentBits.Guilds`, the minimum a slash-command-only bot needs).

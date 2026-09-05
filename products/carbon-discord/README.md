# carbon-discord

The bot surface for the Carbon Native community server. Follows the common
product template, see `products/README.md`: this product composes and
presents, it holds no `domain/` or `application/` layer, and any real logic
it eventually needs (build status, release lookups, plugin-registry queries)
lives in `solutions/` behind a use case, called the same way `carbon-cli`
calls `carbon-cloud`'s HTTP API.

```
composition/
  entrypoint.ts             builds the Client, attaches events, wires all interaction routers, logs in
  commands.ts               every slash command the bot has
  events.ts                 every gateway-event handler the bot has
  components.ts             every message component handler (buttons, select menus)
  modals.ts                 every modal submit handler
  autocompletes.ts          every slash command autocomplete handler
  context-menus.ts          every user/message context menu command
  deploy-commands.ts        one-off script: registers commands.ts's commands with Discord
presentation/
  framework/
    command.ts              the Command contract a slash command implements
    command-registry.ts     lazy descriptors, unique by name: Discord allows exactly one handler per command
    command-router.ts       a chat-input interaction in, the matching command dispatched
    component.ts            the Component contract a button or select menu implements
    component-registry.ts   lazy descriptors, matched by exact customId or prefix
    component-router.ts     a message component interaction in, the matching component dispatched
    modal.ts                the Modal contract a modal submit implements
    modal-registry.ts       lazy descriptors, matched by exact customId or prefix
    modal-router.ts         a modal submit interaction in, the matching modal dispatched
    autocomplete.ts         the Autocomplete contract an option suggestion handler implements
    autocomplete-registry.ts lazy descriptors, unique by command name
    autocomplete-router.ts  an autocomplete interaction in, choices dispatched
    context-menu.ts         the ContextMenuCommand contract for user/message context actions
    context-menu-registry.ts lazy descriptors, unique by name
    context-menu-router.ts  a context menu interaction in, the matching handler dispatched
    event.ts                the BotEvent contract a gateway-event handler implements
    event-registry.ts       lazy descriptors, NOT unique by name: many handlers may share one event
  commands/
    diagnostics/            help.command.ts · ping.command.ts · status.command.ts
    community/              github.command.ts · suggest.command.ts · issue.command.ts · event.command.ts · setup-roles.command.ts · resolve-thread.command.ts
    release/                download.command.ts · release.command.ts
    onboarding/             setup-verification.command.ts
    ticketing/              ticket-panel.command.ts
    broadcast/              announce.command.ts
  components/
    onboarding/             verify-rules.component.ts · verify-identity-button.component.ts
    ticketing/              ticket-open-button.component.ts · ticket-claim.component.ts · ticket-close.component.ts · ticket-transcript.component.ts
    community/              suggest-vote.component.ts · issue-actions.component.ts · event-rsvp.component.ts · role-toggle.component.ts · resolve-thread.component.ts
  modals/
    onboarding/             carbon-identity.modal.ts
    ticketing/              ticket-create.modal.ts
    community/              suggest-create.modal.ts · issue-create.modal.ts
  autocompletes/
    community/              issue-search.autocomplete.ts
  events/
    diagnostics/            ready.event.ts: logs on login, announces to STARTUP_CHANNEL_ID if set
    onboarding/             guild-member-add.event.ts: anti-raid check and onboarding notice
    community/              starboard.event.ts: showcase highlight reaction handler · thread-create.event.ts: forum helper
tests/
  commands.test.ts          command registry coherence, mirrors carbon-cli's tests/registry.test.ts
  events.test.ts            same, for the event registry
  command-router.test.ts    routing + the unregistered-command fallback, against the real registry
  component-router.test.ts  button & select menu routing + prefix matching + graceful fallbacks
  modal-router.test.ts      modal submission routing + fallback handling
  autocomplete-router.test.ts option suggestion routing + hanging UI prevention
  context-menu-router.test.ts user & message context menu action routing
  commands/<category>/*.test.ts unit test per command
  components/<category>/*.test.ts unit test per component
  modals/<category>/*.test.ts   unit test per modal
  autocompletes/<category>/*.test.ts unit test per autocomplete
  events/<category>/*.test.ts   unit test per event
```

## How interactions are separated by contract

Discord interactions are not just chat-input slash commands. Message components (buttons/select menus) and modals route on `customId` (exact match or prefix pattern `namespace:action:id`), autocompletes route on `commandName` and return candidate lists without triggering user-visible message replies, and context menus route on action names.

Each interaction family has its own dedicated contract, lazy registry, and router under `presentation/framework/`:
* `command.ts` / `command-registry.ts` / `command-router.ts` (Chat input slash commands)
* `component.ts` / `component-registry.ts` / `component-router.ts` (Buttons, String/Role/User/Channel/Mentionable select menus)
* `modal.ts` / `modal-registry.ts` / `modal-router.ts` (Modal form submissions)
* `autocomplete.ts` / `autocomplete-registry.ts` / `autocomplete-router.ts` (Dynamic option suggestions)
* `context-menu.ts` / `context-menu-registry.ts` / `context-menu-router.ts` (User and Message context menus)
* `event.ts` / `event-registry.ts` (Gateway WebSocket events)

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

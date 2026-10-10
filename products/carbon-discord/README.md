# carbon-discord

The Discord surface for the Carbon Native community. It provides onboarding,
segmented product communications, structured feedback, scheduled events, and
private support without presenting unfinished Carbon services as operational.

## Product boundaries

Discord is a communication surface. SQLite is the durable local record for
Discord-owned workflows, while authoritative product information must come
from the product that owns it. The following integrations remain intentionally
unavailable until those products expose stable contracts:

- Carbon account linking and Discord Linked Roles;
- Carbon Cloud service-health and incident data;
- signed-release publication and verified download metadata;
- external issue tracker, CRM, or helpdesk synchronization;
- contractual SLA and customer-entitlement routing.

The bot never asks a member to paste a Carbon API token. `/status`, `/docs`,
`/trust`, `/github`, and `/download` say plainly when their authoritative
resource has not been configured.

The deployment is intentionally single-server. `DISCORD_GUILD_ID` is required,
commands are registered only in that guild, and runtime interactions and events
from any other guild are ignored.

## Member experience

| Command or surface | Purpose |
|---|---|
| `/start` | A short route to docs, downloads, public help, private support, and notification preferences |
| `/docs` | Link to the configured official documentation |
| `/download` | Current honest packaging availability |
| `/status` | Link to the configured authoritative status page |
| `/trust` | Security, privacy, support-policy, and status resources |
| `/github` | Live public repository details when a repository is configured |
| `/support` | Open one private support request per member |
| `/issue create|search` | Durable community issue intake and lookup |
| `/suggest` | Post a proposal with a single “I need this too” signal |
| `/event list` | Show native Discord scheduled events |
| `/resolve` | Let a thread author resolve their own help thread |

Staff-only commands are hidden by default when registered and can be exposed
to configured staff roles through Discord command permissions:

- `/announce`, with explicit publication confirmation and an audit entry;
- `/event create`, which creates a native Discord scheduled event;
- `/audit`, showing the 20 most recent staff and security actions;
- `/metrics`, showing 1–365 days of aggregate command and component activity;
- `/ping`, an internal bot connectivity diagnostic;
- `/setup-verification`, `/setup-roles`, and `/ticket-panel`.

## Security and operational behavior

- Support uses private threads only. Failure to create a private thread never
  falls back to a public thread.
- Members may have one open request per server. Only the requester or support
  staff can close it; only support staff can claim or export it.
- Staff capabilities use configured role IDs and fail closed when no role is
  configured. Administrator remains an emergency override.
- User-entered text is length-bounded, mass mentions are neutralized, and
  common Carbon, GitHub, Stripe, and bearer tokens are redacted.
- Issue status controls are staff-only and accept only explicit transitions.
- Star reactions nominate work into a private review channel. A community
  manager must approve a nomination before it reaches the public showcase.
- Help threads can be resolved only by their author or a moderator.
- Help-thread guidance runs only in `HELP_FORUM_CHANNEL_IDS`.
- Issues, support records, suggestion interest, throttles, and audit events
  survive restarts in SQLite. WAL mode and a busy timeout support normal
  concurrent bot activity.
- Public errors carry a short reference ID. Full details stay in operator logs.
- Audit metadata excludes message bodies and secrets and is pruned according
  to `AUDIT_RETENTION_DAYS` (365 days by default, clamped to 30–2555 days).
- Marketing metrics are aggregate daily counts. They do not build member
  profiles or store message content.

Discord Community Onboarding, Rules Screening, AutoMod, and Raid Protection
should be enabled in the server itself. The bot's account-age gate is a small
additional control, not a replacement for Discord moderation controls.

## Configure

Copy `.env.example` to `.env` and fill the required credentials, channel IDs,
role IDs, and only those public URLs that are live and authoritative. Startup
validates URL schemes and Discord snowflake formats before connecting.

Keep `.env` outside version control. Carbon Discord needs these Discord bot
permissions:

- View Channels, Send Messages, Embed Links, Attach Files;
- Create Private Threads, Send Messages in Threads, Manage Threads;
- Manage Roles, with the bot role above member-controlled roles;
- Manage Events;
- Read Message History and Add Reactions.

Do not grant Administrator in production. Staff users may be administrators,
but the bot itself should receive only the permissions above.

## Docker deployment

Install Docker Engine with the Compose plugin on the host. Copy `.env.example`
to `.env`, set `DISCORD_APPLICATION_ID`, `DISCORD_BOT_TOKEN`, and
`DISCORD_GUILD_ID`, then configure the channel and role IDs used by the enabled
features. The Compose file does not publish the health port to the host.

Build the image and register the guild-scoped commands once:

```sh
cd products/carbon-discord
docker compose build bot
docker compose --profile tools run --rm register-commands
```

Registration replaces the command set for the configured guild, including
removal of retired commands such as the former manual `/release` command. Run
the registration command again whenever `composition/commands.ts` changes.

Start or update the long-running bot:

```sh
docker compose up -d --build bot
docker compose ps
docker compose logs --tail=100 bot
```

The service runs as the unprivileged `bun` user with a read-only root
filesystem, no Linux capabilities, `no-new-privileges`, a small temporary
filesystem, and an init process. SQLite state lives in the named
`carbon-discord-data` volume and survives image and container replacement.
Container logs rotate at 10 MB with five files retained.

Docker restarts the process after a crash or non-zero exit. The bot catches
fatal process errors, stops accepting health checks, closes Discord, checkpoints
SQLite WAL state, and exits. Discord.js handles ordinary gateway reconnects; if
the configured guild remains unavailable for
`DISCORD_UNREADY_RESTART_SECONDS` (300 seconds by default), the internal
watchdog exits so Docker can replace the process. `/health/live` and
`/health/ready` are available on port 3000 inside the Compose network, and the
container health check requires a ready Discord connection plus access to the
configured guild.

Use these operational commands:

```sh
docker compose restart bot
docker compose logs -f bot
docker compose stop bot
```

Do not use `docker compose down -v` in normal operations because `-v` deletes
the named database volume. Back up the volume while the service is stopped, or
use SQLite's online backup tooling from a controlled maintenance container.

## Local development

```sh
cd products/carbon-discord
bun run typecheck
bun run test
bun run deploy-commands
bun run start
```

After registration, configure command permissions in Discord for the support,
moderation, and community roles. Staff commands default to disabled for regular
members.

## Run and maintain

Back up the database at `DISCORD_DATA_PATH` together with its `-wal` file, or
use SQLite's online backup tooling. Protect the directory as customer-support
metadata. Test restoration periodically and define a retention process for
closed support records before production use.

Monitor process uptime, restart count, failed interaction references, Discord
gateway disconnects, database size, and backup age. `STARTUP_CHANNEL_ID` is
optional and should normally remain unset; operator monitoring is more useful
than repeatedly announcing restarts to a community channel.

## Architecture

`composition/` wires Discord registries and process startup.
`presentation/` owns Discord commands, events, components, modals, and their
framework routers. `infrastructure/` owns validated environment configuration
and SQLite adapters. Product behavior stays here because it is specific to the
Carbon community server; integrations with product-owned state are deferred
until their product-neutral contracts exist in `solutions/`.
